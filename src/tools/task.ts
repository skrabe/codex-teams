import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";
import type { CodexClientManager } from "../codex-client.js";

export function registerTaskTools(server: McpServer, state: TeamManager, codex: CodexClientManager) {
  server.registerTool(
    "assign_task",
    {
      description: "Assign a task to an agent. Auto-starts if no pending dependencies.",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        agentId: z.string().describe("Agent ID to assign task to"),
        description: z.string().describe("Task description"),
        dependencies: z
          .array(z.string())
          .optional()
          .describe("Task IDs that must complete before this task starts"),
      },
    },
    async ({ teamId, agentId, description, dependencies }) => {
      try {
        const task = state.createTask(teamId, agentId, description, dependencies);

        const hasUnmetDeps =
          dependencies &&
          dependencies.length > 0 &&
          dependencies.some((depId) => {
            const team = state.getTeam(teamId)!;
            const dep = team.tasks.get(depId);
            return !dep || dep.status !== "completed";
          });

        if (!hasUnmetDeps) {
          const agent = state.getAgent(teamId, agentId);
          if (agent && agent.status !== "working") {
            task.status = "in-progress";
            try {
              await codex.sendToAgent(agent, description);
            } catch {
              task.status = "pending";
            }
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  taskId: task.id,
                  assignedTo: task.assignedTo,
                  status: task.status,
                  hasPendingDependencies: !!hasUnmetDeps,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`assign_task error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "task_status",
    {
      description: "Get status of all tasks in a team",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
      },
    },
    async ({ teamId }) => {
      try {
        const tasks = state.listTasks(teamId);
        const summary = tasks.map((t) => ({
          id: t.id,
          description: t.description,
          status: t.status,
          assignedTo: t.assignedTo,
          dependencies: t.dependencies,
          result: t.result ?? undefined,
          createdAt: t.createdAt.toISOString(),
          completedAt: t.completedAt?.toISOString(),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`task_status error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task as completed. Auto-triggers any dependent tasks that become unblocked.",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        taskId: z.string().describe("Task ID to complete"),
        result: z.string().optional().describe("Task result (defaults to agent's last output)"),
      },
    },
    async ({ teamId, taskId, result }) => {
      try {
        const team = state.getTeam(teamId);
        if (!team) {
          return { isError: true, content: [{ type: "text" as const, text: `Team not found: ${teamId}` }] };
        }

        const task = team.tasks.get(taskId);
        if (!task) {
          return { isError: true, content: [{ type: "text" as const, text: `Task not found: ${taskId}` }] };
        }

        const taskResult = result ?? state.getAgent(teamId, task.assignedTo)?.lastOutput ?? "";

        const unblockedIds = state.completeTask(teamId, taskId, taskResult);

        const triggeredTasks: Array<{ taskId: string; agentId: string; description: string }> = [];
        for (const unblockedId of unblockedIds) {
          const unblockedTask = team.tasks.get(unblockedId);
          if (!unblockedTask) continue;

          const agent = state.getAgent(teamId, unblockedTask.assignedTo);
          if (agent && agent.status !== "working") {
            unblockedTask.status = "in-progress";
            triggeredTasks.push({
              taskId: unblockedId,
              agentId: agent.id,
              description: unblockedTask.description,
            });
            const op = codex.sendToAgent(agent, unblockedTask.description).catch((err) => {
              console.error(`Failed to trigger unblocked task ${unblockedId}: ${err}`);
              unblockedTask.status = "pending";
            });
            codex.trackOp(op);
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  completed: taskId,
                  result: taskResult,
                  triggeredTasks,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`complete_task error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
