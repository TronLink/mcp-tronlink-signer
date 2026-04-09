# mcp-tronlink-signer

Monorepo containing a TronLink browser wallet signer SDK and its MCP Server wrapper.

## Packages

| Package | Description |
| ------- | ----------- |
| [tronlink-signer](./packages/tronlink-signer) | Standalone SDK for signing TRON transactions via TronLink browser wallet |
| [mcp-tronlink-signer](./packages/mcp-tronlink-signer) | MCP Server that exposes tronlink-signer as MCP tools |

## Features

- **connect_wallet** - Connect TronLink wallet
- **send_trx** - Send TRX with browser approval
- **send_trc20** - Send TRC20 tokens with browser approval
- **sign_message** - Sign messages via TronLink
- **sign_typed_data** - Sign EIP-712 typed data
- **sign_transaction** - Sign raw transactions (no broadcast)
- **get_balance** - Check TRX balance (no browser needed)

All signing tools support an optional `network` parameter (`mainnet` / `nile` / `shasta`), defaulting to `mainnet`.

## Usage

### As MCP Server (Claude Code)

```bash
claude mcp add -s user tronlink-signer -- node /path/to/packages/mcp-tronlink-signer/dist/cli.js
```

### As MCP Server (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "tronlink-signer": {
      "command": "node",
      "args": ["/path/to/packages/mcp-tronlink-signer/dist/cli.js"]
    }
  }
}
```

### As Standalone SDK

```ts
import { TronSigner } from "tronlink-signer";

const signer = new TronSigner();
await signer.start();

// No need to call connectWallet() first — each signing operation
// automatically handles wallet connection and network switching
// in a single approval page.
const { signature } = await signer.signMessage("hello world");
const { txId } = await signer.sendTrx("TXxx...", 1);
const { balance } = await signer.getBalance("TXxx..."); // No browser needed

// connectWallet() is available if you only need the address
const { address } = await signer.connectWallet();

await signer.stop();
```

### Environment Variables

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `TRON_NETWORK` | Default network (mainnet/nile/shasta) | mainnet |
| `TRON_HTTP_PORT` | Local HTTP server port | 3386 |
| `TRON_API_KEY` | TronGrid API key (optional) | - |

## How It Works

1. AI agent (or your code) calls a signing method (e.g., `signMessage`)
2. Local HTTP server starts on port 3386 and browser opens an approval page
3. Approval page discovers wallet via **TIP-6963** protocol (fallback to `window.tron` / `window.tronLink`)
4. Auto-unlocks wallet (`eth_requestAccounts`) and switches network (`wallet_switchEthereumChain`) if needed
5. User reviews the request and clicks Approve / Reject
6. TronLink extension handles signing in the browser
7. Result is returned to the caller

Private keys never leave the TronLink wallet.

### Network Selection

Each tool accepts an optional `network` parameter. If provided, the approval page will automatically prompt TronLink to switch to the specified network. If omitted, the default network (`mainnet`) is used.

```jsonc
sign_message({ message: "hello", network: "nile" })   // Use Nile testnet
sign_message({ message: "hello" })                     // Use default (mainnet)
```

### EIP-712 Typed Data Signing

```jsonc
sign_typed_data({
  typedData: {
    domain: { name: "MyDApp", version: "1", chainId: 728126428 },
    types: {
      Greeting: [{ name: "contents", type: "string" }]
    },
    primaryType: "Greeting",
    message: { contents: "Hello Tron!" }
  }
})
```

## Development

```bash
pnpm install
pnpm build        # Build all packages
pnpm typecheck    # Type check all packages
```

## Project Structure

```text
packages/
├── tronlink-signer/            # Standalone SDK (publishable to npm)
│   └── src/
│       ├── tron-signer.ts      # Core signing class
│       ├── pending-store.ts    # Async request queue
│       ├── http-server.ts      # Local HTTP server
│       ├── browser.ts          # Browser open helper
│       ├── config.ts           # Network config
│       ├── types.ts            # Type definitions
│       └── web/index.html      # Approval page SPA (TIP-6963)
└── mcp-tronlink-signer/        # MCP Server layer
    └── src/
        ├── server.ts           # MCP tools/resources/prompts
        ├── schemas.ts          # Zod validation schemas
        └── index.ts            # Entry point
```

## License

MIT License Copyright (c) 2026 TronLink
