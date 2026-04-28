import type { Server } from "node:http";
import type { MissionState } from "../mission.js";
import { buildRecoveredTaskSummary, flushPendingPersistence, forgetMission, recoverAgentTasks, updateMissionAgentState } from "../mission.js";
import type { TeamManager } from "../state.js";
import type { CodexClientManager } from "../codex-client.js";
import type { MessageSystem } from "../messages.js";
import type { Team } from "../types.js";
import { removeMissionState } from "./state-file.js";
import { removeWorktree } from "../worktree.js";

export interface RuntimeCleanupContext {
  mission: MissionState;
  team: Team;
  state: TeamManager;
  codex: CodexClientManager;
  messages: MessageSystem;
  httpServer?: Server;
}

const activeCleanupMissionIds = new Set<string>();
const completedCleanupMissionIds = new Set<string>();

export async function cleanupMissionRuntime(
  context: RuntimeCleanupContext,
  reason = "abnormal_exit",
): Promise<void> {
  const missionId = context.mission.id;
  if (completedCleanupMissionIds.has(missionId) || activeCleanupMissionIds.has(missionId)) return;
  activeCleanupMissionIds.add(missionId);

  const agentIds = [context.mission.leadId, ...context.mission.workerIds];

  try {
    for (const agentId of agentIds) {
      updateMissionAgentState(context.team.id, agentId, {
        lifecycle: "shutdown_requested",
        isActive: false,
        terminalReason: reason,
        terminationMode: "forced",
      });
    }

    const recovered = [] as ReturnType<typeof recoverAgentTasks>;
    for (const agentId of agentIds) {
      try {
        recovered.push(...recoverAgentTasks(context.team.id, agentId, "runtime_cleanup", context.state));
      } catch {}
    }

    if (recovered.length > 0) {
      context.messages.groupChatPost(
        context.team.id,
        "orchestrator",
        "system",
        buildRecoveredTaskSummary("runtime-cleanup", "runtime_cleanup", recovered),
      );
    }

    const aborted = context.codex.abortTeam(agentIds);
    for (const agentId of agentIds) {
      context.codex.clearLock(agentId);
      updateMissionAgentState(context.team.id, agentId, {
        lifecycle: "terminated",
        isActive: false,
        terminalReason: aborted.includes(agentId) ? reason : "grace_timeout",
        terminationMode: aborted.includes(agentId) ? "forced" : "grace_timeout",
      });
    }

    flushPendingPersistence(context.mission);

    for (const agent of context.team.agents.values()) {
      if (agent.worktreePath && agent.worktreeBranch && agent.worktreeGitRoot) {
        try { removeWorktree(agent.worktreePath, agent.worktreeBranch, agent.worktreeGitRoot); } catch {}
      }
    }

    for (const agentId of agentIds) {
      context.codex.cleanupAgent(agentId);
    }

    context.messages.dissolveTeamWithAgents(context.team.id, agentIds);
    try {
      context.state.dissolveTeam(context.team.id, { force: true });
    } catch {}

    forgetMission(context.mission.id);
    removeMissionState(context.mission.id);
    context.httpServer?.close();
    await context.codex.disconnect().catch(() => {});
    completedCleanupMissionIds.add(missionId);
  } finally {
    activeCleanupMissionIds.delete(missionId);
  }
}

export function installRuntimeCleanupHandlers(context: RuntimeCleanupContext): () => void {
  const listeners: Array<[NodeJS.Signals | "uncaughtException" | "unhandledRejection", (...args: unknown[]) => void]> = [];

  const register = <T extends NodeJS.Signals | "uncaughtException" | "unhandledRejection">(
    event: T,
    handler: (...args: unknown[]) => void,
  ) => {
    listeners.push([event, handler]);
    process.on(event, handler);
  };

  register("SIGINT", () => {
    void cleanupMissionRuntime(context, "signal_SIGINT").finally(() => process.exit(130));
  });
  register("SIGTERM", () => {
    void cleanupMissionRuntime(context, "signal_SIGTERM").finally(() => process.exit(143));
  });
  register("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    void cleanupMissionRuntime(context, "uncaught_exception").finally(() => process.exit(1));
  });
  register("unhandledRejection", (reason) => {
    console.error(reason);
    void cleanupMissionRuntime(context, "unhandled_rejection").finally(() => process.exit(1));
  });

  return () => {
    for (const [event, handler] of listeners) {
      process.off(event, handler);
    }
  };
}
