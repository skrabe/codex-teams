import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-task-store-"));
    store = new TaskStore("team-123", rootDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("initializes task-list directories", () => {
    const taskListPath = store.initTaskList();

    assert.equal(taskListPath, path.join(rootDir, "team-123"));
    assert.ok(fs.existsSync(path.join(taskListPath, "tasks")));
    assert.ok(fs.existsSync(path.join(taskListPath, ".highwatermark")));
  });

  it("creates, gets, and lists tasks", () => {
    const created = store.createTask({ description: "Build feature X", owner: "agent-a" });

    assert.equal(created.id, "1");
    assert.equal(created.subject, "Build feature X");
    assert.equal(created.owner, "agent-a");
    assert.equal(created.status, "pending");
    assert.deepEqual(created.blockedBy, []);

    const fetched = store.getTask(created.id);
    assert.ok(fetched);
    assert.equal(fetched?.description, "Build feature X");

    const listed = store.listTasks();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
  });

  it("tracks blockedBy from incomplete dependencies", () => {
    const root = store.createTask({ description: "Root" });
    const child = store.createTask({ description: "Child", dependencies: [root.id] });

    assert.deepEqual(child.blockedBy, [root.id]);

    const completed = store.updateTask(root.id, { status: "completed" });
    assert.equal(completed.status, "completed");

    const unblockedChild = store.getTask(child.id);
    assert.deepEqual(unblockedChild?.blockedBy, []);
  });

  it("uses monotonic task IDs even after delete and reset", () => {
    const first = store.createTask({ description: "One" });
    const second = store.createTask({ description: "Two" });

    store.deleteTask(second.id);
    store.resetTask(first.id);

    const third = store.createTask({ description: "Three" });
    assert.equal(third.id, "3");
  });

  it("claims only unblocked pending tasks", () => {
    const root = store.createTask({ description: "Root" });
    const child = store.createTask({ description: "Child", dependencies: [root.id] });

    assert.equal(store.claimTask(child.id, "agent-a"), null);

    store.updateTask(root.id, { status: "completed" });
    const claimed = store.claimTask(child.id, "agent-a");

    assert.ok(claimed);
    assert.equal(claimed?.status, "in-progress");
    assert.equal(claimed?.owner, "agent-a");
  });

  it("supports busy-aware claims", () => {
    const first = store.createTask({ description: "First" });
    const second = store.createTask({ description: "Second" });

    const claimedFirst = store.claimTask(first.id, "agent-a", { checkAgentBusy: true });
    assert.ok(claimedFirst);

    const claimedSecond = store.claimTask(second.id, "agent-a", { checkAgentBusy: true });
    assert.equal(claimedSecond, null);
  });

  it("unassigns unresolved tasks for an agent", () => {
    const first = store.createTask({ description: "First", owner: "agent-a" });
    const second = store.createTask({ description: "Second", owner: "agent-a" });
    store.updateTask(second.id, { status: "completed" });
    store.claimTask(first.id, "agent-a");

    const changed = store.unassignTasksForAgent("agent-a");

    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, first.id);
    assert.equal(changed[0].status, "pending");
    assert.equal(changed[0].owner, null);
  });

  it("cascades removal of dependency references on task deletion", () => {
    const root = store.createTask({ description: "Root task" });
    const child = store.createTask({ description: "Child task", dependencies: [root.id] });

    assert.deepEqual(child.dependencies, [root.id]);
    assert.deepEqual(child.blockedBy, [root.id]);

    store.deleteTask(root.id);

    const updatedChild = store.getTask(child.id);
    assert.ok(updatedChild);
    assert.deepEqual(updatedChild?.dependencies, []);
    assert.deepEqual(updatedChild?.blockedBy, []);
  });

  it("supports activeForm field on tasks", () => {
    const task = store.createTask({
      description: "Run the test suite",
      activeForm: "Running tests",
    });

    assert.equal(task.activeForm, "Running tests");

    const updated = store.updateTask(task.id, { activeForm: "Executing test suite" });
    assert.equal(updated.activeForm, "Executing test suite");

    const fetched = store.getTask(task.id);
    assert.equal(fetched?.activeForm, "Executing test suite");
  });
});
