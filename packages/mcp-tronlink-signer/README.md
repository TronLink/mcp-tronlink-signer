# mcp-tronlink-signer

MCP Server that exposes [tronlink-signer](https://github.com/TronLink/mcp-tronlink-signer/tree/main/packages/tronlink-signer) as MCP tools for Claude and other AI clients. Sign TRON transactions via TronLink browser wallet with user approval — private keys never leave the wallet.

## Setup

### Claude Code

```bash
claude mcp add -s user tronlink-signer -- npx mcp-tronlink-signer
```

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "tronlink-signer": {
      "command": "npx",
      "args": ["mcp-tronlink-signer"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/TronLink/mcp-tronlink-signer.git
cd mcp-tronlink-signer
pnpm install && pnpm build
```

Then point to the built CLI:

```bash
claude mcp add -s user tronlink-signer -- node /path/to/packages/mcp-tronlink-signer/dist/cli.js
```

## MCP Tools

| Tool | Description | Parameters |
| ---- | ----------- | ---------- |
| `connect_wallet` | Connect TronLink wallet | `network?` |
| `send_trx` | Send TRX to an address | `to`, `amount`, `network?` |
| `send_trc20` | Send TRC20 tokens | `contractAddress`, `to`, `amount`, `decimals?`, `network?` |
| `sign_message` | Sign a message | `message`, `network?` |
| `sign_typed_data` | Sign EIP-712 typed data | `typedData`, `network?` |
| `sign_transaction` | Sign a raw transaction (optionally broadcast) | `transaction`, `broadcast?`, `network?` |
| `get_balance` | Get TRX balance | `address`, `network?` |

All tools support an optional `network` parameter (`mainnet` / `nile` / `shasta`), defaulting to `mainnet`.

## MCP Resources

| URI | Description |
| --- | ----------- |
| `wallet://networks` | Available networks and their configurations |
| `wallet://config` | Current signer configuration |

## MCP Prompts

| Prompt | Description |
| ------ | ----------- |
| `send-trx` | Guided workflow for sending TRX |
| `check-balance` | Guided workflow for checking balance |
| `send-token` | Guided workflow for sending TRC20 tokens |

## How It Works

1. AI agent calls an MCP tool (e.g., `send_trx`) — a signing notice is shown in the CLI
2. The server delegates to `tronlink-signer`, which opens a **single browser tab** for approval (reuses existing tab if open)
3. The approval page discovers TronLink via **TIP-6963** protocol
4. Auto-unlocks wallet and switches network if needed
5. `connect_wallet` auto-completes if the wallet is already connected
6. Transaction details are parsed into human-readable format (TRX transfer, TRC20, TRC721 NFT, stake, delegate, vote, etc.)
7. User reviews and approves in the browser
8. TronLink signs the transaction — private keys never leave the wallet
9. Result is returned to the AI agent — the page stays open for the next operation

## Cancellation

All signing tools support MCP cancellation. If the AI client cancels a pending tool call (e.g., user presses Ctrl+C in Claude Code), the in-flight request is automatically aborted and the browser approval page is not opened for already-cancelled requests.

## Transaction Confirmation

When `sign_transaction` is called with `broadcast: true`, the server automatically polls for on-chain confirmation after broadcast and returns the execution status (`success` or `pending`). If the transaction fails on-chain (e.g., `OUT_OF_ENERGY`, Solidity revert), the error is returned to the AI agent with a decoded reason.

## Environment Variables

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `TRON_NETWORK` | Default network (mainnet/nile/shasta) | `mainnet` |
| `TRON_HTTP_PORT` | Local HTTP server port | `3386` |
| `TRON_API_KEY` | TronGrid API key (optional) | - |

## License

MIT License Copyright (c) 2026 TronLink
