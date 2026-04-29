import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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
  shutdownTeammate,
  recordPlanApproval,
  extractJsonArray,
} from "../src/mission.js";
import type { LaunchMissionParams } from "../src/mission.js";
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

function missionParams(overrides: Partial<LaunchMissionParams> = {}): LaunchMissionParams {
  return {
    objective: overrides.objective ?? "Mission",
    workDir: overrides.workDir ?? "/tmp",
    team: overrides.team ?? [{ role: "lead", isLead: true }, { role: "dev" }],
    hooks: overrides.hooks,
    verifyCommand: overrides.verifyCommand,
    verifierRole: overrides.verifierRole,
    maxVerifyRetries: overrides.maxVerifyRetries,
  };
}

describe("createMission + runMission", () => {
  let state: TeamManager;
  let codex: MockCodexClient;
  let messages: MessageSystem;
  let taskStoreRoot: string;
  let protocolInboxRoot: string;

  beforeEach(() => {
    taskStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-mission-"));
    state = new TeamManager(taskStoreRoot);
    codex = new MockCodexClient();
    protocolInboxRoot = path.join(taskStoreRoot, "inboxes");
    messages = new MessageSystem(protocolInboxRoot);
  });

  afterEach(() => {
    fs.rmSync(taskStoreRoot, { recursive: true, force: true });
  });

  it("creates a mission with correct structure", () => {
    const { mission, team } = createMission(
      {
        objective: "Build a login page",
        workDir: "/tmp/test",
        team: [{ role: "lead", isLead: true }, { role: "developer" }],
        hooks: { taskCreated: "echo ok" },
      },
      state,
    );

    assert.ok(mission.id);
    assert.ok(mission.teamId);
    assert.ok(mission.taskListId);
    assert.ok(mission.leadId);
    assert.equal(mission.workerIds.length, 1);
    assert.equal(mission.phase, "executing");
    assert.equal(team.agents.size, 2);
    assert.equal(team.missionId, mission.id);
    assert.equal(team.hookCommands?.taskCreated, "echo ok");
    assert.ok(mission.createdAt instanceof Date);
    assert.ok(mission.updatedAt instanceof Date);
    assert.equal(mission.agentStates.size, 2);
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
    assert.ok(leadCall.message.includes("STARTUP CONTEXT"), "Should contain startup context section");
    assert.ok(leadCall.message.includes("ASSIGNED SCOPE"), "Should contain assigned scope");
    assert.ok(leadCall.message.includes("ESSENTIAL CONTEXT SOURCES"), "Should contain essential context sources");
    assert.ok(leadCall.message.includes("intentionally minimal"), "Should mention scoped context hygiene");
    assert.ok(leadCall.message.includes("group_chat"), "Should mention group_chat");
    assert.ok(leadCall.message.includes("task_create"), "Should mention task_create");
    assert.ok(leadCall.message.includes("task_list"), "Should mention task_list");
    assert.ok(leadCall.message.includes("shutdown_teammate"), "Should mention shutdown_teammate");
    assert.ok(leadCall.message.includes("permission_respond"), "Should mention permission_respond");
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
    assert.ok(workerCall.message.includes("STARTUP CONTEXT"), "Should contain startup context section");
    assert.ok(workerCall.message.includes("ASSIGNED SCOPE"), "Should contain assigned scope");
    assert.ok(workerCall.message.includes("ESSENTIAL CONTEXT SOURCES"), "Should contain essential context sources");
    assert.ok(workerCall.message.includes("Do not assume any hidden parent transcript"), "Should mention no hidden transcript");
    assert.ok(workerCall.message.includes("group_chat_read"), "Should mention group_chat_read");
    assert.ok(workerCall.message.includes("task_list"), "Should mention task_list");
    assert.ok(workerCall.message.includes("task_claim"), "Should mention task_claim");
    assert.ok(workerCall.message.includes("recommendedTaskId"), "Should mention recommendedTaskId heuristic");
    assert.ok(workerCall.message.includes("lowest unblocked pending task ID"), "Should mention lowest-ID selection");
    assert.ok(workerCall.message.includes("task_update"), "Should mention task_update");
    assert.ok(workerCall.message.includes("shutdown_request"), "Should mention shutdown_request");
    assert.ok(workerCall.message.includes("permission request"), "Should mention permission bridge behavior");
    assert.ok(workerCall.message.includes("Do not exit just because one task is done"), "Should mention long-lived loop");
  });

  it("plan-mode worker prompt requires approval before coding", () => {
    const { mission, team } = createMission(
      {
        objective: "Plan mode flow",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "planner", sandbox: "plan-mode" }],
      },
      state,
    );

    const worker = mission.workerIds.map((id) => team.agents.get(id)!).find((agent) => agent.sandbox === "plan-mode")!;
    const prompt = buildWorkerPrompt(mission, team, worker);

    assert.ok(prompt.includes("plan_approval_request"));
    assert.ok(prompt.includes("plan_approval_response"));
    assert.ok(prompt.includes("recommendedTaskId"));
    assert.ok(prompt.includes("lowest unblocked pending task ID"));
    assert.ok(prompt.includes("STARTUP CONTEXT"));
    assert.ok(prompt.includes("ESSENTIAL CONTEXT SOURCES"));
    assert.ok(prompt.includes("Do not implement anything until"));
    assert.ok(prompt.includes("shutdown_request"));
    assert.ok(prompt.includes("Do not exit just because one task is done"));
  });

  it("captures orchestrator shutdown protocol messages for workers", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Long lived workers",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "worker-a" }, { role: "worker-b" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    const shutdownMessages = mission.comms?.protocol.filter((message) => message.type === "shutdown_request") ?? [];
    assert.equal(shutdownMessages.length, mission.workerIds.length);
    assert.ok(shutdownMessages.every((message) => message.from === "orchestrator"));
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

  it("cleans up the task-list directory after mission completion", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      {
        objective: "Cleanup task list",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "worker" }],
      },
      state,
    );

    const taskListPath = path.join(taskStoreRoot, mission.taskListId);
    assert.ok(fs.existsSync(taskListPath));

    await runMission(mission, team, codex, state, messages);

    assert.equal(fs.existsSync(taskListPath), false);
    assert.equal(getMission(mission.id), undefined);
  });

  it("cleans up task-list files and in-memory mission state after lead failure", async () => {
    codex.sendToAgent = async (agent: Agent, message: string) => {
      codex.calls.push({ agentId: agent.id, message });
      if (agent.isLead) throw new Error("Lead crashed");
      return "worker done";
    };

    const { mission, team } = createMission(
      {
        objective: "Cleanup after failure",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "worker" }],
      },
      state,
    );

    const taskListPath = path.join(taskStoreRoot, mission.taskListId);
    assert.ok(fs.existsSync(taskListPath));

    await runMission(mission, team, codex, state, messages);

    assert.equal(fs.existsSync(taskListPath), false);
    assert.equal(getMission(mission.id), undefined);
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

    assert.equal(mission.phase, "completed_with_failures");
    assert.match(mission.error ?? "", /worker.*failed/i);
    assert.equal(mission.workerResults.some((result) => result.status === "error"), true);
  });

  it("treats shutdown grace aborts as successful forced termination", async () => {
    const previousGrace = process.env.CODEX_TEAMS_SHUTDOWN_GRACE_MS;
    process.env.CODEX_TEAMS_SHUTDOWN_GRACE_MS = "1";
    const aborts = new Map<string, () => void>();

    codex.sendToAgent = async (agent: Agent, message: string) => {
      codex.calls.push({ agentId: agent.id, message });
      agent.status = "working";
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      if (agent.isLead) {
        agent.lastOutput = "lead done";
        agent.status = "idle";
        return "lead done";
      }

      return new Promise<string>((_resolve, reject) => {
        aborts.set(agent.id, () => {
          agent.status = "error";
          reject(new Error("MCP error -32001: AbortError: This operation was aborted"));
        });
      });
    };
    codex.abortTeam = (agentIds: string[]) => {
      for (const agentId of agentIds) aborts.get(agentId)?.();
      return agentIds;
    };

    try {
      const { mission, team } = createMission(
        {
          objective: "Shutdown slow worker",
          workDir: "/tmp",
          team: [{ role: "lead", isLead: true }, { role: "worker" }],
        },
        state,
      );

      await runMission(mission, team, codex, state, messages);

      assert.equal(mission.phase, "completed");
      assert.equal(mission.workerResults.length, 1);
      assert.equal(mission.workerResults[0].status, "success");
      assert.equal(mission.agentStates.get(mission.workerIds[0])?.terminationMode, "forced");
      assert.equal(mission.agentStates.get(mission.workerIds[0])?.lifecycle, "terminated");
    } finally {
      if (previousGrace === undefined) {
        delete process.env.CODEX_TEAMS_SHUTDOWN_GRACE_MS;
      } else {
        process.env.CODEX_TEAMS_SHUTDOWN_GRACE_MS = previousGrace;
      }
    }
  });

  it("treats lead-approved shutdown aborts as successful forced termination", async () => {
    let activeMission: ReturnType<typeof createMission>["mission"];

    codex.sendToAgent = async (agent: Agent, message: string) => {
      codex.calls.push({ agentId: agent.id, message });
      agent.status = "working";
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      if (agent.isLead) {
        agent.lastOutput = "lead done";
        agent.status = "idle";
        return "lead done";
      }

      return new Promise<string>((_resolve, reject) => {
        setTimeout(() => {
          activeMission.shutdowns.push({
            agentId: agent.id,
            requestedBy: activeMission.leadId,
            approvedBy: agent.id,
            reason: "done",
            aborted: true,
            terminationMode: "forced",
            recoveredTasks: [],
            notification: "done",
            timestamp: new Date(),
          });
          reject(new Error("Codex agent worker error: MCP error -32001: AbortError: This operation was aborted"));
        }, 1);
      });
    };

    const created = createMission(
      {
        objective: "Lead shutdown",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "worker" }],
      },
      state,
    );
    activeMission = created.mission;

    await runMission(created.mission, created.team, codex, state, messages);

    assert.equal(created.mission.phase, "completed");
    assert.equal(created.mission.workerResults.length, 1);
    assert.equal(created.mission.workerResults[0].status, "success");
    assert.equal(created.mission.agentStates.get(created.mission.workerIds[0])?.terminationMode, "forced");
    assert.equal(created.mission.agentStates.get(created.mission.workerIds[0])?.lifecycle, "terminated");
  });

  it("fails mission when worker returns a hook-blocked error", async () => {
    codex.sendToAgent = async (agent: Agent, message: string) => {
      codex.calls.push({ agentId: agent.id, message });
      if (!agent.isLead) {
        agent.status = "error";
        throw new Error("[HOOK_BLOCK] TeammateIdle hook blocked for worker");
      }
      agent.status = "working";
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      agent.lastOutput = "lead done";
      agent.status = "idle";
      return "lead done";
    };

    const { mission, team } = createMission(
      {
        objective: "Hook block test",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "worker" }],
      },
      state,
    );

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "error");
    assert.match(mission.error ?? "", /\[HOOK_BLOCK\]/);
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

    assert.equal(mission.phase, "error");
    assert.match(mission.error ?? "", /Lead failed/);
    assert.ok(mission.leadOutput?.includes("Lead crashed"));
    assert.equal(mission.workerResults.length, 1);
  });

  it("records graceful shutdowns and recovers unfinished tasks", async () => {
    const { mission, team } = createMission(
      {
        objective: "Recover work from retired worker",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "worker-a" }, { role: "worker-b" }],
      },
      state,
    );

    const workers = mission.workerIds.map((id) => team.agents.get(id)!);
    const targetWorker = workers[0];
    const task = state.createTask(team.id, targetWorker.id, "Finish migration");

    const shutdown = await shutdownTeammate(
      team.id,
      targetWorker.id,
      mission.leadId,
      "scope finished",
      state,
      codex,
      messages,
    );

    assert.equal(shutdown.agentId, targetWorker.id);
    assert.equal(shutdown.requestedBy, mission.leadId);
    assert.equal(shutdown.recoveredTasks.length, 1);
    assert.equal(shutdown.recoveredTasks[0].id, task.id);
    assert.equal(shutdown.recoveredTasks[0].cause, "shutdown");
    assert.equal(shutdown.recoveredTasks[0].previousOwner, targetWorker.id);
    assert.equal(shutdown.terminationMode, "graceful");
    assert.equal(state.getAgent(team.id, targetWorker.id), undefined);

    const recoveredTask = state.getTask(team.id, task.id)!;
    assert.equal(recoveredTask.status, "pending");
    assert.equal(recoveredTask.owner, null);

    assert.equal(mission.shutdowns.length, 1);
    assert.equal(mission.shutdowns[0].agentId, targetWorker.id);
    assert.equal(mission.agentStates.get(targetWorker.id)?.lifecycle, "terminated");
    assert.equal(mission.agentStates.get(targetWorker.id)?.terminalReason, "scope finished");
    assert.equal(mission.agentStates.get(targetWorker.id)?.terminationMode, "graceful");
  });

  it("records plan approval events on the mission", () => {
    const { mission } = createMission(
      {
        objective: "Track approvals",
        workDir: "/tmp",
        team: [{ role: "lead", isLead: true }, { role: "planner", sandbox: "plan-mode" }],
      },
      state,
    );

    recordPlanApproval(mission.teamId, {
      agentId: mission.workerIds[0],
      leadId: mission.leadId,
      request: { summary: "Plan" },
      response: { approved: true },
      autoApproved: true,
      timestamp: new Date(),
    });

    assert.equal(mission.planApprovals.length, 1);
    assert.equal(mission.planApprovals[0].agentId, mission.workerIds[0]);
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
      missionParams({
        objective: "Build with verify",
        verifyCommand: "echo 'all tests pass'",
      }),
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
    const verifyMarker = path.join(taskStoreRoot, "verify-pass.txt");

    const { mission, team } = createMission(
      missionParams({
        objective: "Build with failing verify",
        verifyCommand: `node -e 'process.exit(require("node:fs").existsSync(${JSON.stringify(verifyMarker)}) ? 0 : 1)'`,
        maxVerifyRetries: 1,
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("=== VERIFICATION FAILED")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const fixPlan = JSON.stringify([{ agentId: mission.workerIds[0], task: "Create verification marker" }]);
        agent.lastOutput = fixPlan;
        agent.status = "idle";
        return fixPlan;
      }
      if (!agent.isLead && message.includes("=== FIX TASK ===") && message.includes("Create verification marker")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        fs.writeFileSync(verifyMarker, "ok");
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        agent.lastOutput = "marker created";
        agent.status = "idle";
        return "marker created";
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
    assert.equal(mission.verificationLog.length, 2);
    assert.equal(mission.verificationLog[0].passed, false);
    assert.equal(mission.verificationLog[1].passed, true);

    const leadFixPrompt = codex.calls.find(
      (call) => call.agentId === mission.leadId && call.message.includes("=== VERIFICATION FAILED"),
    );
    assert.ok(leadFixPrompt);
    assert.ok(leadFixPrompt!.message.includes("SCOPED RE-ENTRY CONTEXT"));
    assert.ok(leadFixPrompt!.message.includes("ASSIGNED SCOPE"));
    assert.ok(leadFixPrompt!.message.includes("Return only a valid JSON assignment array"));

    const workerFixPrompt = codex.calls.find(
      (call) => call.agentId === mission.workerIds[0] && call.message.includes("=== FIX TASK ==="),
    );
    assert.ok(workerFixPrompt);
    assert.ok(workerFixPrompt!.message.includes("Build with failing verify"));
    assert.ok(workerFixPrompt!.message.includes("Create verification marker"));
    assert.ok(workerFixPrompt!.message.includes("FAILURE EVIDENCE"));
  });

  it("stops retrying after maxVerifyRetries", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      missionParams({
        objective: "Build with always-failing verify",
        verifyCommand: "exit 1",
        maxVerifyRetries: 1,
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("=== VERIFICATION FAILED")) {
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

    assert.equal(mission.phase, "error");
    assert.match(mission.error ?? "", /Verification failed/);
    assert.ok(mission.verificationLog);
    assert.ok(mission.verificationLog.length > 0);
    assert.equal(mission.verificationLog[mission.verificationLog.length - 1].passed, false);
  });

  it("fails mission when fix assignments are malformed", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      missionParams({
        objective: "Malformed fix assignments",
        verifyCommand: "exit 1",
        maxVerifyRetries: 1,
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("=== VERIFICATION FAILED")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        agent.lastOutput = "not json";
        agent.status = "idle";
        return "not json";
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "error");
    assert.match(mission.error ?? "", /Could not extract JSON array|invalid fix assignments JSON/i);
    assert.equal(mission.verificationLog.length, 1);
  });

  it("runs independent verifier and records PASS verdict", async () => {
    const { mission, team } = createMission(
      missionParams({
        objective: "Verifier pass",
        verifierRole: "Independent Verifier",
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.id.startsWith("verifier-")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const output = "### Check: smoke\n**Command run:**\n  echo ok\n**Output observed:**\n  ok\n**Result: PASS**\n\nVERDICT: PASS";
        agent.lastOutput = output;
        agent.status = "idle";
        return output;
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed");
    assert.equal(mission.verifierAttempts.length, 1);
    assert.equal(mission.verifierAttempts[0].verdict, "PASS");
    assert.equal(mission.verifierResult?.verdict, "PASS");
    assert.ok(mission.verifierId?.startsWith("verifier-"));

    const verifierCall = codex.calls.find((call) => call.agentId === mission.verifierId);
    assert.ok(verifierCall);
    assert.ok(verifierCall!.message.includes("STARTUP CONTEXT"));
    assert.ok(verifierCall!.message.includes("INDEPENDENT VERIFICATION TASK"));
    assert.ok(verifierCall!.message.includes("Rely on scoped summaries below instead of assuming hidden transcript history"));
    assert.ok(verifierCall!.message.includes("Lead summary below"));
  });

  it("fails mission when verifier returns FAIL after retries", async () => {
    const { mission, team } = createMission(
      missionParams({
        objective: "Verifier fail",
        verifierRole: "Independent Verifier",
        maxVerifyRetries: 1,
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.id.startsWith("verifier-")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const output = "### Check: fail\n**Command run:**\n  exit 1\n**Output observed:**\n  failed\n**Result: FAIL**\n\nVERDICT: FAIL";
        agent.lastOutput = output;
        agent.status = "idle";
        return output;
      }
      if (agent.isLead && message.includes("=== VERIFICATION FAILED")) {
        const fixPlan = JSON.stringify([{ agentId: mission.workerIds[0], task: "Try fix" }]);
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        agent.lastOutput = fixPlan;
        agent.status = "idle";
        return fixPlan;
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "error");
    assert.match(mission.error ?? "", /Verifier reported FAIL/);
    assert.equal(mission.verifierAttempts.length, 2);
    assert.ok(mission.verifierAttempts.every((attempt) => attempt.verdict === "FAIL"));
  });

  it("fails mission on PARTIAL verifier verdict without fix rounds", async () => {
    const { mission, team } = createMission(
      missionParams({
        objective: "Verifier partial",
        verifierRole: "Independent Verifier",
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.id.startsWith("verifier-")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const output = "### Check: blocked env\n**Command run:**\n  npm test\n**Output observed:**\n  npm missing\n**Result: FAIL**\n\nVERDICT: PARTIAL";
        agent.lastOutput = output;
        agent.status = "idle";
        return output;
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "completed_with_failures");
    assert.match(mission.error ?? "", /Verifier reported PARTIAL/);
    assert.equal(mission.verifierAttempts.length, 1);
    assert.equal(mission.verifierAttempts[0].verdict, "PARTIAL");
    assert.equal(mission.verifierResult?.verdict, "PARTIAL");
    const fixPrompts = codex.calls.filter((call) => call.agentId === mission.leadId && call.message.includes("VERIFICATION FAILED"));
    assert.equal(fixPrompts.length, 0);
  });

  it("fails mission when verifier output has no parseable verdict", async () => {
    const { mission, team } = createMission(
      missionParams({
        objective: "Verifier malformed",
        verifierRole: "Independent Verifier",
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.id.startsWith("verifier-")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const output = "no verdict";
        agent.lastOutput = output;
        agent.status = "idle";
        return output;
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "error");
    assert.match(mission.error ?? "", /missing final 'VERDICT/);
    assert.equal(mission.verifierAttempts.length, 0);
  });

  it("fails mission when a fix-round worker fails", async () => {
    codex.defaultResponse = "done";

    const { mission, team } = createMission(
      missionParams({
        objective: "Fix worker failure",
        verifyCommand: "exit 1",
        maxVerifyRetries: 1,
      }),
      state,
    );

    const origSend = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string) => {
      if (agent.isLead && message.includes("=== VERIFICATION FAILED")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "working";
        agent.threadId = agent.threadId ?? `thread-${agent.id}`;
        const fixPlan = JSON.stringify([{ agentId: mission.workerIds[0], task: "Apply fix" }]);
        agent.lastOutput = fixPlan;
        agent.status = "idle";
        return fixPlan;
      }
      if (!agent.isLead && message.includes("=== FIX TASK ===") && message.includes("Apply fix")) {
        codex.calls.push({ agentId: agent.id, message });
        agent.status = "error";
        throw new Error("Fix worker crashed");
      }
      return origSend(agent, message);
    };

    await runMission(mission, team, codex, state, messages);

    assert.equal(mission.phase, "error");
    assert.match(mission.error ?? "", /Fix round 1 failed/);
    assert.equal(mission.workerResults.some((result) => result.status === "error"), true);
  });
});

describe("extractJsonArray", () => {
  it("parses plain JSON array", () => {
    const result = extractJsonArray('[{"agentId":"w1","task":"fix"}]');
    assert.deepEqual(result, [{ agentId: "w1", task: "fix" }]);
  });

  it("parses empty array", () => {
    const result = extractJsonArray("[]");
    assert.deepEqual(result, []);
  });

  it("extracts JSON from markdown code fence", () => {
    const input = 'Here are the assignments:\n```json\n[{"agentId":"w1","task":"fix auth"}]\n```';
    const result = extractJsonArray(input);
    assert.deepEqual(result, [{ agentId: "w1", task: "fix auth" }]);
  });

  it("extracts JSON from text with surrounding prose", () => {
    const input = 'I think we need to fix these:\n[{"agentId":"w1","task":"fix"}]\nLet me know.';
    const result = extractJsonArray(input);
    assert.deepEqual(result, [{ agentId: "w1", task: "fix" }]);
  });

  it("extracts empty array from prose", () => {
    const input = "No fixes needed: []";
    const result = extractJsonArray(input);
    assert.deepEqual(result, []);
  });

  it("throws on completely invalid input", () => {
    assert.throws(() => extractJsonArray("no json here"), /Could not extract JSON array/);
  });

  it("handles whitespace and newlines in JSON", () => {
    const input = '  \n  [\n    {"agentId": "w1", "task": "fix"}\n  ]  \n';
    const result = extractJsonArray(input);
    assert.deepEqual(result, [{ agentId: "w1", task: "fix" }]);
  });
});
