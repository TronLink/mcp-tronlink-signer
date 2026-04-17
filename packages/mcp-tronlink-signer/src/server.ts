import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TronSigner, NETWORKS } from "tronlink-signer";
import {
  SendTrxSchema,
  SendTrc20Schema,
  SignMessageSchema,
  SignTypedDataSchema,
  SignTransactionSchema,
  ConnectWalletSchema,
  GetBalanceSchema,
} from "./schemas.js";

export function createMcpServer(signer: TronSigner): McpServer {
  const server = new McpServer({
    name: "mcp-tronlink-signer",
    version: "0.1.0",
  });

  const SIGN_NOTICE = "⚠️ ACTION REQUIRED: Please switch to your browser and approve/reject this request in the TronLink Signer page.";

  function signingResult(result: unknown) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result) },
      ],
    };
  }

  function signingError(e: unknown) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }

  // Tools

  server.tool(
    "connect_wallet",
    `Connect to TronLink wallet. ${SIGN_NOTICE}`,
    ConnectWalletSchema.shape,
    async ({ network }, extra) => {
      console.error(`\n🔔 [mcp-tronlink-signer] Waiting for wallet connection approval in browser...\n`);
      try {
        const result = await signer.connectWallet(network, { signal: extra.signal });
        return signingResult(result);
      } catch (e) {
        return signingError(e);
      }
    }
  );

  server.tool(
    "send_trx",
    `Send TRX to an address. ${SIGN_NOTICE}`,
    SendTrxSchema.shape,
    async ({ to, amount, network }, extra) => {
      console.error(`\n🔔 [mcp-tronlink-signer] Waiting for transaction approval in browser... (send ${amount} TRX to ${to})\n`);
      try {
        const result = await signer.sendTrx(to, amount, network, { signal: extra.signal });
        return signingResult(result);
      } catch (e) {
        return signingError(e);
      }
    }
  );

  server.tool(
    "send_trc20",
    `Send TRC20 tokens. ${SIGN_NOTICE}`,
    SendTrc20Schema.shape,
    async ({ contractAddress, to, amount, decimals, network }, extra) => {
      console.error(`\n🔔 [mcp-tronlink-signer] Waiting for TRC20 transfer approval in browser... (${amount} to ${to})\n`);
      try {
        const result = await signer.sendTrc20(contractAddress, to, amount, decimals, network, { signal: extra.signal });
        return signingResult(result);
      } catch (e) {
        return signingError(e);
      }
    }
  );

  server.tool(
    "sign_message",
    `Sign a message with the wallet. ${SIGN_NOTICE}`,
    SignMessageSchema.shape,
    async ({ message, network }, extra) => {
      console.error(`\n🔔 [mcp-tronlink-signer] Waiting for message signing approval in browser...\n`);
      try {
        const result = await signer.signMessage(message, network, { signal: extra.signal });
        return signingResult(result);
      } catch (e) {
        return signingError(e);
      }
    }
  );

  server.tool(
    "sign_typed_data",
    `Sign EIP-712 typed data. ${SIGN_NOTICE}`,
    SignTypedDataSchema.shape,
    async ({ typedData, network }, extra) => {
      console.error(`\n🔔 [mcp-tronlink-signer] Waiting for typed data signing approval in browser...\n`);
      try {
        const result = await signer.signTypedData(typedData, network, { signal: extra.signal });
        return signingResult(result);
      } catch (e) {
        return signingError(e);
      }
    }
  );

  server.tool(
    "sign_transaction",
    `Sign a raw transaction. ${SIGN_NOTICE}`,
    SignTransactionSchema.shape,
    async ({ transaction, broadcast, network }, extra) => {
      console.error(`\n🔔 [mcp-tronlink-signer] Waiting for transaction signing approval in browser...${broadcast ? ' (will broadcast)' : ''}\n`);
      try {
        const result = await signer.signTransaction(transaction, network, broadcast, { signal: extra.signal });
        return signingResult(result);
      } catch (e) {
        return signingError(e);
      }
    }
  );

  server.tool("get_balance", "Get TRX balance for an address", GetBalanceSchema.shape, async ({ address, network }) => {
    try {
      const result = await signer.getBalance(address, network);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  // Resources

  server.resource("networks", "wallet://networks", async () => ({
    contents: [{ uri: "wallet://networks", text: JSON.stringify(NETWORKS, null, 2) }],
  }));

  server.resource("config", "wallet://config", async () => ({
    contents: [{ uri: "wallet://config", text: JSON.stringify(signer.getConfig(), null, 2) }],
  }));

  // Prompts

  server.prompt("send-trx", "Guide for sending TRX", async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "I want to send TRX to another address. Please help me:\n1. First connect my wallet using connect_wallet\n2. Then use send_trx with the recipient address and amount\n3. A browser window will open for me to approve the transaction in TronLink",
        },
      },
    ],
  }));

  server.prompt("check-balance", "Guide for checking TRX balance", async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "I want to check the TRX balance of an address. Please use get_balance with the Tron address to retrieve the balance.",
        },
      },
    ],
  }));

  server.prompt("send-token", "Guide for sending TRC20 tokens", async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "I want to send TRC20 tokens. Please help me:\n1. First connect my wallet using connect_wallet\n2. Then use send_trc20 with the token contract address, recipient address, amount, and decimals\n3. A browser window will open for me to approve the transaction in TronLink",
        },
      },
    ],
  }));

  return server;
}
