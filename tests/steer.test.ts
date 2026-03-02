import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { CodexClientManager } from "../src/codex-client.js";
import { createServer } from "../src/server.js";
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

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {});
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

describe("steer_team (e2e with mock codex)", () => {
  let state: TeamManager;
  let codex: MockCodexClient;
  let messages: MessageSystem;
  let server: McpServer;

  beforeEach(() => {
    state = new TeamManager();
    codex = new MockCodexClient();
    messages = new MessageSystem();
    server = createServer(state, codex, messages);
  });

  it("steers all agents in a team", async () => {
    const { teamId, agentIds } = createTeamWithAgents(state, "test-team", [
      { role: "lead", isLead: true },
      { role: "worker" },
    ]);

    const result = await callTool(server, "steer_team", {
      teamId,
      directive: "Switch to writing tests instead",
    });

    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.aborted.sort(), agentIds.sort());
    assert.deepEqual(data.steered.sort(), agentIds.sort());
    assert.deepEqual(data.failed, []);

    assert.equal(codex.calls.length, 2);
    for (const call of codex.calls) {
      assert.ok(call.message.includes("DIRECTION CHANGE FROM ORCHESTRATOR"));
      assert.ok(call.message.includes("Switch to writing tests instead"));
    }
  });

  it("steers a subset of agents via agentIds", async () => {
    const { teamId, agentIds } = createTeamWithAgents(state, "test-team", [
      { role: "lead", isLead: true },
      { role: "worker-a" },
      { role: "worker-b" },
    ]);

    const subset = [agentIds[1], agentIds[2]];

    const result = await callTool(server, "steer_team", {
      teamId,
      directive: "New direction",
      agentIds: subset,
    });

    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.aborted.sort(), subset.sort());
    assert.deepEqual(data.steered.sort(), subset.sort());
    assert.equal(codex.calls.length, 2);
    assert.ok(codex.calls.every((c) => subset.includes(c.agentId)));
  });

  it("posts direction change to group chat", async () => {
    const { teamId } = createTeamWithAgents(state, "test-team", [{ role: "dev" }]);

    await callTool(server, "steer_team", {
      teamId,
      directive: "Focus on performance",
    });

    const chatMessages = messages.getTeamChatMessages(teamId);
    assert.equal(chatMessages.length, 1);
    assert.equal(chatMessages[0].from, "orchestrator");
    assert.equal(chatMessages[0].fromRole, "Orchestrator");
    assert.ok(chatMessages[0].text.includes("DIRECTION CHANGE"));
    assert.ok(chatMessages[0].text.includes("Focus on performance"));
  });

  it("includes directive in steer message sent to agents", async () => {
    const { teamId } = createTeamWithAgents(state, "test-team", [{ role: "dev" }]);

    await callTool(server, "steer_team", {
      teamId,
      directive: "Refactor auth module",
    });

    assert.equal(codex.calls.length, 1);
    const msg = codex.calls[0].message;
    assert.ok(msg.includes("=== NEW DIRECTIVE ==="));
    assert.ok(msg.includes("Refactor auth module"));
    assert.ok(msg.includes("Read group_chat"));
  });

  it("returns error for unknown team", async () => {
    const result = await callTool(server, "steer_team", {
      teamId: "nonexistent",
      directive: "anything",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("Team not found"));
  });

  it("handles agent send failure gracefully", async () => {
    const { teamId, agentIds } = createTeamWithAgents(state, "test-team", [
      { role: "good-agent" },
      { role: "bad-agent" },
    ]);

    codex.failForAgentId = agentIds[1];

    const result = await callTool(server, "steer_team", {
      teamId,
      directive: "New plan",
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.steered.length, 1);
    assert.equal(data.steered[0], agentIds[0]);
    assert.equal(data.failed.length, 1);
    assert.equal(data.failed[0].agentId, agentIds[1]);
    assert.ok(data.failed[0].error.includes("Simulated failure"));
  });

  it("returns empty results for team with no agents", async () => {
    const team = state.createTeam("empty-team", []);

    const result = await callTool(server, "steer_team", {
      teamId: team.id,
      directive: "anything",
    });

    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data, { aborted: [], steered: [], failed: [] });
    assert.equal(codex.calls.length, 0);
  });
});
