// Execute wallet actions (sign, send, connect)
(function() {
  async function executeTronAction(req) {
    await window.TronWallet.ensureConnected();
    var tronWeb = window.TronWallet.getTronWeb();
    var data = req.data || {};

    switch (req.type) {
      case 'connect': {
        return { address: tronWeb.defaultAddress.base58, network: window.TronWallet.getCurrentNetwork() };
      }
      case 'send_trx': {
        var trxStr = String(data.amount).trim();
        if (!/^\d+(\.\d+)?$/.test(trxStr)) {
          throw new Error('Invalid TRX amount: ' + data.amount);
        }
        var trxParts = trxStr.split('.');
        var trxWhole = trxParts[0] || '0';
        var trxFracInput = trxParts[1] || '';
        if (trxFracInput.length > 6) {
          throw new Error('TRX has max 6 decimals, got: ' + data.amount);
        }
        var trxFrac = trxFracInput.padEnd(6, '0');
        var sun = BigInt(trxWhole) * 1000000n + BigInt(trxFrac || '0');
        if (sun === 0n) {
          throw new Error('TRX amount is zero: ' + data.amount);
        }
        var tx = await tronWeb.transactionBuilder.sendTrx(data.to, sun.toString());
        var signedTx = await tronWeb.trx.sign(tx);
        var broadcast = await tronWeb.trx.sendRawTransaction(signedTx);
        if (broadcast.result === false) {
          throw new Error('Broadcast failed: ' + (broadcast.message || broadcast.code || 'unknown error'));
        }
        return { txId: broadcast.txid };
      }
      case 'send_trc20': {
        var contract = await tronWeb.contract().at(data.contractAddress);
        var decimals = (data.decimals !== undefined && data.decimals !== null) ? data.decimals : 6;
        var amountStr = String(data.amount).trim();
        if (!/^\d+(\.\d+)?$/.test(amountStr)) {
          throw new Error('Invalid amount format: ' + data.amount);
        }
        var parts = amountStr.split('.');
        var whole = parts[0] || '0';
        var fracInput = parts[1] || '';
        if (fracInput.length > decimals) {
          throw new Error('Amount has too many decimal places (max ' + decimals + ' for this token). Got: ' + data.amount);
        }
        if (decimals > 18) {
          throw new Error('Decimals too large (max 18). Got: ' + decimals);
        }
        var frac = decimals > 0 ? fracInput.padEnd(decimals, '0') : '';
        var multiplier = 10n ** BigInt(decimals);
        var rawAmount = decimals > 0
          ? BigInt(whole) * multiplier + BigInt(frac)
          : BigInt(whole);
        if (rawAmount === 0n) {
          throw new Error('Amount is zero after conversion. Please check the amount: ' + data.amount);
        }
        var txId = await contract.methods.transfer(data.to, rawAmount.toString()).send();
        return { txId: txId };
      }
      case 'sign_message': {
        var signature = await tronWeb.trx.signMessageV2(data.message);
        return { signature: signature };
      }
      case 'sign_typed_data': {
        var typedData = data.typedData;
        var domain = typedData.domain;
        var types = Object.assign({}, typedData.types);
        delete types.EIP712Domain;
        var message = typedData.message;
        var sig = await tronWeb.trx._signTypedData(domain, types, message);
        return { signature: sig };
      }
      case 'sign_transaction': {
        var signed = await tronWeb.trx.sign(data.transaction);
        if (data.broadcast) {
          var broadcast = await tronWeb.trx.sendRawTransaction(signed);
          if (broadcast.result === false) {
            throw new Error('Broadcast failed: ' + (broadcast.message || broadcast.code || 'unknown error'));
          }
          return { signedTransaction: signed, txId: broadcast.txid };
        }
        return { signedTransaction: signed };
      }
      default:
        throw new Error('Unknown request type: ' + req.type);
    }
  }

  window.TronActions = {
    execute: executeTronAction
  };
})();
