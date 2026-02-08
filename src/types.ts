export type AgentStatus = "idle" | "working" | "error";
export type TaskStatus = "pending" | "in-progress" | "completed";
export type ApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "xhigh" | "high" | "medium" | "low";

export interface AgentConfig {
  role: string;
  specialization?: string;
  model?: string;
  sandbox?: SandboxMode;
  baseInstructions?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  isLead?: boolean;
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
  status: AgentStatus;
  lastOutput: string;
  tasks: string[];
}

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  assignedTo: string;
  result?: string;
  dependencies: string[];
  createdAt: Date;
  completedAt?: Date;
}

export interface Team {
  id: string;
  name: string;
  agents: Map<string, Agent>;
  tasks: Map<string, Task>;
  createdAt: Date;
}
