// Transaction parsing and async data fetching
(function() {
  var RESOURCE_NAMES = { 0: 'Bandwidth', 'BANDWIDTH': 'Bandwidth', 1: 'Energy', 'ENERGY': 'Energy' };

  // Known function selectors → decoding spec.
  // tokenAmounts: which args are token amounts (want decimals/symbol formatting).
  //   - { argIndex }                                         → use the contract's own decimals (self)
  //   - { argIndex, pathArgIndex, pathPosition: 'first'|'last' } → look up decimals from path[0] or path[last]
  var KNOWN_METHODS = {
    '095ea7b3': { name: 'approve',     inputs: [{name:'spender',type:'address'},{name:'amount',type:'uint256'}],                                                                                                                     tokenAmounts: [{argIndex: 1}] },
    'a9059cbb': { name: 'transfer',    inputs: [{name:'to',type:'address'},{name:'amount',type:'uint256'}],                                                                                                                          tokenAmounts: [{argIndex: 1}] },
    '23b872dd': { name: 'transferFrom',inputs: [{name:'from',type:'address'},{name:'to',type:'address'},{name:'amount',type:'uint256'}],                                                                                             tokenAmounts: [{argIndex: 2}] },
    '40c10f19': { name: 'mint',        inputs: [{name:'to',type:'address'},{name:'amount',type:'uint256'}],                                                                                                                          tokenAmounts: [{argIndex: 1}] },
    'd505accf': { name: 'permit',      inputs: [{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'deadline',type:'uint256'},{name:'v',type:'uint8'},{name:'r',type:'bytes32'},{name:'s',type:'bytes32'}], tokenAmounts: [{argIndex: 2}] },
    'ac9650d8': { name: 'multicall',   inputs: [{name:'data',type:'bytes[]'}] },
    '38ed1739': { name: 'swapExactTokensForTokens', inputs: [{name:'amountIn',type:'uint256'},{name:'amountOutMin',type:'uint256'},{name:'path',type:'address[]'},{name:'to',type:'address'},{name:'deadline',type:'uint256'}], tokenAmounts: [{argIndex:0, pathArgIndex:2, pathPosition:'first'},{argIndex:1, pathArgIndex:2, pathPosition:'last'}] },
    '8803dbee': { name: 'swapTokensForExactTokens', inputs: [{name:'amountOut',type:'uint256'},{name:'amountInMax',type:'uint256'},{name:'path',type:'address[]'},{name:'to',type:'address'},{name:'deadline',type:'uint256'}], tokenAmounts: [{argIndex:0, pathArgIndex:2, pathPosition:'last'},{argIndex:1, pathArgIndex:2, pathPosition:'first'}] },
    'fb3bdb41': { name: 'swapETHForExactTokens',    inputs: [{name:'amountOut',type:'uint256'},{name:'path',type:'address[]'},{name:'to',type:'address'},{name:'deadline',type:'uint256'}],                                    tokenAmounts: [{argIndex:0, pathArgIndex:1, pathPosition:'last'}] },
    '7ff36ab5': { name: 'swapExactETHForTokens',    inputs: [{name:'amountOutMin',type:'uint256'},{name:'path',type:'address[]'},{name:'to',type:'address'},{name:'deadline',type:'uint256'}],                                 tokenAmounts: [{argIndex:0, pathArgIndex:1, pathPosition:'last'}] },
    '18cbafe5': { name: 'swapExactTokensForETH',    inputs: [{name:'amountIn',type:'uint256'},{name:'amountOutMin',type:'uint256'},{name:'path',type:'address[]'},{name:'to',type:'address'},{name:'deadline',type:'uint256'}], tokenAmounts: [{argIndex:0, pathArgIndex:2, pathPosition:'first'},{argIndex:1, pathArgIndex:2, pathPosition:'last'}] },
    '4a25d94a': { name: 'swapTokensForExactETH',    inputs: [{name:'amountOut',type:'uint256'},{name:'amountInMax',type:'uint256'},{name:'path',type:'address[]'},{name:'to',type:'address'},{name:'deadline',type:'uint256'}], tokenAmounts: [{argIndex:0, pathArgIndex:2, pathPosition:'last'},{argIndex:1, pathArgIndex:2, pathPosition:'first'}] }
  };

  function getResourceName(r) {
    if (r === undefined || r === null) return 'Bandwidth';
    return RESOURCE_NAMES[r] || String(r);
  }

  function fromHexString(hex) {
    if (!hex || typeof hex !== 'string') return hex;
    try {
      var str = '';
      for (var i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
      }
      return str;
    } catch(e) { return hex; }
  }

  function fromHexAddress(hex) {
    if (!hex || typeof hex !== 'string') return hex;
    try {
      var tw = window.TronWallet.getTronWeb();
      if (tw && tw.address && tw.address.fromHex) return tw.address.fromHex(hex);
    } catch(e) {}
    return hex;
  }

  function fromSun(sun) {
    if (sun === undefined || sun === null || sun === '') return '0 TRX';
    var raw;
    try { raw = BigInt(sun); } catch(e) { return String(sun) + ' TRX'; }
    var neg = raw < 0n;
    if (neg) raw = -raw;
    var whole = raw / 1000000n;
    var frac = raw % 1000000n;
    var out = whole.toString();
    if (frac > 0n) {
      var fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
      if (fracStr) out += '.' + fracStr;
    }
    return (neg ? '-' : '') + out + ' TRX';
  }

  function truncateMiddle(s, max) {
    if (!s || s.length <= max) return s;
    var head = Math.floor((max - 1) / 2);
    var tail = max - 1 - head;
    return s.slice(0, head) + '…' + s.slice(-tail);
  }

  function safeStringify(v) {
    try {
      return JSON.stringify(v, function(_, val) {
        return typeof val === 'bigint' ? val.toString() : val;
      });
    } catch(_) { return String(v); }
  }

  // Format a single decoded ABI value. `components` is only meaningful for tuple / tuple[]
  // and carries the struct field spec (name, type, nested components).
  function formatArg(type, value, components) {
    try {
      if (type === 'address') return fromHexAddress(value);
      if (type === 'bool')    return value ? 'true' : 'false';
      if (type === 'string')  return truncateMiddle(String(value), 80);
      if (/^bytes(\d+)?$/.test(type)) {
        var hex = typeof value === 'string' ? value : safeStringify(value);
        if (hex.indexOf('0x') !== 0) hex = '0x' + hex;
        return truncateMiddle(hex, 80);
      }
      if (/^(u?int)(\d+)?$/.test(type)) {
        return (typeof value === 'bigint' ? value : BigInt(value.toString())).toString();
      }

      // tuple (struct) — ethers returns an Array with named properties matching components
      if (type === 'tuple') {
        var entries = (components || []).map(function(c, i) {
          var v = value && (c.name && value[c.name] !== undefined ? value[c.name] : value[i]);
          return (c.name || 'f' + i) + ': ' + formatArg(c.type, v, c.components);
        });
        return truncateMiddle('{' + entries.join(', ') + '}', 120);
      }

      // array types — strip one level of brackets, recurse on element type (carries `components`
      // through so `tuple[]` formats each element as a struct).
      if (/\[\d*\]$/.test(type)) {
        var elemType = type.replace(/\[\d*\]$/, '');
        var arr = value || [];
        var shown = arr.slice(0, 3).map(function(v) { return formatArg(elemType, v, components); });
        var suffix = arr.length > 3 ? ', …(+' + (arr.length - 3) + ' more)' : '';
        return '[' + shown.join(', ') + suffix + ']';
      }

      return truncateMiddle(safeStringify(value), 80);
    } catch(_) {
      return safeStringify(value);
    }
  }

  // Expand tuple / tuple[] / tuple[N] / tuple[][] / tuple[2][3]... to canonical
  // form "(type1,type2,...)[suffix]". Non-tuple types are returned as-is.
  // Strip every trailing "[…]" suffix first so multi-dimensional arrays of
  // tuples are recognized, then reattach the same suffix to the expanded body.
  function canonicalType(input) {
    var t = (input && input.type) || '';
    var m = t.match(/^(.*?)((?:\[\d*\])*)$/);
    var base = m ? m[1] : t;
    var suffix = m ? m[2] : '';
    if (base === 'tuple') {
      var inner = '(' + ((input && input.components) || []).map(canonicalType).join(',') + ')';
      return inner + suffix;
    }
    return t;
  }

  // Decode calldata args using tronWeb's ABI decoder.
  // inputs: [{name, type, components?}, ...]
  // Returns { raw: [...], rows: [{name, type, display}] } or null on failure.
  function decodeCall(argsHex, inputs) {
    if (!inputs || !inputs.length) return { raw: [], rows: [] };
    try {
      var tw = window.TronWallet.getTronWeb();
      if (!tw || !tw.utils || !tw.utils.abi) return null;
      var types = inputs.map(canonicalType);
      // tronWeb's decodeParams signature: (names, types, data, ignoreMethodHash)
      var decoded = tw.utils.abi.decodeParams([], types, '0x' + argsHex, false);
      var rows = inputs.map(function(input, i) {
        var v = decoded[i];
        return { name: input.name || ('arg' + i), type: input.type, display: formatArg(input.type, v, input.components) };
      });
      return { raw: decoded, rows: rows };
    } catch(_) {
      return null;
    }
  }

  function parseTransaction(tx) {
    var contract = null;
    if (tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0]) {
      contract = tx.raw_data.contract[0];
    }
    if (!contract) return null;

    var type = contract.type;
    var v = (contract.parameter && contract.parameter.value) || {};
    var info = { type: type, label: type, details: [] };

    switch (type) {
      case 'TransferContract':
        info.label = 'Transfer TRX';
        info.details = [
          { l: 'From', v: fromHexAddress(v.owner_address) },
          { l: 'To', v: fromHexAddress(v.to_address) },
          { l: 'Amount', v: fromSun(v.amount) }
        ];
        break;
      case 'TransferAssetContract':
        info.label = 'Transfer TRC10 Asset';
        info._trc10 = {
          assetName: fromHexString(v.asset_name),
          rawAmount: v.amount
        };
        info.details = [
          { l: 'From', v: fromHexAddress(v.owner_address) },
          { l: 'To', v: fromHexAddress(v.to_address) },
          { l: 'Asset ID', v: fromHexString(v.asset_name) },
          { l: 'Amount', v: 'Loading...' }
        ];
        break;
      case 'TriggerSmartContract': {
        var methodSig = v.data ? v.data.substring(0, 8) : '';
        if (methodSig === 'a9059cbb' && v.data && v.data.length >= 136) {
          var toHex = '41' + v.data.substring(32, 72);
          var amountHex = v.data.substring(72, 136);
          info.label = 'TRC20 Transfer';
          info._trc20 = {
            toHex: toHex,
            contractHex: v.contract_address,
            rawAmount: BigInt('0x' + amountHex).toString()
          };
          info.details = [
            { l: 'From', v: fromHexAddress(v.owner_address) },
            { l: 'To', v: fromHexAddress(toHex) },
            { l: 'Contract', v: fromHexAddress(v.contract_address) },
            { l: 'Amount', v: 'Loading...' }
          ];
        } else {
          // NOTE: 0x23b872dd 既是 TRC20 也是 TRC721 的 transferFrom(address,address,uint256)，
          // calldata 无法区分。统一走 KNOWN_METHODS 的 transferFrom 条目：第三个参数命名为
          // "amount"（对 TRC20 精确、对 NFT 其实是 tokenId，显示数字相同）。错标成 NFT 会
          // 在普通代币场景误导签名人，correctness 优先。
          var argsHex = v.data ? v.data.substring(8) : '';
          var known = KNOWN_METHODS[methodSig];
          var baseRows = [
            { l: 'From',       v: fromHexAddress(v.owner_address),   k: 'from' },
            { l: 'Contract',   v: fromHexAddress(v.contract_address),k: 'contract' },
            { l: 'Call Value', v: v.call_value ? fromSun(v.call_value) : '0 TRX', k: 'callValue' }
          ];

          if (known) {
            info.label = 'Contract Call: ' + known.name;
            var decoded = decodeCall(argsHex, known.inputs);
            baseRows.push({ l: 'Method', v: known.name, k: 'method' });
            if (decoded) {
              decoded.rows.forEach(function(arg, i) {
                baseRows.push({ l: arg.name, v: arg.display, k: 'arg-' + i });
              });
              info._contractCall = {
                contractHex: v.contract_address,
                selector: methodSig,
                argsHex: argsHex,
                resolved: true,
                rawArgs: decoded.raw,
                inputs: known.inputs,
                tokenAmounts: known.tokenAmounts
              };
            } else {
              baseRows.push({ l: 'Data', v: truncateMiddle('0x' + (v.data || ''), 120), k: 'data' });
            }
          } else {
            info.label = 'Contract Call';
            baseRows.push({ l: 'Method', v: methodSig ? '0x' + methodSig + ' · Loading ABI…' : '-', k: 'method' });
            baseRows.push({ l: 'Data',   v: truncateMiddle('0x' + (v.data || ''), 120), k: 'data' });
            info._contractCall = {
              contractHex: v.contract_address,
              selector: methodSig,
              argsHex: argsHex,
              resolved: false
            };
          }
          info.details = baseRows;
        }
        break;
      }
      case 'FreezeBalanceV2Contract':
        info.label = 'Stake TRX (Freeze v2)';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) },
          { l: 'Amount', v: fromSun(v.frozen_balance) },
          { l: 'Resource', v: getResourceName(v.resource) }
        ];
        break;
      case 'UnfreezeBalanceV2Contract':
        info.label = 'Unstake TRX (Unfreeze v2)';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) },
          { l: 'Amount', v: fromSun(v.unfreeze_balance) },
          { l: 'Resource', v: getResourceName(v.resource) }
        ];
        break;
      case 'DelegateResourceContract': {
        info.label = 'Delegate Resource';
        info.details = [
          { l: 'From', v: fromHexAddress(v.owner_address) },
          { l: 'To', v: fromHexAddress(v.receiver_address) },
          { l: 'Amount', v: fromSun(v.balance) },
          { l: 'Resource', v: getResourceName(v.resource) },
          { l: 'Lock', v: v.lock ? 'Yes' : 'No' }
        ];
        if (v.lock && v.lock_period) {
          var totalSeconds = v.lock_period * 3;
          var days = totalSeconds / 86400;
          var lockDisplay = days >= 1
            ? days.toFixed(1).replace(/\.0$/, '') + ' days'
            : (totalSeconds / 3600).toFixed(1).replace(/\.0$/, '') + ' hours';
          info.details.push({ l: 'Lock Period', v: lockDisplay });
        }
        break;
      }
      case 'UnDelegateResourceContract':
        info.label = 'Undelegate Resource';
        info.details = [
          { l: 'From', v: fromHexAddress(v.owner_address) },
          { l: 'Receiver', v: fromHexAddress(v.receiver_address) },
          { l: 'Amount', v: fromSun(v.balance) },
          { l: 'Resource', v: getResourceName(v.resource) }
        ];
        break;
      case 'WithdrawExpireUnfreezeContract':
        info.label = 'Withdraw Unfrozen TRX';
        info._withdrawOwner = fromHexAddress(v.owner_address);
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) },
          { l: 'Amount', v: 'Loading...' }
        ];
        break;
      case 'VoteWitnessContract':
        info.label = 'Vote for SR';
        info.details = [
          { l: 'Voter', v: fromHexAddress(v.owner_address) }
        ];
        if (v.votes && v.votes.length) {
          v.votes.forEach(function(vote, i) {
            info.details.push({ l: 'SR #' + (i+1), v: fromHexAddress(vote.vote_address) + ' (' + vote.vote_count + ')' });
          });
        }
        break;
      case 'WithdrawBalanceContract':
        info.label = 'Claim Rewards';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) }
        ];
        break;
      case 'CreateSmartContract':
        info.label = 'Deploy Contract';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) },
          { l: 'Name', v: (v.new_contract && v.new_contract.name) || '-' }
        ];
        break;
      case 'AccountCreateContract':
        info.label = 'Create Account';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) },
          { l: 'New Account', v: fromHexAddress(v.account_address) }
        ];
        break;
      case 'AccountUpdateContract':
        info.label = 'Update Account Name';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) },
          { l: 'Name', v: v.account_name || '-' }
        ];
        break;
      case 'AccountPermissionUpdateContract':
        info.label = 'Update Account Permission';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) }
        ];
        break;
      case 'CancelAllUnfreezeV2Contract':
        info.label = 'Cancel All Pending Unstake';
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) }
        ];
        break;
      default:
        info.details = [
          { l: 'Owner', v: fromHexAddress(v.owner_address) || '-' }
        ];
    }
    return info;
  }

  function updateRowByKey(detailsEl, key, text) {
    var row = detailsEl.querySelector('.detail-row[data-row-key="' + key + '"]');
    if (row) {
      var val = row.querySelector('.value');
      if (val) val.textContent = text;
    }
  }

  function updateLabelByKey(detailsEl, key, text) {
    var row = detailsEl.querySelector('.detail-row[data-row-key="' + key + '"]');
    if (row) {
      var l = row.querySelector('.label');
      if (l) l.textContent = text;
    }
  }

  function updateRowByLabel(detailsEl, label, text) {
    var rows = detailsEl.querySelectorAll('.detail-row');
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i].querySelector('.label');
      if (l && l.textContent === label) {
        var val = rows[i].querySelector('.value');
        if (val) val.textContent = text;
        return;
      }
    }
  }

  // Back-compat: existing TRC10/TRC20/withdraw flows target the Amount row by label.
  function updateAmountRow(detailsEl, text) {
    updateRowByLabel(detailsEl, 'Amount', text);
  }

  // isStale: optional () => boolean. When it returns true, the lookup must
  // not write to detailsEl — the user has switched to a different request
  // and the shared DOM now belongs to that request.
  function stale(isStale) { return typeof isStale === 'function' && isStale(); }

  async function fetchTrc20Info(trc20, detailsEl, isStale) {
    try {
      var tronWeb = window.TronWallet.getTronWeb();
      if (!tronWeb) {
        await window.TronWallet.waitForWallet(5000);
        tronWeb = window.TronWallet.getTronWeb();
      }
      if (!tronWeb) return;
      if (stale(isStale)) return;

      var addr = fromHexAddress(trc20.contractHex);
      var contract = await tronWeb.contract().at(addr);
      if (stale(isStale)) return;
      var decimals = 6;
      var symbol = '';
      try { decimals = Number(await contract.methods.decimals().call()); } catch(e) {}
      try { symbol = await contract.methods.symbol().call(); } catch(e) {}
      if (stale(isStale)) return;

      var raw = BigInt(trc20.rawAmount);
      var divisor = 10n ** BigInt(decimals);
      var whole = raw / divisor;
      var frac = raw % divisor;
      var formatted = whole.toString();
      if (frac > 0n) {
        var fracStr = frac.toString().padStart(Number(decimals), '0').replace(/0+$/, '');
        formatted += '.' + fracStr;
      }
      updateAmountRow(detailsEl, formatted + (symbol ? ' ' + symbol : ''));
    } catch(e) {
      if (stale(isStale)) return;
      updateAmountRow(detailsEl, trc20.rawAmount + ' (raw)');
    }
  }

  async function fetchWithdrawAmount(ownerAddress, detailsEl, isStale) {
    try {
      var tronWeb = window.TronWallet.getTronWeb();
      if (!tronWeb) {
        await window.TronWallet.waitForWallet(5000);
        tronWeb = window.TronWallet.getTronWeb();
      }
      if (!tronWeb) return;
      if (stale(isStale)) return;

      var account = await tronWeb.trx.getAccount(ownerAddress);
      if (stale(isStale)) return;
      var total = 0;
      var now = Date.now();
      if (account.unfrozenV2 && account.unfrozenV2.length) {
        account.unfrozenV2.forEach(function(item) {
          if (item.unfreeze_expire_time && item.unfreeze_expire_time <= now) {
            total += item.unfreeze_amount || 0;
          }
        });
      }
      updateAmountRow(detailsEl, fromSun(total));
    } catch(e) {
      if (stale(isStale)) return;
      updateAmountRow(detailsEl, 'Unable to fetch');
    }
  }

  async function fetchTrc10Info(trc10, detailsEl, fullHost, isStale) {
    try {
      var res = await fetch(fullHost + '/wallet/getassetissuebyid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: trc10.assetName })
      });
      if (stale(isStale)) return;
      var token = await res.json();
      if (stale(isStale)) return;
      var precision = token && token.precision ? token.precision : 0;
      var rawName = (token && token.abbr) || (token && token.name) || '';
      var name = '';
      if (rawName) {
        // API returns hex-encoded strings — decode if valid hex, fallback to raw if printable
        if (/^[0-9a-fA-F]+$/.test(rawName) && rawName.length % 2 === 0) {
          var decoded = fromHexString(rawName);
          if (/^[\x20-\x7E]+$/.test(decoded)) name = decoded;
        }
        if (!name && /^[\x20-\x7E]+$/.test(rawName)) name = rawName;
      }
      var raw = BigInt(trc10.rawAmount);
      if (precision > 0) {
        var divisor = 10n ** BigInt(precision);
        var whole = raw / divisor;
        var frac = raw % divisor;
        var formatted = whole.toString();
        if (frac > 0n) {
          var fracStr = frac.toString().padStart(precision, '0').replace(/0+$/, '');
          formatted += '.' + fracStr;
        }
        updateAmountRow(detailsEl, formatted + (name ? ' ' + name : ''));
      } else {
        updateAmountRow(detailsEl, raw.toString() + (name ? ' ' + name : ''));
      }
    } catch(e) {
      if (stale(isStale)) return;
      updateAmountRow(detailsEl, trc10.rawAmount + ' (raw)');
    }
  }

  // Pick token address for a tokenAmount entry. Returns hex (41...) or null.
  function tokenAddressForAmount(cc, entry) {
    if (!entry.pathArgIndex && entry.pathArgIndex !== 0) return cc.contractHex;
    var path = cc.rawArgs && cc.rawArgs[entry.pathArgIndex];
    if (!Array.isArray(path) || !path.length) return null;
    if (entry.pathPosition === 'last') return path[path.length - 1];
    return path[0];
  }

  // Probe the contract to classify it. decimals() is cheapest and conclusive for TRC20;
  // on failure we fall back to ERC165 supportsInterface(0x80ac58cd) for TRC721.
  // Returns one of: {kind:'trc20', decimals, symbol}, {kind:'trc721'}, {kind:'unknown'}.
  async function detectTokenKind(tronWeb, hexAddr) {
    var base58 = fromHexAddress(hexAddr);
    var contract = await tronWeb.contract().at(base58);
    try {
      var d = Number(await contract.methods.decimals().call());
      var symbol = '';
      try { symbol = await contract.methods.symbol().call(); } catch(_) {}
      return { kind: 'trc20', decimals: d, symbol: symbol };
    } catch(_) {}
    try {
      var isNft = await contract.methods.supportsInterface('0x80ac58cd').call();
      if (isNft) return { kind: 'trc721' };
    } catch(_) {}
    return { kind: 'unknown' };
  }

  function formatTokenAmount(raw, decimals, symbol) {
    var big = typeof raw === 'bigint' ? raw : BigInt(raw.toString());
    var divisor = 10n ** BigInt(decimals);
    var whole = big / divisor;
    var frac = big % divisor;
    var out = whole.toString();
    if (frac > 0n) {
      var fracStr = frac.toString().padStart(Number(decimals), '0').replace(/0+$/, '');
      if (fracStr) out += '.' + fracStr;
    }
    return out + (symbol ? ' ' + symbol : '');
  }

  async function fetchTrc20AmountForCall(cc, detailsEl, isStale) {
    if (!cc || !cc.tokenAmounts || !cc.tokenAmounts.length || !cc.rawArgs) return;
    try {
      var tronWeb = window.TronWallet.getTronWeb();
      if (!tronWeb) {
        await window.TronWallet.waitForWallet(5000);
        tronWeb = window.TronWallet.getTronWeb();
      }
      if (!tronWeb) return;
      if (stale(isStale)) return;

      // Cache per token address so we don't re-probe the same contract for swaps.
      var kindCache = {};
      var nftDetected = false;

      for (var i = 0; i < cc.tokenAmounts.length; i++) {
        var entry = cc.tokenAmounts[i];
        var tokenHex = tokenAddressForAmount(cc, entry);
        if (!tokenHex) continue;
        var rawVal = cc.rawArgs[entry.argIndex];
        if (rawVal === undefined || rawVal === null) continue;

        var info;
        try {
          if (kindCache[tokenHex]) info = kindCache[tokenHex];
          else info = kindCache[tokenHex] = await detectTokenKind(tronWeb, tokenHex);
        } catch(_) { continue; }
        if (stale(isStale)) return;

        if (info.kind === 'trc20') {
          try { updateRowByKey(detailsEl, 'arg-' + entry.argIndex, formatTokenAmount(rawVal, info.decimals, info.symbol)); } catch(_) {}
        } else if (info.kind === 'trc721' && cc.selector === '23b872dd' && entry.argIndex === 2) {
          // TRC721 transferFrom — the 3rd arg is tokenId, not a token amount.
          updateLabelByKey(detailsEl, 'arg-' + entry.argIndex, 'tokenId');
          nftDetected = true;
        }
        // 'unknown' or NFT outside the transferFrom tokenId slot: leave the raw uint display.
      }

      if (nftDetected) {
        updateRowByLabel(detailsEl, 'Type', 'NFT Transfer');
      }
    } catch(_) { /* silent — keep raw display */ }
  }

  // Compute the 4-byte selector for "name(canonicalTypes...)".
  // inputs must include `components` for tuple params so they expand correctly —
  // e.g. `foo((address,uint256))` not `foo(tuple)`.
  function selectorOf(name, inputs) {
    try {
      var tw = window.TronWallet.getTronWeb();
      if (!tw) return '';
      var types = (inputs || []).map(canonicalType);
      var sig = name + '(' + types.join(',') + ')';
      var hash;
      if (tw.utils && tw.utils.ethersUtils && tw.utils.ethersUtils.keccak256) {
        hash = tw.utils.ethersUtils.keccak256(tw.utils.ethersUtils.toUtf8Bytes(sig));
      } else if (tw.sha3) {
        hash = tw.sha3(sig);
      } else {
        return '';
      }
      hash = hash.indexOf('0x') === 0 ? hash.slice(2) : hash;
      return hash.slice(0, 8);
    } catch(_) { return ''; }
  }

  async function fetchContractCallAbi(cc, detailsEl, isStale) {
    if (!cc || cc.resolved) return;
    try {
      var tronWeb = window.TronWallet.getTronWeb();
      if (!tronWeb) {
        await window.TronWallet.waitForWallet(5000);
        tronWeb = window.TronWallet.getTronWeb();
      }
      if (!tronWeb) return;
      if (stale(isStale)) return;

      var base58 = fromHexAddress(cc.contractHex);
      var contractInfo = await tronWeb.trx.getContract(base58);
      if (stale(isStale)) return;
      var entrys = contractInfo && contractInfo.abi && contractInfo.abi.entrys;
      if (!Array.isArray(entrys)) throw new Error('no abi');

      var matched = null;
      for (var i = 0; i < entrys.length; i++) {
        var e = entrys[i];
        if (e.type !== 'Function') continue;
        if (selectorOf(e.name, e.inputs || []) === cc.selector) { matched = e; break; }
      }

      if (!matched) {
        updateRowByKey(detailsEl, 'method', '0x' + cc.selector + ' (unknown)');
        return;
      }

      var inputs = (matched.inputs || []).map(function(x) {
        return { name: x.name, type: x.type, components: x.components };
      });
      var decoded = decodeCall(cc.argsHex, inputs);
      if (!decoded) {
        updateRowByKey(detailsEl, 'method', matched.name + ' (decode failed)');
        return;
      }

      updateRowByKey(detailsEl, 'method', matched.name);
      var dataRow = detailsEl.querySelector('.detail-row[data-row-key="data"]');
      if (dataRow) dataRow.parentNode.removeChild(dataRow);
      decoded.rows.forEach(function(arg, idx) {
        var row = document.createElement('div');
        row.className = 'detail-row';
        row.setAttribute('data-row-key', 'arg-' + idx);
        row.innerHTML = '<span class="label"></span><span class="value"></span>';
        row.querySelector('.label').textContent = arg.name;
        row.querySelector('.value').textContent = arg.display;
        detailsEl.appendChild(row);
      });
    } catch(_) {
      if (stale(isStale)) return;
      updateRowByKey(detailsEl, 'method', '0x' + cc.selector + ' (ABI unavailable)');
    }
  }

  window.TxParser = {
    parseTransaction: parseTransaction,
    fetchTrc10Info: fetchTrc10Info,
    fetchTrc20Info: fetchTrc20Info,
    fetchWithdrawAmount: fetchWithdrawAmount,
    fetchTrc20AmountForCall: fetchTrc20AmountForCall,
    fetchContractCallAbi: fetchContractCallAbi
  };
})();
