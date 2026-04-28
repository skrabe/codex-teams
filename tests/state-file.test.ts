import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { listMissionStates, readMissionState, removeMissionState, writeMissionState } from "../src/cli/state-file.js";

describe("mission state file", () => {
  const missionIds: string[] = [];

  afterEach(() => {
    for (const missionId of missionIds.splice(0)) {
      removeMissionState(missionId);
    }
  });

  it("round-trips lifecycle metadata", () => {
    const missionId = `mission-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    missionIds.push(missionId);

    writeMissionState(missionId, {
      missionId,
      objective: "Test runtime persistence",
      phase: "executing",
      teamId: "team-1",
      teamName: "mission-abc123",
      taskListId: "team-1",
      leadId: "lead-1",
      workerIds: ["worker-1"],
      createdAt: new Date("2026-04-03T10:00:00.000Z").toISOString(),
      updatedAt: new Date("2026-04-03T10:05:00.000Z").toISOString(),
      agents: [
        {
          id: "lead-1",
          role: "lead",
          specialization: "",
          isLead: true,
          status: "idle",
          lifecycle: "terminated",
          isActive: false,
          sandbox: "workspace-write",
          approvalPolicy: "never",
          awaitingPlanApproval: false,
          threadId: "thread-lead",
          tasks: [],
          lastSeenAt: new Date("2026-04-03T10:04:00.000Z").toISOString(),
          terminalReason: "mission_completed",
          terminationMode: "graceful",
          recoveryAttempts: 1,
          lastRecoveryReason: "heartbeat_timeout",
          lastRecoveryAt: new Date("2026-04-03T10:03:30.000Z").toISOString(),
          lastOutput: "done",
          controlPlane: {
            queued: 0,
            leased: 0,
            activeDeliveryId: null,
            nextMessageType: null,
          },
        },
      ],
      planApprovals: [],
      shutdowns: [],
      verifierRole: "Independent Verifier",
      verifierId: "verifier-1",
      verifierAttempts: [
        {
          attempt: 1,
          verdict: "PASS",
          output: "VERDICT: PASS",
        },
      ],
      verifierResult: {
        agentId: "verifier-1",
        attempt: 1,
        verdict: "PASS",
        output: "VERDICT: PASS",
      },
      commsPort: 4321,
      pid: 9999,
    });

    const loaded = readMissionState(missionId);
    assert.ok(loaded);
    assert.equal(loaded?.agents.length, 1);
    assert.equal(loaded?.agents[0].lifecycle, "terminated");
    assert.equal(loaded?.agents[0].terminalReason, "mission_completed");
    assert.equal(loaded?.agents[0].terminationMode, "graceful");
    assert.equal(loaded?.agents[0].recoveryAttempts, 1);
    assert.equal(loaded?.verifierRole, "Independent Verifier");
    assert.equal(loaded?.verifierResult?.verdict, "PASS");
    assert.equal(loaded?.verifierAttempts?.length, 1);
    assert.equal(loaded?.commsPort, 4321);

    const all = listMissionStates().filter((state) => state.missionId === missionId);
    assert.equal(all.length, 1);
  });
});
