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

  server.registerTool(
    "relay",
    {
      description: "Relay one agent's last output to another agent (or all agents)",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        fromAgentId: z.string().describe("Source agent ID (relay their last output)"),
        toAgentId: z.string().optional().describe("Target agent ID"),
        toAll: z.boolean().optional().describe("Relay to all other agents"),
        prefix: z.string().optional().describe("Prefix to prepend to relayed message"),
      },
    },
    async ({ teamId, fromAgentId, toAgentId, toAll, prefix }) => {
      try {
        const team = state.getTeam(teamId);
        if (!team) {
          return { isError: true, content: [{ type: "text" as const, text: `Team not found: ${teamId}` }] };
        }

        const fromAgent = team.agents.get(fromAgentId);
        if (!fromAgent) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Source agent not found: ${fromAgentId}` }],
          };
        }

        if (!fromAgent.lastOutput) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Agent ${fromAgentId} has no output to relay` }],
          };
        }

        if (!toAgentId && !toAll) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Must specify either toAgentId or toAll" }],
          };
        }

        const relayMessage = prefix ? `${prefix}\n\n${fromAgent.lastOutput}` : fromAgent.lastOutput;

        if (toAgentId) {
          const target = team.agents.get(toAgentId);
          if (!target) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Target agent not found: ${toAgentId}` }],
            };
          }
          if (target.status === "working") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Agent ${toAgentId} is currently working` }],
            };
          }
          const output = await codex.sendToAgent(target, relayMessage);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ relayedTo: target.id, role: target.role, output }, null, 2),
              },
            ],
          };
        }

        const targets = Array.from(team.agents.values()).filter(
          (a) => a.id !== fromAgentId && a.status !== "working",
        );

        const results = await Promise.allSettled(
          targets.map(async (agent) => {
            const output = await codex.sendToAgent(agent, relayMessage);
            return { agentId: agent.id, role: agent.role, output };
          }),
        );

        const summary = results.map((r, i) => {
          if (r.status === "fulfilled") return { ...r.value, status: "success" };
          return {
            agentId: targets[i].id,
            role: targets[i].role,
            status: "error",
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          };
        });

        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`relay error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
