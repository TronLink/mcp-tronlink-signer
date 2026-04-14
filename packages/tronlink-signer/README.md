# tronlink-signer

Standalone SDK for signing TRON transactions via the TronLink browser wallet. Private keys never leave TronLink — all signing happens in the browser through a local approval page.

## Installation

```bash
npm install tronlink-signer
```

## Quick Start

```ts
import { TronSigner } from "tronlink-signer";

const signer = new TronSigner();
await signer.start();

const { address, network } = await signer.connectWallet();
const { txId } = await signer.sendTrx("TXxx...", 1);
const { balance } = await signer.getBalance("TXxx...");

await signer.stop();
```

## API

### `new TronSigner(config?: Partial<AppConfig>)`

Creates a new signer instance. If no config is provided, it reads from environment variables via `loadConfig()`.

### `signer.start(): Promise<void>`

Starts the local HTTP server for browser approval.

### `signer.stop(): Promise<void>`

Stops the server and clears all pending requests.

### `signer.getConfig(): AppConfig`

Returns the current configuration.

### `signer.connectWallet(network?: TronNetwork): Promise<{ address: string; network: string }>`

Opens the browser to connect TronLink and retrieve the wallet address and current network. If the wallet is already connected (same browser tab still open), auto-completes without user interaction.

### `signer.sendTrx(to, amount, network?): Promise<{ txId: string }>`

Sends TRX to a recipient address. Opens a browser approval page for the user to confirm.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `to` | `string` | Recipient Tron address (base58) |
| `amount` | `number` | Amount of TRX to send |
| `network` | `TronNetwork` | Optional network override |

### `signer.sendTrc20(contractAddress, to, amount, decimals?, network?): Promise<{ txId: string }>`

Sends TRC20 tokens. Opens a browser approval page.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `contractAddress` | `string` | TRC20 token contract address |
| `to` | `string` | Recipient Tron address (base58) |
| `amount` | `string` | Amount in token units (supports decimals, e.g., `"0.01"`) |
| `decimals` | `number` | Token decimals (default: 6) |
| `network` | `TronNetwork` | Optional network override |

### `signer.signMessage(message, network?): Promise<{ signature: string }>`

Signs a plain text message.

### `signer.signTypedData(typedData, network?): Promise<{ signature: string }>`

Signs EIP-712 typed data.

```ts
const { signature } = await signer.signTypedData({
  domain: { name: "MyDApp", version: "1", chainId: 728126428 },
  types: {
    Greeting: [{ name: "contents", type: "string" }],
  },
  primaryType: "Greeting",
  message: { contents: "Hello Tron!" },
});
```

### `signer.signTransaction(transaction, network?): Promise<{ signedTransaction: Record<string, unknown> }>`

Signs a raw transaction without broadcasting it.

### `signer.getBalance(address, network?): Promise<{ balance: string; balanceSun: number }>`

Gets TRX balance for an address. No browser approval needed.

## How It Works

1. Your code calls a signing method (e.g., `signMessage`)
2. A local HTTP server starts on port 3386 and a **single browser tab** opens the approval page
3. The approval page discovers the wallet via **TIP-6963** protocol (fallback to `window.tron`)
4. Auto-unlocks wallet and switches network if needed
5. For `connectWallet`, if the wallet is already connected, it auto-completes without user interaction
6. For signing/sending, the user reviews the transaction details and clicks Approve / Reject
7. The approval page parses transaction types (TRX transfer, TRC20, TRC721 NFT, stake, delegate, vote, etc.) into human-readable display
8. TronLink handles signing in the browser
9. The result is returned to your code — the page stays open and polls for the next request

All subsequent operations reuse the same browser tab. The page detects server disconnection via heartbeat and shows a session expired message. The local server binds to `127.0.0.1` only. If port 3386 is in use, it auto-increments. Requests timeout after 5 minutes. The server gracefully shuts down on process exit (SIGINT/SIGTERM).

## Networks

All signing methods accept an optional `network` parameter:

| Network | Full Host | Explorer |
| ------- | --------- | -------- |
| `mainnet` (default) | `https://api.trongrid.io` | `https://tronscan.org` |
| `nile` | `https://nile.trongrid.io` | `https://nile.tronscan.org` |
| `shasta` | `https://api.shasta.trongrid.io` | `https://shasta.tronscan.org` |

## Environment Variables

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `TRON_NETWORK` | Default network | `mainnet` |
| `TRON_HTTP_PORT` | Local HTTP server port | `3386` |
| `TRON_API_KEY` | TronGrid API key (optional) | - |

## Types

```ts
type TronNetwork = "mainnet" | "nile" | "shasta";

interface AppConfig {
  network: TronNetwork;
  httpPort: number;
  apiKey?: string;
}

interface NetworkConfig {
  name: string;
  fullHost: string;
  explorerUrl: string;
}
```

## Exports

```ts
// Class
export { TronSigner } from "./tron-signer.js";

// Config
export { NETWORKS, DEFAULT_HTTP_PORT, REQUEST_TIMEOUT_MS, loadConfig } from "./config.js";

// Types
export type {
  TronNetwork, NetworkConfig, AppConfig,
  PendingRequestType, PendingRequest,
  ConnectData, SendTrxData, SendTrc20Data,
  SignMessageData, SignTypedDataData, SignTransactionData,
} from "./types.js";
```

## License

MIT License Copyright (c) 2026 TronLink
