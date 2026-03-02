import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";
import type { CodexClientManager } from "../codex-client.js";

export function registerCommunicationTools(server: McpServer, state: TeamManager, codex: CodexClientManager) {
  server.registerTool(
    "send_message",
    {
      description: "Send a message to an agent and get their response",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        agentId: z.string().describe("Agent ID"),
        message: z.string().describe("Message to send"),
      },
    },
    async ({ teamId, agentId, message }) => {
      try {
        const agent = state.getAgent(teamId, agentId);
        if (!agent) {
          return { isError: true, content: [{ type: "text" as const, text: `Agent not found: ${agentId}` }] };
        }
        if (agent.status === "working") {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Agent ${agentId} is currently working. Wait for it to finish.`,
              },
            ],
          };
        }

        const output = await codex.sendToAgent(agent, message);
        return { content: [{ type: "text" as const, text: output }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`send_message error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "broadcast",
    {
      description: "Broadcast a message to all (or a subset of) agents in parallel",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        message: z.string().describe("Message to broadcast"),
        agentIds: z.array(z.string()).optional().describe("Subset of agent IDs (default: all)"),
      },
    },
    async ({ teamId, message, agentIds }) => {
      try {
        const team = state.getTeam(teamId);
        if (!team) {
          return { isError: true, content: [{ type: "text" as const, text: `Team not found: ${teamId}` }] };
        }

        const targets = agentIds
          ? agentIds.map((id) => team.agents.get(id)).filter(Boolean)
          : Array.from(team.agents.values());

        const available = targets.filter((a) => a!.status !== "working");

        const results = await Promise.allSettled(
          available.map(async (agent) => {
            const output = await codex.sendToAgent(agent!, message);
            return { agentId: agent!.id, role: agent!.role, status: "success" as const, output };
          }),
        );

        const summary = results.map((r, i) => {
          if (r.status === "fulfilled") return r.value;
          return {
            agentId: available[i]!.id,
            role: available[i]!.role,
            status: "error" as const,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          };
        });

        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`broadcast error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
