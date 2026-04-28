import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isProcessAlive } from "../src/cli/pid-check.js";
import { purgeOrphanedMissions, writeMissionState, listMissionStates } from "../src/cli/state-file.js";
import type { MissionStateFile } from "../src/cli/state-file.js";

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("returns false for an obviously dead PID", () => {
    assert.equal(isProcessAlive(999999999), false);
  });
});

describe("purgeOrphanedMissions", () => {
  let tmpDir: string;
  let stateDir: string;
  let taskDir: string;
  let savedEnv: string | undefined;
  let savedTaskEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleanup-"));
    stateDir = path.join(tmpDir, "missions");
    taskDir = path.join(tmpDir, "tasks");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(taskDir, { recursive: true });
    savedEnv = process.env.CODEX_TEAMS_STATE_DIR;
    savedTaskEnv = process.env.CODEX_TEAMS_TASK_DIR;
    process.env.CODEX_TEAMS_STATE_DIR = stateDir;
    process.env.CODEX_TEAMS_TASK_DIR = taskDir;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CODEX_TEAMS_STATE_DIR;
    else process.env.CODEX_TEAMS_STATE_DIR = savedEnv;
    if (savedTaskEnv === undefined) delete process.env.CODEX_TEAMS_TASK_DIR;
    else process.env.CODEX_TEAMS_TASK_DIR = savedTaskEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFakeState(missionId: string, pid: number, taskListId: string) {
    const state = {
      missionId,
      objective: "test",
      phase: "executing" as const,
      teamId: "team-1",
      teamName: "test",
      taskListId,
      leadId: "lead-1",
      workerIds: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agents: [] as any[],
      planApprovals: [] as any[],
      shutdowns: [] as any[],
      commsPort: 3000,
      pid,
    };
    fs.writeFileSync(path.join(stateDir, `${missionId}.json`), JSON.stringify(state));
  }

  function createFakeTaskDir(taskListId: string) {
    const tasksPath = path.join(taskDir, taskListId, "tasks");
    fs.mkdirSync(tasksPath, { recursive: true });
    fs.writeFileSync(path.join(taskDir, taskListId, ".highwatermark"), "1\n");
    fs.writeFileSync(path.join(tasksPath, "1.json"), JSON.stringify({ id: "1", subject: "test" }));
  }

  it("removes state files for dead PIDs", () => {
    writeFakeState("dead-mission", 999999999, "task-dead");

    const result = purgeOrphanedMissions();

    assert.ok(result.purged.includes("dead-mission"));
    assert.equal(fs.existsSync(path.join(stateDir, "dead-mission.json")), false);
  });

  it("preserves state files for alive PIDs", () => {
    writeFakeState("alive-mission", process.pid, "task-alive");

    const result = purgeOrphanedMissions();

    assert.ok(result.alive.includes("alive-mission"));
    assert.equal(fs.existsSync(path.join(stateDir, "alive-mission.json")), true);
  });

  it("cleans up task directories for dead missions", () => {
    writeFakeState("dead-with-tasks", 999999999, "task-orphan");
    createFakeTaskDir("task-orphan");

    const result = purgeOrphanedMissions();

    assert.ok(result.purged.includes("dead-with-tasks"));
    assert.equal(fs.existsSync(path.join(taskDir, "task-orphan")), false);
  });

  it("returns empty results when no state files exist", () => {
    const result = purgeOrphanedMissions();

    assert.equal(result.purged.length, 0);
    assert.equal(result.alive.length, 0);
  });
});
