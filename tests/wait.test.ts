import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { registerCommsTools } from "../src/comms-server.js";

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function getTools(server: McpServer) {
  return (server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })
    ._registeredTools;
}

function parseResult(result: ToolResult) {
  return JSON.parse(result.content[0].text);
}

describe("wait_for_messages", () => {
  let state: TeamManager;
  let ms: MessageSystem;
  let teamId: string;
  let leadId: string;
  let workerId: string;
  let workerTools: ReturnType<typeof getTools>;
  let leadTools: ReturnType<typeof getTools>;

  beforeEach(() => {
    state = new TeamManager();
    ms = new MessageSystem();

    const team = state.createTeam("test-team", [
      { role: "lead", isLead: true },
      { role: "worker" },
    ]);
    teamId = team.id;
    const agents = Array.from(team.agents.values());
    leadId = agents.find((a) => a.isLead)!.id;
    workerId = agents.find((a) => !a.isLead)!.id;

    const workerServer = new McpServer({ name: "test", version: "1.0.0" });
    registerCommsTools(workerServer, ms, state, workerId);
    workerTools = getTools(workerServer);

    const leadServer = new McpServer({ name: "test", version: "1.0.0" });
    registerCommsTools(leadServer, ms, state, leadId);
    leadTools = getTools(leadServer);
  });

  it("returns immediately when unreads exist", async () => {
    ms.groupChatPost(teamId, leadId, "lead", "plan posted");

    const result = await workerTools.wait_for_messages.handler({ timeoutMs: 5000 }, {}) as ToolResult;
    const data = parseResult(result);

    assert.equal(data.timedOut, false);
    assert.equal(data.groupChat, 1);
  });

  it("blocks then resolves when message arrives", async () => {
    const start = Date.now();
    const waitPromise = workerTools.wait_for_messages.handler({ timeoutMs: 10000 }, {}) as Promise<ToolResult>;

    setTimeout(() => {
      ms.groupChatPost(teamId, leadId, "lead", "delayed message");
    }, 50);

    const result = await waitPromise;
    const elapsed = Date.now() - start;
    const data = parseResult(result);

    assert.equal(data.timedOut, false);
    assert.equal(data.groupChat, 1);
    assert.ok(elapsed < 5000, `Should resolve quickly, took ${elapsed}ms`);
  });

  it("times out and returns timedOut: true", async () => {
    const result = await workerTools.wait_for_messages.handler({ timeoutMs: 1000 }, {}) as ToolResult;
    const data = parseResult(result);

    assert.equal(data.timedOut, true);
    assert.equal(data.groupChat, 0);
    assert.equal(data.dms, 0);
  });

  it("dissolution returns dissolved: true", async () => {
    const waitPromise = workerTools.wait_for_messages.handler({ timeoutMs: 10000 }, {}) as Promise<ToolResult>;

    setTimeout(() => {
      ms.dissolveTeamWithAgents(teamId, [leadId, workerId]);
    }, 50);

    const result = await waitPromise;
    const data = parseResult(result);

    assert.equal(data.dissolved, true);
    assert.equal(data.timedOut, false);
  });

  it("own messages do not trigger wake-up", async () => {
    const start = Date.now();
    const waitPromise = workerTools.wait_for_messages.handler({ timeoutMs: 1000 }, {}) as Promise<ToolResult>;

    setTimeout(() => {
      ms.groupChatPost(teamId, workerId, "worker", "my own message");
    }, 50);

    const result = await waitPromise;
    const elapsed = Date.now() - start;
    const data = parseResult(result);

    assert.equal(data.timedOut, true);
    assert.ok(elapsed >= 900, `Should have timed out, took ${elapsed}ms`);
  });

  it("lead sees leadChat count, worker gets 0", async () => {
    ms.leadChatPost("other-lead", "lead", "other-team", "cross-team msg");

    const leadResult = await leadTools.wait_for_messages.handler({ timeoutMs: 5000 }, {}) as ToolResult;
    const leadData = parseResult(leadResult);
    assert.equal(leadData.leadChat, 1);

    const workerResult = await workerTools.wait_for_messages.handler({ timeoutMs: 1000 }, {}) as ToolResult;
    const workerData = parseResult(workerResult);
    assert.equal(workerData.leadChat, 0);
  });

  it("DM triggers wake-up for recipient", async () => {
    const waitPromise = workerTools.wait_for_messages.handler({ timeoutMs: 10000 }, {}) as Promise<ToolResult>;

    setTimeout(() => {
      ms.dmSend(leadId, workerId, "lead", "hey worker");
    }, 50);

    const result = await waitPromise;
    const data = parseResult(result);

    assert.equal(data.timedOut, false);
    assert.equal(data.dms, 1);
  });

  it("counting relay 1-10: two agents take turns via group chat", async () => {
    const MAX = 10;
    const log: Array<{ n: number; from: string; elapsed: number }> = [];
    const start = Date.now();

    async function agentTurn(
      myTools: ReturnType<typeof getTools>,
      myRole: string,
      myNumbers: number[],
    ) {
      for (const n of myNumbers) {
        if (n > 1) {
          const waitResult = await myTools.wait_for_messages.handler({ timeoutMs: 5000 }, {}) as ToolResult;
          const waitData = parseResult(waitResult);
          assert.equal(waitData.timedOut, false, `Agent ${myRole} timed out waiting for ${n - 1}`);

          const readResult = await myTools.group_chat_read.handler({}, {}) as ToolResult;
          const msgs = JSON.parse(readResult.content[0].text);
          const last = msgs[msgs.length - 1];
          assert.equal(last.text, String(n - 1), `Expected ${n - 1}, got "${last.text}"`);
        }

        await myTools.group_chat_post.handler({ message: String(n) }, {});
        log.push({ n, from: myRole, elapsed: Date.now() - start });
      }
    }

    const oddNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 1);
    const evenNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 0);

    await Promise.all([
      agentTurn(leadTools, "lead", oddNumbers),
      agentTurn(workerTools, "worker", evenNumbers),
    ]);

    assert.equal(log.length, MAX);

    const sorted = [...log].sort((a, b) => a.n - b.n);
    for (let i = 0; i < MAX; i++) {
      assert.equal(sorted[i].n, i + 1);
      assert.equal(sorted[i].from, i % 2 === 0 ? "lead" : "worker");
    }

    const totalMs = log[log.length - 1].elapsed;
    const perTurnMs = totalMs / (MAX - 1);

    console.log(`    Relay 1-${MAX}: ${totalMs}ms total, ${perTurnMs.toFixed(1)}ms/turn`);
    console.log(`    Turns: ${log.map((l) => `${l.n}(${l.from} +${l.elapsed}ms)`).join(" → ")}`);

    assert.ok(totalMs < 2000, `Full relay took ${totalMs}ms, expected < 2000ms`);
  });

  it("counting relay 1-20 via DMs", async () => {
    const MAX = 20;
    const log: Array<{ n: number; from: string; elapsed: number }> = [];
    const start = Date.now();

    async function agentTurn(
      myTools: ReturnType<typeof getTools>,
      myRole: string,
      partnerId: string,
      myNumbers: number[],
    ) {
      for (const n of myNumbers) {
        if (n > 1) {
          const waitResult = await myTools.wait_for_messages.handler({ timeoutMs: 5000 }, {}) as ToolResult;
          const waitData = parseResult(waitResult);
          assert.equal(waitData.timedOut, false, `Agent ${myRole} timed out waiting for ${n - 1}`);

          const readResult = await myTools.dm_read.handler({}, {}) as ToolResult;
          const msgs = JSON.parse(readResult.content[0].text);
          const last = msgs[msgs.length - 1];
          assert.equal(last.text, String(n - 1), `Expected ${n - 1}, got "${last.text}"`);
        }

        await myTools.dm_send.handler({ toAgentId: partnerId, message: String(n) }, {});
        log.push({ n, from: myRole, elapsed: Date.now() - start });
      }
    }

    const oddNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 1);
    const evenNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 0);

    await Promise.all([
      agentTurn(leadTools, "lead", workerId, oddNumbers),
      agentTurn(workerTools, "worker", leadId, evenNumbers),
    ]);

    assert.equal(log.length, MAX);

    const sorted = [...log].sort((a, b) => a.n - b.n);
    for (let i = 0; i < MAX; i++) {
      assert.equal(sorted[i].n, i + 1);
    }

    const totalMs = log[log.length - 1].elapsed;
    const perTurnMs = totalMs / (MAX - 1);

    console.log(`    DM relay 1-${MAX}: ${totalMs}ms total, ${perTurnMs.toFixed(1)}ms/turn`);

    assert.ok(totalMs < 2000, `Full DM relay took ${totalMs}ms, expected < 2000ms`);
  });
});
