import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";

export function registerResultTools(server: McpServer, state: TeamManager) {
  server.registerTool(
    "get_output",
    {
      description: "Get an agent's last output, status, and role",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        agentId: z.string().describe("Agent ID"),
      },
    },
    async ({ teamId, agentId }) => {
      try {
        const agent = state.getAgent(teamId, agentId);
        if (!agent) {
          return { isError: true, content: [{ type: "text" as const, text: `Agent not found: ${agentId}` }] };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { agentId: agent.id, role: agent.role, status: agent.status, output: agent.lastOutput },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`get_output error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
