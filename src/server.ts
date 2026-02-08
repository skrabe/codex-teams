import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "./state.js";
import type { CodexClientManager } from "./codex-client.js";
import type { MessageSystem } from "./messages.js";
import { registerTeamTools } from "./tools/team.js";
import { registerAgentTools } from "./tools/agent.js";
import { registerCommunicationTools } from "./tools/communication.js";
import { registerTaskTools } from "./tools/task.js";
import { registerResultTools } from "./tools/results.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerMissionTools } from "./tools/mission.js";

export function createServer(
  state: TeamManager,
  codex: CodexClientManager,
  messages?: MessageSystem,
): McpServer {
  const server = new McpServer({
    name: "codex-teams",
    version: "2.0.0",
  });

  registerTeamTools(server, state, messages);
  registerAgentTools(server, state);
  registerCommunicationTools(server, state, codex);
  registerTaskTools(server, state, codex);
  registerResultTools(server, state);

  if (messages) {
    registerDispatchTools(server, state, codex, messages);
    registerMissionTools(server, state, codex, messages);
  }

  return server;
}
