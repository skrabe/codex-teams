import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { StaleTaskMonitor } from "../src/stale-task-monitor.js";
import type { Task } from "../src/types.js";

describe("StaleTaskMonitor", () => {
  let state: TeamManager;
  let messages: MessageSystem;
  let monitor: StaleTaskMonitor;
  let taskStoreRoot: string;

  beforeEach(() => {
    taskStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-stale-"));
    state = new TeamManager(taskStoreRoot);
    messages = new MessageSystem();
    monitor = new StaleTaskMonitor(state, messages);
  });

  afterEach(() => {
    monitor.stop();
    fs.rmSync(taskStoreRoot, { recursive: true, force: true });
  });

  function setupTeam() {
    const team = state.createTeam("stale-test", [
      { role: "lead", isLead: true },
      { role: "worker-a" },
      { role: "worker-b" },
    ]);
    state.initializeTaskList(team.id);
    const agents = Array.from(team.agents.values());
    const lead = agents.find((a) => a.isLead)!;
    const workerA = agents.find((a) => a.role === "worker-a")!;
    const workerB = agents.find((a) => a.role === "worker-b")!;
    return { team, lead, workerA, workerB };
  }

  function makeTaskStale(teamId: string, taskId: string, ageMs: number) {
    const taskFile = path.join(taskStoreRoot, teamId, "tasks", `${taskId}.json`);
    const stored = JSON.parse(fs.readFileSync(taskFile, "utf8"));
    stored.updatedAt = new Date(Date.now() - ageMs).toISOString();
    fs.writeFileSync(taskFile, JSON.stringify(stored, null, 2));
  }

  it("resets stale in-progress tasks to pending", () => {
    const { team, workerA } = setupTeam();
    const task = state.createTask(team.id, workerA.id, "Build API");
    state.updateTask(team.id, task.id, { status: "in-progress", owner: workerA.id });
    makeTaskStale(team.taskListId, task.id, 200);

    monitor.start({ teamId: team.id, thresholdMs: 100, intervalMs: 999_999 });
    monitor.tick();

    const after = state.getTask(team.id, task.id)!;
    assert.equal(after.status, "pending");
    assert.equal(after.owner, null);
  });

  it("skips lead-owned tasks", () => {
    const { team, lead } = setupTeam();
    const task = state.createTask(team.id, lead.id, "Lead work");
    state.updateTask(team.id, task.id, { status: "in-progress", owner: lead.id });
    makeTaskStale(team.taskListId, task.id, 200);

    monitor.start({ teamId: team.id, thresholdMs: 100, intervalMs: 999_999 });
    monitor.tick();

    const after = state.getTask(team.id, task.id)!;
    assert.equal(after.status, "in-progress");
    assert.equal(after.owner, lead.id);
  });

  it("posts group chat notification for stale tasks", () => {
    const { team, workerA } = setupTeam();
    const task = state.createTask(team.id, workerA.id, "Build API");
    state.updateTask(team.id, task.id, { status: "in-progress", owner: workerA.id });
    makeTaskStale(team.taskListId, task.id, 200);

    monitor.start({ teamId: team.id, thresholdMs: 100, intervalMs: 999_999 });
    monitor.tick();

    const chatMessages = messages.getTeamChatMessages(team.id);
    assert.ok(chatMessages.length > 0, "Expected group chat notification");
    assert.ok(chatMessages[0].text.includes("Stale task auto-reassign"));
    assert.ok(chatMessages[0].text.includes("Build API"));
  });

  it("sends protocol notification to lead", () => {
    const { team, lead, workerA } = setupTeam();
    const task = state.createTask(team.id, workerA.id, "Build API");
    state.updateTask(team.id, task.id, { status: "in-progress", owner: workerA.id });
    makeTaskStale(team.taskListId, task.id, 200);

    monitor.start({ teamId: team.id, thresholdMs: 100, intervalMs: 999_999 });
    monitor.tick();

    const batch = messages.protocolRead(lead.id);
    assert.ok(batch.messages.length > 0, "Expected protocol message to lead");
    assert.equal(batch.messages[0].type, "task_assignment");
    const data = batch.messages[0].data as { action: string; tasks: Array<{ id: string }> };
    assert.equal(data.action, "stale_reassign");
    assert.equal(data.tasks[0].id, task.id);
  });

  it("does nothing when no tasks are stale", () => {
    const { team, workerA } = setupTeam();
    const task = state.createTask(team.id, workerA.id, "Build API");
    state.updateTask(team.id, task.id, { status: "in-progress", owner: workerA.id });

    monitor.start({ teamId: team.id, thresholdMs: 999_999, intervalMs: 999_999 });
    monitor.tick();

    const after = state.getTask(team.id, task.id)!;
    assert.equal(after.status, "in-progress");
    assert.equal(after.owner, workerA.id);
    assert.equal(messages.getTeamChatMessages(team.id).length, 0);
  });

  it("stops cleanly without errors", () => {
    const { team } = setupTeam();
    monitor.start({ teamId: team.id, thresholdMs: 100, intervalMs: 50 });
    monitor.stop();
    monitor.stop();
  });

  it("runs periodically via start/stop", async () => {
    const { team, workerA } = setupTeam();
    const task = state.createTask(team.id, workerA.id, "Build API");
    state.updateTask(team.id, task.id, { status: "in-progress", owner: workerA.id });
    makeTaskStale(team.taskListId, task.id, 200);

    monitor.start({ teamId: team.id, thresholdMs: 100, intervalMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    monitor.stop();

    const after = state.getTask(team.id, task.id)!;
    assert.equal(after.status, "pending");
    assert.equal(after.owner, null);
  });
});
