import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";

describe("TeamManager", () => {
  let manager: TeamManager;

  beforeEach(() => {
    manager = new TeamManager();
  });

  describe("createTeam", () => {
    it("creates a team with agents", () => {
      const team = manager.createTeam("test-team", [{ role: "architect" }, { role: "worker" }]);

      assert.equal(team.name, "test-team");
      assert.equal(team.agents.size, 2);
      assert.ok(team.id);
      assert.ok(team.createdAt instanceof Date);

      const agents = Array.from(team.agents.values());
      assert.ok(agents[0].id.startsWith("architect-"));
      assert.ok(agents[1].id.startsWith("worker-"));
    });

    it("creates a team with zero agents", () => {
      const team = manager.createTeam("empty-team", []);
      assert.equal(team.agents.size, 0);
    });

    it("applies default values to agents", () => {
      const team = manager.createTeam("defaults", [{ role: "dev" }]);
      const agent = Array.from(team.agents.values())[0];

      assert.equal(agent.model, "gpt-5.3-codex");
      assert.equal(agent.sandbox, "workspace-write");
      assert.equal(agent.approvalPolicy, "never");
      assert.equal(agent.baseInstructions, "");
      const instructions = manager.buildInstructions(agent, team.id);
      assert.ok(instructions.includes("Team Member"));
      assert.equal(agent.specialization, "");
      assert.equal(agent.reasoningEffort, "high");
      assert.equal(agent.isLead, false);
      assert.equal(agent.status, "idle");
      assert.equal(agent.lastOutput, "");
      assert.equal(agent.threadId, null);
      assert.deepEqual(agent.tasks, []);
    });

    it("applies custom config to agents", () => {
      const team = manager.createTeam("custom", [
        {
          role: "lead",
          model: "o4-mini",
          sandbox: "read-only",
          baseInstructions: "Focus on architecture.",
          cwd: "/tmp/test",
          approvalPolicy: "on-request",
          isLead: true,
          specialization: "System architecture",
        },
      ]);
      const agent = Array.from(team.agents.values())[0];

      assert.equal(agent.model, "o4-mini");
      assert.equal(agent.sandbox, "read-only");
      assert.equal(agent.cwd, "/tmp/test");
      assert.equal(agent.approvalPolicy, "on-request");
      assert.equal(agent.isLead, true);
      assert.equal(agent.reasoningEffort, "xhigh");
      assert.equal(agent.specialization, "System architecture");
      assert.equal(agent.baseInstructions, "Focus on architecture.");
      const instructions = manager.buildInstructions(agent, team.id);
      assert.ok(instructions.includes("TEAM LEAD"));
      assert.ok(instructions.includes("System architecture"));
      assert.ok(instructions.includes("Focus on architecture."));
    });

    it("builds correct base instructions for specialized teammate", () => {
      const team = manager.createTeam("t", [
        { role: "frontend-dev", specialization: "React/TypeScript UI components" },
      ]);
      const agent = Array.from(team.agents.values())[0];

      assert.equal(agent.isLead, false);
      assert.equal(agent.reasoningEffort, "high");
      const instructions = manager.buildInstructions(agent, team.id);
      assert.ok(instructions.includes("Team Member"));
      assert.ok(instructions.includes("React/TypeScript UI components"));
    });

    it("creates multiple independent teams", () => {
      const t1 = manager.createTeam("team-1", [{ role: "a" }]);
      const t2 = manager.createTeam("team-2", [{ role: "b" }]);

      assert.notEqual(t1.id, t2.id);
      assert.equal(manager.listTeams().length, 2);
    });
  });

  describe("getTeam", () => {
    it("returns team by ID", () => {
      const created = manager.createTeam("t", []);
      const found = manager.getTeam(created.id);
      assert.equal(found?.id, created.id);
    });

    it("returns undefined for nonexistent team", () => {
      assert.equal(manager.getTeam("nonexistent"), undefined);
    });
  });

  describe("dissolveTeam", () => {
    it("dissolves an existing team", () => {
      const team = manager.createTeam("t", []);
      assert.equal(manager.dissolveTeam(team.id), true);
      assert.equal(manager.getTeam(team.id), undefined);
    });

    it("returns false for nonexistent team", () => {
      assert.equal(manager.dissolveTeam("nonexistent"), false);
    });
  });

  describe("listTeams", () => {
    it("returns empty array initially", () => {
      assert.deepEqual(manager.listTeams(), []);
    });

    it("returns all teams", () => {
      manager.createTeam("a", []);
      manager.createTeam("b", []);
      assert.equal(manager.listTeams().length, 2);
    });
  });

  describe("addAgent", () => {
    it("adds agent to existing team", () => {
      const team = manager.createTeam("t", []);
      const agent = manager.addAgent(team.id, { role: "new-agent" });

      assert.ok(agent.id.startsWith("new-agent-"));
      assert.equal(team.agents.size, 1);
      assert.equal(team.agents.get(agent.id)?.role, "new-agent");
    });

    it("throws for nonexistent team", () => {
      assert.throws(() => manager.addAgent("nonexistent", { role: "x" }), /Team not found/);
    });
  });

  describe("removeAgent", () => {
    it("removes an idle agent", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];

      assert.equal(manager.removeAgent(team.id, agentId), true);
      assert.equal(team.agents.size, 0);
    });

    it("throws when removing a working agent", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agent = Array.from(team.agents.values())[0];
      agent.status = "working";

      assert.throws(() => manager.removeAgent(team.id, agent.id), /currently working/);
    });

    it("returns false for nonexistent agent", () => {
      const team = manager.createTeam("t", []);
      assert.equal(manager.removeAgent(team.id, "nonexistent"), false);
    });

    it("throws for nonexistent team", () => {
      assert.throws(() => manager.removeAgent("nonexistent", "x"), /Team not found/);
    });
  });

  describe("getAgent", () => {
    it("returns agent by ID", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      const agent = manager.getAgent(team.id, agentId);

      assert.equal(agent?.role, "dev");
    });

    it("returns undefined for nonexistent agent", () => {
      const team = manager.createTeam("t", []);
      assert.equal(manager.getAgent(team.id, "nonexistent"), undefined);
    });

    it("returns undefined for nonexistent team", () => {
      assert.equal(manager.getAgent("nonexistent", "x"), undefined);
    });
  });

  describe("listAgents", () => {
    it("returns all agents in team", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const agents = manager.listAgents(team.id);
      assert.equal(agents.length, 2);
    });

    it("throws for nonexistent team", () => {
      assert.throws(() => manager.listAgents("nonexistent"), /Team not found/);
    });
  });

  describe("createTask", () => {
    it("creates a task assigned to agent", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];

      const task = manager.createTask(team.id, agentId, "Build feature X");

      assert.ok(task.id);
      assert.equal(task.description, "Build feature X");
      assert.equal(task.status, "pending");
      assert.equal(task.assignedTo, agentId);
      assert.deepEqual(task.dependencies, []);
      assert.ok(task.createdAt instanceof Date);
      assert.equal(task.completedAt, undefined);
      assert.equal(task.result, undefined);
    });

    it("creates a task with dependencies", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const [agentA, agentB] = Array.from(team.agents.keys());

      const taskA = manager.createTask(team.id, agentA, "Task A");
      const taskB = manager.createTask(team.id, agentB, "Task B", [taskA.id]);

      assert.deepEqual(taskB.dependencies, [taskA.id]);
    });

    it("adds task ID to agent's task list", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agent = Array.from(team.agents.values())[0];
      const task = manager.createTask(team.id, agent.id, "Do thing");

      assert.deepEqual(agent.tasks, [task.id]);
    });

    it("throws for nonexistent team", () => {
      assert.throws(() => manager.createTask("nonexistent", "x", "y"), /Team not found/);
    });

    it("throws for nonexistent agent", () => {
      const team = manager.createTeam("t", []);
      assert.throws(() => manager.createTask(team.id, "nonexistent", "y"), /Agent not found/);
    });
  });

  describe("completeTask", () => {
    it("marks task as completed with result", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      const task = manager.createTask(team.id, agentId, "Do thing");

      manager.completeTask(team.id, task.id, "Done!");

      assert.equal(task.status, "completed");
      assert.equal(task.result, "Done!");
      assert.ok(task.completedAt instanceof Date);
    });

    it("returns empty array when no tasks are unblocked", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      const task = manager.createTask(team.id, agentId, "Solo task");

      const unblocked = manager.completeTask(team.id, task.id, "result");
      assert.deepEqual(unblocked, []);
    });

    it("unblocks dependent task when single dependency completes", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const [agentA, agentB] = Array.from(team.agents.keys());

      const taskA = manager.createTask(team.id, agentA, "Task A");
      const taskB = manager.createTask(team.id, agentB, "Task B", [taskA.id]);

      const unblocked = manager.completeTask(team.id, taskA.id, "A done");

      assert.deepEqual(unblocked, [taskB.id]);
    });

    it("does not unblock task when only some dependencies complete", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }, { role: "c" }]);
      const [agentA, agentB, agentC] = Array.from(team.agents.keys());

      const taskA = manager.createTask(team.id, agentA, "Task A");
      const taskB = manager.createTask(team.id, agentB, "Task B");
      const taskC = manager.createTask(team.id, agentC, "Task C", [taskA.id, taskB.id]);

      const unblocked = manager.completeTask(team.id, taskA.id, "A done");
      assert.deepEqual(unblocked, []);
      assert.equal(taskC.status, "pending");
    });

    it("unblocks task when ALL dependencies complete", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }, { role: "c" }]);
      const [agentA, agentB, agentC] = Array.from(team.agents.keys());

      const taskA = manager.createTask(team.id, agentA, "Task A");
      const taskB = manager.createTask(team.id, agentB, "Task B");
      const taskC = manager.createTask(team.id, agentC, "Task C", [taskA.id, taskB.id]);

      manager.completeTask(team.id, taskA.id, "A done");
      const unblocked = manager.completeTask(team.id, taskB.id, "B done");

      assert.deepEqual(unblocked, [taskC.id]);
    });

    it("unblocks multiple tasks in a fan-out pattern", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }, { role: "c" }]);
      const [agentA, agentB, agentC] = Array.from(team.agents.keys());

      const taskA = manager.createTask(team.id, agentA, "Root task");
      const taskB = manager.createTask(team.id, agentB, "Child 1", [taskA.id]);
      const taskC = manager.createTask(team.id, agentC, "Child 2", [taskA.id]);

      const unblocked = manager.completeTask(team.id, taskA.id, "root done");

      assert.equal(unblocked.length, 2);
      assert.ok(unblocked.includes(taskB.id));
      assert.ok(unblocked.includes(taskC.id));
    });

    it("does not unblock already completed or in-progress tasks", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const [agentA, agentB] = Array.from(team.agents.keys());

      const taskA = manager.createTask(team.id, agentA, "Task A");
      const taskB = manager.createTask(team.id, agentB, "Task B", [taskA.id]);
      taskB.status = "in-progress";

      const unblocked = manager.completeTask(team.id, taskA.id, "A done");
      assert.deepEqual(unblocked, []);
    });

    it("handles diamond dependency pattern", () => {
      const team = manager.createTeam("t", [{ role: "a" }, { role: "b" }, { role: "c" }, { role: "d" }]);
      const [aId, bId, cId, dId] = Array.from(team.agents.keys());

      const taskA = manager.createTask(team.id, aId, "Root");
      const taskB = manager.createTask(team.id, bId, "Left", [taskA.id]);
      const taskC = manager.createTask(team.id, cId, "Right", [taskA.id]);
      const taskD = manager.createTask(team.id, dId, "Join", [taskB.id, taskC.id]);

      let unblocked = manager.completeTask(team.id, taskA.id, "root");
      assert.equal(unblocked.length, 2);

      unblocked = manager.completeTask(team.id, taskB.id, "left");
      assert.deepEqual(unblocked, []);

      unblocked = manager.completeTask(team.id, taskC.id, "right");
      assert.deepEqual(unblocked, [taskD.id]);
    });

    it("throws for nonexistent team", () => {
      assert.throws(() => manager.completeTask("nonexistent", "x", "y"), /Team not found/);
    });

    it("throws for nonexistent task", () => {
      const team = manager.createTeam("t", []);
      assert.throws(() => manager.completeTask(team.id, "nonexistent", "y"), /Task not found/);
    });
  });

  describe("listTasks", () => {
    it("returns all tasks", () => {
      const team = manager.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];

      manager.createTask(team.id, agentId, "Task 1");
      manager.createTask(team.id, agentId, "Task 2");

      assert.equal(manager.listTasks(team.id).length, 2);
    });

    it("returns empty array when no tasks", () => {
      const team = manager.createTeam("t", []);
      assert.deepEqual(manager.listTasks(team.id), []);
    });

    it("throws for nonexistent team", () => {
      assert.throws(() => manager.listTasks("nonexistent"), /Team not found/);
    });
  });

  describe("agent ID uniqueness", () => {
    it("generates unique IDs for agents with same role", () => {
      const team = manager.createTeam("t", [{ role: "worker" }, { role: "worker" }, { role: "worker" }]);
      const ids = Array.from(team.agents.keys());
      const uniqueIds = new Set(ids);
      assert.equal(uniqueIds.size, 3);
    });
  });
});
