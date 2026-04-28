import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { CodexClientManager } from "../src/codex-client.js";
import { steerTeam, buildSteerPrompt } from "../src/mission.js";
import type { Agent } from "../src/types.js";

class MockCodexClient extends CodexClientManager {
  calls: Array<{ agentId: string; message: string }> = [];
  abortedAgents: string[] = [];
  nextResponse = "steered response";
  failForAgentId: string | null = null;

  override async connect() {}
  override async disconnect() {}
  override isConnected() {
    return true;
  }

  override abortAgent(agentId: string): boolean {
    this.abortedAgents.push(agentId);
    return true;
  }

  override abortTeam(agentIds: string[]): string[] {
    for (const id of agentIds) this.abortedAgents.push(id);
    return agentIds;
  }

  override async sendToAgent(agent: Agent, message: string): Promise<string> {
    this.calls.push({ agentId: agent.id, message });

    if (this.failForAgentId && agent.id === this.failForAgentId) {
      agent.status = "error";
      throw new Error(`Simulated failure for ${agent.id}`);
    }

    agent.status = "working";
    agent.threadId = agent.threadId ?? `thread-${agent.id}`;
    agent.lastOutput = this.nextResponse;
    agent.status = "idle";
    return this.nextResponse;
  }
}

function createTeamWithAgents(
  state: TeamManager,
  name: string,
  roles: Array<{ role: string; isLead?: boolean }>,
): { teamId: string; agentIds: string[] } {
  const team = state.createTeam(name, roles.map((r) => ({ role: r.role, isLead: r.isLead })));
  const agentIds = Array.from(team.agents.values()).map((a) => a.id);
  return { teamId: team.id, agentIds };
}

describe("steerTeam", () => {
  let state: TeamManager;
  let codex: MockCodexClient;
  let messages: MessageSystem;

  beforeEach(() => {
    state = new TeamManager();
    codex = new MockCodexClient();
    messages = new MessageSystem();
  });

  it("steers all agents in a team", async () => {
    const { teamId, agentIds } = createTeamWithAgents(state, "test-team", [
      { role: "lead", isLead: true },
      { role: "worker" },
    ]);

    const result = await steerTeam(teamId, "Switch to writing tests instead", undefined, state, codex, messages);

    assert.deepEqual(result.aborted.sort(), agentIds.sort());
    assert.deepEqual(result.steered.sort(), agentIds.sort());
    assert.deepEqual(result.failed, []);

    assert.equal(codex.calls.length, 2);
    for (const call of codex.calls) {
    assert.ok(call.message.includes("DIRECTION CHANGE FROM ORCHESTRATOR"));
      assert.ok(call.message.includes("Switch to writing tests instead"));
    assert.ok(call.message.includes("SCOPED RE-ENTRY CONTEXT"));
    }
  });

  it("steers a subset of agents via agentIds", async () => {
    const { teamId, agentIds } = createTeamWithAgents(state, "test-team", [
      { role: "lead", isLead: true },
      { role: "worker-a" },
      { role: "worker-b" },
    ]);

    const subset = [agentIds[1], agentIds[2]];

    const result = await steerTeam(teamId, "New direction", subset, state, codex, messages);

    assert.deepEqual(result.aborted.sort(), subset.sort());
    assert.deepEqual(result.steered.sort(), subset.sort());
    assert.equal(codex.calls.length, 2);
    assert.ok(codex.calls.every((c) => subset.includes(c.agentId)));
  });

  it("posts direction change to group chat", async () => {
    const { teamId } = createTeamWithAgents(state, "test-team", [{ role: "dev" }]);

    await steerTeam(teamId, "Focus on performance", undefined, state, codex, messages);

    const chatMessages = messages.getTeamChatMessages(teamId);
    assert.equal(chatMessages.length, 1);
    assert.equal(chatMessages[0].from, "orchestrator");
    assert.equal(chatMessages[0].fromRole, "Orchestrator");
    assert.ok(chatMessages[0].text.includes("DIRECTION CHANGE"));
    assert.ok(chatMessages[0].text.includes("Focus on performance"));
  });

  it("includes directive in steer message sent to agents", async () => {
    const { teamId } = createTeamWithAgents(state, "test-team", [{ role: "dev" }]);

    await steerTeam(teamId, "Refactor auth module", undefined, state, codex, messages);

    assert.equal(codex.calls.length, 1);
    const msg = codex.calls[0].message;
    assert.ok(msg.includes("SCOPED RE-ENTRY CONTEXT"));
    assert.ok(msg.includes("=== NEW DIRECTIVE ==="));
    assert.ok(msg.includes("Refactor auth module"));
    assert.ok(msg.includes("Read group_chat"));
    assert.ok(msg.includes("Do not assume any hidden parent transcript"));
    assert.ok(msg.includes("task_list() / task_get()"));
  });

  it("throws for unknown team", async () => {
    await assert.rejects(
      () => steerTeam("nonexistent", "anything", undefined, state, codex, messages),
      /Team not found/,
    );
  });

  it("handles agent send failure gracefully", async () => {
    const { teamId, agentIds } = createTeamWithAgents(state, "test-team", [
      { role: "good-agent" },
      { role: "bad-agent" },
    ]);

    codex.failForAgentId = agentIds[1];

    const result = await steerTeam(teamId, "New plan", undefined, state, codex, messages);

    assert.equal(result.steered.length, 1);
    assert.equal(result.steered[0], agentIds[0]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].agentId, agentIds[1]);
    assert.ok(result.failed[0].error.includes("Simulated failure"));
  });

  it("returns empty results for team with no agents", async () => {
    const team = state.createTeam("empty-team", []);

    const result = await steerTeam(team.id, "anything", undefined, state, codex, messages);

    assert.deepEqual(result, { aborted: [], steered: [], failed: [] });
    assert.equal(codex.calls.length, 0);
  });
});
