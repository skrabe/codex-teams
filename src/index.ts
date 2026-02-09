#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TeamManager } from "./state.js";
import { CodexClientManager } from "./codex-client.js";
import { MessageSystem } from "./messages.js";
import { startCommsServer } from "./comms-server.js";
import { createServer } from "./server.js";

async function main() {
  const state = new TeamManager();
  const messages = new MessageSystem();
  const codex = new CodexClientManager();

  await codex.connect();

  const { httpServer, port } = await startCommsServer(messages, state, codex);
  codex.setCommsPort(port);
  codex.setStateManager(state);

  const server = createServer(state, codex, messages);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("codex-teams: MCP server ready (v2)");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("codex-teams: shutting down...");
    httpServer.close();
    await codex.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.on("exit", () => {
    httpServer.close();
  });

  process.on("unhandledRejection", (reason) => {
    console.error("codex-teams: unhandled rejection:", reason);
  });
}

main().catch((error) => {
  console.error("codex-teams: fatal error:", error);
  process.exit(1);
});
