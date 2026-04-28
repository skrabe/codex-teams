import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHook } from "../src/hooks.js";

const ALLOW_COMMAND =
  'node -e "process.stdin.resume();process.stdin.on(\'end\',()=>process.exit(0));"';
const FAIL_COMMAND =
  'node -e "process.stdin.resume();process.stdin.on(\'end\',()=>{console.error(\'blocked by policy\');process.exit(1);});"';
const JSON_BLOCK_COMMAND =
  'node -e "process.stdin.resume();process.stdin.on(\'end\',()=>{console.log(JSON.stringify({decision:\'block\',message:\'policy rejected\'}));});"';

describe("runHook", () => {
  it("allows when no hook command is configured", async () => {
    const result = await runHook(undefined, "TaskCreated", {
      event: "TaskCreated",
      teamId: "team-1",
      timestamp: new Date().toISOString(),
    });

    assert.equal(result.blocked, false);
  });

  it("blocks when hook exits non-zero", async () => {
    const result = await runHook(
      { taskCreated: FAIL_COMMAND },
      "TaskCreated",
      {
        event: "TaskCreated",
        teamId: "team-1",
        timestamp: new Date().toISOString(),
      },
    );

    assert.equal(result.blocked, true);
    assert.match(result.message ?? "", /blocked by policy/);
  });

  it("blocks when hook returns decision=block JSON", async () => {
    const result = await runHook(
      { taskCompleted: JSON_BLOCK_COMMAND },
      "TaskCompleted",
      {
        event: "TaskCompleted",
        teamId: "team-1",
        timestamp: new Date().toISOString(),
      },
    );

    assert.equal(result.blocked, true);
    assert.equal(result.message, "policy rejected");
  });

  it("allows when hook exits zero with no block decision", async () => {
    const result = await runHook(
      { teammateIdle: ALLOW_COMMAND },
      "TeammateIdle",
      {
        event: "TeammateIdle",
        teamId: "team-1",
        timestamp: new Date().toISOString(),
      },
    );

    assert.equal(result.blocked, false);
  });
});
