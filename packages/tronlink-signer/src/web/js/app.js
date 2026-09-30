// Main app: polling, request lifecycle, UI events
(function() {
  var statusEl = document.getElementById('status');
  var detailsEl = document.getElementById('details');
  var typeBadgeEl = document.getElementById('typeBadge');
  var networkBadgeEl = document.getElementById('networkBadge');
  var tabBarEl = document.getElementById('tabBar');
  var buttonGroup = document.getElementById('buttonGroup');
  var retryGroup = document.getElementById('retryGroup');
  var retryBtn = document.getElementById('retryBtn');
  var approveBtn = document.getElementById('approveBtn');
  var rejectBtn = document.getElementById('rejectBtn');
  var APPROVE_LABEL_DEFAULT = approveBtn.textContent;
  // Cap how long Approve stays disabled while identifying an ambiguous
  // transferFrom (TRC20 amount vs TRC721 tokenId). A slow/unreachable node must
  // not strand the user on a disabled button — see runAsyncLookups.
  var IDENTIFY_TIMEOUT_MS = 8000;

  var pendingRequests = {};   // id -> request
  var pendingRequest = null;  // currently active request object
  var currentRequestId = null;
  var polling = false;
  // Bumped whenever the active request changes or the UI is torn down. The
  // transferFrom identify-gating captures the cycle at setup; its timer/probe
  // callbacks no-op if the cycle has since advanced — so switching away from an
  // ambiguous request (and back, restarting a fresh gating cycle) can't let the
  // stale timer re-enable Approve or flash a spurious "network slow" warning.
  var identifyCycle = 0;
  var activeIdentifyTimer = null;
  // sessionId is injected into the HTML by the server (per-pageload). It never
  // travels in a response body — any local process that could read it over HTTP
  // would be able to forge approvals.
  var sessionMeta = document.querySelector('meta[name="session-id"]');
  var sessionId = sessionMeta ? sessionMeta.getAttribute('content') : null;
  var lastResultAt = 0;       // suppress idle status overwrite right after approve/reject

  function sessionHeaders(extra) {
    var h = { 'x-session-id': sessionId || '' };
    if (extra) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    }
    return h;
  }

  var NETWORK_NAMES = {
    mainnet: 'Mainnet',
    nile: 'Nile Testnet',
    shasta: 'Shasta Testnet'
  };

  // Heartbeat — detect server disconnect or session change
  var heartbeatFailCount = 0;
  var sessionExpired = false;
  var RELOAD_KEY = 'tronlink-signer:lastReloadAt';
  var RELOAD_COOLDOWN_MS = 10_000;

  function markSessionExpired() {
    sessionExpired = true;
    setStatus('Session expired. Please close this tab and try again.', 'error');
    buttonGroup.style.display = 'none';
    retryGroup.style.display = 'none';
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    tabBarEl.innerHTML = '';
  }

  // 410 (sessionId mismatch — daemon restarted) or repeated heartbeat failures
  // route here. Try in-place refresh first: fetch '/' with cache:'no-store',
  // parse the new sessionId out of the meta tag, swap it in memory. This keeps
  // the current tab (preserving the single-window-per-instance invariant and
  // the in-progress UI: tabBar, pending request, wallet popup state).
  //
  // Only fall back to location.reload() when the in-place fetch fails (network
  // truly down). Reload is throttled by RELOAD_COOLDOWN_MS in sessionStorage —
  // two reloads within the window means the previous one didn't help, so we go
  // terminal instead of thrashing.
  async function attemptReloadOrExpire() {
    if (sessionExpired) return;

    try {
      var res = await fetch('/?_=' + Date.now(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (res.ok) {
        var html = await res.text();
        var m = html.match(/<meta name="session-id" content="([^"]+)">/);
        var newId = m && m[1];
        if (newId && newId !== '{{SESSION_ID}}') {
          if (newId !== sessionId) {
            sessionId = newId;
            var meta = document.querySelector('meta[name="session-id"]');
            if (meta) meta.setAttribute('content', newId);
          }
          heartbeatFailCount = 0;
          try { sessionStorage.removeItem(RELOAD_KEY); } catch (_) {}
          return;
        }
      }
    } catch (_) { /* fall through to reload */ }

    var now = Date.now();
    var lastReload = 0;
    try { lastReload = parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10) || 0; } catch (_) {}
    if (lastReload && now - lastReload < RELOAD_COOLDOWN_MS) {
      markSessionExpired();
      return;
    }
    try { sessionStorage.setItem(RELOAD_KEY, String(now)); } catch (_) {}
    location.reload();
  }

  function pulseHeartbeat() {
    if (sessionExpired) return;
    if (!sessionId) return;
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: sessionHeaders({ 'Content-Type': 'application/json' }),
      body: '{}'
    })
      .then(function(res) {
        if (res.status === 410) {
          attemptReloadOrExpire();
          return;
        }
        if (res.ok) {
          heartbeatFailCount = 0;
          try { sessionStorage.removeItem(RELOAD_KEY); } catch (_) {}
        }
        else heartbeatFailCount++;
      })
      .catch(function() { heartbeatFailCount++; })
      .finally(function() {
        if (heartbeatFailCount >= 3 && !sessionExpired) attemptReloadOrExpire();
      });
  }
  // Fire immediately so the first heartbeat doesn't have to wait a full second
  // — closes the gap with the SDK's watchTimer DISCONNECT_TIMEOUT during cold
  // browser startup.
  pulseHeartbeat();
  setInterval(pulseHeartbeat, 1000);

  // --- UI helpers ---

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + type;
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function addDetail(label, value, rowKey) {
    var row = document.createElement('div');
    row.className = 'detail-row';
    if (rowKey) row.setAttribute('data-row-key', rowKey);
    // Build with textContent — the previous innerHTML concatenation escaped
    // `value` but not `label`. All current callers pass static strings, but
    // this page holds signing capability (sessionId + /api/complete/*id*) so
    // an XSS regression would let any future malicious dynamic label forge
    // approvals. textContent removes the foot-gun entirely.
    var l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    var v = document.createElement('span');
    v.className = 'value';
    v.textContent = String(value);
    row.append(l, v);
    detailsEl.appendChild(row);
  }

  function disableButtons() {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
  }

  function resetApproveButton() {
    approveBtn.disabled = false;
    approveBtn.textContent = APPROVE_LABEL_DEFAULT;
  }

  // Invalidate any in-flight transferFrom identify-gating: advance the cycle (so
  // the pending timer/probe callbacks no-op) and clear the outstanding timer.
  function cancelIdentifyGating() {
    identifyCycle++;
    if (activeIdentifyTimer) { clearTimeout(activeIdentifyTimer); activeIdentifyTimer = null; }
  }

  function clearActiveUI() {
    cancelIdentifyGating();
    detailsEl.innerHTML = '';
    typeBadgeEl.style.display = 'none';
    networkBadgeEl.style.display = 'none';
    buttonGroup.style.display = 'none';
    retryGroup.style.display = 'none';
    approveBtn.textContent = APPROVE_LABEL_DEFAULT;
  }

  // --- Tab bar ---

  var SIGN_TX_TITLES = {
    'Transfer TRX':            'Transfer TRX',
    'Transfer TRC10 Asset':    'TRC10 Transfer',
    'TRC20 Transfer':          'TRC20 Transfer',
    'TRC721 Transfer (NFT)':   'NFT Transfer',
    'Stake TRX (Freeze v2)':   'Stake TRX',
    'Unstake TRX (Unfreeze v2)': 'Unstake TRX',
    'Delegate Resource':       'Delegate',
    'Undelegate Resource':     'Undelegate',
    'Withdraw Unfrozen TRX':   'Withdraw',
    'Vote for SR':             'Vote',
    'Claim Rewards':           'Claim',
    'Deploy Contract':         'Deploy',
    'Create Account':          'Create Acct'
  };

  function getDetail(details, label) {
    if (!details) return null;
    for (var i = 0; i < details.length; i++) {
      if (details[i].l === label) return details[i].v;
    }
    return null;
  }

  function amountArrow(amount, to) {
    var parts = [];
    if (amount && amount !== 'Loading...') parts.push(amount);
    if (to) parts.push('→ ' + shortAddr(to));
    return parts.join(' ');
  }

  function signTxLabel(tx, broadcast) {
    var parsed = null;
    try { parsed = window.TxParser.parseTransaction(tx); } catch (_) {}
    if (!parsed) return { title: 'Sign Tx', summary: broadcast ? 'sign + broadcast' : 'sign only' };
    var title = SIGN_TX_TITLES[parsed.label] || parsed.label || 'Sign Tx';
    var to = getDetail(parsed.details, 'To') || getDetail(parsed.details, 'Receiver') || '';
    var amount = getDetail(parsed.details, 'Amount') || '';
    var summary = amountArrow(amount, to);
    if (!summary) summary = broadcast ? 'sign + broadcast' : 'sign only';
    return { title: title, summary: summary };
  }

  function tabLabel(req) {
    var data = req.data || {};
    switch (req.type) {
      case 'connect':         return { title: 'Connect',    summary: 'Wallet connect' };
      case 'send_trx':        return { title: 'Send TRX',   summary: amountArrow(data.amount != null ? data.amount + ' TRX' : '', data.to) };
      case 'send_trc20':      return { title: 'Send TRC20', summary: amountArrow(data.amount != null ? String(data.amount) : '', data.to) };
      case 'sign_message':    return { title: 'Sign Msg',   summary: truncate(String(data.message || ''), 24) };
      case 'sign_typed_data': return { title: 'Typed Data', summary: 'EIP-712' };
      case 'sign_transaction':return signTxLabel(data.transaction, data.broadcast);
      default:                return { title: req.type,     summary: '' };
    }
  }

  function shortAddr(a) {
    if (!a || typeof a !== 'string' || a.length < 10) return String(a || '');
    return a.slice(0, 5) + '…' + a.slice(-4);
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function renderTabBar() {
    tabBarEl.innerHTML = '';
    var sorted = Object.keys(pendingRequests)
      .map(function(k) { return pendingRequests[k]; })
      .sort(function(a, b) { return a.createdAt - b.createdAt; });
    if (sorted.length <= 1) return; // don't show tab bar for single or zero
    sorted.forEach(function(r) {
      var label = tabLabel(r);
      var tab = document.createElement('div');
      tab.className = 'tab' + (r.id === currentRequestId ? ' active' : '');
      tab.innerHTML =
        '<div class="tab-title">' + escapeHtml(label.title) + '</div>' +
        '<div class="tab-summary">' + escapeHtml(label.summary) + '</div>';
      tab.addEventListener('click', function() { switchTo(r.id); });
      tabBarEl.appendChild(tab);
    });
  }

  function switchTo(id) {
    if (id === currentRequestId) return;
    var req = pendingRequests[id];
    if (!req) return;
    cancelIdentifyGating();
    console.error('[switchTo]', { id: id, type: req.type, network: req.network });
    currentRequestId = id;
    pendingRequest = req;
    resetApproveButton();
    rejectBtn.disabled = false;
    buttonGroup.style.display = 'none';
    retryGroup.style.display = 'none';
    renderTabBar();
    handleRequest(req);
  }

  // --- Render request details ---

  function renderDetails(req) {
    typeBadgeEl.textContent = req.type;
    typeBadgeEl.style.display = 'inline-block';
    if (req.network) {
      networkBadgeEl.textContent = NETWORK_NAMES[req.network] || req.network;
      networkBadgeEl.style.display = 'inline-block';
    }
    detailsEl.innerHTML = '';

    var data = req.data || {};
    switch (req.type) {
      case 'connect':
        addDetail('Action', 'Connect Wallet');
        break;
      case 'send_trx':
        addDetail('To', data.to);
        addDetail('Amount', data.amount + ' TRX');
        break;
      case 'send_trc20':
        addDetail('Contract', data.contractAddress);
        addDetail('To', data.to);
        addDetail('Amount', data.amount);
        addDetail('Decimals', data.decimals !== undefined ? data.decimals : 'auto-detect from contract');
        break;
      case 'sign_message':
        addDetail('Message', data.message);
        break;
      case 'sign_typed_data':
        addDetail('Typed Data', JSON.stringify(data.typedData, null, 2));
        break;
      case 'sign_transaction': {
        if (data.broadcast) {
          addDetail('Broadcast', 'Yes (will send on-chain after signing)');
        }
        var parsed = window.TxParser.parseTransaction(data.transaction);
        if (parsed) {
          addDetail('Type', parsed.label);
          parsed.details.forEach(function(d) { addDetail(d.l, d.v, d.k); });
        } else {
          addDetail('Transaction', JSON.stringify(data.transaction, null, 2));
        }
        break;
      }
    }
  }

  // Async on-chain lookups (TRC10 precision, TRC20 decimals/symbol, unfrozen
  // withdraw amount). Must run AFTER ensureWalletReady completes any network
  // switch, otherwise they hit the wrong chain and fail silently.
  //
  // detailsEl is shared across requests (cleared by renderDetails on switch),
  // and the lookups locate target rows by label/key. Without a guard, a
  // lookup fired for request A that resolves after the user switched to B
  // would clobber B's matching row (e.g. write A's TRC20 "1.0 USDT" into B's
  // "Amount" row that holds "10 TRX"). isStale snapshots the request id at
  // dispatch time so each lookup can no-op on stale resolutions.
  function runAsyncLookups(req) {
    if (!req) return;
    var data = req.data || {};
    var snapshotId = req.id;
    var isStale = function() { return currentRequestId !== snapshotId; };
    // send_trc20 carries only high-level fields (no raw tx to parse) — resolve the
    // token's decimals/symbol so the Amount/Decimals rows show real precision
    // (e.g. "0.0001 USDD" / "18") instead of the "auto-detect from contract"
    // placeholder. Reuses the same fetchTokenMeta as the sign_transaction path.
    if (req.type === 'send_trc20') {
      window.TxParser.fetchSendTrc20Display(data.contractAddress, data.amount, data.decimals, detailsEl, isStale);
      return;
    }
    if (req.type !== 'sign_transaction') return;
    var parsed;
    try { parsed = window.TxParser.parseTransaction(data.transaction); } catch (_) { return; }
    if (!parsed) return;
    if (parsed._trc10 && req.networkConfig) {
      window.TxParser.fetchTrc10Info(parsed._trc10, detailsEl, req.networkConfig.fullHost, isStale);
    }
    if (parsed._trc20) {
      window.TxParser.fetchTrc20Info(parsed._trc20, detailsEl, isStale);
    }
    if (parsed._withdrawOwner) {
      window.TxParser.fetchWithdrawAmount(parsed._withdrawOwner, detailsEl, isStale);
    }
    if (parsed._contractCall) {
      var cc = parsed._contractCall;
      if (cc.resolved) {
        if (cc.tokenAmounts && cc.tokenAmounts.length) {
          // fetchTrc20AmountForCall swallows errors internally, so this Promise
          // settles either way.
          var probe = Promise.resolve(window.TxParser.fetchTrc20AmountForCall(cc, detailsEl, isStale));
          // For selectors shared between fungible and NFT semantics (currently
          // only 0x23b872dd transferFrom), the displayed "amount" can actually be
          // a tokenId. Block Approve until detectTokenKind resolves so the user
          // can't sign a stale misread — but cap the wait: a slow/unreachable node
          // must not strand the user on a permanently-disabled button (they could
          // otherwise only Reject). On timeout, re-enable and flag the unresolved
          // ambiguity so the "amount or tokenId" row gets a deliberate look.
          if (cc.ambiguousKind) {
            // Capture the gating cycle: a later switch/teardown advances it, so a
            // stale timer/probe from this cycle can't re-enable Approve on a newer
            // request — or on this same request re-opened with a fresh gating.
            var myCycle = identifyCycle;
            approveBtn.disabled = true;
            approveBtn.textContent = 'Identifying token…';
            var settled = false;
            var release = function(timedOut) {
              if (settled || isStale() || myCycle !== identifyCycle) return;
              settled = true;
              activeIdentifyTimer = null;
              resetApproveButton();
              if (timedOut) {
                setStatus('Could not confirm token type (network slow). This may be an NFT transfer — check the "amount or tokenId" value before approving.', 'error');
              }
            };
            if (activeIdentifyTimer) clearTimeout(activeIdentifyTimer);
            var idTimer = setTimeout(function() { release(true); }, IDENTIFY_TIMEOUT_MS);
            activeIdentifyTimer = idTimer;
            probe.then(function() { clearTimeout(idTimer); release(false); },
                       function() { clearTimeout(idTimer); release(false); });
          }
        }
      } else {
        window.TxParser.fetchContractCallAbi(cc, detailsEl, isStale);
      }
    }
  }

  // --- Wallet readiness ---

  async function tryEnsureWallet() {
    if (!pendingRequest) return;
    retryGroup.style.display = 'none';
    buttonGroup.style.display = 'none';
    try {
      await window.TronWallet.ensureWalletReady(pendingRequest.network, setStatus);
      if (!pendingRequest) return;

      // Auto-complete connect requests once wallet is ready
      if (pendingRequest.type === 'connect') {
        for (var i = 0; i < 10; i++) {
          var addr = window.TronWallet.getAddress();
          if (addr) {
            try {
              await completeRequest(currentRequestId, true, { address: addr, network: window.TronWallet.getCurrentNetwork() });
              setStatus('Wallet connected: ' + addr, 'success');
              lastResultAt = Date.now();
            } catch (_) {
              setStatus('Request expired or no longer available.', 'error');
            }
            return;
          }
          await new Promise(function(r) { setTimeout(r, 300); });
        }
      }

      runAsyncLookups(pendingRequest);
      setStatus('Ready. Review and approve or reject.', 'info');
      buttonGroup.style.display = 'flex';
    } catch (e) {
      setStatus(e.message || 'Wallet connection failed. Please try again.', 'error');
      retryGroup.style.display = 'flex';
    }
  }

  // --- Request lifecycle ---

  async function completeRequest(id, success, resultOrError) {
    var body = success
      ? { success: true, result: resultOrError }
      : { success: false, error: resultOrError };
    var res = await fetch('/api/complete/' + id, {
      method: 'POST',
      headers: sessionHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (res.status === 410) {
      attemptReloadOrExpire();
      throw new Error('Session expired.');
    }
    if (!res.ok) {
      throw new Error('Request expired or no longer available.');
    }
  }

  async function handleRequest(req) {
    pendingRequest = req;
    currentRequestId = req.id;

    setStatus('Discovering wallets...', 'waiting');
    try {
      await window.TronWallet.waitForWallet(5000);
      var detail = window.TronWallet.getProviderDetail();
      if (detail && detail.info) {
        setStatus('Found wallet: ' + detail.info.name, 'info');
      }
    } catch (e) {
      renderDetails(req);
      setStatus(e.message, 'error');
      return;
    }

    renderDetails(req);
    await tryEnsureWallet();
  }

  // --- List polling ---

  function syncPendingList(requests) {
    var newMap = {};
    requests.forEach(function(r) { newMap[r.id] = r; });
    pendingRequests = newMap;

    // Current request disappeared (completed/rejected/expired from server side)
    if (currentRequestId && !pendingRequests[currentRequestId]) {
      currentRequestId = null;
      pendingRequest = null;
      clearActiveUI();
      if (requests.length === 0 && Date.now() - lastResultAt > 2000) {
        setStatus('Waiting for request...', 'info');
      }
    }

    renderTabBar();

    // Idle with incoming requests: auto-select oldest
    if (!currentRequestId && requests.length > 0) {
      switchTo(requests[0].id);
    }
  }

  async function pollPending() {
    if (polling || sessionExpired) return;
    polling = true;
    try {
      // Triple defense against the stale-410 trap: a query-string cache-bust,
      // fetch's `cache: 'no-store'`, and a `Cache-Control: no-cache` header.
      // Server-side no-store on /api/* only protects responses going forward —
      // browsers that already cached a 410 from a previous daemon will keep
      // serving it from disk on the very first poll after restart, which is
      // exactly when we need to discover the new sessionId. Belt + suspenders.
      var res = await fetch('/api/pending?_=' + Date.now(), {
        cache: 'no-store',
        headers: sessionHeaders({ 'Cache-Control': 'no-cache' })
      });
      if (res.status === 410) {
        attemptReloadOrExpire();
      } else if (res.ok) {
        var data = await res.json();
        syncPendingList(data.requests || []);
      }
    } catch (_) { /* ignore transient error */ }
    polling = false;
  }

  // --- Event listeners ---

  retryBtn.addEventListener('click', function() {
    tryEnsureWallet();
  });

  function shortTx(id) {
    if (!id || typeof id !== 'string') return '';
    return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-6) : id;
  }

  approveBtn.addEventListener('click', async function() {
    if (!currentRequestId || !pendingRequest) return;
    var id = currentRequestId;
    var req = pendingRequest;
    disableButtons();
    setStatus('Processing with wallet...', 'waiting');
    try {
      var result = await window.TronActions.execute(req, {
        onBroadcast: async function(info) {
          setStatus('Broadcast sent (' + shortTx(info.txId) + '). Waiting for on-chain confirmation…', 'waiting');
          // Notify server so SDK caller's onBroadcasted fires immediately,
          // before we block on chain confirmation. Best-effort: ignore errors.
          try {
            await fetch('/api/broadcasted/' + id, {
              method: 'POST',
              headers: sessionHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                txId: info.txId,
                signedTransaction: info.signedTransaction,
              }),
            });
          } catch (_) { /* don't block confirmation on this */ }
        },
      });
      await completeRequest(id, true, result);
      if (result && result.status === 'pending' && result.txId) {
        // Browser hands off confirmation polling to the SDK side — txid is on the
        // chain, the caller will surface success/failed/timeout.
        setStatus('Broadcast sent (txid: ' + shortTx(result.txId) + '). Caller is awaiting on-chain confirmation.', 'success');
      } else if (req.type === 'sign_message' || req.type === 'sign_typed_data' || req.type === 'sign_transaction') {
        setStatus('Signed successfully. Result returned to caller.', 'success');
      } else {
        setStatus('Approved.', 'success');
      }
    } catch (e) {
      var msg = e.message || String(e);
      try { await completeRequest(id, false, msg); } catch (_) {}
      setStatus('Error: ' + msg, 'error');
    }
    lastResultAt = Date.now();
  });

  rejectBtn.addEventListener('click', async function() {
    if (!currentRequestId) return;
    var id = currentRequestId;
    disableButtons();
    try {
      await completeRequest(id, false, 'USER_REJECTED');
      setStatus('Rejected.', 'error');
    } catch (_) {
      setStatus('Request expired or no longer available.', 'error');
    }
    lastResultAt = Date.now();
  });

  // --- Wallet change handling ---

  async function handleWalletChanged(reason) {
    console.error('[handleWalletChanged] fired', reason);
    try {
      await fetch('/api/wallet-changed', {
        method: 'POST',
        headers: sessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason: reason }),
      });
    } catch (_) { /* server will catch up on next poll */ }
    pendingRequests = {};
    currentRequestId = null;
    pendingRequest = null;
    clearActiveUI();
    tabBarEl.innerHTML = '';
    var label = reason === 'account' ? 'Account changed'
              : reason === 'network' ? 'Network changed'
              : reason === 'disconnect' ? 'Wallet disconnected'
              : 'Wallet changed';
    setStatus(label + '. Pending requests cleared.', 'info');
    lastResultAt = Date.now();
  }

  window.TronWallet.setOnWalletChanged(handleWalletChanged);

  // --- Init ---
  window.TronWallet.discoverWallets();
  if (!sessionId) {
    markSessionExpired();
  } else {
    setStatus('Waiting for request...', 'info');
    setInterval(pollPending, 1000);
    pollPending();
  }
})();
