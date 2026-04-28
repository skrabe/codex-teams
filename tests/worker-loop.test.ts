import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { CodexClientManager } from "../src/codex-client.js";
import { createMission, buildContinuationPrompt } from "../src/mission.js";
import type { LaunchMissionParams, MissionState } from "../src/mission.js";
import type { Agent, Team } from "../src/types.js";
import { runWorkerLoop } from "../src/worker-loop.js";
import { TaskStore } from "../src/task-store.js";

let sendCount = 0;
let lastPrompts: Array<{ agentId: string; message: string }> = [];
let simulateTimeout = false;
let simulateTimeoutOnce = false;

class MockCodexClient extends CodexClientManager {
  override async connect() {}
  override async disconnect() {}
  override isConnected() {
    return true;
  }
  override abortAgent(_agentId: string): boolean {
    return true;
  }
  override abortTeam(agentIds: string[]): string[] {
    return agentIds;
  }

  override async sendToAgent(agent: Agent, message: string, _signal?: AbortSignal): Promise<string> {
    lastPrompts.push({ agentId: agent.id, message });
    sendCount++;
    agent.threadId = agent.threadId ?? `thread-${agent.id}`;
    agent.status = "working";

    if (simulateTimeout || simulateTimeoutOnce) {
      simulateTimeoutOnce = false;
      throw new Error("Worker heartbeat timed out after 600s");
    }

    agent.status = "idle";
    agent.lastOutput = "mock output";
    return "mock output";
  }
}

function missionParams(overrides: Partial<LaunchMissionParams> = {}): LaunchMissionParams {
  return {
    objective: overrides.objective ?? "Test mission",
    workDir: overrides.workDir ?? "/tmp",
    team: overrides.team ?? [{ role: "lead", isLead: true }, { role: "dev" }],
    hooks: overrides.hooks,
    verifyCommand: overrides.verifyCommand,
  };
}

describe("runWorkerLoop", () => {
  let state: TeamManager;
  let messages: MessageSystem;
  let codex: MockCodexClient;
  let taskStoreRoot: string;
  let protocolInboxRoot: string;
  let chatStoreRoot: string;

  beforeEach(() => {
    taskStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-wl-"));
    protocolInboxRoot = path.join(taskStoreRoot, "inboxes");
    chatStoreRoot = path.join(taskStoreRoot, "chats");
    state = new TeamManager(taskStoreRoot);
    messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    codex = new MockCodexClient();
    sendCount = 0;
    lastPrompts = [];
    simulateTimeout = false;
    simulateTimeoutOnce = false;
  });

  afterEach(() => {
    fs.rmSync(taskStoreRoot, { recursive: true, force: true });
  });

  function setupMission(): { mission: MissionState; team: Team; worker: Agent } {
    const { mission, team } = createMission(missionParams({ workDir: taskStoreRoot }), state);
    const worker = Array.from(team.agents.values()).find((a) => !a.isLead)!;
    return { mission, team, worker };
  }

  it("exits cleanly when no tasks remain after initial prompt", async () => {
    const { mission, team, worker } = setupMission();

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      heartbeatTimeoutMs: 60_000,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.equal(result.agentId, worker.id);
    assert.equal(sendCount, 1);
  });

  it("loops when tasks are available between iterations", async () => {
    const { mission, team, worker } = setupMission();

    const store = new TaskStore(mission.taskListId, taskStoreRoot);
    store.initTaskList();
    store.createTask({ description: "Task A" });
    store.createTask({ description: "Task B" });

    let callIndex = 0;
    codex.sendToAgent = async (agent: Agent, message: string, _signal?: AbortSignal) => {
      lastPrompts.push({ agentId: agent.id, message });
      sendCount++;
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      agent.status = "idle";
      callIndex++;

      if (callIndex === 1) {
        store.claimTask("1", worker.id);
        store.updateTask("1", { status: "completed" });
        return "completed task 1";
      }
      if (callIndex === 2) {
        store.claimTask("2", worker.id);
        store.updateTask("2", { status: "completed" });
        return "completed task 2";
      }
      return "done";
    };

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      heartbeatTimeoutMs: 60_000,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.ok(sendCount >= 2, `Expected >= 2 sends, got ${sendCount}`);
  });

  it("exits on shutdown_request protocol message", async () => {
    const { mission, team, worker } = setupMission();

    const store = new TaskStore(mission.taskListId, taskStoreRoot);
    store.initTaskList();
    store.createTask({ description: "Task X" });

    let callIndex = 0;
    codex.sendToAgent = async (agent: Agent, _message: string) => {
      sendCount++;
      callIndex++;
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      agent.status = "idle";

      if (callIndex === 1) {
        messages.protocolSend("orchestrator", worker.id, "shutdown_request", { reason: "test" });
        return "first output";
      }
      return "should not reach";
    };

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      heartbeatTimeoutMs: 60_000,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.equal(sendCount, 1);
  });


  it("prioritizes lead control messages before autonomous task continuation", async () => {
    const { mission, team, worker } = setupMission();

    const store = new TaskStore(mission.taskListId, taskStoreRoot);
    store.initTaskList();
    store.createTask({ description: "Task waiting" });

    let callIndex = 0;
    codex.sendToAgent = async (agent: Agent, message: string) => {
      lastPrompts.push({ agentId: agent.id, message });
      sendCount++;
      callIndex++;
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      agent.status = "idle";

      if (callIndex === 1) {
        messages.protocolSend(mission.leadId, worker.id, "task_assignment", { taskId: "1" });
        return "bootstrap";
      }

      if (callIndex === 2) {
        store.claimTask("1", worker.id);
        store.updateTask("1", { status: "completed" });
        return "handled lead message";
      }

      return "done";
    };

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      heartbeatTimeoutMs: 60_000,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.ok(sendCount >= 2);
    assert.ok(lastPrompts[1]?.message.includes("lead control-plane message"));
  });

  it("recovers from heartbeat timeout", async () => {
    const { mission, team, worker } = setupMission();

    const store = new TaskStore(mission.taskListId, taskStoreRoot);
    store.initTaskList();
    store.createTask({ description: "Recoverable task" });

    simulateTimeoutOnce = true;

    let callIndex = 0;
    const originalSendToAgent = codex.sendToAgent.bind(codex);
    codex.sendToAgent = async (agent: Agent, message: string, signal?: AbortSignal) => {
      callIndex++;
      if (callIndex === 1 && simulateTimeoutOnce) {
        simulateTimeoutOnce = false;
        sendCount++;
        throw new Error("Worker heartbeat timed out after 600s");
      }
      store.claimTask("1", worker.id);
      store.updateTask("1", { status: "completed" });
      return originalSendToAgent(agent, message, signal);
    };

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      heartbeatTimeoutMs: 100,
      maxRecoveryAttempts: 2,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.ok(sendCount >= 2, `Expected at least 2 sends (1 timeout + 1 recovery), got ${sendCount}`);

    const workerState = mission.agentStates.get(worker.id)!;
    assert.equal(workerState.recoveryAttempts, 1);
    assert.equal(workerState.lastRecoveryReason, "heartbeat_timeout");
  });

  it("fails after max recovery attempts exceeded", async () => {
    const { mission, team, worker } = setupMission();

    simulateTimeout = true;

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      heartbeatTimeoutMs: 100,
      maxRecoveryAttempts: 1,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "error");
    assert.ok(result.output.includes("recovery attempts"));

    const workerState = mission.agentStates.get(worker.id)!;
    assert.equal(workerState.lastRecoveryReason, "heartbeat_timeout");
    assert.equal(workerState.terminationMode, "forced");
  });

  it("recovers from invalid thread without exhausting the worker loop", async () => {
    const { mission, team, worker } = setupMission();

    let callIndex = 0;
    codex.sendToAgent = async (agent: Agent, _message: string) => {
      callIndex++;
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      if (callIndex === 1) {
        throw new Error("thread not found");
      }
      agent.status = "idle";
      return "continued";
    };

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      heartbeatTimeoutMs: 60_000,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.equal(mission.agentStates.get(worker.id)?.lastRecoveryReason, "thread_invalid");
  });

  it("exits on abort signal", async () => {
    const { mission, team, worker } = setupMission();

    const store = new TaskStore(mission.taskListId, taskStoreRoot);
    store.initTaskList();
    store.createTask({ description: "Never-ending task" });

    const controller = new AbortController();

    let callIndex = 0;
    codex.sendToAgent = async (agent: Agent, _message: string) => {
      sendCount++;
      callIndex++;
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      agent.status = "idle";

      if (callIndex === 1) {
        controller.abort();
        return "first output";
      }
      return "should not reach";
    };

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      signal: controller.signal,
      heartbeatTimeoutMs: 60_000,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.equal(sendCount, 1);
  });


  it("interrupts only the current turn and continues without recovery", async () => {
    const { mission, team, worker } = setupMission();
    const interruptController = new AbortController();

    let callIndex = 0;
    codex.sendToAgent = async (agent: Agent, message: string, signal?: AbortSignal) => {
      lastPrompts.push({ agentId: agent.id, message });
      sendCount++;
      callIndex++;
      agent.threadId = agent.threadId ?? `thread-${agent.id}`;
      agent.status = "working";

      if (callIndex === 1) {
        setTimeout(() => interruptController.abort(), 10);

        return await new Promise<string>((resolve, reject) => {
          const completion = setTimeout(() => resolve("should-not-complete"), 100);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(completion);
              reject(new Error("turn aborted"));
            },
            { once: true },
          );
        });
      }

      agent.status = "idle";
      return "continued";
    };

    const result = await runWorkerLoop({
      worker,
      mission,
      team,
      codex,
      state,
      messages,
      turnInterruptSignal: interruptController.signal,
      heartbeatTimeoutMs: 60_000,
      taskStoreRoot,
      idleRecheckDelayMs: 10,
      maxIdleRechecks: 1,
    });

    assert.equal(result.status, "success");
    assert.equal(sendCount, 2);
    assert.ok(lastPrompts[1]?.message.includes("INTERRUPTED TURN"));
    const workerState = mission.agentStates.get(worker.id)!;
    assert.equal(workerState.recoveryAttempts, 0);
    assert.equal(workerState.lastRecoveryReason, undefined);
  });
});

describe("buildContinuationPrompt", () => {
  let state: TeamManager;
  let taskStoreRoot: string;

  beforeEach(() => {
    taskStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-cont-"));
    state = new TeamManager(taskStoreRoot);
  });

  afterEach(() => {
    fs.rmSync(taskStoreRoot, { recursive: true, force: true });
  });

  it("generates compact continuation prompt for tasks_available", () => {
    const { mission } = createMission(missionParams({ workDir: taskStoreRoot }), state);
    const worker = Array.from(
      state.getTeam(mission.teamId)!.agents.values(),
    ).find((a) => !a.isLead)!;

    const prompt = buildContinuationPrompt(mission, worker, "tasks_available");
    assert.ok(prompt.includes("task_list()"));
    assert.ok(prompt.includes(worker.id));
    assert.ok(!prompt.includes("RECOVERY"));
    assert.ok(prompt.length < 2000, `Continuation prompt too long: ${prompt.length}`);
  });

  it("includes recovery note when reason is recovery", () => {
    const { mission } = createMission(missionParams({ workDir: taskStoreRoot }), state);
    const worker = Array.from(
      state.getTeam(mission.teamId)!.agents.values(),
    ).find((a) => !a.isLead)!;

    const prompt = buildContinuationPrompt(mission, worker, "recovery");
    assert.ok(prompt.includes("RECOVERY"));
    assert.ok(prompt.includes("unexpectedly"));
  });

  it("includes lead-priority note when reason is lead_message", () => {
    const { mission } = createMission(missionParams({ workDir: taskStoreRoot }), state);
    const worker = Array.from(
      state.getTeam(mission.teamId)!.agents.values(),
    ).find((a) => !a.isLead)!;

    const prompt = buildContinuationPrompt(mission, worker, "lead_message");
    assert.ok(prompt.includes("lead control-plane message"));
    assert.ok(prompt.includes("PRIORITY EVENT"));
  });

  it("includes interrupted-turn note when reason is interrupted", () => {
    const { mission } = createMission(missionParams({ workDir: taskStoreRoot }), state);
    const worker = Array.from(
      state.getTeam(mission.teamId)!.agents.values(),
    ).find((a) => !a.isLead)!;

    const prompt = buildContinuationPrompt(mission, worker, "interrupted");
    assert.ok(prompt.includes("INTERRUPTED TURN"));
  });
});
