import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";

export function registerAgentTools(server: McpServer, state: TeamManager) {
  server.registerTool(
    "add_agent",
    {
      description: "Add a new agent to an existing team",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        role: z.string().describe("Agent role/name"),
        specialization: z.string().optional().describe("Agent's area of expertise"),
        model: z.string().optional().describe("Model (default: gpt-5.3-codex)"),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional()
          .describe("Sandbox mode"),
        baseInstructions: z.string().optional().describe("System instructions"),
        cwd: z.string().optional().describe("Working directory"),
        approvalPolicy: z
          .enum(["untrusted", "on-request", "on-failure", "never"])
          .optional()
          .describe("Approval policy"),
        isLead: z
          .boolean()
          .optional()
          .describe("Team lead (xhigh reasoning). Defaults to false (high reasoning)."),
        reasoningEffort: z
          .enum(["xhigh", "high", "medium", "low", "minimal"])
          .optional()
          .describe("Reasoning effort level (default: xhigh for lead, high for workers)"),
      },
    },
    async ({ teamId, ...config }) => {
      try {
        const agent = state.addAgent(teamId, config);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: agent.id,
                  role: agent.role,
                  specialization: agent.specialization,
                  model: agent.model,
                  isLead: agent.isLead,
                  reasoningEffort: agent.reasoningEffort,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`add_agent error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "remove_agent",
    {
      description: "Remove an agent from a team",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        agentId: z.string().describe("Agent ID to remove"),
      },
    },
    async ({ teamId, agentId }) => {
      try {
        const success = state.removeAgent(teamId, agentId);
        if (!success) {
          return { isError: true, content: [{ type: "text" as const, text: `Agent not found: ${agentId}` }] };
        }
        return { content: [{ type: "text" as const, text: `Agent ${agentId} removed` }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`remove_agent error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "list_agents",
    {
      description: "List all agents in a team with their status",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
      },
    },
    async ({ teamId }) => {
      try {
        const agents = state.listAgents(teamId);
        const summary = agents.map((a) => ({
          id: a.id,
          role: a.role,
          status: a.status,
          model: a.model,
          hasActiveSession: a.threadId !== null,
          taskCount: a.tasks.length,
          lastOutput: a.lastOutput,
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`list_agents error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
