import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";
import type { CodexClientManager } from "../codex-client.js";
import type { MessageSystem } from "../messages.js";
import { withTimeout, WORKER_TIMEOUT_MS } from "../tool-utils.js";

export function registerDispatchTools(
  server: McpServer,
  state: TeamManager,
  codex: CodexClientManager,
  messages: MessageSystem,
) {
  server.registerTool(
    "dispatch_team",
    {
      description:
        "Create a team, dispatch tasks to all agents in parallel, collect results, dissolve team. Fire-and-forget parallel execution.",
      inputSchema: {
        name: z.string().describe("Team name"),
        workDir: z.string().describe("Working directory for all agents"),
        agents: z
          .array(
            z.object({
              role: z.string().describe("Agent role"),
              specialization: z.string().optional().describe("Agent specialization"),
              isLead: z.boolean().optional().describe("Is this the team lead?"),
              task: z.string().describe("Task for this agent to execute"),
              sandbox: z
                .enum(["read-only", "workspace-write", "danger-full-access"])
                .optional()
                .describe("Sandbox mode"),
              reasoningEffort: z
                .enum(["xhigh", "high", "medium", "low", "minimal"])
                .optional()
                .describe("Reasoning effort level (default: xhigh for lead, high for workers)"),
            }),
          )
          .describe("Agent configs with their tasks"),
      },
    },
    async ({ name, workDir, agents: agentConfigs }) => {
      let team: ReturnType<typeof state.createTeam> | undefined;
      try {
        team = state.createTeam(
          name,
          agentConfigs.map((a) => ({
            role: a.role,
            specialization: a.specialization,
            isLead: a.isLead,
            sandbox: a.sandbox,
            reasoningEffort: a.reasoningEffort,
            cwd: workDir,
          })),
        );

        const agentList = Array.from(team.agents.values());
        const tasks = agentConfigs.map((ac) => ac.task);

        const results = await Promise.allSettled(
          agentList.map((agent, i) =>
            withTimeout((signal) => codex.sendToAgent(agent, tasks[i], signal), WORKER_TIMEOUT_MS, `Agent ${agent.id}`),
          ),
        );

        const report = agentList.map((agent, i) => {
          const r = results[i];
          return {
            agentId: agent.id,
            role: agent.role,
            status: r.status === "fulfilled" ? "success" : "error",
            output:
              r.status === "fulfilled"
                ? r.value
                : r.reason instanceof Error
                  ? r.reason.message
                  : String(r.reason),
          };
        });

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ teamName: name, results: report }, null, 2) },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`dispatch_team error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      } finally {
        if (team) {
          const agentIds = Array.from(team.agents.values()).map((a) => a.id);
          messages.dissolveTeamWithAgents(team.id, agentIds);
          state.dissolveTeam(team.id);
        }
      }
    },
  );
}
