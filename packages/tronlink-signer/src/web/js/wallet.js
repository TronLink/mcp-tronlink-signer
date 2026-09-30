// Wallet discovery, connection, and network management
(function() {
  // Wallet selection, in descending confidence:
  //   1. TIP-6963 announce whose info.rdns is TronLink's official rdns
  //   2. TIP-6963 announce whose info.name looks like TronLink (rdns absent/changed)
  //   3. Injected globals (window.tron / window.tronLink) — pre-TIP-6963 builds,
  //      or a TronLink whose announce we didn't match
  //
  // Preferring TronLink's declared identity over a random first-responder raises
  // the bar against a rogue extension hijacking sign calls through this
  // "TronLink Signer" UI. It is NOT a cryptographic guarantee: TIP-6963 rdns/name
  // and the injected globals are all self-declared and can be spoofed. The user
  // still confirms every request in TronLink's own popup.
  //
  // rdns source: TronLink content-script EIP6963ProviderInfo.rdns.
  var TRONLINK_RDNS = 'org.tronlink.www';
  var TRONLINK_NAME_RE = /tronlink/i;
  // Hold weaker signals (name match / injected globals) back for this long after
  // discovery starts, so the real TronLink's rdns announce can win even if a
  // name-alike or a stray window.tron shows up first.
  var NAME_MATCH_GRACE_MS = 400;

  var _candidates = [];
  var _providerDetail = null;
  var _discoveryStartedAt = 0;
  var _listenerAttached = false;

  // De-dup re-announces: every requestProvider makes each wallet re-announce, so
  // without this the candidate set would grow unbounded across repeated
  // discoveries. Keyed on the provider object, falling back to the announce uuid.
  function rememberCandidate(detail) {
    if (!detail || !detail.provider) return;
    var uuid = detail.info && detail.info.uuid;
    for (var i = 0; i < _candidates.length; i++) {
      var ex = _candidates[i];
      if (ex.provider === detail.provider) return;
      if (uuid && ex.info && ex.info.uuid === uuid) return;
    }
    _candidates.push(detail);
  }

  function discoverWallets() {
    // Attach the collector once — re-attaching on every call would duplicate
    // every announce into _candidates.
    if (!_listenerAttached) {
      _listenerAttached = true;
      window.addEventListener('TIP6963:announceProvider', function(e) {
        rememberCandidate(e && e.detail);
      });
    }
    // Restart the grace window on EVERY discovery, not just the first. A signing
    // request can arrive minutes after page-load — long after the initial window
    // expired — and must still wait briefly for TronLink's rdns announce before
    // falling back to a name-alike or a stray global.
    _discoveryStartedAt = Date.now();
    window.dispatchEvent(new Event('TIP6963:requestProvider'));
  }

  // rdns is the strongest signal; the wallet name is a weaker fallback (it's the
  // identifier TronLink's own integration docs key off) for a TronLink that
  // changes or omits rdns. Name matching is held back for a short grace window
  // (see getProviderDetail) so a name-alike that announces first can't pre-empt
  // the real TronLink's slightly-later rdns announce.
  function findCandidateByRdns() {
    for (var i = 0; i < _candidates.length; i++) {
      var c = _candidates[i];
      if (c && c.info && c.info.rdns === TRONLINK_RDNS && c.provider) return c;
    }
    return null;
  }

  function findCandidateByName() {
    for (var i = 0; i < _candidates.length; i++) {
      var c = _candidates[i];
      if (c && c.info && TRONLINK_NAME_RE.test(c.info.name || '') && c.provider) return c;
    }
    return null;
  }

  // True once we've waited long enough past discovery start to stop holding out
  // for an rdns match. If discovery never started, nothing is held back.
  function graceElapsed() {
    if (_discoveryStartedAt === 0) return true;
    return Date.now() - _discoveryStartedAt >= NAME_MATCH_GRACE_MS;
  }

  function getProviderDetail() {
    if (_providerDetail) return _providerDetail;
    var rdns = findCandidateByRdns();
    if (rdns) { _providerDetail = rdns; return rdns; } // memoize the strongest match
    // Accept a name-only match only after the grace window, and never memoize it
    // — a real rdns announce arriving later must still be able to take over.
    if (graceElapsed()) {
      var named = findCandidateByName();
      if (named) return named;
    }
    return null;
  }

  function getProvider() {
    var detail = getProviderDetail();
    if (detail && detail.provider) return detail.provider;
    // Injected-globals fallback (pre-TIP-6963 TronLink, or a TronLink whose
    // announce we didn't match). While TIP-6963 announces are in play, hold off
    // until the grace elapses so an incoming rdns announce isn't pre-empted by a
    // stray/rogue window.tron. But with ZERO announces there is no rdns coming
    // (old TronLink only exposes window.tron) — fall through immediately rather
    // than make every legacy user wait out the grace. A rogue that set window.tron
    // could equally fake an rdns, so gating the no-announce case on grace adds no
    // real protection. (This is NOT the old "_candidates.length===0" hard gate
    // that broke detection — here we only skip the *wait*, never the fallback.)
    if (_candidates.length > 0 && !graceElapsed()) return null;
    // Prefer the more explicitly-named window.tronLink over window.tron, and a
    // global that self-identifies as TronLink over one that doesn't.
    var globals = [window.tronLink, window.tron];
    for (var i = 0; i < globals.length; i++) {
      if (globals[i] && globals[i].isTronLink) return globals[i];
    }
    return window.tronLink || window.tron || null;
  }

  function getTronWeb() {
    var provider = getProvider();
    if (provider && provider.tronWeb) {
      return provider.tronWeb;
    }
    return window.tronWeb || null;
  }

  function waitForWallet(maxWait) {
    maxWait = maxWait || 5000;
    discoverWallets();

    return new Promise(function(resolve, reject) {
      if (getProvider()) { resolve(true); return; }

      var elapsed = 0;
      var interval = setInterval(function() {
        elapsed += 200;
        if (getProvider()) {
          clearInterval(interval);
          resolve(true);
        } else if (elapsed >= maxWait) {
          clearInterval(interval);
          reject(new Error('No TRON wallet found. Please install TronLink extension.'));
        }
      }, 200);
    });
  }

  var NETWORK_CHAIN_IDS = {
    mainnet: '0x2b6653dc',
    nile: '0xcd8690dc',
    shasta: '0x94a9059e'
  };

  var NETWORK_FULL_HOSTS = {
    mainnet: 'https://api.trongrid.io',
    nile: 'https://nile.trongrid.io',
    shasta: 'https://api.shasta.trongrid.io'
  };

  function isConnected() {
    var tronWeb = getTronWeb();
    return !!(tronWeb && tronWeb.defaultAddress && tronWeb.defaultAddress.base58);
  }

  function getAddress() {
    var tronWeb = getTronWeb();
    return (tronWeb && tronWeb.defaultAddress && tronWeb.defaultAddress.base58) || null;
  }

  // TronLink exposes two provider styles with DIFFERENT account-request methods:
  // the modern window.tron speaks eth_requestAccounts; the legacy window.tronLink
  // speaks tron_requestAccounts. getProvider() may return either (a TIP-6963
  // announce vs the injected-global fallback, and which one wins isn't fully
  // deterministic), so connecting must be method-agnostic: try one, and if the
  // provider answers "Unknown method called" (method not supported), try the
  // other. Either may RESOLVE with a { code } (4001 user-rejected / 4000 already
  // queued) instead of throwing — surface those clearly and do NOT fall through.
  function isUnknownMethodError(e) {
    var msg = (e && (e.message || e.data)) || (typeof e === 'string' ? e : '') || '';
    return (e && e.code === -32601) || /unknown method|not supported|method not found/i.test(String(msg));
  }
  function assertAccountCode(res) {
    var code = res && res.code;
    if (code === 4001) throw new Error('You rejected the wallet connection. Click Retry to approve it.');
    if (code === 4000) throw new Error('A TronLink connection request is already open. Approve it (or close duplicate signer tabs), then click Retry.');
    return res;
  }
  async function requestAccounts(provider) {
    var methods = ['tron_requestAccounts', 'eth_requestAccounts'];
    var lastErr;
    for (var i = 0; i < methods.length; i++) {
      try {
        return assertAccountCode(await provider.request({ method: methods[i] }));
      } catch (e) {
        lastErr = e;
        if (!isUnknownMethodError(e)) throw e; // real rejection/timeout — don't retry the other method
      }
    }
    throw lastErr;
  }

  async function ensureConnected() {
    if (isConnected()) return;
    await requestAccounts(getProvider());
    await new Promise(function(r) { setTimeout(r, 500); });
  }

  async function ensureWalletReady(expectedNetwork, setStatus) {
    var provider = getProvider();
    if (!provider) {
      throw new Error('No TRON wallet found. Please install TronLink extension and refresh.');
    }

    // Skip connection prompt if already connected
    if (!isConnected()) {
      setStatus('Connecting wallet...', 'waiting');
      try {
        // Method-agnostic connect — works whether getProvider() returned the
        // modern window.tron (eth_requestAccounts) or legacy window.tronLink
        // (tron_requestAccounts). See requestAccounts().
        await requestAccounts(provider);
      } catch (e) {
        console.error('[ensureWalletReady] requestAccounts failed:', e && e.code, e && e.message, e);
        throw new Error((e && e.message) || 'Wallet connection failed. Please unlock TronLink and click Retry.');
      }
    }

    var tronWeb = getTronWeb();
    if (!tronWeb || !tronWeb.defaultAddress || !tronWeb.defaultAddress.base58) {
      await new Promise(function(r) { setTimeout(r, 1000); });
      tronWeb = getTronWeb();
      if (!tronWeb || !tronWeb.defaultAddress || !tronWeb.defaultAddress.base58) {
        throw new Error('Wallet not ready. Please unlock TronLink and refresh.');
      }
    }

    if (expectedNetwork) {
      var currentHost = tronWeb.fullNode.host;
      var expectedHost = NETWORK_FULL_HOSTS[expectedNetwork];
      console.error('[ensureWalletReady] host check', { expectedNetwork: expectedNetwork, currentHost: currentHost, expectedHost: expectedHost, mismatch: currentHost !== expectedHost });
      if (expectedHost && currentHost !== expectedHost) {
        setStatus('Switching to ' + expectedNetwork + ' network...', 'waiting');
        var chainId = NETWORK_CHAIN_IDS[expectedNetwork];
        if (!chainId) {
          throw new Error('Unknown network ' + expectedNetwork + '. Please switch TronLink manually then click Retry.');
        }
        console.error('[ensureWalletReady] calling wallet_switchEthereumChain', chainId);
        suppressNodeChange(10000);
        try {
          var switchRes = await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainId }]
          });
          console.error('[ensureWalletReady] switch returned', switchRes);
        } catch (switchErr) {
          console.error('[ensureWalletReady] switch threw', switchErr);
          throw new Error('Please switch TronLink to ' + expectedNetwork + ' network manually then click Retry.');
        }
        var deadline = Date.now() + 5000;
        var nowHost = currentHost;
        while (Date.now() < deadline) {
          await new Promise(function(r) { setTimeout(r, 300); });
          var tw = getTronWeb();
          nowHost = tw && tw.fullNode ? tw.fullNode.host : null;
          if (nowHost === expectedHost) break;
        }
        console.error('[ensureWalletReady] after poll', { nowHost: nowHost, matched: nowHost === expectedHost });
        if (nowHost !== expectedHost) {
          throw new Error('Please switch TronLink to ' + expectedNetwork + ' network manually then click Retry.');
        }
      }
    }
  }

  var HOST_TO_NETWORK = {
    'https://api.trongrid.io': 'mainnet',
    'https://nile.trongrid.io': 'nile',
    'https://api.shasta.trongrid.io': 'shasta'
  };

  function getCurrentNetwork() {
    var tw = getTronWeb();
    if (tw && tw.fullNode) {
      return HOST_TO_NETWORK[tw.fullNode.host] || 'unknown';
    }
    return 'unknown';
  }

  // Listen for TronLink wallet-change notifications (postMessage-based).
  // Normalize the three TronLink actions (setAccount / setNode / disconnectWeb)
  // plus EIP-1193 accountsChanged into a single callback with a short reason.
  var _onWalletChanged = null;
  // setNode events that fire while we're actively driving a network switch
  // (ensureWalletReady → wallet_switchEthereumChain) are our own doing, not a
  // real user-initiated wallet change — don't treat them as cancellation.
  var _suppressNodeChangeUntil = 0;

  function setOnWalletChanged(cb) {
    _onWalletChanged = typeof cb === 'function' ? cb : null;
  }

  function suppressNodeChange(ms) {
    _suppressNodeChangeUntil = Date.now() + (ms || 10000);
  }

  window.addEventListener('message', function(e) {
    // TronLink's content script posts wallet events via window.postMessage, so
    // the legitimate source is always our own window. Any cross-window sender
    // (attacker tab holding window.opener, a rogue extension targeting this
    // tab, etc.) must be ignored — without this check, a spoofed message would
    // trigger pendingStore.clearAll and cancel whatever we're about to sign.
    if (e.source !== window) return;
    if (!e.data || !e.data.isTronLink || !e.data.message) return;
    var m = e.data.message;
    var reason = null;
    if (m.action === 'setAccount' || m.action === 'accountsChanged') reason = 'account';
    else if (m.action === 'setNode') {
      if (Date.now() < _suppressNodeChangeUntil) return;
      reason = 'network';
    }
    else if (m.action === 'disconnectWeb') reason = 'disconnect';
    if (!reason) return;
    if (_onWalletChanged) _onWalletChanged(reason);
  });

  // Expose to global
  window.TronWallet = {
    discoverWallets: discoverWallets,
    getProviderDetail: getProviderDetail,
    getProvider: getProvider,
    getTronWeb: getTronWeb,
    waitForWallet: waitForWallet,
    isConnected: isConnected,
    getAddress: getAddress,
    ensureConnected: ensureConnected,
    ensureWalletReady: ensureWalletReady,
    getCurrentNetwork: getCurrentNetwork,
    setOnWalletChanged: setOnWalletChanged,
    suppressNodeChange: suppressNodeChange
  };
})();
