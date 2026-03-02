import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TeamManager } from "../src/state.js";
import { CodexClientManager } from "../src/codex-client.js";
import { createServer } from "../src/server.js";
import type { Agent } from "../src/types.js";

class MockCodexClient extends CodexClientManager {
  calls: Array<{ agentId: string; message: string }> = [];
  nextResponse = "mock response";

  override async connect() {}
  override async disconnect() {}
  override isConnected() {
    return true;
  }

  override async sendToAgent(agent: Agent, message: string): Promise<string> {
    this.calls.push({ agentId: agent.id, message });
    agent.status = "working";
    agent.threadId = agent.threadId ?? `thread-${agent.id}`;
    agent.lastOutput = this.nextResponse;
    agent.status = "idle";
    return this.nextResponse;
  }
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {});
}

describe("Tool Handlers (e2e with mock codex)", () => {
  let state: TeamManager;
  let codex: MockCodexClient;
  let server: McpServer;

  beforeEach(() => {
    state = new TeamManager();
    codex = new MockCodexClient();
    server = createServer(state, codex);
  });

  describe("create_team", () => {
    it("creates a team with specialized agents", async () => {
      const result = await callTool(server, "create_team", {
        name: "frontend",
        agents: [
          { role: "lead", isLead: true, specialization: "Frontend architecture" },
          { role: "component-dev", specialization: "React components" },
        ],
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.name, "frontend");
      assert.equal(data.agents.length, 2);
      assert.equal(data.agents[0].isLead, true);
      assert.equal(data.agents[0].reasoningEffort, "xhigh");
      assert.equal(data.agents[0].specialization, "Frontend architecture");
      assert.equal(data.agents[1].isLead, false);
      assert.equal(data.agents[1].reasoningEffort, "high");
    });
  });

  describe("dissolve_team", () => {
    it("dissolves an existing team", async () => {
      const team = state.createTeam("t", []);
      const result = await callTool(server, "dissolve_team", { teamId: team.id });
      assert.ok(result.content[0].text.includes("dissolved"));
    });

    it("returns error for nonexistent team", async () => {
      const result = await callTool(server, "dissolve_team", { teamId: "nope" });
      assert.equal(result.isError, true);
    });
  });

  describe("add_agent", () => {
    it("adds an agent to a team", async () => {
      const team = state.createTeam("t", []);
      const result = await callTool(server, "add_agent", {
        teamId: team.id,
        role: "tester",
        specialization: "E2E testing with Playwright",
      });

      const data = JSON.parse(result.content[0].text);
      assert.ok(data.id.startsWith("tester-"));
    });
  });

  describe("remove_agent", () => {
    it("removes an idle agent", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      const result = await callTool(server, "remove_agent", { teamId: team.id, agentId });
      assert.ok(result.content[0].text.includes("removed"));
    });

    it("rejects removing a working agent", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agent = Array.from(team.agents.values())[0];
      agent.status = "working";
      const result = await callTool(server, "remove_agent", { teamId: team.id, agentId: agent.id });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("working"));
    });
  });

  describe("list_agents", () => {
    it("lists agents with status", async () => {
      const team = state.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const result = await callTool(server, "list_agents", { teamId: team.id });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.length, 2);
      assert.ok(data[0].id);
      assert.equal(data[0].status, "idle");
    });
  });

  describe("send_message", () => {
    it("sends message and returns response", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      codex.nextResponse = "Hello from codex!";

      const result = await callTool(server, "send_message", {
        teamId: team.id,
        agentId,
        message: "Hi there",
      });

      assert.equal(result.content[0].text, "Hello from codex!");
      assert.equal(codex.calls.length, 1);
      assert.equal(codex.calls[0].message, "Hi there");
    });

    it("rejects when agent is working", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agent = Array.from(team.agents.values())[0];
      agent.status = "working";
      const result = await callTool(server, "send_message", {
        teamId: team.id,
        agentId: agent.id,
        message: "test",
      });
      assert.equal(result.isError, true);
    });

    it("returns error for nonexistent agent", async () => {
      const team = state.createTeam("t", []);
      const result = await callTool(server, "send_message", {
        teamId: team.id,
        agentId: "nope",
        message: "test",
      });
      assert.equal(result.isError, true);
    });
  });

  describe("broadcast", () => {
    it("broadcasts to all agents", async () => {
      const team = state.createTeam("t", [{ role: "a" }, { role: "b" }]);
      codex.nextResponse = "ack";

      const result = await callTool(server, "broadcast", {
        teamId: team.id,
        message: "global update",
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.length, 2);
      assert.equal(data[0].status, "success");
      assert.equal(data[1].status, "success");
      assert.equal(codex.calls.length, 2);
    });

    it("broadcasts to subset of agents", async () => {
      const team = state.createTeam("t", [{ role: "a" }, { role: "b" }, { role: "c" }]);
      const [id1] = Array.from(team.agents.keys());

      const result = await callTool(server, "broadcast", {
        teamId: team.id,
        message: "targeted",
        agentIds: [id1],
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.length, 1);
    });

    it("skips working agents", async () => {
      const team = state.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const [, agent2] = Array.from(team.agents.values());
      agent2.status = "working";

      const result = await callTool(server, "broadcast", {
        teamId: team.id,
        message: "test",
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.length, 1);
    });
  });

  describe("assign_task", () => {
    it("assigns and auto-starts task with no deps", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      codex.nextResponse = "task done";

      const result = await callTool(server, "assign_task", {
        teamId: team.id,
        agentId,
        description: "Build the login page",
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.status, "in-progress");
      assert.equal(data.hasPendingDependencies, false);
      assert.equal(codex.calls.length, 1);
    });

    it("keeps task pending when deps unmet", async () => {
      const team = state.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const [agentA, agentB] = Array.from(team.agents.keys());

      const taskA = state.createTask(team.id, agentA, "Task A");

      const result = await callTool(server, "assign_task", {
        teamId: team.id,
        agentId: agentB,
        description: "Task B",
        dependencies: [taskA.id],
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.hasPendingDependencies, true);
      assert.equal(data.status, "pending");
      assert.equal(codex.calls.length, 0);
    });
  });

  describe("task_status", () => {
    it("returns all tasks", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      state.createTask(team.id, agentId, "Task 1");
      state.createTask(team.id, agentId, "Task 2");

      const result = await callTool(server, "task_status", { teamId: team.id });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.length, 2);
    });
  });

  describe("complete_task", () => {
    it("completes task and triggers cascade", async () => {
      const team = state.createTeam("t", [{ role: "a" }, { role: "b" }]);
      const [agentA, agentB] = Array.from(team.agents.keys());

      const taskA = state.createTask(team.id, agentA, "Task A");
      state.createTask(team.id, agentB, "Task B", [taskA.id]);

      const agentARef = state.getAgent(team.id, agentA)!;
      agentARef.lastOutput = "A result";

      const result = await callTool(server, "complete_task", {
        teamId: team.id,
        taskId: taskA.id,
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.completed, taskA.id);
      assert.equal(data.triggeredTasks.length, 1);
    });

    it("uses explicit result over agent output", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agentId = Array.from(team.agents.keys())[0];
      const task = state.createTask(team.id, agentId, "Do thing");

      const result = await callTool(server, "complete_task", {
        teamId: team.id,
        taskId: task.id,
        result: "explicit result",
      });

      const data = JSON.parse(result.content[0].text);
      assert.ok(data.result.includes("explicit result"));
    });
  });

  describe("get_output", () => {
    it("returns agent's last output", async () => {
      const team = state.createTeam("t", [{ role: "dev" }]);
      const agent = Array.from(team.agents.values())[0];
      agent.lastOutput = "some output";

      const result = await callTool(server, "get_output", {
        teamId: team.id,
        agentId: agent.id,
      });

      const data = JSON.parse(result.content[0].text);
      assert.equal(data.output, "some output");
      assert.equal(data.role, "dev");
    });

    it("errors for nonexistent agent", async () => {
      const team = state.createTeam("t", []);
      const result = await callTool(server, "get_output", {
        teamId: team.id,
        agentId: "nope",
      });
      assert.equal(result.isError, true);
    });
  });

});
