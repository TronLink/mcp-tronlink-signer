// Transaction parsing and async data fetching
(function() {
  var RESOURCE_NAMES = { 0: 'Bandwidth', 'BANDWIDTH': 'Bandwidth', 1: 'Energy', 'ENERGY': 'Energy' };

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
    return (Number(sun) / 1e6) + ' TRX';
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
        } else if (methodSig === '23b872dd' && v.data && v.data.length >= 200) {
          // TRC721 transferFrom(address,address,uint256)
          var nftFrom = '41' + v.data.substring(32, 72);
          var nftTo = '41' + v.data.substring(96, 136);
          var tokenIdHex = v.data.substring(136, 200);
          var tokenId = BigInt('0x' + tokenIdHex).toString();
          info.label = 'TRC721 Transfer (NFT)';
          info.details = [
            { l: 'From', v: fromHexAddress(nftFrom) },
            { l: 'To', v: fromHexAddress(nftTo) },
            { l: 'Contract', v: fromHexAddress(v.contract_address) },
            { l: 'Token ID', v: tokenId }
          ];
        } else {
          var METHOD_NAMES = {
            '095ea7b3': 'approve',
            '70a08231': 'balanceOf',
            'dd62ed3e': 'allowance',
            '42842e0e': 'safeTransferFrom'
          };
          var methodName = METHOD_NAMES[methodSig];
          info.label = methodName ? 'Contract Call: ' + methodName : 'Contract Call';
          info.details = [
            { l: 'From', v: fromHexAddress(v.owner_address) },
            { l: 'Contract', v: fromHexAddress(v.contract_address) },
            { l: 'Call Value', v: v.call_value ? fromSun(v.call_value) : '0 TRX' },
            { l: 'Method', v: methodName || (methodSig ? '0x' + methodSig : '-') }
          ];
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
          var days = Math.round(v.lock_period * 3 / 86400);
          info.details.push({ l: 'Lock Period', v: days + ' days' });
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

  // Update an Amount row in the details UI
  function updateAmountRow(detailsEl, text) {
    var rows = detailsEl.querySelectorAll('.detail-row');
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i].querySelector('.label');
      if (label && label.textContent === 'Amount') {
        rows[i].querySelector('.value').textContent = text;
        return;
      }
    }
  }

  async function fetchTrc20Info(trc20, detailsEl) {
    try {
      var tronWeb = window.TronWallet.getTronWeb();
      if (!tronWeb) {
        await window.TronWallet.waitForWallet(5000);
        tronWeb = window.TronWallet.getTronWeb();
      }
      if (!tronWeb) return;

      var addr = fromHexAddress(trc20.contractHex);
      var contract = await tronWeb.contract().at(addr);
      var decimals = 6;
      var symbol = '';
      try { decimals = await contract.methods.decimals().call(); } catch(e) {}
      try { symbol = await contract.methods.symbol().call(); } catch(e) {}

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
      updateAmountRow(detailsEl, trc20.rawAmount + ' (raw)');
    }
  }

  async function fetchWithdrawAmount(ownerAddress, detailsEl) {
    try {
      var tronWeb = window.TronWallet.getTronWeb();
      if (!tronWeb) {
        await window.TronWallet.waitForWallet(5000);
        tronWeb = window.TronWallet.getTronWeb();
      }
      if (!tronWeb) return;

      var account = await tronWeb.trx.getAccount(ownerAddress);
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
      updateAmountRow(detailsEl, 'Unable to fetch');
    }
  }

  async function fetchTrc10Info(trc10, detailsEl, fullHost) {
    try {
      var res = await fetch(fullHost + '/wallet/getassetissuebyid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: trc10.assetName })
      });
      var token = await res.json();
      var precision = token && token.precision ? token.precision : 0;
      var name = (token && token.abbr) || (token && token.name) || '';
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
      updateAmountRow(detailsEl, trc10.rawAmount + ' (raw)');
    }
  }

  window.TxParser = {
    parseTransaction: parseTransaction,
    fetchTrc10Info: fetchTrc10Info,
    fetchTrc20Info: fetchTrc20Info,
    fetchWithdrawAmount: fetchWithdrawAmount
  };
})();
