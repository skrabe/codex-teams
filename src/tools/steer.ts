import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";
import type { CodexClientManager } from "../codex-client.js";
import type { MessageSystem } from "../messages.js";
import { toolError, toolJson } from "../tool-utils.js";

function buildSteerPrompt(directive: string): string {
  return `=== DIRECTION CHANGE FROM ORCHESTRATOR ===

Your previous task has been interrupted. Drop what you were doing and follow the new directive below.

=== NEW DIRECTIVE ===
${directive}

=== WHAT TO DO ===
1. Stop any current work immediately.
2. Read group_chat for context from the direction change.
3. Execute the new directive above.
4. Coordinate with teammates — they received the same redirect.`;
}

export function registerSteerTools(
  server: McpServer,
  state: TeamManager,
  codex: CodexClientManager,
  messages: MessageSystem,
) {
  server.registerTool(
    "steer_team",
    {
      description:
        "Interrupt agents in a team and redirect them with a new directive. " +
        "Aborts in-flight work, posts the direction change to group chat, and sends each agent the new directive. " +
        "If this team is part of a running mission, the mission may error since its agent calls will be interrupted.",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
        directive: z.string().describe("New directive for the agents"),
        agentIds: z.array(z.string()).optional().describe("Subset of agent IDs to steer (default: all)"),
      },
    },
    async ({ teamId, directive, agentIds }) => {
      const team = state.getTeam(teamId);
      if (!team) return toolError(`Team not found: ${teamId}`);

      const targets = agentIds
        ? agentIds.map((id) => team.agents.get(id)).filter(Boolean)
        : Array.from(team.agents.values());

      if (targets.length === 0) {
        return toolJson({ aborted: [], steered: [], failed: [] });
      }

      const targetIds = targets.map((a) => a!.id);
      const aborted = codex.abortTeam(targetIds);

      messages.groupChatPost(
        teamId,
        "orchestrator",
        "Orchestrator",
        `=== DIRECTION CHANGE ===\n${directive}`,
      );

      const steerPrompt = buildSteerPrompt(directive);

      const results = await Promise.allSettled(
        targets.map((agent) => codex.sendToAgent(agent!, steerPrompt)),
      );

      const steered: string[] = [];
      const failed: Array<{ agentId: string; error: string }> = [];

      results.forEach((r, i) => {
        const agentId = targets[i]!.id;
        if (r.status === "fulfilled") {
          steered.push(agentId);
        } else {
          failed.push({
            agentId,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      });

      return toolJson({ aborted, steered, failed });
    },
  );
}
