import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { CodexClientManager } from "../src/codex-client.js";
import {
  createMission,
  runMission,
  getMission,
  buildLeadPrompt,
  buildWorkerPrompt,
  buildFixPrompt,
  runVerifyCommand,
} from "../src/mission.js";
import type { Agent } from "../src/types.js";

class MockCodexClient extends CodexClientManager {
  calls: Array<{ agentId: string; message: string }> = [];
  responseMap: Map<string, string[]> = new Map();
  defaultResponse = "mock response";

  override async connect() {}
  override async disconnect() {}
  override isConnected() {
    return true;
  }

  override async sendToAgent(agent: Agent, message: string): Promise<string> {
    this.calls.push({ agentId: agent.id, message });
    agent.status = "working";
    agent.threadId = agent.threadId ?? `thread-${agent.id}`;

    const queue = this.responseMap.get(agent.id);
    const response = queue && queue.length > 0 ? queue.shift()! : this.defaultResponse;

    agent.lastOutput = response;
    agent.status = "idle";
    return response;
  }
}

describe("createMission + runMission", () => {
  let state: TeamManager;
  let codex: MockCodexClient;
  let messages: MessageSystem;

  beforeEach(() => {
    state = new TeamManager();
    codex = new MockCodexClient();
    messages = new MessageSystem();
  });

  it("creates a mission with correct structure", () => {
    const { mission, team } = createMission(
      {
        objective: "Build a login page",
        workDir: "/tmp/test",
        team: [{ role: "lead", isLead: true }, { role: "developer" }],
      },
      state,
    );

    assert.ok(mission.id);
    assert.ok(mission.teamId);
    assert.ok(mission.leadId);
    assert.equal(mission.workerIds.length, 1);
    assert.equal(mission.phase, "executing");
    assert.equal(team.agents.size, 2);
  });

  it("spawns lead and workers simultaneously", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Build feature",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "frontend-dev" }, { role: "backend-dev" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    const calledAgentIds = codex.calls.map((c) => c.agentId);
    assert.ok(calledAgentIds.includes(mission.leadId), "Lead should be called");
    for (const wid of mission.workerIds) {
      assert.ok(calledAgentIds.includes(wid), `Worker ${wid} should be called`);
    }
  });

  it("lead prompt contains mission objective and comms instructions", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Implement OAuth flow",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "dev" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    const leadCall = codex.calls.find((c) => c.agentId === mission.leadId);
    assert.ok(leadCall, "Lead should be called");
    assert.ok(leadCall.message.includes("TEAM LEAD"), "Should contain TEAM LEAD");
    assert.ok(leadCall.message.includes("MISSION OBJECTIVE"), "Should contain MISSION OBJECTIVE");
    assert.ok(leadCall.message.includes("Implement OAuth flow"), "Should contain the objective");
    assert.ok(leadCall.message.includes("group_chat"), "Should mention group_chat");
  });

  it("worker prompt contains assignment instructions and team info", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Build API",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "dev" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    const workerId = mission.workerIds[0];
    const workerCall = codex.calls.find((c) => c.agentId === workerId);
    assert.ok(workerCall, "Worker should be called");
    assert.ok(workerCall.message.includes(workerId), "Should contain worker's own ID");
    assert.ok(workerCall.message.includes("group_chat_read"), "Should mention group_chat_read");
  });

  it("mission completes with lead output and worker results", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Quick task",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "worker" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
    assert.ok(mission.leadOutput);
    assert.ok(mission.workerResults);
    assert.equal(mission.workerResults.length, 1);
  });

  it("handles worker errors gracefully", async () => {
    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.role === "bad-worker") {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "error";
        throw new Error("Worker crashed");
      }
      return origSend(agent, message);
    };

    const { mission, team } = createMission(
      {
        objective: "Error handling test",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "good-worker" }, { role: "bad-worker" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
  });

  it("handles lead error gracefully", async () => {
    codex.sendToAgent = async (agent: Agent, message: string) => {
      codex.calls.push({ agentId: agent.id, message });
      if (agent.isLead) {
        agent.status = "error";
        throw new Error("Lead crashed");
      }
      agent.status = "working";
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      agent.lastOutput = "worker done";
      agent.status = "idle";
      return "worker done";
    };

    const { mission, team } = createMission(
      {
        objective: "Error test",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "dev" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
    assert.ok(mission.leadOutput?.includes("Lead crashed"));
  });

  it("requires a lead in the team", () => {
    assert.throws(
      () =>
        createMission(
          {
            objective: "No leader",
            workDir: "/tmp",
            team: [{ role: "worker-a" }, { role: "worker-b" }],
          },
          state,
        ),
      /lead/i,
    );
  });

  it("runs verifyCommand after workers complete", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Build with verify",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "dev" }],
        verifyCommand: "echo 'all tests pass'",
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
    assert.ok(mission.verificationLog);
    assert.ok(mission.verificationLog.length > 0);
    assert.equal(mission.verificationLog[0].passed, true);
  });

  it("retries verification on failure", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Build with failing verify",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "dev" }],
        verifyCommand: "echo 'pass' && true",
        maxVerifyRetries: 1,
      },
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("VERIFICATION FAILED")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const fixPlan = JSON.stringify([{ agentId: mission.workerIds[0], task: "Fix the failing test" }]);
        agent.lastOutput = fixPlan;
        agent.status = "idle";
        return fixPlan;
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
  });

  it("stops retrying after maxVerifyRetries", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Build with always-failing verify",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "dev" }],
        verifyCommand: "exit 1",
        maxVerifyRetries: 1,
      },
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("VERIFICATION FAILED")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const fixPlan = JSON.stringify([{ agentId: mission.workerIds[0], task: "Try to fix" }]);
        agent.lastOutput = fixPlan;
        agent.status = "idle";
        return fixPlan;
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
    assert.ok(mission.verificationLog);
    assert.ok(mission.verificationLog.length > 0);
    assert.equal(mission.verificationLog[mission.verificationLog.length - 1].passed, false);
  });
});
