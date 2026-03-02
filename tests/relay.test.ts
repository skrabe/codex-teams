import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { startCommsServer } from "../src/comms-server.js";

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function createAgentClient(port: number, agentId: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${port}/mcp?agent=${encodeURIComponent(agentId)}`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: `agent-${agentId}`, version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function parseToolResult(result: ToolResultContent) {
  return JSON.parse(result.content[0].text);
}

describe("relay e2e (real HTTP MCP stack)", () => {
  let httpServer: Server;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {});
    clients.length = 0;
    httpServer?.close();
  });

  it("two agents count 1-10 via group chat over HTTP", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();

    const team = state.createTeam("relay-team", [
      { role: "agent-a" },
      { role: "agent-b" },
    ]);
    const agents = Array.from(team.agents.values());
    const agentA = agents[0];
    const agentB = agents[1];

    const server = await startCommsServer(messages, state);
    httpServer = server.httpServer;

    const clientA = await createAgentClient(server.port, agentA.id);
    const clientB = await createAgentClient(server.port, agentB.id);
    clients.push(clientA, clientB);

    const MAX = 10;
    const log: Array<{ n: number; from: string; elapsed: number }> = [];
    const start = Date.now();

    async function agentTurn(
      client: Client,
      role: string,
      myNumbers: number[],
    ) {
      for (const n of myNumbers) {
        if (n > 1) {
          const waitResult = await client.callTool({
            name: "wait_for_messages",
            arguments: { timeoutMs: 10000 },
          }) as ToolResultContent;
          const waitData = parseToolResult(waitResult);
          assert.equal(waitData.timedOut, false, `${role} timed out waiting for ${n - 1}`);

          await client.callTool({ name: "group_chat_read", arguments: {} });
        }

        await client.callTool({
          name: "group_chat_post",
          arguments: { message: String(n) },
        });
        log.push({ n, from: role, elapsed: Date.now() - start });
      }
    }

    const oddNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 1);
    const evenNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 0);

    await Promise.all([
      agentTurn(clientA, "A", oddNumbers),
      agentTurn(clientB, "B", evenNumbers),
    ]);

    assert.equal(log.length, MAX);

    const sorted = [...log].sort((a, b) => a.n - b.n);
    for (let i = 0; i < MAX; i++) {
      assert.equal(sorted[i].n, i + 1);
    }

    const totalMs = log[log.length - 1].elapsed;
    const perTurnMs = totalMs / (MAX - 1);

    console.log(`    HTTP relay 1-${MAX}: ${totalMs}ms total, ${perTurnMs.toFixed(1)}ms/turn`);
    console.log(`    Turns: ${sorted.map((l) => `${l.n}(${l.from} +${l.elapsed}ms)`).join(" → ")}`);
  });

  it("two agents count 1-20 via DMs over HTTP", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();

    const team = state.createTeam("dm-relay-team", [
      { role: "agent-a" },
      { role: "agent-b" },
    ]);
    const agents = Array.from(team.agents.values());
    const agentA = agents[0];
    const agentB = agents[1];

    const server = await startCommsServer(messages, state);
    httpServer = server.httpServer;

    const clientA = await createAgentClient(server.port, agentA.id);
    const clientB = await createAgentClient(server.port, agentB.id);
    clients.push(clientA, clientB);

    const MAX = 20;
    const log: Array<{ n: number; from: string; elapsed: number }> = [];
    const start = Date.now();

    async function agentTurn(
      client: Client,
      role: string,
      partnerId: string,
      myNumbers: number[],
    ) {
      for (const n of myNumbers) {
        if (n > 1) {
          const waitResult = await client.callTool({
            name: "wait_for_messages",
            arguments: { timeoutMs: 10000 },
          }) as ToolResultContent;
          const waitData = parseToolResult(waitResult);
          assert.equal(waitData.timedOut, false, `${role} timed out waiting for ${n - 1}`);

          await client.callTool({ name: "dm_read", arguments: {} });
        }

        await client.callTool({
          name: "dm_send",
          arguments: { toAgentId: partnerId, message: String(n) },
        });
        log.push({ n, from: role, elapsed: Date.now() - start });
      }
    }

    const oddNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 1);
    const evenNumbers = Array.from({ length: MAX }, (_, i) => i + 1).filter((n) => n % 2 === 0);

    await Promise.all([
      agentTurn(clientA, "A", agentB.id, oddNumbers),
      agentTurn(clientB, "B", agentA.id, evenNumbers),
    ]);

    assert.equal(log.length, MAX);

    const sorted = [...log].sort((a, b) => a.n - b.n);
    for (let i = 0; i < MAX; i++) {
      assert.equal(sorted[i].n, i + 1);
    }

    const totalMs = log[log.length - 1].elapsed;
    const perTurnMs = totalMs / (MAX - 1);

    console.log(`    HTTP DM relay 1-${MAX}: ${totalMs}ms total, ${perTurnMs.toFixed(1)}ms/turn`);
    console.log(`    Turns: ${sorted.map((l) => `${l.n}(${l.from} +${l.elapsed}ms)`).join(" → ")}`);
  });

  it("four agents round-robin count 1-20 via group chat over HTTP", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();

    const team = state.createTeam("round-robin-team", [
      { role: "agent-a" },
      { role: "agent-b" },
      { role: "agent-c" },
      { role: "agent-d" },
    ]);
    const agents = Array.from(team.agents.values());

    const server = await startCommsServer(messages, state);
    httpServer = server.httpServer;

    const agentClients = await Promise.all(
      agents.map((a) => createAgentClient(server.port, a.id)),
    );
    clients.push(...agentClients);

    const MAX = 20;
    const log: Array<{ n: number; from: string; elapsed: number }> = [];
    const start = Date.now();

    async function agentTurn(
      client: Client,
      role: string,
      myNumbers: number[],
    ) {
      for (const n of myNumbers) {
        if (n > 1) {
          const waitResult = await client.callTool({
            name: "wait_for_messages",
            arguments: { timeoutMs: 10000 },
          }) as ToolResultContent;
          const waitData = parseToolResult(waitResult);
          assert.equal(waitData.timedOut, false, `${role} timed out waiting for ${n - 1}`);

          await client.callTool({ name: "group_chat_read", arguments: {} });
        }

        await client.callTool({
          name: "group_chat_post",
          arguments: { message: String(n) },
        });
        log.push({ n, from: role, elapsed: Date.now() - start });
      }
    }

    const agentNumbers: number[][] = [[], [], [], []];
    for (let n = 1; n <= MAX; n++) {
      agentNumbers[(n - 1) % 4].push(n);
    }

    await Promise.all(
      agentClients.map((client, i) =>
        agentTurn(client, `Agent${i}`, agentNumbers[i]),
      ),
    );

    assert.equal(log.length, MAX);

    const sorted = [...log].sort((a, b) => a.n - b.n);
    for (let i = 0; i < MAX; i++) {
      assert.equal(sorted[i].n, i + 1);
    }

    const totalMs = log[log.length - 1].elapsed;
    const perTurnMs = totalMs / (MAX - 1);

    console.log(`    HTTP 4-agent relay 1-${MAX}: ${totalMs}ms total, ${perTurnMs.toFixed(1)}ms/turn`);
    console.log(`    Turns: ${sorted.map((l) => `${l.n}(${l.from} +${l.elapsed}ms)`).join(" → ")}`);
  });
});
