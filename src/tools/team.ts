import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";
import type { MessageSystem } from "../messages.js";

export function registerTeamTools(server: McpServer, state: TeamManager, messages?: MessageSystem) {
  server.registerTool(
    "create_team",
    {
      description: "Create a new team with agents",
      inputSchema: {
        name: z.string().describe("Team name"),
        agents: z
          .array(
            z.object({
              role: z.string().describe("Agent role/name (e.g. architect, frontend-dev, api-dev)"),
              specialization: z
                .string()
                .optional()
                .describe(
                  "Agent's area of expertise (e.g. 'React/TypeScript frontend components', 'PostgreSQL database design and optimization')",
                ),
              model: z.string().optional().describe("Model (default: gpt-5.3-codex)"),
              sandbox: z
                .enum(["read-only", "workspace-write", "danger-full-access"])
                .optional()
                .describe("Sandbox mode (default: workspace-write)"),
              baseInstructions: z.string().optional().describe("System instructions for agent"),
              cwd: z.string().optional().describe("Working directory"),
              approvalPolicy: z
                .enum(["untrusted", "on-request", "on-failure", "never"])
                .optional()
                .describe("Approval policy (default: never)"),
              isLead: z
                .boolean()
                .optional()
                .describe("Team lead (xhigh reasoning). Defaults to false (high reasoning)."),
              reasoningEffort: z
                .enum(["xhigh", "high", "medium", "low", "minimal"])
                .optional()
                .describe("Reasoning effort level (default: xhigh for lead, high for workers)"),
            }),
          )
          .describe("Agent configurations"),
      },
    },
    async ({ name, agents: agentConfigs }) => {
      try {
        const team = state.createTeam(name, agentConfigs);
        const agentList = Array.from(team.agents.values()).map((a) => ({
          id: a.id,
          role: a.role,
          specialization: a.specialization,
          model: a.model,
          isLead: a.isLead,
          reasoningEffort: a.reasoningEffort,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ teamId: team.id, name: team.name, agents: agentList }, null, 2),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`create_team error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "dissolve_team",
    {
      description: "Dissolve a team and all its agents",
      inputSchema: {
        teamId: z.string().describe("Team ID to dissolve"),
      },
    },
    async ({ teamId }) => {
      try {
        const team = state.getTeam(teamId);
        if (!team) {
          return { isError: true, content: [{ type: "text" as const, text: `Team not found: ${teamId}` }] };
        }

        if (messages) {
          const agentIds = Array.from(team.agents.keys());
          messages.dissolveTeamWithAgents(teamId, agentIds);
        }

        state.dissolveTeam(teamId);
        return { content: [{ type: "text" as const, text: `Team ${teamId} dissolved` }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`dissolve_team error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
