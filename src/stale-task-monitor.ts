import type { TeamManager } from "./state.js";
import type { MessageSystem } from "./messages.js";
import { syncMissionControlPlaneState } from "./mission.js";

export interface StaleTaskMonitorOptions {
  teamId: string;
  thresholdMs: number;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class StaleTaskMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private teamId: string;
  private thresholdMs: number;
  private intervalMs: number;

  constructor(
    private state: TeamManager,
    private messages: MessageSystem,
  ) {
    this.teamId = "";
    this.thresholdMs = 0;
    this.intervalMs = DEFAULT_INTERVAL_MS;
  }

  start(options: StaleTaskMonitorOptions): void {
    this.stop();
    this.teamId = options.teamId;
    this.thresholdMs = options.thresholdMs;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick(): void {
    const team = this.state.getTeam(this.teamId);
    if (!team) return;

    const lead = Array.from(team.agents.values()).find((a) => a.isLead);
    const now = Date.now();
    const staleTasks: Array<{ id: string; subject: string; owner: string }> = [];

    for (const task of team.tasks.values()) {
      if (task.status !== "in-progress" || !task.owner) continue;
      if (lead && task.owner === lead.id) continue;
      if (now - task.updatedAt.getTime() > this.thresholdMs) {
        staleTasks.push({ id: task.id, subject: task.subject, owner: task.owner });
      }
    }

    if (staleTasks.length === 0) return;

    for (const stale of staleTasks) {
      this.state.resetTask(this.teamId, stale.id);
    }

    const taskList = staleTasks.map((t) => `#${t.id} "${t.subject}" (was ${t.owner})`).join(", ");
    this.messages.groupChatPost(
      this.teamId,
      "orchestrator",
      "system",
      `Stale task auto-reassign: ${staleTasks.length} task(s) reset to pending after ${Math.round(this.thresholdMs / 60_000)}min idle: ${taskList}. Use task_list() to claim them.`,
    );

    if (lead) {
      this.messages.protocolSend("orchestrator", lead.id, "task_assignment", {
        action: "stale_reassign",
        tasks: staleTasks.map((t) => ({ id: t.id, subject: t.subject, previousOwner: t.owner })),
      });
      syncMissionControlPlaneState(this.teamId, lead.id, this.messages);
    }
  }
}
