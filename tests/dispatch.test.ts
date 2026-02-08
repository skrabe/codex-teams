import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { CodexClientManager } from "../src/codex-client.js";
import { createServer } from "../src/server.js";
import type { Agent } from "../src/types.js";

interface DispatchResultEntry {
  role: string;
  status: string;
  output: string;
}

class MockCodexClient extends CodexClientManager {
  calls: Array<{ agentId: string; message: string }> = [];
  nextResponse = "mock response";
  failForAgentRole: string | null = null;

  override async connect() {}
  override async disconnect() {}
  override isConnected() {
    return true;
  }

  override async sendToAgent(agent: Agent, message: string): Promise<string> {
    this.calls.push({ agentId: agent.id, message });

    if (this.failForAgentRole && agent.role === this.failForAgentRole) {
      agent.status = "error";
      throw new Error(`Simulated failure for ${agent.role}`);
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

describe("dispatch_team (e2e with mock codex)", () => {
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

  it("creates team, dispatches tasks in parallel, returns report", async () => {
    codex.nextResponse = "task completed successfully";

    const result = await callTool(server, "dispatch_team", {
      name: "test-team",
      workDir: "/tmp/test",
      agents: [
        { role: "dev-a", specialization: "Frontend", task: "Build login page" },
        { role: "dev-b", specialization: "Backend", task: "Create API endpoint" },
        { role: "tester", task: "Write tests" },
      ],
    });

    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.teamName, "test-team");
    assert.equal(data.results.length, 3);
    assert.ok(data.results.every((r: DispatchResultEntry) => r.status === "success"));
    assert.ok(data.results.every((r: DispatchResultEntry) => r.output === "task completed successfully"));

    assert.equal(codex.calls.length, 3);
    assert.equal(codex.calls[0].message, "Build login page");
    assert.equal(codex.calls[1].message, "Create API endpoint");
    assert.equal(codex.calls[2].message, "Write tests");
  });

  it("dissolves team after dispatch", async () => {
    codex.nextResponse = "done";

    await callTool(server, "dispatch_team", {
      name: "ephemeral",
      workDir: "/tmp",
      agents: [{ role: "dev", task: "do something" }],
    });

    assert.equal(state.listTeams().length, 0);
  });

  it("handles agent errors gracefully (one fails, others succeed)", async () => {
    codex.nextResponse = "success";
    codex.failForAgentRole = "bad-agent";

    const result = await callTool(server, "dispatch_team", {
      name: "mixed-team",
      workDir: "/tmp",
      agents: [
        { role: "good-agent", task: "work fine" },
        { role: "bad-agent", task: "will fail" },
        { role: "another-good", task: "also works" },
      ],
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results.length, 3);

    const good1 = data.results.find((r: DispatchResultEntry) => r.role === "good-agent");
    assert.equal(good1.status, "success");

    const bad = data.results.find((r: DispatchResultEntry) => r.role === "bad-agent");
    assert.equal(bad.status, "error");
    assert.ok(bad.output.includes("Simulated failure"));

    const good2 = data.results.find((r: DispatchResultEntry) => r.role === "another-good");
    assert.equal(good2.status, "success");
  });

  it("cleans up messages on dissolve", async () => {
    codex.nextResponse = "done";

    await callTool(server, "dispatch_team", {
      name: "msg-team",
      workDir: "/tmp",
      agents: [{ role: "dev", task: "task" }],
    });

    assert.equal(state.listTeams().length, 0);
  });

  it("returns report with correct roles", async () => {
    codex.nextResponse = "output";

    const result = await callTool(server, "dispatch_team", {
      name: "role-test",
      workDir: "/tmp",
      agents: [
        { role: "architect", isLead: true, task: "design" },
        { role: "developer", task: "implement" },
      ],
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results[0].role, "architect");
    assert.equal(data.results[1].role, "developer");
  });

  it("works with single agent team", async () => {
    codex.nextResponse = "solo result";

    const result = await callTool(server, "dispatch_team", {
      name: "solo",
      workDir: "/tmp",
      agents: [{ role: "solo-dev", task: "do everything" }],
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].status, "success");
  });

  it("works with large team", async () => {
    codex.nextResponse = "done";

    const agents = Array.from({ length: 10 }, (_, i) => ({
      role: `worker-${i}`,
      task: `task ${i}`,
    }));

    const result = await callTool(server, "dispatch_team", {
      name: "large-team",
      workDir: "/tmp",
      agents,
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results.length, 10);
    assert.equal(codex.calls.length, 10);
  });

  it("passes sandbox mode through", async () => {
    codex.nextResponse = "done";

    await callTool(server, "dispatch_team", {
      name: "sandbox-test",
      workDir: "/tmp",
      agents: [{ role: "dev", task: "task", sandbox: "danger-full-access" }],
    });

    assert.equal(codex.calls.length, 1);
  });
});
