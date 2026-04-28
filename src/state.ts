import crypto from "node:crypto";
import type { Agent, AgentConfig, AgentLifecycleState, AgentStatus, Task, Team } from "./types.js";
import { buildInstructions as buildInstructionsImpl } from "./instructions.js";
import { TaskStore } from "./task-store.js";

function normalizeAgentRuntimeState(agent: Agent): void {
  if (agent.status === "error" || agent.lifecycle === "error") {
    agent.status = "error";
    agent.lifecycle = "error";
    agent.isActive = false;
    return;
  }

  if (agent.lifecycle === "working") {
    agent.status = "working";
    agent.isActive = true;
    return;
  }

  if (agent.status === "working") {
    agent.status = "idle";
  }

  if (agent.lifecycle === "waiting_plan_approval") {
    agent.awaitingPlanApproval = true;
  }

  if (agent.lifecycle === "terminated") {
    agent.awaitingPlanApproval = false;
  }

  agent.isActive = false;
}

export class TeamManager {
  private teams: Map<string, Team> = new Map();
  private taskStores: Map<string, TaskStore> = new Map();

  constructor(private readonly taskStoreRootDir?: string) {}

  createTeam(name: string, agentConfigs: AgentConfig[]): Team {
    for (const existingTeam of this.teams.values()) {
      const existingLead = Array.from(existingTeam.agents.values()).find(
        (agent) => agent.isLead && (agent.isActive || agent.status === "working"),
      );
      if (existingLead) {
        throw new Error(
          `Cannot create team: an active team already exists (${existingTeam.id}) with lead ${existingLead.id}. Only one team per leader session is allowed.`,
        );
      }
    }

    const teamId = crypto.randomUUID();
    const agents = new Map<string, Agent>();

    for (const config of agentConfigs) {
      const agent = this.buildAgent(config);
      agents.set(agent.id, agent);
    }

    const team: Team = {
      id: teamId,
      name,
      agents,
      tasks: new Map(),
      taskListId: teamId,
      createdAt: new Date(),
    };

    this.teams.set(teamId, team);
    return team;
  }

  getTeam(teamId: string): Team | undefined {
    const team = this.teams.get(teamId);
    if (!team) return undefined;
    this.syncTeamTasks(team);
    return team;
  }

  dissolveTeam(teamId: string, options?: { force?: boolean }): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;

    if (!options?.force) {
      const activeMembers = Array.from(team.agents.values()).filter(
        (agent) => agent.isActive || agent.status === "working",
      );
      if (activeMembers.length > 0) {
        throw new Error(
          `Cannot dissolve team ${teamId}: ${activeMembers.length} active member(s) remain (${activeMembers.map((a) => a.id).join(", ")}). Shut them down first or use force.`,
        );
      }
    }

    this.getTaskStore(team).deleteTaskList();
    this.taskStores.delete(teamId);
    return this.teams.delete(teamId);
  }

  listTeams(): Team[] {
    const teams = Array.from(this.teams.values());
    for (const team of teams) this.syncTeamTasks(team);
    return teams;
  }

  addAgent(teamId: string, config: AgentConfig): Agent {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const agent = this.buildAgent(config);
    team.agents.set(agent.id, agent);
    return agent;
  }

  removeAgent(teamId: string, agentId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    this.syncTeamTasks(team);

    const agent = team.agents.get(agentId);
    if (!agent) return false;
    if (agent.status === "working") throw new Error(`Agent ${agentId} is currently working`);
    if (agent.tasks.length > 0)
      throw new Error(`Agent ${agentId} has ${agent.tasks.length} assigned task(s)`);

    return team.agents.delete(agentId);
  }

  terminateAgent(teamId: string, agentId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    this.syncTeamTasks(team);

    return team.agents.delete(agentId);
  }

  getAgent(teamId: string, agentId: string): Agent | undefined {
    return this.teams.get(teamId)?.agents.get(agentId);
  }

  listAgents(teamId: string): Agent[] {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    this.syncTeamTasks(team);
    return Array.from(team.agents.values());
  }

  initializeTaskList(teamId: string): string {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const taskStore = this.getTaskStore(team);
    const taskListPath = taskStore.initTaskList();
    this.syncTeamTasks(team);
    return taskListPath;
  }

  createTask(teamId: string, agentId: string, description: string, dependencies: string[] = []): Task {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const agent = team.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const task = this.getTaskStore(team).createTask({
      subject: description,
      description,
      owner: agentId,
      dependencies,
    });
    this.syncTeamTasks(team);
    return team.tasks.get(task.id)!;
  }

  completeTask(teamId: string, taskId: string, result?: string): string[] {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const before = new Map(this.listTasks(teamId).map((task) => [task.id, task]));
    this.getTaskStore(team).updateTask(taskId, { status: "completed", result });
    this.syncTeamTasks(team);

    const unblockedTaskIds: string[] = [];
    for (const candidate of team.tasks.values()) {
      const previous = before.get(candidate.id);
      if (!previous) continue;
      if (!candidate.dependencies.includes(taskId)) continue;
      if (previous.status !== "pending" || previous.blockedBy.length === 0) continue;
      if (candidate.status === "pending" && candidate.blockedBy.length === 0) {
        unblockedTaskIds.push(candidate.id);
      }
    }
    return unblockedTaskIds;
  }

  listTasks(teamId: string): Task[] {
    return this.listTasksFiltered(teamId, { includeCompleted: true });
  }

  listTasksFiltered(
    teamId: string,
    filters?: { status?: Task["status"]; owner?: string | null; includeCompleted?: boolean },
  ): Task[] {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    this.syncTeamTasks(team);
    let tasks = Array.from(team.tasks.values());

    if (!filters?.includeCompleted && filters?.status === undefined) {
      tasks = tasks.filter((task) => task.status !== "completed");
    }
    if (filters?.status !== undefined) {
      tasks = tasks.filter((task) => task.status === filters.status);
    }
    if (filters?.owner !== undefined) {
      tasks = tasks.filter((task) => task.owner === filters.owner);
    }

    return tasks;
  }

  getTask(teamId: string, taskId: string): Task | undefined {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    this.syncTeamTasks(team);
    return team.tasks.get(taskId);
  }

  deleteTask(teamId: string, taskId: string): void {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    this.getTaskStore(team).deleteTask(taskId);
    this.syncTeamTasks(team);
  }

  updateTask(
    teamId: string,
    taskId: string,
    input: { subject?: string; description?: string; activeForm?: string; status?: Task["status"]; owner?: string | null; result?: string },
  ): Task {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const task = this.getTaskStore(team).updateTask(taskId, input);
    this.syncTeamTasks(team);
    return team.tasks.get(task.id)!;
  }

  claimTask(teamId: string, taskId: string, agentId: string, checkAgentBusy = false): Task | null {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    if (!team.agents.has(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const task = this.getTaskStore(team).claimTask(taskId, agentId, { checkAgentBusy });
    this.syncTeamTasks(team);
    return task ? team.tasks.get(task.id)! : null;
  }

  resetTask(teamId: string, taskId: string): Task {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const task = this.getTaskStore(team).resetTask(taskId);
    this.syncTeamTasks(team);
    return team.tasks.get(task.id)!;
  }

  unassignTask(teamId: string, taskId: string): Task {
    return this.resetTask(teamId, taskId);
  }

  unassignTasksForAgent(teamId: string, agentId: string): Task[] {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    if (!team.agents.has(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const tasks = this.getTaskStore(team).unassignTasksForAgent(agentId);
    this.syncTeamTasks(team);
    return tasks.map((task) => team.tasks.get(task.id)!).filter(Boolean);
  }

  buildInstructions(agent: Agent, teamId: string): string {
    const team = this.teams.get(teamId);
    if (!team) return agent.baseInstructions;

    const otherTeams = this.listTeams().filter((t) => t.id !== teamId);
    return buildInstructionsImpl(agent, team, otherTeams);
  }

  private buildAgent(config: AgentConfig): Agent {
    const isLead = config.isLead ?? false;
    const specialization = config.specialization ?? "";

    return {
      id: `${config.role}-${crypto.randomUUID().slice(0, 12)}`,
      role: config.role,
      specialization,
      threadId: null,
      model: config.model ?? "gpt-5.4",
      sandbox: config.sandbox ?? "workspace-write",
      baseInstructions: config.baseInstructions ?? "",
      cwd: config.cwd ?? process.cwd(),
      approvalPolicy: config.approvalPolicy ?? "never",
      reasoningEffort: config.reasoningEffort ?? (isLead ? "xhigh" : "high"),
      isLead,
      fastMode: config.fastMode ?? false,
      status: "idle",
      lifecycle: "created",
      isActive: false,
      awaitingPlanApproval: false,
      lastSeenAt: new Date(),
      lastOutput: "",
      tasks: [],
      isolation: config.isolation,
    };
  }

  setAwaitingPlanApproval(teamId: string, agentId: string, awaiting: boolean): void {
    const agent = this.getAgent(teamId, agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    agent.awaitingPlanApproval = awaiting;
    agent.lastSeenAt = new Date();
    if (awaiting) {
      agent.lifecycle = "waiting_plan_approval";
      agent.isActive = false;
      agent.terminalReason = undefined;
      normalizeAgentRuntimeState(agent);
      return;
    }

    if (agent.lifecycle === "waiting_plan_approval") {
      agent.lifecycle = agent.status === "working" ? "working" : agent.status === "error" ? "error" : "idle";
      agent.isActive = agent.status === "working";
    }
    normalizeAgentRuntimeState(agent);
  }

  updateAgentRuntime(
    teamId: string,
    agentId: string,
    input: {
      status?: AgentStatus;
      lifecycle?: AgentLifecycleState;
      isActive?: boolean;
      awaitingPlanApproval?: boolean;
      threadId?: string | null;
      lastOutput?: string;
      terminalReason?: string | null;
    },
  ): Agent {
    const agent = this.getAgent(teamId, agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    if (input.status !== undefined) agent.status = input.status;
    if (input.lifecycle !== undefined) agent.lifecycle = input.lifecycle;
    if (input.isActive !== undefined) agent.isActive = input.isActive;
    if (input.awaitingPlanApproval !== undefined) agent.awaitingPlanApproval = input.awaitingPlanApproval;
    if (input.threadId !== undefined) agent.threadId = input.threadId;
    if (input.lastOutput !== undefined) agent.lastOutput = input.lastOutput;
    if (input.terminalReason !== undefined) {
      agent.terminalReason = input.terminalReason ?? undefined;
    }
    normalizeAgentRuntimeState(agent);
    agent.lastSeenAt = new Date();
    return agent;
  }

  private getTaskStore(team: Team): TaskStore {
    let taskStore = this.taskStores.get(team.id);
    if (!taskStore) {
      taskStore = new TaskStore(team.taskListId, this.taskStoreRootDir);
      this.taskStores.set(team.id, taskStore);
    }
    return taskStore;
  }

  private syncTeamTasks(team: Team): void {
    const taskStore = this.getTaskStore(team);
    const tasks = taskStore.listTasks();
    team.tasks = new Map(tasks.map((task) => [task.id, task]));

    for (const agent of team.agents.values()) {
      agent.tasks = tasks.filter((task) => task.owner === agent.id).map((task) => task.id);
    }
  }
}
