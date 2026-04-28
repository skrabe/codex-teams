import type { Agent, Team } from "./types.js";
import type { ProtocolMessage, MessageSystem } from "./messages.js";
import type { CodexClientManager } from "./codex-client.js";
import type { TeamManager } from "./state.js";
import type { AgentRecoveryReason, MissionState, TaskRecoveryCause, WorkerResult } from "./mission.js";
import { buildContinuationPrompt, buildRecoveredTaskSummary, buildWorkerPrompt, recoverAgentTasks } from "./mission.js";
import { syncMissionAgentState, syncMissionControlPlaneState, updateMissionAgentState } from "./mission.js";
import { TaskStore } from "./task-store.js";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 2;
const DEFAULT_IDLE_RECHECK_DELAY_MS = 5_000;
const DEFAULT_MAX_IDLE_RECHECKS = 3;
const MAX_IDLE_SUMMARY_CHARS = 280;

const TURN_INTERRUPTED_ERROR = "__worker_turn_interrupted__";
const LIFECYCLE_ABORTED_ERROR = "__worker_lifecycle_aborted__";

type WorkerRuntimePhase = "running_turn" | "idle_waiting" | "shutdown_requested" | "recovering" | "terminated";
type WorkerContinuationReason = "tasks_available" | "recovery" | "lead_message" | "peer_message" | "interrupted";
type IdleAvailability = "available" | "blocked" | "interrupted";

interface WorkerIdleSnapshot {
  availability: Exclude<IdleAvailability, "interrupted">;
  activeTaskId?: string;
  activeTaskSubject?: string;
  lastCompletedTaskId?: string;
  lastCompletedTaskSubject?: string;
}

type NextWorkerAction =
  | { type: "shutdown"; trigger: ProtocolMessage | null }
  | { type: "continue"; reason: WorkerContinuationReason; trigger?: ProtocolMessage }
  | { type: "wait" };

export interface WorkerLoopConfig {
  worker: Agent;
  mission: MissionState;
  team: Team;
  codex: CodexClientManager;
  state: TeamManager;
  messages: MessageSystem;
  signal?: AbortSignal;
  turnInterruptSignal?: AbortSignal;
  heartbeatTimeoutMs?: number;
  maxRecoveryAttempts?: number;
  taskStoreRoot?: string;
  idleRecheckDelayMs?: number;
  maxIdleRechecks?: number;
}

function hasRemainingWork(taskListId: string, workerId: string, taskStoreRoot?: string): boolean {
  const store = new TaskStore(taskListId, taskStoreRoot);
  if (!store.exists()) return false;
  const tasks = store.listTasks();
  const unresolvedIds = new Set(
    tasks.filter((t) => t.status !== "completed").map((t) => t.id),
  );
  return tasks.some(
    (t) =>
      (t.status === "pending" && t.blockedBy.every((id) => !unresolvedIds.has(id))) ||
      (t.status === "in-progress" && t.owner === workerId),
  );
}

function snapshotIdleState(taskListId: string, workerId: string, taskStoreRoot?: string): WorkerIdleSnapshot {
  const store = new TaskStore(taskListId, taskStoreRoot);
  if (!store.exists()) return { availability: "blocked" };

  const tasks = store.listTasks();
  const unresolvedIds = new Set(
    tasks.filter((t) => t.status !== "completed").map((t) => t.id),
  );

  const active = tasks.find((task) => task.owner === workerId && task.status === "in-progress");
  const hasClaimablePending = tasks.some(
    (task) => task.status === "pending" && task.blockedBy.every((dependencyId) => !unresolvedIds.has(dependencyId)),
  );

  const completedByWorker = tasks
    .filter((task) => task.owner === workerId && task.status === "completed" && task.completedAt)
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0));
  const lastCompleted = completedByWorker[0];

  return {
    availability: hasClaimablePending ? "available" : "blocked",
    activeTaskId: active?.id,
    activeTaskSubject: active?.subject,
    lastCompletedTaskId: lastCompleted?.id,
    lastCompletedTaskSubject: lastCompleted?.subject,
  };
}

function summarizeOutput(output: string): string | undefined {
  const compact = output.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= MAX_IDLE_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_IDLE_SUMMARY_CHARS - 3)}...`;
}

function publishIdleTransition(
  mission: MissionState,
  team: Team,
  worker: Agent,
  messages: MessageSystem,
  taskStoreRoot: string | undefined,
  output: string,
  availabilityOverride?: IdleAvailability,
): void {
  const idle = snapshotIdleState(mission.taskListId, worker.id, taskStoreRoot);
  const availability = availabilityOverride ?? idle.availability;
  const lastPeerDmSummary = messages.getLastPeerDmSummary(worker.id, mission.leadId);
  messages.protocolSend(worker.id, mission.leadId, "idle_notification", {
    workerId: worker.id,
    availability,
    summary: lastPeerDmSummary ?? summarizeOutput(output),
    activeTaskId: idle.activeTaskId,
    activeTaskSubject: idle.activeTaskSubject,
    lastCompletedTaskId: idle.lastCompletedTaskId,
    lastCompletedTaskSubject: idle.lastCompletedTaskSubject,
    emittedAt: new Date().toISOString(),
  });
  syncMissionControlPlaneState(team.id, mission.leadId, messages);
}

interface RecoveryClassification {
  reason: AgentRecoveryReason;
  recoverable: boolean;
  unassignCause?: TaskRecoveryCause;
  resetThread: boolean;
}

function classifyRecoveryError(message: string, aborted: boolean): RecoveryClassification {
  if (aborted) {
    return { reason: "aborted", recoverable: false, resetThread: false };
  }

  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("heartbeat")) {
    return {
      reason: "heartbeat_timeout",
      recoverable: true,
      unassignCause: "timeout",
      resetThread: true,
    };
  }

  if ((lower.includes("thread") && lower.includes("not found")) || lower.includes("invalid thread")) {
    return {
      reason: "thread_invalid",
      recoverable: true,
      resetThread: true,
    };
  }

  if (lower.includes("aborted_during_permission_wait")) {
    return { reason: "permission_wait_abort", recoverable: false, resetThread: false };
  }

  return { reason: "unknown", recoverable: false, resetThread: false };
}

function selectNextAction(
  mission: MissionState,
  messages: MessageSystem,
  workerId: string,
  taskStoreRoot: string | undefined,
  pendingRecovery: boolean,
  pendingInterruption: boolean,
  seenControlMessageIds: Set<string>,
): NextWorkerAction {
  const actionable = messages.protocolListActionable(workerId);
  const shutdown = actionable.find((message) => message.type === "shutdown_request") ?? null;
  if (shutdown) {
    return { type: "shutdown", trigger: shutdown };
  }

  const leadMessage = actionable.find(
    (message) => (message.from === mission.leadId || message.from === "orchestrator") && !seenControlMessageIds.has(message.id),
  );
  if (leadMessage) {
    return { type: "continue", reason: "lead_message", trigger: leadMessage };
  }

  const peerMessage = actionable.find(
    (message) => message.from !== mission.leadId && message.from !== "orchestrator" && !seenControlMessageIds.has(message.id),
  );
  if (peerMessage) {
    return { type: "continue", reason: "peer_message", trigger: peerMessage };
  }

  if (pendingRecovery) {
    return { type: "continue", reason: "recovery" };
  }

  if (pendingInterruption) {
    return { type: "continue", reason: "interrupted" };
  }

  if (hasRemainingWork(mission.taskListId, workerId, taskStoreRoot)) {
    return { type: "continue", reason: "tasks_available" };
  }

  return { type: "wait" };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runWorkerLoop(config: WorkerLoopConfig): Promise<WorkerResult> {
  const {
    worker,
    mission,
    team,
    codex,
    state,
    messages,
    signal,
  } = config;
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const maxRecoveryAttempts = config.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
  const taskStoreRoot = config.taskStoreRoot;
  const idleRecheckDelayMs = config.idleRecheckDelayMs ?? DEFAULT_IDLE_RECHECK_DELAY_MS;
  const maxIdleRechecks = config.maxIdleRechecks ?? DEFAULT_MAX_IDLE_RECHECKS;

  let consecutiveRecoveryAttempts = 0;
  let totalRecoveryAttempts = 0;
  let lastOutput = "";
  let runtimePhase: WorkerRuntimePhase = "idle_waiting";
  let firstTurn = true;
  let idleRechecks = 0;
  let pendingRecoveryPrompt = false;
  let pendingInterruptionPrompt = false;
  let turnInterruptConsumed = false;
  const seenControlMessageIds = new Set<string>();

  const initialPrompt = buildWorkerPrompt(mission, team, worker);

  try {
    while (true) {
      if (signal?.aborted) {
        runtimePhase = "terminated";
        break;
      }

      const action = firstTurn
        ? (() => {
            const shutdown = messages.protocolListActionable(worker.id).find((message) => message.type === "shutdown_request") ?? null;
            if (shutdown) return { type: "shutdown", trigger: shutdown } as NextWorkerAction;
            return { type: "continue", reason: "tasks_available" } as NextWorkerAction;
          })()
        : selectNextAction(
            mission,
            messages,
            worker.id,
            taskStoreRoot,
            pendingRecoveryPrompt,
            pendingInterruptionPrompt,
            seenControlMessageIds,
          );

      if (action.type === "shutdown") {
        runtimePhase = "shutdown_requested";
        break;
      }

      if (action.type === "wait") {
        runtimePhase = "idle_waiting";

        if (idleRechecks === 0) {
          publishIdleTransition(
            mission,
            team,
            worker,
            messages,
            taskStoreRoot,
            lastOutput,
            pendingInterruptionPrompt ? "interrupted" : undefined,
          );
          pendingInterruptionPrompt = false;
        }

        if (idleRechecks >= maxIdleRechecks) {
          break;
        }

        idleRechecks++;
        await sleep(idleRecheckDelayMs);
        continue;
      }

      idleRechecks = 0;

      const prompt = firstTurn
        ? initialPrompt
        : buildContinuationPrompt(mission, worker, action.reason);
      firstTurn = false;

      if (action.reason === "recovery") pendingRecoveryPrompt = false;
      if (action.reason === "interrupted") pendingInterruptionPrompt = false;
      if (action.trigger) seenControlMessageIds.add(action.trigger.id);

      runtimePhase = action.reason === "recovery" ? "recovering" : "running_turn";
      updateMissionAgentState(team.id, worker.id, {
        lifecycle: "working",
        isActive: true,
        terminalReason: undefined,
        lastSeenAt: new Date(),
      });

      let output: string;
      try {
        const interruptSignal = turnInterruptConsumed ? undefined : config.turnInterruptSignal;
        output = await raceHeartbeat(
          (s) => codex.sendToAgent(worker, prompt, s),
          heartbeatTimeoutMs,
          signal,
          interruptSignal,
        );
        consecutiveRecoveryAttempts = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg === TURN_INTERRUPTED_ERROR) {
          turnInterruptConsumed = true;
          pendingInterruptionPrompt = true;
          runtimePhase = "idle_waiting";
          codex.abortAgent(worker.id);
          updateMissionAgentState(team.id, worker.id, {
            lifecycle: "idle",
            isActive: false,
            terminalReason: undefined,
            lastSeenAt: new Date(),
          });
          publishIdleTransition(mission, team, worker, messages, taskStoreRoot, lastOutput, "interrupted");
          continue;
        }

        if (msg === LIFECYCLE_ABORTED_ERROR || signal?.aborted) {
          runtimePhase = "terminated";
          break;
        }

        const recovery = classifyRecoveryError(msg, false);

        if (recovery.recoverable) {
          runtimePhase = "recovering";
          consecutiveRecoveryAttempts++;
          totalRecoveryAttempts++;
          pendingRecoveryPrompt = true;

          updateMissionAgentState(team.id, worker.id, {
            recoveryAttempts: totalRecoveryAttempts,
            lastRecoveryReason: recovery.reason,
            lastRecoveryAt: new Date(),
          });

          if (consecutiveRecoveryAttempts > maxRecoveryAttempts) {
            updateMissionAgentState(team.id, worker.id, {
              lifecycle: "error",
              terminalReason: "recovery_exhausted",
              terminationMode: "forced",
              recoveryAttempts: totalRecoveryAttempts,
              lastRecoveryReason: recovery.reason,
              lastRecoveryAt: new Date(),
            });
            return {
              agentId: worker.id,
              role: worker.role,
              status: "error",
              output: `Agent died after ${maxRecoveryAttempts} recovery attempts (${recovery.reason}): ${msg}`,
            };
          }

          let recoveredTasks = [] as ReturnType<typeof recoverAgentTasks>;
          if (recovery.unassignCause) {
            const store = new TaskStore(mission.taskListId, taskStoreRoot);
            if (store.exists()) {
              recoveredTasks = recoverAgentTasks(team.id, worker.id, recovery.unassignCause, state);
            }
          }

          codex.abortAgent(worker.id);
          if (recovery.resetThread) {
            worker.threadId = null;
          }

          updateMissionAgentState(team.id, worker.id, {
            lifecycle: "working",
            lastSeenAt: new Date(),
            terminalReason: undefined,
            recoveryAttempts: totalRecoveryAttempts,
            lastRecoveryReason: recovery.reason,
            lastRecoveryAt: new Date(),
          });

          messages.groupChatPost(
            team.id,
            "orchestrator",
            "system",
            `${buildRecoveredTaskSummary(worker.id, recovery.unassignCause ?? (recovery.reason === "thread_invalid" ? "thread_invalid" : "manual_unassign"), recoveredTasks)}; recovery_attempt=${consecutiveRecoveryAttempts}/${maxRecoveryAttempts}`,
          );

          continue;
        }

        updateMissionAgentState(team.id, worker.id, {
          lifecycle: "error",
          terminalReason: msg,
          terminationMode: recovery.reason === "aborted" ? "forced" : undefined,
          recoveryAttempts: totalRecoveryAttempts,
          lastRecoveryReason: recovery.reason,
          lastRecoveryAt: new Date(),
        });

        return {
          agentId: worker.id,
          role: worker.role,
          status: "error",
          output: msg,
        };
      }

      lastOutput = output;
      worker.lastOutput = output;
      worker.lastSeenAt = new Date();
      syncMissionAgentState(team.id, worker);

      updateMissionAgentState(team.id, worker.id, {
        lifecycle: "idle",
        isActive: false,
        terminalReason: undefined,
        lastSeenAt: new Date(),
      });

      publishIdleTransition(mission, team, worker, messages, taskStoreRoot, output);
    }

    updateMissionAgentState(team.id, worker.id, {
      lifecycle: "terminated",
      isActive: false,
      terminalReason: signal?.aborted
        ? "aborted"
        : runtimePhase === "shutdown_requested"
          ? "shutdown_requested"
          : "loop_exit",
      terminationMode: signal?.aborted ? "forced" : "graceful",
      recoveryAttempts: totalRecoveryAttempts,
      lastSeenAt: new Date(),
    });

    return {
      agentId: worker.id,
      role: worker.role,
      status: "success",
      output: lastOutput,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateMissionAgentState(team.id, worker.id, {
      lifecycle: "error",
      isActive: false,
      terminalReason: msg,
      terminationMode: "forced",
      recoveryAttempts: totalRecoveryAttempts,
      lastRecoveryReason: "unknown",
      lastRecoveryAt: new Date(),
      lastSeenAt: new Date(),
    });
    return {
      agentId: worker.id,
      role: worker.role,
      status: "error",
      output: msg,
    };
  }
}

async function raceHeartbeat(
  fn: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  turnInterruptSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (value: { ok: true; value: string } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      if (value.ok) resolve(value.value);
      else reject(value.error);
    };

    const onParentAbort = () => {
      controller.abort();
      finish({ ok: false, error: new Error(LIFECYCLE_ABORTED_ERROR) });
    };

    const onTurnInterrupt = () => {
      controller.abort();
      finish({ ok: false, error: new Error(TURN_INTERRUPTED_ERROR) });
    };

    const cleanup = () => {
      parentSignal?.removeEventListener("abort", onParentAbort);
      turnInterruptSignal?.removeEventListener("abort", onTurnInterrupt);
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        onParentAbort();
        return;
      }
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    if (turnInterruptSignal) {
      if (turnInterruptSignal.aborted) {
        onTurnInterrupt();
        return;
      }
      turnInterruptSignal.addEventListener("abort", onTurnInterrupt, { once: true });
    }

    timer = setTimeout(() => {
      controller.abort();
      finish({ ok: false, error: new Error(`Worker heartbeat timed out after ${Math.round(timeoutMs / 1000)}s`) });
    }, timeoutMs);
    if (timer.unref) {
      timer.unref();
    }

    fn(controller.signal).then(
      (val) => finish({ ok: true, value: val }),
      (err) => finish({ ok: false, error: err instanceof Error ? err : new Error(String(err)) }),
    );
  });
}
