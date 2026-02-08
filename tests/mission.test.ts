import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { CodexClientManager } from "../src/codex-client.js";
import { createServer } from "../src/server.js";
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

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {});
}

function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, 50);
    };
    check();
  });
}

describe("launch_mission + mission_status (async model)", () => {
  let state: TeamManager;
  let codex: MockCodexClient;
  let messages: MessageSystem;
  let server: McpServer;

  beforeEach(() => {
    state = new TeamManager();
    codex = new MockCodexClient();
    messages = new MessageSystem();
    server = createServer(state, codex, messages);
  });

  it("returns missionId immediately", async () => {
    const result = await callTool(server, "launch_mission", {
      objective: "Build a login page",
      workDir: "/tmp/test",
      team: [{ role: "lead", isLead: true }, { role: "developer" }],
    });

    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.missionId);
    assert.ok(data.teamId);
    assert.ok(data.leadId);
    assert.equal(data.workerIds.length, 1);
    assert.equal(data.status, "launched");
  });

  it("spawns lead and workers simultaneously", async () => {
    codex.defaultResponse = "done";

    const result = await callTool(server, "launch_mission", {
      objective: "Build feature",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "frontend-dev" }, { role: "backend-dev" }],
    });

    const { leadId, workerIds } = JSON.parse(result.content[0].text);

    await waitFor(() => codex.calls.length >= 3);
    await new Promise((r) => setTimeout(r, 100));

    const calledAgentIds = codex.calls.map((c) => c.agentId);
    assert.ok(calledAgentIds.includes(leadId), "Lead should be called");
    for (const wid of workerIds) {
      assert.ok(calledAgentIds.includes(wid), `Worker ${wid} should be called`);
    }
  });

  it("lead prompt contains mission objective and comms instructions", async () => {
    codex.defaultResponse = "done";

    const result = await callTool(server, "launch_mission", {
      objective: "Implement OAuth flow",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "dev" }],
    });

    const { leadId } = JSON.parse(result.content[0].text);

    await waitFor(() => codex.calls.length >= 2);

    const leadCall = codex.calls.find((c) => c.agentId === leadId);
    assert.ok(leadCall, "Lead should be called");
    assert.ok(leadCall.message.includes("TEAM LEAD"), "Should contain TEAM LEAD");
    assert.ok(leadCall.message.includes("MISSION OBJECTIVE"), "Should contain MISSION OBJECTIVE");
    assert.ok(leadCall.message.includes("Implement OAuth flow"), "Should contain the objective");
    assert.ok(leadCall.message.includes("group_chat_post"), "Should mention group_chat_post");
  });

  it("worker prompt contains assignment instructions and team info", async () => {
    codex.defaultResponse = "done";

    const result = await callTool(server, "launch_mission", {
      objective: "Build API",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "dev" }],
    });

    const { leadId, workerIds } = JSON.parse(result.content[0].text);
    const workerId = workerIds[0];

    await waitFor(() => codex.calls.length >= 2);

    const workerCall = codex.calls.find((c) => c.agentId === workerId);
    assert.ok(workerCall, "Worker should be called");
    assert.ok(workerCall.message.includes(workerId), "Should contain worker's own ID");
    assert.ok(workerCall.message.includes(leadId), "Should contain lead ID");
    assert.ok(workerCall.message.includes("group_chat_read"), "Should mention group_chat_read");
  });

  it("mission completes with final report", async () => {
    codex.defaultResponse = "done";

    const result = await callTool(server, "launch_mission", {
      objective: "Quick task",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "worker" }],
    });

    const { missionId, leadId } = JSON.parse(result.content[0].text);

    codex.responseMap.set(leadId, [
      "lead initial done",
      "Final mission report: everything completed successfully",
    ]);

    await waitFor(() => {
      const statusCalls = codex.calls.filter((c) => c.agentId === leadId);
      return statusCalls.length >= 2;
    }, 10000);

    await new Promise((r) => setTimeout(r, 200));

    const statusResult = await callTool(server, "mission_status", { missionId });
    const status = JSON.parse(statusResult.content[0].text);
    assert.equal(status.phase, "completed");
    assert.ok(status.workerResults.length >= 1);
  });

  it("handles worker errors gracefully", async () => {
    let badWorkerId = "";
    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.role === "bad-worker") {
        badWorkerId = agent.id;
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "error";
        throw new Error("Worker crashed");
      }
      return origSend(agent, message);
    };

    const result = await callTool(server, "launch_mission", {
      objective: "Error handling test",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "good-worker" }, { role: "bad-worker" }],
    });

    const { missionId, leadId } = JSON.parse(result.content[0].text);

    await waitFor(() => {
      const leadCalls = codex.calls.filter((c) => c.agentId === leadId);
      return leadCalls.length >= 2;
    }, 10000);

    await new Promise((r) => setTimeout(r, 200));

    const statusResult = await callTool(server, "mission_status", { missionId });
    const status = JSON.parse(statusResult.content[0].text);
    assert.equal(status.phase, "completed");

    const badResult = status.workerResults.find((r: { agentId: string }) => r.agentId === badWorkerId);
    assert.ok(badResult, "Should have result for bad worker");
    assert.equal(badResult.status, "error");
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

    const launchResult = await callTool(server, "launch_mission", {
      objective: "Error test",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "dev" }],
    });

    const { missionId } = JSON.parse(launchResult.content[0].text);

    await waitFor(() => codex.calls.length >= 1, 3000);
    await new Promise((r) => setTimeout(r, 300));

    const statusResult = await callTool(server, "mission_status", { missionId });
    const status = JSON.parse(statusResult.content[0].text);
    assert.equal(status.phase, "error");
    assert.ok(status.error?.includes("Lead crashed"));
  });

  it("requires a lead in the team", async () => {
    const result = await callTool(server, "launch_mission", {
      objective: "No leader",
      workDir: "/tmp",
      team: [{ role: "worker-a" }, { role: "worker-b" }],
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("lead"));
  });

  it("mission_status returns error for unknown missionId", async () => {
    const result = await callTool(server, "mission_status", {
      missionId: "nonexistent-id",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("not found"));
  });

  it("runs verifyCommand after workers complete", async () => {
    codex.defaultResponse = "done";

    const result = await callTool(server, "launch_mission", {
      objective: "Build with verify",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "dev" }],
      verifyCommand: "echo 'all tests pass'",
    });

    const { missionId, leadId } = JSON.parse(result.content[0].text);

    await waitFor(() => {
      const leadCalls = codex.calls.filter((c) => c.agentId === leadId);
      return leadCalls.some((c) => c.message.includes("MISSION COMPILATION"));
    }, 10000);

    await new Promise((r) => setTimeout(r, 200));

    const statusResult = await callTool(server, "mission_status", { missionId });
    const status = JSON.parse(statusResult.content[0].text);
    assert.equal(status.phase, "completed");
    assert.ok(status.verificationLog.length >= 1);
    assert.equal(status.verificationLog[0].passed, true);

    const compilationCall = codex.calls.find(
      (c) => c.agentId === leadId && c.message.includes("VERIFICATION RESULTS"),
    );
    assert.ok(compilationCall, "Compilation prompt should include verification results");
  });

  it("retries verification on failure", async () => {
    codex.defaultResponse = "done";

    const result = await callTool(server, "launch_mission", {
      objective: "Build with failing verify",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "dev" }],
      verifyCommand: "echo 'pass' && true",
      maxVerifyRetries: 1,
    });

    const { missionId, leadId, workerIds } = JSON.parse(result.content[0].text);

    let verifyCallCount = 0;
    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("VERIFICATION FAILED")) {
        verifyCallCount++;
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const fixPlan = JSON.stringify([{ agentId: workerIds[0], task: "Fix the failing test" }]);
        agent.lastOutput = fixPlan;
        agent.status = "idle";
        return fixPlan;
      }
      return origSend(agent, message);
    };

    await waitFor(() => {
      const statusCalls = codex.calls.filter((c) => c.agentId === leadId);
      return statusCalls.some((c) => c.message.includes("MISSION COMPILATION"));
    }, 10000);

    await new Promise((r) => setTimeout(r, 200));

    const statusResult = await callTool(server, "mission_status", { missionId });
    const status = JSON.parse(statusResult.content[0].text);
    assert.equal(status.phase, "completed");
    assert.ok(status.verificationLog.length >= 1);
  });

  it("stops retrying after maxVerifyRetries", async () => {
    codex.defaultResponse = "done";

    const result = await callTool(server, "launch_mission", {
      objective: "Build with always-failing verify",
      workDir: "/tmp",
      team: [{ role: "lead", isLead: true }, { role: "dev" }],
      verifyCommand: "exit 1",
      maxVerifyRetries: 1,
    });

    const { missionId, leadId, workerIds } = JSON.parse(result.content[0].text);

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("VERIFICATION FAILED")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const fixPlan = JSON.stringify([{ agentId: workerIds[0], task: "Try to fix" }]);
        agent.lastOutput = fixPlan;
        agent.status = "idle";
        return fixPlan;
      }
      return origSend(agent, message);
    };

    await waitFor(() => {
      const leadCalls = codex.calls.filter((c) => c.agentId === leadId);
      return leadCalls.some((c) => c.message.includes("MISSION COMPILATION"));
    }, 10000);

    await new Promise((r) => setTimeout(r, 200));

    const statusResult = await callTool(server, "mission_status", { missionId });
    const status = JSON.parse(statusResult.content[0].text);
    assert.equal(status.phase, "completed");
    assert.ok(status.verificationLog.length <= 3);

    const lastVerification = status.verificationLog[status.verificationLog.length - 1];
    assert.equal(lastVerification.passed, false);

    const compilationCall = codex.calls.find((c) => c.agentId === leadId && c.message.includes("FAILED"));
    assert.ok(compilationCall, "Compilation should mention failure");
  });
});
