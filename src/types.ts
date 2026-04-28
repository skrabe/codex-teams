export type AgentStatus = "idle" | "working" | "error";
export type TaskStatus = "pending" | "in-progress" | "completed";
export type ApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type SandboxMode = "plan-mode" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal";
export type HookEvent = "TaskCreated" | "TaskCompleted" | "TeammateIdle";
export type AgentLifecycleState =
  | "created"
  | "working"
  | "idle"
  | "waiting_plan_approval"
  | "waiting_permission"
  | "shutdown_requested"
  | "terminated"
  | "error";

export interface HookCommands {
  taskCreated?: string;
  taskCompleted?: string;
  teammateIdle?: string;
  timeoutMs?: number;
}

export type IsolationMode = "worktree";

export interface AgentConfig {
  role: string;
  specialization?: string;
  model?: string;
  sandbox?: SandboxMode;
  baseInstructions?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  reasoningEffort?: ReasoningEffort;
  isLead?: boolean;
  fastMode?: boolean;
  isolation?: IsolationMode;
  symlinkDirs?: string[];
}

export interface Agent {
  id: string;
  role: string;
  specialization: string;
  threadId: string | null;
  model: string;
  sandbox: SandboxMode;
  baseInstructions: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  reasoningEffort: ReasoningEffort;
  isLead: boolean;
  fastMode: boolean;
  status: AgentStatus;
  lifecycle: AgentLifecycleState;
  isActive: boolean;
  awaitingPlanApproval: boolean;
  lastSeenAt: Date;
  terminalReason?: string;
  lastOutput: string;
  tasks: string[];
  isolation?: IsolationMode;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeHeadCommit?: string;
  worktreeGitRoot?: string;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner: string | null;
  result?: string;
  dependencies: string[];
  blockedBy: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface Team {
  id: string;
  name: string;
  agents: Map<string, Agent>;
  tasks: Map<string, Task>;
  taskListId: string;
  missionId?: string;
  hookCommands?: HookCommands;
  createdAt: Date;
}
