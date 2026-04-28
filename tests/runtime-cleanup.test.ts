import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { CodexClientManager } from "../src/codex-client.js";
import { createMission, serializeMissionState } from "../src/mission.js";
import { cleanupMissionRuntime } from "../src/cli/runtime-cleanup.js";
import { readMissionState, removeMissionState, writeMissionState } from "../src/cli/state-file.js";

class MockCodexClient extends CodexClientManager {
  disconnectCalls = 0;
  abortCalls: string[][] = [];
  cleanupCalls: string[] = [];

  override async connect() {}
  override async disconnect() {
    this.disconnectCalls += 1;
  }
  override isConnected() {
    return true;
  }
  override abortTeam(agentIds: string[]): string[] {
    this.abortCalls.push([...agentIds]);
    return agentIds;
  }
  override cleanupAgent(agentId: string): void {
    this.cleanupCalls.push(agentId);
  }
}

describe("runtime cleanup", () => {
  let taskStoreRoot: string;
  let protocolInboxRoot: string;

  beforeEach(() => {
    taskStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-cleanup-"));
    protocolInboxRoot = path.join(taskStoreRoot, "inboxes");
  });

  afterEach(() => {
    fs.rmSync(taskStoreRoot, { recursive: true, force: true });
  });

  it("removes mission runtime artifacts idempotently", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot);
    const codex = new MockCodexClient();

    const { mission, team } = createMission(
      {
        objective: "Cleanup runtime",
        workDir: taskStoreRoot,
        team: [{ role: "lead", isLead: true }, { role: "worker" }],
      },
      state,
    );

    writeMissionState(mission.id, {
      ...serializeMissionState(mission),
      commsPort: 1234,
      pid: process.pid,
    });
    messages.protocolSend("lead", mission.workerIds[0], "shutdown_request", { reason: "test" });
    const batch = messages.protocolRead(mission.workerIds[0]);
    assert.equal(batch.messages.length, 1);

    const taskListPath = path.join(taskStoreRoot, mission.taskListId);
    const inboxPath = path.join(protocolInboxRoot, `${mission.workerIds[0]}.json`);
    assert.equal(fs.existsSync(taskListPath), true);
    assert.equal(fs.existsSync(inboxPath), true);
    assert.ok(readMissionState(mission.id));

    await cleanupMissionRuntime({ mission, team, state, codex, messages }, "test_cleanup");
    await cleanupMissionRuntime({ mission, team, state, codex, messages }, "test_cleanup");

    assert.equal(readMissionState(mission.id), null);
    assert.equal(fs.existsSync(taskListPath), false);
    assert.equal(fs.existsSync(inboxPath), false);
    assert.equal(state.getTeam(team.id), undefined);
    assert.equal(codex.disconnectCalls, 1);
    assert.equal(codex.abortCalls.length, 1);

    const workerState = mission.agentStates.get(mission.workerIds[0]);
    assert.equal(workerState?.terminationMode, "forced");
    assert.equal(workerState?.terminalReason, "test_cleanup");

    removeMissionState(mission.id);
  });
});
