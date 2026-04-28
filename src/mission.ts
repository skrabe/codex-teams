import crypto from "node:crypto";
import { exec } from "node:child_process";
import type { TeamManager } from "./state.js";
import type { CodexClientManager } from "./codex-client.js";
import type { Message, MessageSystem, ProtocolMessage, ProtocolQueueSummary } from "./messages.js";
import type { Agent, AgentLifecycleState, HookCommands, IsolationMode, Task, Team } from "./types.js";
import { renderScopedContext } from "./bootstrap-context.js";
import { HOOK_BLOCK_PREFIX } from "./hooks.js";
import { withTimeout, WORKER_TIMEOUT_MS } from "./tool-utils.js";
import { TaskStore } from "./task-store.js";
import { StaleTaskMonitor } from "./stale-task-monitor.js";
import { runWorkerLoop } from "./worker-loop.js";
import {
  findGitRoot,
  createWorktree,
  hasWorktreeChanges,
  removeWorktree,
  mergeWorktreeBranches,
  cleanupIntegrationBranch,
  type WorktreeResult,
} from "./worktree.js";

export type MissionPhase = "executing" | "verifying" | "fixing" | "completed" | "completed_with_failures" | "error";

export interface WorkerResult {
  agentId: string;
  role: string;
  status: "success" | "error";
  output: string;
}

export interface VerificationAttempt {
  attempt: number;
  passed: boolean;
  output: string;
}

export type VerifierVerdict = "PASS" | "FAIL" | "PARTIAL";

export interface VerifierAttempt {
  attempt: number;
  verdict: VerifierVerdict;
  output: string;
}

export interface MissionVerifierResult {
  agentId: string;
  attempt: number;
  verdict: VerifierVerdict;
  output: string;
}

export interface ShutdownEvent {
  agentId: string;
  requestedBy: string;
  approvedBy: string;
  reason?: string;
  aborted: boolean;
  terminationMode: TerminationMode;
  recoveredTasks: RecoveredTaskEvent[];
  notification: string;
  timestamp: Date;
}

export interface PlanApprovalEvent {
  agentId: string;
  leadId: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  autoApproved: boolean;
  timestamp: Date;
}

export type AgentRecoveryReason =
  | "heartbeat_timeout"
  | "thread_invalid"
  | "aborted"
  | "permission_wait_abort"
  | "unknown";

export type TaskRecoveryCause = "shutdown" | "timeout" | "runtime_cleanup" | "manual_unassign" | "thread_invalid";

export type TerminationMode = "graceful" | "forced" | "grace_timeout";

export interface RecoveredTaskEvent {
  id: string;
  subject: string;
  previousOwner: string | null;
  cause: TaskRecoveryCause;
  recoveredAt: Date;
}

export interface PersistedRecoveredTaskEvent extends Omit<RecoveredTaskEvent, "recoveredAt"> {
  recoveredAt: string;
}

export interface MissionAgentControlPlaneState {
  queued: number;
  leased: number;
  activeDeliveryId: string | null;
  nextMessageType: ProtocolMessage["type"] | null;
  lastDeliveredAt?: Date;
  lastProcessedAt?: Date;
}

export interface PersistedMissionAgentControlPlaneState
  extends Omit<MissionAgentControlPlaneState, "lastDeliveredAt" | "lastProcessedAt"> {
  lastDeliveredAt?: string;
  lastProcessedAt?: string;
}

export interface MissionAgentState {
  id: string;
  role: string;
  specialization: string;
  isLead: boolean;
  status: Agent["status"];
  lifecycle: AgentLifecycleState;
  isActive: boolean;
  sandbox: Agent["sandbox"];
  approvalPolicy: Agent["approvalPolicy"];
  awaitingPlanApproval: boolean;
  threadId: string | null;
  tasks: string[];
  lastSeenAt: Date;
  terminalReason?: string;
  terminationMode?: TerminationMode;
  recoveryAttempts: number;
  lastRecoveryReason?: AgentRecoveryReason;
  lastRecoveryAt?: Date;
  lastOutput: string;
  controlPlane: MissionAgentControlPlaneState;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface PersistedMissionAgentState
  extends Omit<MissionAgentState, "lastSeenAt" | "lastRecoveryAt" | "controlPlane"> {
  lastSeenAt: string;
  lastRecoveryAt?: string;
  controlPlane: PersistedMissionAgentControlPlaneState;
}

export interface TaskBoardEntry {
  id: string;
  subject: string;
  status: Task["status"];
  owner: string | null;
  blockedBy: string[];
  dependencies: string[];
  result?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  staleDurationMs?: number;
}

export interface TaskBoardSnapshot {
  tasks: TaskBoardEntry[];
  stats: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
  };
}

export interface PersistedMissionState {
  missionId: string;
  objective: string;
  phase: MissionPhase;
  teamId: string;
  teamName: string;
  taskListId: string;
  leadId: string;
  workerIds: string[];
  createdAt: string;
  updatedAt: string;
  agents: PersistedMissionAgentState[];
  planApprovals: Array<Omit<PlanApprovalEvent, "timestamp"> & { timestamp: string }>;
  shutdowns: Array<Omit<ShutdownEvent, "timestamp" | "recoveredTasks"> & { timestamp: string; recoveredTasks: PersistedRecoveredTaskEvent[] }>;
  taskBoard?: TaskBoardSnapshot;
  verifierRole?: string;
  verifierId?: string;
  verifierAttempts?: VerifierAttempt[];
  verifierResult?: MissionVerifierResult;
  worktreeResults?: WorktreeResult[];
  error?: string;
}

export interface MissionState {
  id: string;
  objective: string;
  teamId: string;
  teamName: string;
  taskListId: string;
  phase: MissionPhase;
  leadId: string;
  workerIds: string[];
  workerResults: WorkerResult[];
  verifyCommand?: string;
  verifierRole?: string;
  verifierId?: string;
  maxVerifyRetries: number;
  verificationLog: VerificationAttempt[];
  verifierAttempts: VerifierAttempt[];
  verifierResult?: MissionVerifierResult;
  leadOutput: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  agentStates: Map<string, MissionAgentState>;
  planApprovals: PlanApprovalEvent[];
  shutdowns: ShutdownEvent[];
  staleThresholdMs?: number;
  worktreeResults?: WorktreeResult[];
  persistSnapshot?: (snapshot: PersistedMissionState) => void;
  comms?: {
    groupChat: Message[];
    dms: Message[];
    leadChat: Message[];
    protocol: ProtocolMessage[];
    sharedArtifacts: Array<{ from: string; data: string; timestamp: Date }>;
  };
}

const missions = new Map<string, MissionState>();

function emptyMissionAgentControlPlaneState(): MissionAgentControlPlaneState {
  return {
    queued: 0,
    leased: 0,
    activeDeliveryId: null,
    nextMessageType: null,
  };
}

function toMissionAgentControlPlaneState(summary: ProtocolQueueSummary): MissionAgentControlPlaneState {
  return {
    queued: summary.queued,
    leased: summary.leased,
    activeDeliveryId: summary.activeDeliveryId,
    nextMessageType: summary.nextMessageType,
    lastDeliveredAt: summary.lastDeliveredAt ? new Date(summary.lastDeliveredAt) : undefined,
    lastProcessedAt: summary.lastProcessedAt ? new Date(summary.lastProcessedAt) : undefined,
  };
}

function normalizeMissionAgentState(state: MissionAgentState): MissionAgentState {
  const normalized: MissionAgentState = {
    ...state,
    tasks: [...state.tasks],
    controlPlane: { ...state.controlPlane },
    isActive: state.lifecycle === "working",
  };

  if (normalized.status === "error" || normalized.lifecycle === "error") {
    normalized.status = "error";
    normalized.lifecycle = "error";
    normalized.isActive = false;
  } else if (normalized.lifecycle === "working") {
    normalized.status = "working";
    normalized.isActive = true;
  } else if (normalized.status === "working") {
    normalized.status = "idle";
  }

  if (normalized.lifecycle === "waiting_plan_approval") {
    normalized.awaitingPlanApproval = true;
    normalized.isActive = false;
  }

  if (normalized.lifecycle === "terminated") {
    normalized.awaitingPlanApproval = false;
    normalized.isActive = false;
  }

  return normalized;
}

export function buildRecoveredTaskSummary(agentId: string, cause: TaskRecoveryCause, recoveredTasks: RecoveredTaskEvent[]): string {
  if (recoveredTasks.length === 0) {
    return `[task_recovery] worker=${agentId} cause=${cause} recovered=0`;
  }
  const tasks = recoveredTasks.map((task) => `#${task.id}("${task.subject}")`).join(", ");
  return `[task_recovery] worker=${agentId} cause=${cause} recovered=${recoveredTasks.length} tasks=${tasks}`;
}

export function recoverAgentTasks(
  teamId: string,
  agentId: string,
  cause: TaskRecoveryCause,
  state: TeamManager,
): RecoveredTaskEvent[] {
  const recoveredAt = new Date();
  const recovered = state.unassignTasksForAgent(teamId, agentId);
  return recovered.map((task) => ({
    id: task.id,
    subject: task.subject,
    previousOwner: agentId,
    cause,
    recoveredAt,
  }));
}

function toMissionAgentState(agent: Agent): MissionAgentState {
  return {
    id: agent.id,
    role: agent.role,
    specialization: agent.specialization,
    isLead: agent.isLead,
    status: agent.status,
    lifecycle: agent.lifecycle,
    isActive: agent.isActive,
    sandbox: agent.sandbox,
    approvalPolicy: agent.approvalPolicy,
    awaitingPlanApproval: agent.awaitingPlanApproval,
    threadId: agent.threadId,
    tasks: [...agent.tasks],
    lastSeenAt: new Date(agent.lastSeenAt),
    terminalReason: agent.terminalReason,
    terminationMode: undefined,
    recoveryAttempts: 0,
    lastRecoveryReason: undefined,
    lastRecoveryAt: undefined,
    lastOutput: agent.lastOutput,
    controlPlane: emptyMissionAgentControlPlaneState(),
    worktreePath: agent.worktreePath,
    worktreeBranch: agent.worktreeBranch,
  };
}

function syncAgentStateRecord(mission: MissionState, agent: Agent): MissionAgentState {
  const existing = mission.agentStates.get(agent.id);
  const snapshot = normalizeMissionAgentState({
    ...toMissionAgentState(agent),
    controlPlane: existing ? { ...existing.controlPlane } : emptyMissionAgentControlPlaneState(),
    terminationMode: existing?.terminationMode,
    recoveryAttempts: existing?.recoveryAttempts ?? 0,
    lastRecoveryReason: existing?.lastRecoveryReason,
    lastRecoveryAt: existing?.lastRecoveryAt,
  });
  mission.agentStates.set(agent.id, snapshot);
  return snapshot;
}

const TASK_BOARD_CACHE_TTL_MS = 5_000;
const DEBOUNCE_MS = 500;
const DEBOUNCE_MAX_MS = 2_000;

const taskBoardCache = new Map<string, { snapshot: TaskBoardSnapshot; cachedAt: number }>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastFlushAt = new Map<string, number>();

function getCachedTaskBoard(taskListId: string, forceRefresh = false): TaskBoardSnapshot | undefined {
  if (!forceRefresh) {
    const cached = taskBoardCache.get(taskListId);
    if (cached && Date.now() - cached.cachedAt < TASK_BOARD_CACHE_TTL_MS) {
      return cached.snapshot;
    }
  }
  const snapshot = buildTaskBoardSnapshot(taskListId);
  if (snapshot) {
    taskBoardCache.set(taskListId, { snapshot, cachedAt: Date.now() });
  }
  return snapshot;
}

function persistNow(mission: MissionState, forceRefreshBoard = false): void {
  mission.updatedAt = new Date();
  if (forceRefreshBoard) {
    taskBoardCache.delete(mission.taskListId);
  }
  mission.persistSnapshot?.(serializeMissionState(mission));
  lastFlushAt.set(mission.id, Date.now());
}

function touchMission(mission: MissionState): void {
  const existing = pendingTimers.get(mission.id);
  if (existing) clearTimeout(existing);

  const lastFlush = lastFlushAt.get(mission.id) ?? 0;
  if (Date.now() - lastFlush >= DEBOUNCE_MAX_MS) {
    persistNow(mission);
    return;
  }

  mission.updatedAt = new Date();
  const timer = setTimeout(() => {
    pendingTimers.delete(mission.id);
    persistNow(mission);
  }, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  pendingTimers.set(mission.id, timer);
}

function touchMissionImmediate(mission: MissionState): void {
  const existing = pendingTimers.get(mission.id);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(mission.id);
  }
  persistNow(mission, true);
}

export function flushPendingPersistence(mission: MissionState): void {
  const existing = pendingTimers.get(mission.id);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(mission.id);
    persistNow(mission, true);
  }
}

function cleanupMissionCaches(missionId: string, taskListId: string): void {
  const timer = pendingTimers.get(missionId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(missionId);
  }
  lastFlushAt.delete(missionId);
  taskBoardCache.delete(taskListId);
}

function sortAgentStates(agentStates: Iterable<MissionAgentState>): MissionAgentState[] {
  return Array.from(agentStates).sort((left, right) => {
    if (left.isLead !== right.isLead) return left.isLead ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

export function getMission(id: string): MissionState | undefined {
  return missions.get(id);
}

export function listMissions(): MissionState[] {
  return Array.from(missions.values());
}

export function forgetMission(id: string): void {
  missions.delete(id);
}

function getMissionByTeamId(teamId: string): MissionState | undefined {
  return Array.from(missions.values()).find((mission) => mission.teamId === teamId);
}

export function buildTaskBoardSnapshot(taskListId: string, taskStoreRoot?: string): TaskBoardSnapshot | undefined {
  try {
    const store = new TaskStore(taskListId, taskStoreRoot);
    if (!store.exists()) return undefined;
    const tasks = store.listTasks();
    const now = Date.now();
    const entries: TaskBoardEntry[] = tasks.map((task) => {
      const entry: TaskBoardEntry = {
        id: task.id,
        subject: task.subject,
        status: task.status,
        owner: task.owner,
        blockedBy: [...task.blockedBy],
        dependencies: [...task.dependencies],
        result: task.result,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
        completedAt: task.completedAt?.toISOString(),
      };
      if (task.status === "in-progress" && task.owner) {
        entry.staleDurationMs = now - task.updatedAt.getTime();
      }
      return entry;
    });
    return {
      tasks: entries,
      stats: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        inProgress: tasks.filter((t) => t.status === "in-progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        blocked: tasks.filter((t) => t.blockedBy.length > 0 && t.status !== "completed").length,
      },
    };
  } catch {
    return undefined;
  }
}

export function serializeMissionState(mission: MissionState): PersistedMissionState {
  return {
    missionId: mission.id,
    objective: mission.objective,
    phase: mission.phase,
    teamId: mission.teamId,
    teamName: mission.teamName,
    taskListId: mission.taskListId,
    leadId: mission.leadId,
    workerIds: [...mission.workerIds],
    createdAt: mission.createdAt.toISOString(),
    updatedAt: mission.updatedAt.toISOString(),
    agents: sortAgentStates(mission.agentStates.values()).map((agent) => ({
      ...agent,
      tasks: [...agent.tasks],
      lastSeenAt: agent.lastSeenAt.toISOString(),
      lastRecoveryAt: agent.lastRecoveryAt?.toISOString(),
      controlPlane: {
        ...agent.controlPlane,
        lastDeliveredAt: agent.controlPlane.lastDeliveredAt?.toISOString(),
        lastProcessedAt: agent.controlPlane.lastProcessedAt?.toISOString(),
      },
    })),
    planApprovals: mission.planApprovals.map((approval) => ({
      ...approval,
      timestamp: approval.timestamp.toISOString(),
    })),
    shutdowns: mission.shutdowns.map((shutdown) => ({
      ...shutdown,
      recoveredTasks: shutdown.recoveredTasks.map((task) => ({
        ...task,
        recoveredAt: task.recoveredAt.toISOString(),
      })),
      timestamp: shutdown.timestamp.toISOString(),
    })),
    taskBoard: getCachedTaskBoard(mission.taskListId),
    verifierRole: mission.verifierRole,
    verifierId: mission.verifierId,
    verifierAttempts: mission.verifierAttempts.length > 0 ? mission.verifierAttempts.map((attempt) => ({ ...attempt })) : undefined,
    verifierResult: mission.verifierResult ? { ...mission.verifierResult } : undefined,
    worktreeResults: mission.worktreeResults,
    error: mission.error,
  };
}

export function registerMissionPersistence(
  mission: MissionState,
  persistSnapshot: (snapshot: PersistedMissionState) => void,
): void {
  mission.persistSnapshot = persistSnapshot;
  touchMission(mission);
}

export function syncMissionTeamState(teamId: string, team: Team): void {
  const mission = getMissionByTeamId(teamId);
  if (!mission) return;
  for (const agent of team.agents.values()) {
    syncAgentStateRecord(mission, agent);
  }
  touchMission(mission);
}

export function syncMissionAgentState(teamId: string, agent: Agent): void {
  const mission = getMissionByTeamId(teamId);
  if (!mission) return;
  syncAgentStateRecord(mission, agent);
  touchMission(mission);
}

export function updateMissionAgentState(
  teamId: string,
  agentId: string,
  patch: Partial<MissionAgentState>,
): void {
  const mission = getMissionByTeamId(teamId);
  if (!mission) return;
  const existing = mission.agentStates.get(agentId);
  if (!existing) return;
  const merged: MissionAgentState = {
    ...existing,
    ...patch,
    tasks: patch.tasks ? [...patch.tasks] : [...existing.tasks],
    controlPlane: patch.controlPlane ? { ...patch.controlPlane } : { ...existing.controlPlane },
    lastSeenAt: patch.lastSeenAt ? new Date(patch.lastSeenAt) : new Date(),
    lastRecoveryAt: patch.lastRecoveryAt ? new Date(patch.lastRecoveryAt) : existing.lastRecoveryAt,
  };
  mission.agentStates.set(agentId, normalizeMissionAgentState(merged));
  touchMission(mission);
}

export function syncMissionControlPlaneState(teamId: string, agentId: string, messages: MessageSystem): void {
  updateMissionAgentState(teamId, agentId, {
    controlPlane: toMissionAgentControlPlaneState(messages.protocolSummary(agentId)),
  });
}

export function recordPlanApproval(teamId: string, event: PlanApprovalEvent): void {
  const mission = getMissionByTeamId(teamId);
  if (mission) {
    mission.planApprovals.push(event);
    touchMissionImmediate(mission);
  }
}

export function buildLeadPrompt(mission: MissionState, team: Team, workers: Agent[], lead: Agent): string {
  const workerList = workers
    .map((w) => `  - @${w.id} (${w.role}${w.specialization ? " — " + w.specialization : ""})`)
    .join("\n");
  const scopedContext = renderScopedContext({
    window: "startup",
    objective: mission.objective,
    assignedScope: [
      "Create the initial task graph quickly.",
      "Kick off the team with assignments, dependencies, and risks.",
      "Execute your own technical work while unblocking workers.",
    ],
    essentialContextSources: [
      "task_list() / task_get() for the shared backlog and task details",
      "group_chat_read() for the worker kickoff thread and integration decisions",
      "get_shared() for artifacts teammates already published",
      "lead_chat_read() when cross-team coordination exists",
      "protocol_read() for approvals, shutdowns, and other control-plane events",
    ],
  });

  return `=== YOU ARE THE TEAM LEAD ===

${scopedContext}

=== YOUR WORKERS ===
${workerList}

=== WHAT TO DO RIGHT NOW ===
Your workers are starting up simultaneously. Use the shared task tools as the source of truth for
work state. Your job: create the initial task graph fast, align the team, then execute your own work.

1. CREATE THE INITIAL TASK GRAPH
   Before or alongside your kickoff message, use task_create() to create the initial work items.
   - Break the mission into concrete tasks with clear ownership and dependencies
   - Assign an owner when the work clearly belongs to one worker; otherwise leave it unowned
   - Keep task descriptions execution-oriented and specific

2. KICK OFF WITH A PLAN
   Post one clear kickoff message in group_chat with:
   - Problem breakdown: what needs to happen and why
   - Approach: how the work divides, which task IDs each worker should take, where pieces connect
   - Dependencies, interfaces, and key risks
   - Concrete assignments per worker — name each by @agent-id, reference their task IDs,
     and note where their work connects to others' work
   End with: "Raise concrete concerns or blockers now, otherwise execute."
   Do not ask for acknowledgements. Do not wait for every worker to respond — if no one raises
   a concern within their first message cycle, the plan is accepted.

3. EXECUTE YOUR OWN WORK
   You are a coding lead, not a project manager. After posting the plan, start executing your
   own technical assignments immediately. Keep task state current with task_update(). Check
   group_chat between your own milestones (after completing a file, after a test run).
   When a worker posts a blocker or question, respond immediately with a decision or unblock.
   When two workers need to coordinate, connect them directly — don't relay messages.
   Stay active until the mission is actually done. Your workers will keep running, waiting,
   claiming next tasks, and responding to new work until you or the orchestrator shut them down.
   Workers in plan mode will send a plan_approval_request via protocol_send before they begin coding.
   You MUST check protocol_read() regularly for these requests and respond promptly:
   - Read the plan in the request's data payload (summary, steps, task IDs, risks).
   - If acceptable, respond with protocol_send(toAgentId=workerAgentId, type="plan_approval_response",
     data={approved: true}).
   - If the plan needs revision, respond with protocol_send(toAgentId=workerAgentId,
     type="plan_approval_response", data={approved: false, feedback: "..."}).
   Workers are blocked and waiting until they receive your response. Do not delay.

4. COORDINATE AND UNBLOCK
   - Resolve ambiguity, blockers, and conflicts fast. Close decision loops in one round.
   - Workers should coordinate directly with each other. Step in only for tie-breaks,
     cross-scope decisions, or when a worker is stuck.
   - Use group_chat for decisions/risks that affect multiple workers. Avoid noise.
   - If your worker protocol traffic shows permission_request items (triggered when
     Codex pauses for tool/sandbox approvals), respond immediately with
     permission_respond(requestId, decision, feedback?).
   - If a worker's scope is finished or you need to recover work, retire them with
     shutdown_teammate(agentId, reason).
   - If other teams exist, use lead_chat to coordinate with other leads.
     Check lead_chat_peek between milestones and relay only actionable updates.

5. VERIFY AND CLOSE
   Use task_list() and task_get() to review progress and confirm all required tasks are complete.
   When workers share deliverables, review their artifacts via get_shared(). Check that interfaces
   between workers' code are compatible. If integration issues exist, flag them immediately in
   group_chat with specifics and update tasks as needed.
   share() your final assessment: key decisions made, integration status, and any remaining work.

Your agent ID: ${lead.id}
Team ID: ${team.id}`;
}

export function buildWorkerPrompt(
  mission: MissionState,
  _team: Team,
  worker: Agent,
): string {
  const scopedContext = renderScopedContext({
    window: "startup",
    objective: mission.objective,
    assignedScope: [
      "Read the kickoff/task state, then claim the recommended unblocked task for your scope.",
      "Keep working through the backlog until you receive shutdown_request.",
      worker.sandbox === "plan-mode"
        ? "If you are in plan mode, get plan approval before making code changes."
        : "Coordinate only when needed and otherwise stay focused on execution.",
    ],
    essentialContextSources: [
      "task_list() / task_get() for the current backlog, task scope, and recommendedTaskId",
      "group_chat_read() for the lead kickoff and cross-worker decisions",
      "get_shared() for artifacts or discoveries already published by teammates",
      "protocol_read() for plan approvals, shutdowns, and permission-related control messages",
    ],
  });

  if (worker.sandbox === "plan-mode") {
    return `${scopedContext}

=== BOOTSTRAP ===
1. Call task_list() immediately and inspect available tasks.
2. Call group_chat_read() immediately.
3. Call protocol_read() immediately in case there are control-plane updates, then protocol_ack(deliveryId) after processing.
4. Draft a concrete implementation plan for your scope before writing code.
5. Send protocol_send() to your lead with type="plan_approval_request" and data containing:
   - a short summary
   - numbered steps
   - task IDs you expect to claim or create
   - risks / open questions
6. Do not implement anything until protocol_read() returns plan_approval_response with approved=true, and ack that delivery.
7. While waiting, use wait_for_messages(15000) instead of polling.

LONG-LIVED LOOP AFTER APPROVAL
- Read task_list() and prefer the recommendedTaskId (lowest unblocked pending task ID).
- Claim your first unblocked task with task_claim(taskId).
- Keep task state current with task_update().
- When a task is done, mark it completed with task_update(taskId, status="completed", result=...).
- After completing a task, call task_list() again, prefer recommendedTaskId, and take the next unblocked task.
- If no work is available, call wait_for_messages(15000), then re-check protocol_read() (and protocol_ack delivery), group_chat_read(), and task_list().
- If protocol_read() includes shutdown_request, ack it, stop taking new work, post any final blocker/handoff note if needed, and exit.
- Do not exit just because one task is done; stay alive and keep cycling until shutdown_request.

IF REJECTED
- Revise the plan using the feedback in plan_approval_response.
- Send a new plan_approval_request.
- Do not start coding until approved.

Your agent ID: ${worker.id}
Team ID: ${_team.id}`;
  }

  return `${scopedContext}

=== BOOTSTRAP ===
1. Call task_list() immediately and inspect available tasks.
2. Call group_chat_read() immediately.
3. Call protocol_read() immediately in case there are control-plane updates, then protocol_ack(deliveryId) after processing.
4. In task_list() output, prefer recommendedTaskId (lowest unblocked pending task ID).
5. Claim that task with task_claim(taskId).
6. If no task is recommended, use the lead's kickoff message plus task_list() to determine what to do.

LONG-LIVED TASK WORKFLOW
- Start work by claiming an unblocked task with task_claim(taskId), prioritizing recommendedTaskId.
- Keep task state current with task_update().
- When a task is done, mark it completed with task_update(taskId, status="completed", result=...).
- After completing a task, call task_list() again, prioritize recommendedTaskId, and take the next unblocked task.
- If your runtime pauses on a permission request, wait for the lead's response rather than
  retrying or working around the gate.
- If nothing is available, call wait_for_messages(15000), then re-check protocol_read() (and protocol_ack delivery), group_chat_read(), and task_list().
- If protocol_read() includes shutdown_request, ack it, stop taking new work, post any final blocker/handoff note if needed, and exit.
- Do not exit just because one task is done; stay alive and keep cycling until shutdown_request.

If the plan or task graph has a material issue with your scope, raise it with specifics in group_chat.
If it looks right, execute — do not post just to agree.

Your agent ID: ${worker.id}
Team ID: ${_team.id}`;
}

export function buildContinuationPrompt(
  mission: MissionState,
  worker: Agent,
  reason: "tasks_available" | "recovery" | "lead_message" | "peer_message" | "interrupted",
): string {
  const reasonScope =
    reason === "recovery"
      ? "Your previous session ended unexpectedly. Check task state and resume."
      : reason === "lead_message"
        ? "A lead control-plane message is waiting. Process it before claiming new tasks."
        : reason === "peer_message"
          ? "A teammate control-plane message is waiting. Process it before claiming new tasks."
          : reason === "interrupted"
            ? "Your current turn was interrupted. Re-sync quickly and continue."
            : "More tasks are available. Continue working.";

  const scopedContext = renderScopedContext({
    window: "reentry",
    objective: mission.objective,
    assignedScope: [
      reasonScope,
      "Call task_list() to find your next recommended task.",
      "Keep working through the backlog until shutdown_request.",
    ],
    essentialContextSources: [
      "task_list() / task_get() for current backlog and recommendedTaskId",
      "group_chat_read() for recent team updates",
      "protocol_read() for control-plane events (shutdowns, approvals)",
      "get_shared() for artifacts from teammates",
    ],
  });

  const reentryNote =
    reason === "recovery"
      ? `

=== RECOVERY ===
Your previous session may have ended unexpectedly. Any in-progress tasks you owned have been reset to pending.
Check task_list() and group_chat_read() to understand current state before claiming work.`
      : reason === "lead_message"
        ? `

=== PRIORITY EVENT ===
A lead-originated control-plane message is pending. Read protocol first and act on it before autonomous task claiming.`
        : reason === "peer_message"
          ? `

=== PRIORITY EVENT ===
A teammate-originated control-plane message is pending. Read protocol first, coordinate if needed, then continue task work.`
          : reason === "interrupted"
            ? `

=== INTERRUPTED TURN ===
Your last turn was interrupted. Re-check protocol_read(), group_chat_read(), and task_list() before resuming.`
            : "";

  return `${scopedContext}${reentryNote}

=== RESUME ===
1. Call protocol_read() first and process pending control-plane events.
2. Call task_list() — prefer recommendedTaskId.
3. Claim the next unblocked task with task_claim(taskId).
4. Keep task state current with task_update().
5. If protocol_read() includes shutdown_request, stop and exit.

Your agent ID: ${worker.id}`;
}

export function buildFixPrompt(
  mission: MissionState,
  verifyOutput: string,
  attempt: number,
  maxRetries: number,
): string {
  const workerList = mission.workerIds.map((id) => `  - ${id}`).join("\n");
  const scopedContext = renderScopedContext({
    window: "reentry",
    objective: mission.objective,
    assignedScope: [
      "Analyze the verification failure evidence below.",
      "Assign concrete fix tasks to workers without replaying unrelated history.",
      "Return only a valid JSON assignment array.",
    ],
    essentialContextSources: [
      "The verification evidence below",
      "task_list() / task_get() for current ownership and backlog state",
      "group_chat_read() and get_shared() for integration notes from workers",
      "Your own existing thread context only as needed for the current failure",
    ],
  });

  return `${scopedContext}

=== VERIFICATION FAILED (attempt ${attempt}/${maxRetries}) ===

The verification command failed with the following output:

---
${verifyOutput}
---

=== YOUR WORKERS ===
${workerList}

Review the errors above and assign fix tasks to your workers. Respond with a JSON array of assignments:
[{"agentId": "worker-id", "task": "Detailed description of what to fix"}]

Only output the JSON array, nothing else. Invalid JSON, unknown worker IDs, or empty task strings will fail the mission. If you believe the errors are unfixable, respond with an empty array: []`;
}

export function runVerifyCommand(command: string, cwd: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 600_000 }, (error, stdout, stderr) => {
      const output = (stdout + "\n" + stderr).trim();
      resolve({ passed: !error, output });
    });
  });
}

export interface MissionProgress {
  phase: MissionPhase;
  detail?: string;
}

interface FixAssignment {
  agentId: string;
  task: string;
}

async function collectWorkerResult(
  worker: Agent,
  promise: Promise<string>,
): Promise<WorkerResult> {
  try {
    const output = await promise;
    return {
      agentId: worker.id,
      role: worker.role,
      status: "success",
      output,
    };
  } catch (err) {
    return {
      agentId: worker.id,
      role: worker.role,
      status: "error",
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

export function extractJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct;
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  const bracketMatch = trimmed.match(/(\[\s*\{[\s\S]*\}\s*\])/);  
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[1]);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  const emptyMatch = trimmed.match(/(\[\s*\])/);
  if (emptyMatch) return [];

  throw new Error("Could not extract JSON array from response");
}

function parseFixAssignments(response: string, workerIds: string[]): FixAssignment[] {
  const parsed = extractJsonArray(response);

  const knownWorkers = new Set(workerIds);
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Fix assignment ${index + 1} must be an object`);
    }

    const { agentId, task } = entry as Record<string, unknown>;
    if (typeof agentId !== "string" || agentId.trim() === "") {
      throw new Error(`Fix assignment ${index + 1} is missing a valid agentId`);
    }
    if (!knownWorkers.has(agentId)) {
      throw new Error(`Fix assignment ${index + 1} targets unknown worker: ${agentId}`);
    }
    if (typeof task !== "string" || task.trim() === "") {
      throw new Error(`Fix assignment ${index + 1} is missing a valid task`);
    }

    return { agentId, task: task.trim() };
  });
}

const FIX_PARSE_RETRY_PROMPT = `Your previous response could not be parsed as a valid JSON array of fix assignments.
Respond with ONLY a JSON array, no markdown fences, no explanation:
[{"agentId": "worker-id", "task": "what to fix"}]
Or an empty array if no fixes are needed: []`;

async function parseFixAssignmentsWithRetry(
  response: string,
  workerIds: string[],
  lead: Agent,
  codex: CodexClientManager,
): Promise<FixAssignment[]> {
  try {
    return parseFixAssignments(response, workerIds);
  } catch (firstError) {
    const isParseError = firstError instanceof Error && firstError.message.includes("JSON");
    if (!isParseError) throw firstError;

    const retryResponse = await codex.sendToAgent(lead, FIX_PARSE_RETRY_PROMPT);
    return parseFixAssignments(retryResponse, workerIds);
  }
}

function getWorkerFailures(results: WorkerResult[]): WorkerResult[] {
  return results.filter((result) => result.status === "error");
}

function getShutdownGraceMs(): number {
  const raw = process.env.CODEX_TEAMS_SHUTDOWN_GRACE_MS;
  if (!raw) return 120_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 120_000;
}

function isShutdownAbortOutput(output: string): boolean {
  const lower = output.toLowerCase();
  return lower.includes("aborterror") || lower.includes("operation was aborted") || lower.includes("worker_lifecycle_aborted");
}

function assertNoWorkerFailures(results: WorkerResult[], context: string): void {
  const failures = getWorkerFailures(results);
  if (failures.length === 0) return;

  throw new Error(
    `${context}: ${failures.map((failure) => `${failure.agentId}: ${failure.output}`).join("; ")}`,
  );
}

function truncateForVerifier(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}
... [truncated ${text.length - maxChars} chars]`;
}

function parseVerifierVerdict(output: string): VerifierVerdict {
  const lines = output.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  const match = /^VERDICT:\s*(PASS|FAIL|PARTIAL)$/.exec(lastLine);
  if (!match) {
    throw new Error("Verifier output missing final 'VERDICT: PASS|FAIL|PARTIAL' line");
  }
  return match[1] as VerifierVerdict;
}

function buildVerifierPrompt(
  mission: MissionState,
  lead: Agent,
  workerResults: WorkerResult[],
  sharedArtifacts: Array<{ from: string; data: string; timestamp: Date }>,
  attempt: number,
): string {
  const workerSummary = workerResults
    .map((result) => {
      const label = `${result.agentId} (${result.role}) [${result.status}]`;
      return `- ${label}
${truncateForVerifier(result.output, 2000)}`;
    })
    .join("\n\n");

  const artifactSummary = sharedArtifacts.length > 0
    ? sharedArtifacts
        .slice(-20)
        .map(
          (artifact) =>
            `- ${artifact.from} @ ${artifact.timestamp.toISOString()}: ${truncateForVerifier(artifact.data, 400)}`,
        )
        .join("\n")
    : "- none";

  const verifyHint = mission.verifyCommand
    ? `
Required baseline command: run this exact command first and include its output.
${mission.verifyCommand}
`
    : "";
  const scopedContext = renderScopedContext({
    window: "startup",
    objective: mission.objective,
    assignedScope: [
      "Independently verify the delivered implementation.",
      "Use concrete command evidence and produce a strict final verdict.",
      "Rely on scoped summaries below instead of assuming hidden transcript history.",
    ],
    essentialContextSources: [
      "Lead summary below",
      "Worker outputs below",
      "Shared artifacts below",
      mission.verifyCommand ? "The required baseline verification command below" : "Your own validation commands",
    ],
  });

  return `${scopedContext}

=== INDEPENDENT VERIFICATION TASK ===
You are the mission verifier. Verify implementation quality with command evidence and a strict verdict.

=== LEAD SUMMARY ===
${truncateForVerifier(mission.leadOutput || "(no lead output)", 4000)}

=== WORKER OUTPUTS ===
${workerSummary || "- none"}

=== SHARED ARTIFACTS ===
${artifactSummary}

=== ATTEMPT ===
${attempt} of ${mission.maxVerifyRetries + 1}${verifyHint}

=== HARD CONSTRAINTS ===
- Do not modify, create, or delete project files.
- Do not install dependencies.
- Run concrete validation commands and capture real output.
- Include at least one adversarial probe relevant to this mission.
- If environment limitations block full verification, use PARTIAL.

=== REQUIRED OUTPUT FORMAT ===
For each check:
### Check: <what you verified>
**Command run:**
  <exact command>
**Output observed:**
  <actual output>
**Result: PASS** or **Result: FAIL**

End with exactly one final line:
VERDICT: PASS
or
VERDICT: FAIL
or
VERDICT: PARTIAL`;
}

function buildFixTaskPrompt(
  mission: MissionState,
  task: string,
  failureOutput: string,
  attempt: number,
  maxRetries: number,
): string {
  const scopedContext = renderScopedContext({
    window: "reentry",
    objective: mission.objective,
    assignedScope: [
      `Execute this assigned fix task: ${task}`,
      "Use the scoped failure evidence below; do not assume the full prior transcript is replayed here.",
      "Make the fix, verify it, then return a concise result summary.",
    ],
    essentialContextSources: [
      "The fix task and failure evidence below",
      "task_list() / task_get() for backlog and dependency state",
      "group_chat_read() / protocol_read() for current team coordination",
      "get_shared() for artifacts or interface notes from teammates",
    ],
  });

  return `${scopedContext}

=== FIX TASK ===
${task}

=== FAILURE EVIDENCE (attempt ${attempt}/${maxRetries}) ===
${truncateForVerifier(failureOutput, 4000)}

=== WHAT TO DO ===
1. Fix the issue described above.
2. Run the relevant checks for your change.
3. Return a concise implementation/result summary.`;
}


function createVerifierAgent(mission: MissionState, lead: Agent): Agent {
  const verifierId = mission.verifierId ?? `verifier-${crypto.randomUUID().slice(0, 12)}`;
  mission.verifierId = verifierId;

  return {
    id: verifierId,
    role: mission.verifierRole ?? "Verifier",
    specialization: "Independent verification",
    threadId: null,
    model: lead.model,
    sandbox: "workspace-write",
    baseInstructions: "",
    cwd: lead.cwd,
    approvalPolicy: "never",
    reasoningEffort: "none",
    isLead: false,
    fastMode: false,
    status: "idle",
    lifecycle: "created",
    isActive: false,
    awaitingPlanApproval: false,
    lastSeenAt: new Date(),
    lastOutput: "",
    tasks: [],
  };
}

function syncStandaloneMissionAgent(mission: MissionState, agent: Agent): void {
  syncAgentStateRecord(mission, agent);
  touchMission(mission);
}

async function shutdownWorkersAndCollectResults(
  mission: MissionState,
  team: Team,
  workerRuns: Array<{ worker: Agent; promise: Promise<WorkerResult> }>,
  codex: CodexClientManager,
  messages: MessageSystem,
): Promise<WorkerResult[]> {
  const activeWorkers = workerRuns
    .map(({ worker }) => worker)
    .filter((worker) => team.agents.has(worker.id));

  for (const worker of activeWorkers) {
    messages.protocolSend("orchestrator", worker.id, "shutdown_request", {
      reason: "mission_complete",
      missionId: mission.id,
    });
    syncMissionControlPlaneState(team.id, worker.id, messages);
    updateMissionAgentState(team.id, worker.id, {
      lifecycle: "shutdown_requested",
      isActive: false,
      terminalReason: "mission_complete",
      terminationMode: "graceful",
    });
  }

  const allResultsPromise = Promise.all(workerRuns.map(({ promise }) => promise));
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), getShutdownGraceMs());
    timeoutHandle.unref?.();
  });
  const settled = await Promise.race([
    allResultsPromise.then((results) => ({ timedOut: false as const, results })),
    timeoutPromise,
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  let forced = new Set<string>();
  let graceTimeout = false;

  if (settled.timedOut) {
    graceTimeout = true;
    const abortTargets = workerRuns
      .map(({ worker }) => worker.id)
      .filter((agentId) => team.agents.has(agentId));
    forced = new Set(codex.abortTeam(abortTargets));

    for (const agentId of abortTargets) {
      updateMissionAgentState(team.id, agentId, {
        lifecycle: "shutdown_requested",
        isActive: false,
        terminalReason: forced.has(agentId) ? "forced_termination" : "grace_timeout",
        terminationMode: forced.has(agentId) ? "forced" : "grace_timeout",
      });
    }
  }

  const results = (await allResultsPromise).map((result) =>
    graceTimeout && isShutdownAbortOutput(result.output)
      ? { ...result, status: "success" as const }
      : result,
  );
  for (const result of results) {
    const mode = graceTimeout ? (forced.has(result.agentId) ? "forced" : "grace_timeout") : "graceful";
    const agent = team.agents.get(result.agentId);
    if (agent) agent.status = result.status === "error" ? "error" : "idle";
    updateMissionAgentState(team.id, result.agentId, {
      status: result.status === "error" ? "error" : "idle",
      lifecycle: result.status === "error" ? "error" : "terminated",
      isActive: false,
      terminationMode: mode,
      terminalReason: result.status === "error" ? result.output : "mission_complete",
    });
  }

  const blocked = results.find((result) => result.status === "error" && result.output.includes(HOOK_BLOCK_PREFIX));
  if (blocked) throw new Error(blocked.output);
  return results;
}

export async function runMission(
  mission: MissionState,
  team: Team,
  codex: CodexClientManager,
  state: TeamManager,
  messages: MessageSystem,
  onProgress?: (p: MissionProgress) => void,
): Promise<void> {
  const lead = team.agents.get(mission.leadId)!;
  const workers = mission.workerIds.map((id) => team.agents.get(id)!).filter(Boolean);

  const report = (phase: MissionPhase, detail?: string) => {
    mission.phase = phase;
    syncMissionTeamState(mission.teamId, team);
    touchMissionImmediate(mission);
    onProgress?.({ phase, detail });
  };

  const staleMonitor = new StaleTaskMonitor(state, messages);
  if (mission.staleThresholdMs && mission.staleThresholdMs > 0) {
    staleMonitor.start({ teamId: team.id, thresholdMs: mission.staleThresholdMs });
  }

  try {
    report("executing", "Sending prompts to lead and workers");

    const leadPrompt = buildLeadPrompt(mission, team, workers, lead);
    const leadPromise = withTimeout(
      (signal) => codex.sendToAgent(lead, leadPrompt, signal),
      WORKER_TIMEOUT_MS,
      `Lead ${lead.id}`,
    );

    const workerRuns = workers.map((worker) => {
      const promise = runWorkerLoop({
        worker,
        mission,
        team,
        codex,
        state,
        messages,
      });
      return { worker, promise };
    });
    report("executing", "Workers are running in long-lived mode; waiting for lead");

    let leadFailure: Error | undefined;
    try {
      mission.leadOutput = await leadPromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mission.leadOutput = msg;
      leadFailure = new Error(`Lead failed: ${msg}`);
    }

    report("executing", leadFailure ? "Lead failed; requesting worker shutdown" : "Lead finished; requesting worker shutdown");
    mission.workerResults = await shutdownWorkersAndCollectResults(mission, team, workerRuns, codex, messages);
    if (leadFailure) throw leadFailure;

    const initialWorkerFailures = getWorkerFailures(mission.workerResults);
    let hasWorkerFailures = initialWorkerFailures.length > 0;
    if (hasWorkerFailures) {
      report("executing", `${initialWorkerFailures.length} worker(s) failed: ${initialWorkerFailures.map((f) => f.agentId).join(", ")}`);
    }

    if (mission.verifierRole) {
      report("verifying", `Running independent verifier: ${mission.verifierRole}`);
      const verifier = createVerifierAgent(mission, lead);
      syncStandaloneMissionAgent(mission, verifier);

      let verifierPassed = false;
      let verifierPartial = false;

      for (let attempt = 1; attempt <= mission.maxVerifyRetries + 1; attempt++) {
        const sharedArtifacts = messages.getSharedArtifacts(mission.teamId);
        const verifierPrompt = buildVerifierPrompt(mission, lead, mission.workerResults, sharedArtifacts, attempt);
        const verifierOutput = await codex.sendToAgent(verifier, verifierPrompt);
        syncStandaloneMissionAgent(mission, verifier);

        const verdict = parseVerifierVerdict(verifierOutput);
        mission.verifierAttempts.push({ attempt, verdict, output: verifierOutput });
        mission.verifierResult = {
          agentId: verifier.id,
          attempt,
          verdict,
          output: verifierOutput,
        };
        touchMissionImmediate(mission);

        if (verdict === "PASS") {
          verifierPassed = true;
          report("verifying", `Verifier PASS on attempt ${attempt}`);
          break;
        }

        if (verdict === "PARTIAL") {
          verifierPartial = true;
          report("verifying", `Verifier PARTIAL on attempt ${attempt}`);
          break;
        }

        if (attempt <= mission.maxVerifyRetries) {
          report("fixing", `Verifier FAIL on attempt ${attempt}; assigning fixes`);
          const fixPrompt = buildFixPrompt(mission, verifierOutput, attempt, mission.maxVerifyRetries);
          const fixResponse = await codex.sendToAgent(lead, fixPrompt);
          const fixAssignments = await parseFixAssignmentsWithRetry(fixResponse, mission.workerIds, lead, codex);
          if (fixAssignments.length === 0) {
            throw new Error(`Verifier failed on attempt ${attempt} and lead returned no fix assignments`);
          }

          const fixResults = await Promise.allSettled(
            fixAssignments.map(({ agentId, task }) => {
              const worker = team.agents.get(agentId);
              if (!worker) return Promise.reject(new Error(`Agent not found: ${agentId}`));
              return codex.sendToAgent(
                worker,
                buildFixTaskPrompt(mission, task, verifierOutput, attempt, mission.maxVerifyRetries),
              );
            }),
          );

          for (let i = 0; i < fixAssignments.length; i++) {
            const result = fixResults[i];
            const existing = mission.workerResults.find((workerResult) => workerResult.agentId === fixAssignments[i].agentId);
            if (existing) {
              existing.status = result.status === "fulfilled" ? "success" : "error";
              existing.output =
                result.status === "fulfilled"
                  ? (result.value as string)
                  : result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason);
            }
          }

          assertNoWorkerFailures(mission.workerResults, `Fix round ${attempt} failed`);
          report("verifying", `Re-running verifier after fix attempt ${attempt}`);
        }
      }

      if (!verifierPassed && !verifierPartial) {
        throw new Error(`Verifier reported FAIL after ${mission.verifierAttempts.length} attempt(s)`);
      }
      if (verifierPartial) {
        hasWorkerFailures = true;
        mission.error = `Verifier reported PARTIAL on attempt ${mission.verifierAttempts.length}`;
      }
    } else if (mission.verifyCommand) {
      report("verifying", `Running: ${mission.verifyCommand}`);
      let verificationPassed = false;

      const worktreeAgents = Array.from(team.agents.values()).filter((a) => a.worktreeBranch && a.worktreeGitRoot);
      const integrationBranch = worktreeAgents.length > 0 ? `integration-${mission.id.slice(0, 8)}` : null;

      for (let attempt = 1; attempt <= mission.maxVerifyRetries + 1; attempt++) {
        let verifyCwd = lead.cwd;

        if (integrationBranch && worktreeAgents.length > 0) {
          const wtBranches = worktreeAgents.map((a) => a.worktreeBranch!);
          const mergeResult = mergeWorktreeBranches(worktreeAgents[0].worktreeGitRoot!, integrationBranch, wtBranches);
          if (!mergeResult.ok) {
            mission.verificationLog.push({ attempt, passed: false, output: `Worktree merge conflict: ${mergeResult.error}` });
            if (attempt <= mission.maxVerifyRetries) {
              report("fixing", `Merge conflict from ${mergeResult.conflictBranch}, assigning fixes`);
              cleanupIntegrationBranch(worktreeAgents[0].worktreeGitRoot!, integrationBranch);
            }
            continue;
          }
        }

        const verification = await runVerifyCommand(mission.verifyCommand, verifyCwd);

        if (integrationBranch) {
          cleanupIntegrationBranch(worktreeAgents[0].worktreeGitRoot!, integrationBranch);
        }

        mission.verificationLog.push({
          attempt,
          passed: verification.passed,
          output: verification.output,
        });

        if (verification.passed) {
          verificationPassed = true;
          report("verifying", `Verification passed on attempt ${attempt}`);
          break;
        }

        if (attempt <= mission.maxVerifyRetries) {
          report("fixing", `Attempt ${attempt} failed, assigning fixes`);
          const fixPrompt = buildFixPrompt(mission, verification.output, attempt, mission.maxVerifyRetries);
          const fixResponse = await codex.sendToAgent(lead, fixPrompt);
          const fixAssignments = await parseFixAssignmentsWithRetry(fixResponse, mission.workerIds, lead, codex);
          if (fixAssignments.length === 0) {
            throw new Error(`Verification failed on attempt ${attempt} and lead returned no fix assignments`);
          }

          const fixResults = await Promise.allSettled(
            fixAssignments.map(({ agentId, task }) => {
              const worker = team.agents.get(agentId);
              if (!worker) return Promise.reject(new Error(`Agent not found: ${agentId}`));
              return codex.sendToAgent(
                worker,
                buildFixTaskPrompt(mission, task, verification.output, attempt, mission.maxVerifyRetries),
              );
            }),
          );

          for (let i = 0; i < fixAssignments.length; i++) {
            const r = fixResults[i];
            const existing = mission.workerResults.find((wr) => wr.agentId === fixAssignments[i].agentId);
            if (existing) {
              existing.status = r.status === "fulfilled" ? "success" : "error";
              existing.output =
                r.status === "fulfilled"
                  ? (r.value as string)
                  : r.reason instanceof Error
                    ? r.reason.message
                    : String(r.reason);
            }
          }

          assertNoWorkerFailures(mission.workerResults, `Fix round ${attempt} failed`);

          report("verifying", `Re-verifying after fix attempt ${attempt}`);
        }
      }

      if (!verificationPassed) {
        throw new Error(`Verification failed after ${mission.verificationLog.length} attempt(s)`);
      }
    }

    if (hasWorkerFailures) {
      if (!mission.error) {
        mission.error = `${initialWorkerFailures.length} worker(s) failed: ${initialWorkerFailures.map((f) => `${f.agentId}`).join(", ")}`;
      }
      report("completed_with_failures", mission.error);
    } else {
      report("completed");
    }
  } catch (error) {
    mission.phase = "error";
    mission.error = error instanceof Error ? error.message : String(error);
    syncMissionTeamState(mission.teamId, team);
    touchMissionImmediate(mission);
    onProgress?.({ phase: "error", detail: mission.error });
  } finally {
    staleMonitor.stop();
    flushPendingPersistence(mission);
    const terminalReason = mission.phase === "completed" || mission.phase === "completed_with_failures"
      ? "mission_completed"
      : mission.error ?? "mission_error";
    for (const agentState of mission.agentStates.values()) {
      agentState.isActive = false;
      agentState.lifecycle = agentState.status === "error" ? "error" : "terminated";
      agentState.terminalReason = agentState.terminalReason ?? terminalReason;
      agentState.terminationMode = agentState.terminationMode ?? (agentState.status === "error" ? "forced" : "graceful");
      agentState.lastSeenAt = new Date();
    }

    const agentIds = [mission.leadId, ...mission.workerIds];
    const commsAgentIds = [...agentIds];
    mission.comms = {
      groupChat: messages.getTeamChatMessages(mission.teamId),
      dms: messages.getAllDmMessages(commsAgentIds),
      leadChat: messages.getLeadChatMessages(commsAgentIds),
      protocol: messages.getAllProtocolMessages(commsAgentIds),
      sharedArtifacts: messages.getSharedArtifacts(mission.teamId),
    };
    const worktreeResults: WorktreeResult[] = [];
    for (const agent of team.agents.values()) {
      if (!agent.worktreePath || !agent.worktreeHeadCommit || !agent.worktreeGitRoot) continue;
      const changed = hasWorktreeChanges(agent.worktreePath, agent.worktreeHeadCommit);
      worktreeResults.push({
        agentId: agent.id,
        path: agent.worktreePath,
        branch: agent.worktreeBranch!,
        hasChanges: changed,
      });
      if (!changed) {
        removeWorktree(agent.worktreePath, agent.worktreeBranch!, agent.worktreeGitRoot);
      }
    }
    if (worktreeResults.length > 0) {
      mission.worktreeResults = worktreeResults;
    }

    messages.dissolveTeamWithAgents(mission.teamId, commsAgentIds);
    for (const id of agentIds) codex.cleanupAgent(id);
    if (mission.verifierId) codex.cleanupAgent(mission.verifierId);
    state.dissolveTeam(mission.teamId, { force: true });
    cleanupMissionCaches(mission.id, mission.taskListId);
    missions.delete(mission.id);
  }
}

export interface LaunchMissionParams {
  objective: string;
  workDir: string;
  team: Array<{
    role: string;
    specialization?: string;
    isLead?: boolean;
    sandbox?: "plan-mode" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
    model?: string;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    fastMode?: boolean;
    isolation?: IsolationMode;
    symlinkDirs?: string[];
  }>;
  hooks?: HookCommands;
  verifyCommand?: string;
  verifierRole?: string;
  maxVerifyRetries?: number;
  staleThresholdMs?: number;
}

export function createMission(
  params: LaunchMissionParams,
  state: TeamManager,
): { mission: MissionState; team: Team } {
  const leadCount = params.team.filter((t) => t.isLead).length;
  if (leadCount !== 1) {
    throw new Error(`Team must have exactly one lead (isLead: true), got ${leadCount}`);
  }

  const team = state.createTeam(
    `mission-${crypto.randomUUID().slice(0, 6)}`,
    params.team.map((t) => ({
      role: t.role,
      specialization: t.specialization,
      isLead: t.isLead,
      sandbox: t.sandbox,
      approvalPolicy: t.approvalPolicy,
      model: t.model,
      reasoningEffort: t.reasoningEffort,
      fastMode: t.fastMode,
      cwd: params.workDir,
      isolation: t.isLead ? undefined : t.isolation,
    })),
  );

  const agents = Array.from(team.agents.values());
  const lead = agents.find((a) => a.isLead);
  if (!lead) throw new Error("Failed to create lead agent");

  const hasWorktreeAgents = agents.some((a) => a.isolation === "worktree");
  if (hasWorktreeAgents) {
    const gitRoot = findGitRoot(params.workDir);
    if (!gitRoot) {
      throw new Error("--isolation worktree requires a git repository");
    }
    for (const agent of agents) {
      if (!agent.isolation || agent.isLead) continue;
      const memberConfig = params.team.find((t) => t.role === agent.role);
      const slug = agent.id.replace(/^[^-]+-/, "wt-");
      const info = createWorktree(gitRoot, slug, memberConfig?.symlinkDirs);
      agent.cwd = info.worktreePath;
      agent.worktreePath = info.worktreePath;
      agent.worktreeBranch = info.branch;
      agent.worktreeHeadCommit = info.headCommit;
      agent.worktreeGitRoot = info.gitRoot;
    }
  }

  const mission: MissionState = {
    id: crypto.randomUUID(),
    objective: params.objective,
    teamId: team.id,
    teamName: team.name,
    taskListId: team.taskListId,
    phase: "executing",
    leadId: lead.id,
    workerIds: agents.filter((a) => !a.isLead).map((a) => a.id),
    workerResults: [],
    verifyCommand: params.verifyCommand,
    verifierRole: params.verifierRole,
    verifierId: undefined,
    maxVerifyRetries: params.maxVerifyRetries ?? 2,
    verificationLog: [],
    verifierAttempts: [],
    verifierResult: undefined,
    leadOutput: "",
    staleThresholdMs: params.staleThresholdMs,
    planApprovals: [],
    shutdowns: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    agentStates: new Map(agents.map((agent) => [agent.id, toMissionAgentState(agent)])),
  };

  team.missionId = mission.id;
  team.hookCommands = params.hooks;

  state.initializeTaskList(team.id);
  missions.set(mission.id, mission);
  return { mission, team };
}

export function buildSteerPrompt(objective: string, directive: string): string {
  const scopedContext = renderScopedContext({
    window: "reentry",
    objective,
    assignedScope: [
      "Stop the previous line of work and switch to the new directive.",
      "Re-read only the minimal team context needed to resume correctly.",
      "Coordinate with teammates affected by the redirect.",
    ],
    essentialContextSources: [
      "The new directive below",
      "group_chat_read() for the orchestrator direction-change note",
      "task_list() / task_get() for the current backlog and ownership state",
      "protocol_read() and get_shared() for control-plane updates and published artifacts",
    ],
  });

  return `${scopedContext}

=== DIRECTION CHANGE FROM ORCHESTRATOR ===

Your previous task has been interrupted. Drop what you were doing and follow the new directive below.

=== NEW DIRECTIVE ===
${directive}

=== WHAT TO DO ===
1. Stop any current work immediately.
2. Read group_chat for context from the direction change.
3. Execute the new directive above.
4. Coordinate with teammates — they received the same redirect.`;
}

export async function shutdownTeammate(
  teamId: string,
  targetAgentId: string,
  requestedBy: string,
  reason: string | undefined,
  state: TeamManager,
  codex: CodexClientManager,
  messages: MessageSystem,
): Promise<ShutdownEvent> {
  const team = state.getTeam(teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);

  const target = team.agents.get(targetAgentId);
  if (!target) throw new Error(`Agent not found: ${targetAgentId}`);
  if (target.isLead) throw new Error(`Cannot shutdown lead agent: ${targetAgentId}`);

  const lead = Array.from(team.agents.values()).find((agent) => agent.isLead);
  if (!lead) throw new Error(`Lead not found for team: ${teamId}`);

  const requester = team.agents.get(requestedBy);
  const requesterId = requester?.id ?? requestedBy;
  const requesterRole = requester?.role ?? "Orchestrator";
  const approvalRecipient = requester ? requester.id : lead.id;

  messages.protocolSend(requesterId, targetAgentId, "shutdown_request", { reason });
  syncMissionControlPlaneState(teamId, targetAgentId, messages);
  updateMissionAgentState(teamId, targetAgentId, {
    lifecycle: "shutdown_requested",
    isActive: false,
    terminalReason: reason ?? "shutdown_requested",
    terminationMode: "graceful",
  });
  messages.protocolSend(targetAgentId, approvalRecipient, "shutdown_approved", {
    reason,
    autoApproved: true,
  });
  syncMissionControlPlaneState(teamId, approvalRecipient, messages);

  const aborted = codex.abortAgent(targetAgentId);
  codex.clearLock(targetAgentId);

  const recoveredTasks = recoverAgentTasks(teamId, targetAgentId, "shutdown", state);

  syncMissionTeamState(teamId, team);

  state.terminateAgent(teamId, targetAgentId);
  codex.cleanupAgent(targetAgentId);
  updateMissionAgentState(teamId, targetAgentId, {
    status: aborted ? "error" : "idle",
    lifecycle: "terminated",
    isActive: false,
    tasks: [],
    terminalReason: reason ?? "shutdown",
    terminationMode: aborted ? "forced" : "graceful",
  });

  const notification =
    recoveredTasks.length > 0
      ? `${target.id} shut down. ${buildRecoveredTaskSummary(target.id, "shutdown", recoveredTasks)}.`
      : `${target.id} shut down. No unresolved tasks needed recovery.`;

  messages.groupChatPost(teamId, requesterId, requesterRole, notification);

  const event: ShutdownEvent = {
    agentId: targetAgentId,
    requestedBy: requesterId,
    approvedBy: targetAgentId,
    reason,
    aborted,
    terminationMode: aborted ? "forced" : "graceful",
    recoveredTasks,
    notification,
    timestamp: new Date(),
  };

  const mission = getMissionByTeamId(teamId);
  if (mission) {
    mission.shutdowns.push(event);
    touchMissionImmediate(mission);
  }

  return event;
}

export async function steerTeam(
  teamId: string,
  directive: string,
  agentIds: string[] | undefined,
  state: TeamManager,
  codex: CodexClientManager,
  messages: MessageSystem,
): Promise<{ aborted: string[]; steered: string[]; failed: Array<{ agentId: string; error: string }> }> {
  const team = state.getTeam(teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);

  const targets = agentIds
    ? agentIds.map((id) => team.agents.get(id)).filter(Boolean)
    : Array.from(team.agents.values());

  if (targets.length === 0) {
    return { aborted: [], steered: [], failed: [] };
  }

  const targetIds = targets.map((a) => a!.id);
  const aborted = codex.abortTeam(targetIds);
  for (const id of aborted) {
    codex.clearLock(id);
    updateMissionAgentState(teamId, id, {
      status: "idle",
      lifecycle: "idle",
      isActive: false,
      terminalReason: undefined,
    });
  }

  messages.groupChatPost(teamId, "orchestrator", "Orchestrator", `=== DIRECTION CHANGE ===\n${directive}`);

  const steerPrompt = buildSteerPrompt(getMissionByTeamId(teamId)?.objective ?? "Updated mission directive", directive);
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

  return { aborted, steered, failed };
}
