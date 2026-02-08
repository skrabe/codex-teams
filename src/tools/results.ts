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

  server.registerTool(
    "get_team_report",
    {
      description: "Get a full team report: all agents with status and task summary",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
      },
    },
    async ({ teamId }) => {
      try {
        const team = state.getTeam(teamId);
        if (!team) {
          return { isError: true, content: [{ type: "text" as const, text: `Team not found: ${teamId}` }] };
        }

        const agents = Array.from(team.agents.values()).map((a) => ({
          id: a.id,
          role: a.role,
          status: a.status,
          model: a.model,
          hasActiveSession: a.threadId !== null,
          lastOutput: a.lastOutput,
        }));

        const tasks = Array.from(team.tasks.values());
        const taskSummary = {
          total: tasks.length,
          pending: tasks.filter((t) => t.status === "pending").length,
          inProgress: tasks.filter((t) => t.status === "in-progress").length,
          completed: tasks.filter((t) => t.status === "completed").length,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ teamId: team.id, name: team.name, agents, taskSummary }, null, 2),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`get_team_report error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
