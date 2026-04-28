import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";
import { CodexClientManager } from "../src/codex-client.js";

const ALLOW_HOOK_COMMAND =
  'node -e "process.stdin.resume();process.stdin.on(\'end\',()=>process.exit(0));"';
const BLOCK_HOOK_COMMAND =
  'node -e "process.stdin.resume();process.stdin.on(\'end\',()=>{console.error(\'idle blocked\');process.exit(1);});"';

describe("codex-client teammate idle hooks", () => {
  let taskStoreRoot: string;

  beforeEach(() => {
    taskStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-codex-hooks-"));
  });

  afterEach(() => {
    fs.rmSync(taskStoreRoot, { recursive: true, force: true });
  });

  it("allows worker idle transition when hook succeeds", async () => {
    const state = new TeamManager(taskStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "worker" }]);
    team.missionId = "mission-1";
    team.hookCommands = { teammateIdle: ALLOW_HOOK_COMMAND };

    const worker = Array.from(team.agents.values()).find((agent) => !agent.isLead)!;
    const codex = new CodexClientManager();
    codex.setStateManager(state);

    await codex.runTeammateIdleHook(worker);
  });

  it("blocks worker idle transition when hook fails", async () => {
    const state = new TeamManager(taskStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "worker" }]);
    team.missionId = "mission-2";
    team.hookCommands = { teammateIdle: BLOCK_HOOK_COMMAND };

    const worker = Array.from(team.agents.values()).find((agent) => !agent.isLead)!;
    const codex = new CodexClientManager();
    codex.setStateManager(state);

    await assert.rejects(
      () => codex.runTeammateIdleHook(worker),
      /TeammateIdle hook blocked/,
    );
  });
});
