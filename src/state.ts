import crypto from "node:crypto";
import type { Agent, AgentConfig, Task, Team } from "./types.js";
import { buildInstructions as buildInstructionsImpl } from "./instructions.js";

export class TeamManager {
  private teams: Map<string, Team> = new Map();

  createTeam(name: string, agentConfigs: AgentConfig[]): Team {
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
      createdAt: new Date(),
    };

    this.teams.set(teamId, team);
    return team;
  }

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  dissolveTeam(teamId: string): boolean {
    return this.teams.delete(teamId);
  }

  listTeams(): Team[] {
    return Array.from(this.teams.values());
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

    const agent = team.agents.get(agentId);
    if (!agent) return false;
    if (agent.status === "working") throw new Error(`Agent ${agentId} is currently working`);
    if (agent.tasks.length > 0)
      throw new Error(`Agent ${agentId} has ${agent.tasks.length} assigned task(s)`);

    return team.agents.delete(agentId);
  }

  getAgent(teamId: string, agentId: string): Agent | undefined {
    return this.teams.get(teamId)?.agents.get(agentId);
  }

  listAgents(teamId: string): Agent[] {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return Array.from(team.agents.values());
  }

  createTask(teamId: string, agentId: string, description: string, dependencies: string[] = []): Task {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const agent = team.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const taskId = crypto.randomUUID();
    const task: Task = {
      id: taskId,
      description,
      status: "pending",
      assignedTo: agentId,
      dependencies,
      createdAt: new Date(),
    };

    team.tasks.set(taskId, task);
    agent.tasks.push(taskId);
    return task;
  }

  completeTask(teamId: string, taskId: string, result?: string): string[] {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const task = team.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    task.status = "completed";
    task.result = result;
    task.completedAt = new Date();

    const unblockedTaskIds: string[] = [];
    for (const [, candidate] of team.tasks) {
      if (candidate.status !== "pending" || candidate.dependencies.length === 0) continue;
      if (!candidate.dependencies.includes(taskId)) continue;

      const allDepsCompleted = candidate.dependencies.every((depId) => {
        const dep = team.tasks.get(depId);
        return dep?.status === "completed";
      });

      if (allDepsCompleted) {
        unblockedTaskIds.push(candidate.id);
      }
    }

    return unblockedTaskIds;
  }

  listTasks(teamId: string): Task[] {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return Array.from(team.tasks.values());
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
      model: config.model ?? "gpt-5.3-codex",
      sandbox: config.sandbox ?? "workspace-write",
      baseInstructions: config.baseInstructions ?? "",
      cwd: config.cwd ?? process.cwd(),
      approvalPolicy: config.approvalPolicy ?? "never",
      reasoningEffort: config.reasoningEffort ?? (isLead ? "xhigh" : "high"),
      isLead,
      status: "idle",
      lastOutput: "",
      tasks: [],
    };
  }
}
