import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { startCommsServer } from "../src/comms-server.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function initRequest(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };
}

async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error(`No data line in SSE response: ${text}`);
    return JSON.parse(dataLine.slice(6));
  }
  return res.json();
}

describe("comms server HTTP", () => {
  let httpServer: Server;

  afterEach(() => {
    httpServer?.close();
  });

  it("assigns a real port (not 0)", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    assert.ok(result.port > 0, `Expected port > 0, got ${result.port}`);
    assert.ok(result.port < 65536, `Expected port < 65536, got ${result.port}`);
  });

  it("accepts HTTP connections on the assigned port", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const res = await fetch(`http://127.0.0.1:${result.port}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ invalid: true }),
    });

    assert.ok(res.status >= 400, `Expected error status for invalid request, got ${res.status}`);
  });

  it("completes MCP initialize handshake", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const res = await fetch(`http://127.0.0.1:${result.port}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(initRequest()),
    });

    assert.equal(res.status, 200, `Expected 200 for initialize, got ${res.status}`);
    const body = await parseResponse(res);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 1);
    const result2 = body.result as Record<string, unknown>;
    assert.ok(result2, "Should have result in initialize response");
    const serverInfo = result2.serverInfo as Record<string, unknown>;
    assert.ok(serverInfo, "Should have serverInfo");
    assert.equal(serverInfo.name, "team-comms");
  });

  it("returns session ID header after initialize", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const res = await fetch(`http://127.0.0.1:${result.port}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(initRequest()),
    });

    const sessionId = res.headers.get("mcp-session-id");
    assert.ok(sessionId, "Should return mcp-session-id header");
    assert.ok(sessionId.length > 0, "Session ID should not be empty");
  });

  it("can call tools after initialize", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();
    state.createTeam("test-team", [{ role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const agent = Array.from(state.listTeams()[0].agents.values())[0];

    const initRes = await fetch(
      `http://127.0.0.1:${result.port}/mcp?agent=${encodeURIComponent(agent.id)}`,
      {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(initRequest()),
      },
    );

    const sessionId = initRes.headers.get("mcp-session-id")!;

    const toolCall = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "group_chat_peek",
        arguments: {},
      },
    };

    const toolRes = await fetch(`http://127.0.0.1:${result.port}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify(toolCall),
    });

    assert.equal(toolRes.status, 200);
    const toolBody = await parseResponse(toolRes);
    assert.equal(toolBody.id, 2);
    assert.ok(toolBody.result, "Should have tool result");
  });

  it("starts multiple servers on different ports", async () => {
    const state = new TeamManager();
    const messages = new MessageSystem();
    const result1 = await startCommsServer(messages, state);
    const result2 = await startCommsServer(messages, state);

    assert.ok(result1.port > 0);
    assert.ok(result2.port > 0);
    assert.notEqual(result1.port, result2.port, "Each server should get a unique port");

    result1.httpServer.close();
    result2.httpServer.close();
  });
});
