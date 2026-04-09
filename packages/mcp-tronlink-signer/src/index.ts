import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TronSigner } from "tronlink-signer";
import { createMcpServer } from "./server.js";

export async function startServer(): Promise<void> {
  const signer = new TronSigner();
  await signer.start();

  const mcpServer = createMcpServer(signer);
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await signer.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await signer.stop();
    process.exit(0);
  });

  await mcpServer.connect(transport);
  console.error("MCP server running on stdio");
}
