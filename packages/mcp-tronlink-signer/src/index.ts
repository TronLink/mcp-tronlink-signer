import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TronSigner } from "tronlink-signer";
import { createMcpServer } from "./server.js";

const SHUTDOWN_TIMEOUT_MS = 2_000;

export async function startServer(): Promise<void> {
  const signer = new TronSigner();
  await signer.start();

  const mcpServer = createMcpServer(signer);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.race([
      signer.stop().catch(() => undefined),
      new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
    ]);
    process.exit(code);
  };

  process.on("SIGINT", () => { void shutdown(0); });
  process.on("SIGTERM", () => { void shutdown(0); });
  // If the MCP host goes away (stdio EOF), exit so we don't linger as an
  // orphan holding the HTTP port.
  process.stdin.on("end", () => { void shutdown(0); });
  process.stdin.on("close", () => { void shutdown(0); });

  await mcpServer.connect(transport);
  console.error("MCP server running on stdio");
}
