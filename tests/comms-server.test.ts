import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";
import { startCommsServer } from "../src/comms-server.js";
import { CodexClientManager } from "../src/codex-client.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const BLOCK_HOOK_COMMAND =
  'node -e "process.stdin.resume();process.stdin.on(\'end\',()=>{console.error(\'blocked by policy\');process.exit(1);});"';

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

async function initializeAgent(port: number, agentId: string, token?: string): Promise<string> {
  const params = new URLSearchParams({ agent: agentId });
  if (token) params.set("token", token);
  const res = await fetch(`http://127.0.0.1:${port}/mcp?${params.toString()}`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(initRequest()),
  });
  return res.headers.get("mcp-session-id")!;
}

async function callTool(port: number, sessionId: string, name: string, args: Record<string, unknown>, id = 2) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  assert.equal(res.status, 200);
  return parseResponse(res);
}

function parseToolText(body: Record<string, unknown>) {
  const result = body.result as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>>;
  return JSON.parse(content[0].text as string) as Record<string, unknown>;
}

describe("comms server HTTP", () => {
  let httpServer: Server;
  let taskStoreRoot: string;
  let protocolInboxRoot: string;
  let chatStoreRoot: string;

  beforeEach(() => {
    taskStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-comms-"));
    protocolInboxRoot = path.join(taskStoreRoot, "inboxes");
    chatStoreRoot = path.join(taskStoreRoot, "chats");
  });

  afterEach(() => {
    httpServer?.close();
    fs.rmSync(taskStoreRoot, { recursive: true, force: true });
  });

  it("assigns a real port (not 0)", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    assert.ok(result.port > 0, `Expected port > 0, got ${result.port}`);
    assert.ok(result.port < 65536, `Expected port < 65536, got ${result.port}`);
  });

  it("accepts HTTP connections on the assigned port", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
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
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
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
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
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
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    state.createTeam("test-team", [{ role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const agent = Array.from(state.listTeams()[0].agents.values())[0];
    const sessionId = await initializeAgent(result.port, agent.id);
    const toolBody = await callTool(result.port, sessionId, "group_chat_peek", {});
    assert.equal(toolBody.id, 2);
    assert.ok(toolBody.result, "Should have tool result");
  });

  it("requires DM summaries and returns them on read", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id);
    const workerSession = await initializeAgent(result.port, worker.id);

    const missingSummary = await callTool(
      result.port,
      leadSession,
      "dm_send",
      { toAgentId: worker.id, message: "Need you on auth" },
      60,
    );
    const missingSummaryResult = missingSummary.result as Record<string, unknown>;
    assert.equal(missingSummaryResult.isError, true);

    await callTool(
      result.port,
      leadSession,
      "dm_send",
      { toAgentId: worker.id, message: "Need you on auth", summary: "Auth question" },
      61,
    );

    const read = parseToolText(await callTool(result.port, workerSession, "dm_read", {}, 62)) as Array<Record<string, unknown>>;
    assert.equal(read.length, 1);
    assert.equal(read[0].text, "Need you on auth");
    assert.equal(read[0].summary, "Auth question");
  });

  it("supports task tool workflow with Claude-style ownership", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id);
    const workerSession = await initializeAgent(result.port, worker.id);

    const created = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "task_create",
        { subject: "Root task", description: "Create the shared type", owner: null },
      ),
    );
    const createdTask = created.task as Record<string, unknown>;
    assert.equal(createdTask.subject, "Root task");
    assert.equal(createdTask.owner, null);

    const updated = parseToolText(
      await callTool(
        result.port,
        workerSession,
        "task_update",
        { taskId: createdTask.id, status: "in-progress" },
        3,
      ),
    );
    const inProgressTask = updated.task as Record<string, unknown>;
    assert.equal(inProgressTask.owner, worker.id);
    assert.equal(inProgressTask.status, "in-progress");

    const protocol = parseToolText(
      await callTool(result.port, workerSession, "protocol_read", {}, 31),
    );
    const protocolBatch = protocol as Record<string, unknown>;
    const protocolMessages = protocolBatch.messages as Array<Record<string, unknown>>;
    assert.equal(typeof protocolBatch.deliveryId, "string");
    assert.equal(protocolMessages.length, 1);
    assert.equal(protocolMessages[0].type, "task_assignment");
    assert.equal((protocolMessages[0].data as Record<string, unknown>).taskId, createdTask.id);

    const ack = parseToolText(await callTool(result.port, workerSession, "protocol_ack", { deliveryId: protocolBatch.deliveryId }, 311));
    assert.equal((ack as Record<string, unknown>).acknowledged, 1);

    const completed = parseToolText(
      await callTool(
        result.port,
        workerSession,
        "task_update",
        { taskId: createdTask.id, status: "completed", result: "Done" },
        4,
      ),
    );
    assert.equal((completed.task as Record<string, unknown>).status, "completed");

    const list = parseToolText(
      await callTool(result.port, leadSession, "task_list", { includeCompleted: true }, 5),
    );
    const tasks = list.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].result, "Done");
    assert.equal(list.recommendedTaskId, undefined);
    assert.equal(list.claimableCount, 0);
    assert.equal(list.blockedCount, 0);
    assert.equal(tasks[0].claimable, false);
    assert.equal(tasks[0].recommended, false);

    const fetched = parseToolText(
      await callTool(result.port, leadSession, "task_get", { taskId: createdTask.id }, 6),
    );
    assert.equal((fetched.task as Record<string, unknown>).id, createdTask.id);

    const reset = parseToolText(
      await callTool(result.port, leadSession, "task_reset", { taskId: createdTask.id }, 7),
    );
    assert.equal((reset.task as Record<string, unknown>).owner, null);
    assert.equal((reset.task as Record<string, unknown>).status, "pending");

    const another = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "task_create",
        { description: "Implement endpoint", owner: null },
        8,
      ),
    );
    const anotherTask = another.task as Record<string, unknown>;

    const claimed = parseToolText(
      await callTool(
        result.port,
        workerSession,
        "task_claim",
        { taskId: anotherTask.id, checkAgentBusy: true },
        9,
      ),
    );
    assert.equal((claimed.task as Record<string, unknown>).owner, worker.id);

    const unassigned = parseToolText(
      await callTool(result.port, workerSession, "task_unassign", {}, 10),
    );
    const unassignedTasks = unassigned.tasks as Array<Record<string, unknown>>;
    assert.equal(unassignedTasks.length, 1);
  });

  it("orders task_list by execution priority and marks recommended claimable task", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id);
    const workerSession = await initializeAgent(result.port, worker.id);

    const root = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "task_create",
        { subject: "1 root", description: "root", owner: null },
        70,
      ),
    );
    const rootTask = root.task as Record<string, unknown>;

    const blocked = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "task_create",
        { subject: "2 blocked", description: "blocked", owner: null, dependencies: [rootTask.id] },
        71,
      ),
    );
    const blockedTask = blocked.task as Record<string, unknown>;

    const workerOwned = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "task_create",
        { subject: "3 worker", description: "worker scoped", owner: worker.id },
        72,
      ),
    );
    const workerTask = workerOwned.task as Record<string, unknown>;

    const leadOwned = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "task_create",
        { subject: "4 lead", description: "lead scoped", owner: lead.id },
        73,
      ),
    );
    const leadTask = leadOwned.task as Record<string, unknown>;

    const listed = parseToolText(
      await callTool(result.port, workerSession, "task_list", { includeCompleted: true }, 74),
    );
    const tasks = listed.tasks as Array<Record<string, unknown>>;

    assert.equal(listed.recommendedTaskId, rootTask.id);
    assert.equal(listed.claimableCount, 2);
    assert.equal(listed.blockedCount, 1);

    assert.deepEqual(
      tasks.map((task) => task.id),
      [rootTask.id, workerTask.id, blockedTask.id, leadTask.id],
    );

    const rootListed = tasks.find((task) => task.id === rootTask.id)!;
    const workerListed = tasks.find((task) => task.id === workerTask.id)!;
    const blockedListed = tasks.find((task) => task.id === blockedTask.id)!;
    const leadListed = tasks.find((task) => task.id === leadTask.id)!;

    assert.equal(rootListed.claimable, true);
    assert.equal(rootListed.recommended, true);
    assert.equal(workerListed.claimable, true);
    assert.equal(workerListed.recommended, false);
    assert.equal(blockedListed.claimable, false);
    assert.equal(blockedListed.recommended, false);
    assert.equal(leadListed.claimable, false);
    assert.equal(leadListed.recommended, false);
  });

  it("rolls back task_create when TaskCreated hook blocks", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }]);
    team.hookCommands = { taskCreated: BLOCK_HOOK_COMMAND };
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const lead = Array.from(team.agents.values())[0];
    const leadSession = await initializeAgent(result.port, lead.id);
    const response = await callTool(
      result.port,
      leadSession,
      "task_create",
      { subject: "Blocked task", description: "Should not persist" },
      32,
    );
    const callResult = response.result as Record<string, unknown>;
    assert.equal(callResult.isError, true);
    const content = callResult.content as Array<Record<string, unknown>>;
    assert.match(content[0].text as string, /TaskCreated hook blocked/);

    const listed = parseToolText(await callTool(result.port, leadSession, "task_list", { includeCompleted: true }, 33));
    const tasks = listed.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 0);
  });

  it("blocks task completion when TaskCompleted hook fails", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    team.hookCommands = { taskCompleted: BLOCK_HOOK_COMMAND };
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id);
    const workerSession = await initializeAgent(result.port, worker.id);

    const created = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "task_create",
        { subject: "Implement API", description: "Create endpoint", owner: null },
        34,
      ),
    );
    const task = (created.task as Record<string, unknown>).id as string;

    await callTool(result.port, workerSession, "task_update", { taskId: task, status: "in-progress" }, 35);
    const completion = await callTool(
      result.port,
      workerSession,
      "task_update",
      { taskId: task, status: "completed", result: "Done" },
      36,
    );
    const completionResult = completion.result as Record<string, unknown>;
    assert.equal(completionResult.isError, true);
    const errorContent = completionResult.content as Array<Record<string, unknown>>;
    assert.match(errorContent[0].text as string, /TaskCompleted hook blocked/);

    const taskAfter = parseToolText(await callTool(result.port, workerSession, "task_get", { taskId: task }, 37));
    assert.equal((taskAfter.task as Record<string, unknown>).status, "in-progress");
  });

  it("rejects unknown owners in task tools", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const agent = Array.from(team.agents.values())[0];
    const sessionId = await initializeAgent(result.port, agent.id);

    const toolBody = await callTool(
      result.port,
      sessionId,
      "task_create",
      { description: "Bad owner", owner: "missing-agent" },
      3,
    );
    const resultBody = toolBody.result as Record<string, unknown>;
    assert.equal(resultBody.isError, true);
  });

  it("sends and reads protocol messages without exposing them through chat tools", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id);
    const workerSession = await initializeAgent(result.port, worker.id);

    await callTool(
      result.port,
      leadSession,
      "protocol_send",
      { toAgentId: worker.id, type: "shutdown_request", data: { reason: "done" } },
      20,
    );

    const peek = parseToolText(await callTool(result.port, workerSession, "protocol_peek", {}, 21));
    assert.equal((peek as Record<string, unknown>).unread, 1);

    const read = parseToolText(await callTool(result.port, workerSession, "protocol_read", {}, 22));
    const readBatch = read as Record<string, unknown>;
    const protocolMessages = readBatch.messages as Array<Record<string, unknown>>;
    assert.equal(typeof readBatch.deliveryId, "string");
    assert.equal(protocolMessages.length, 1);
    assert.equal(protocolMessages[0].type, "shutdown_request");

    const postReadPeek = parseToolText(await callTool(result.port, workerSession, "protocol_peek", {}, 221));
    assert.equal((postReadPeek as Record<string, unknown>).pending, 1);

    const ack = parseToolText(await callTool(result.port, workerSession, "protocol_ack", { deliveryId: readBatch.deliveryId }, 222));
    assert.equal((ack as Record<string, unknown>).acknowledged, 1);

    const dmRead = parseToolText(await callTool(result.port, workerSession, "dm_read", {}, 23));
    assert.deepEqual(dmRead, []);
  });

  it("rejects unsupported protocol types and invalid payloads", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id);

    const invalidType = await callTool(
      result.port,
      leadSession,
      "protocol_send",
      { toAgentId: worker.id, type: "unknown_type", data: { foo: "bar" } },
      620,
    );
    const invalidTypeResult = invalidType.result as Record<string, unknown>;
    assert.equal(invalidTypeResult.isError, true);

    const invalidPayload = await callTool(
      result.port,
      leadSession,
      "protocol_send",
      { toAgentId: worker.id, type: "shutdown_request", data: { bad: true } },
      621,
    );
    const invalidPayloadResult = invalidPayload.result as Record<string, unknown>;
    assert.equal(invalidPayloadResult.isError, true);
    const invalidContent = invalidPayloadResult.content as Array<Record<string, unknown>>;
    assert.match(invalidContent[0].text as string, /reason/i);
  });

  it("enforces lead-only protocol authority for mode and team permission updates", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id);
    const workerSession = await initializeAgent(result.port, worker.id);

    const workerDenied = await callTool(
      result.port,
      workerSession,
      "protocol_send",
      { toAgentId: lead.id, type: "mode_set_request", data: { mode: "on-request" } },
      622,
    );
    const workerDeniedResult = workerDenied.result as Record<string, unknown>;
    assert.equal(workerDeniedResult.isError, true);

    const leadAllowed = await callTool(
      result.port,
      leadSession,
      "protocol_send",
      { toAgentId: worker.id, type: "team_permission_update", data: { permissionMode: "on-request" } },
      623,
    );
    const leadAllowedResult = leadAllowed.result as Record<string, unknown>;
    assert.equal(leadAllowedResult.isError, undefined);

    const workerBatch = parseToolText(await callTool(result.port, workerSession, "protocol_read", {}, 624)) as Record<string, unknown>;
    const workerMessages = workerBatch.messages as Array<Record<string, unknown>>;
    assert.equal(workerMessages.length, 1);
    assert.equal(workerMessages[0].type, "team_permission_update");
    await callTool(result.port, workerSession, "protocol_ack", { deliveryId: workerBatch.deliveryId }, 625);
  });

  it("routes permissions-kind bridge messages via sandbox_permission protocol types", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const codex = new CodexClientManager();
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state, codex);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id, codex.generateAgentToken(lead.id));
    const workerSession = await initializeAgent(result.port, worker.id, codex.generateAgentToken(worker.id));

    const pendingDecision = codex.beginPermissionRequest(worker.id, {
      kind: "permissions",
      reason: "Need host permission",
      permissions: { network: { host: "example.com" } },
    });

    const leadBatch = parseToolText(await callTool(result.port, leadSession, "protocol_read", {}, 626)) as Record<string, unknown>;
    const leadMessages = leadBatch.messages as Array<Record<string, unknown>>;
    assert.equal(leadMessages.length, 1);
    assert.equal(leadMessages[0].type, "sandbox_permission_request");
    const requestData = leadMessages[0].data as Record<string, unknown>;

    await callTool(
      result.port,
      leadSession,
      "permission_respond",
      { requestId: requestData.requestId, decision: "approve", feedback: "ok" },
      627,
    );

    const decision = await pendingDecision;
    assert.equal(decision.approved, true);

    const workerBatch = parseToolText(await callTool(result.port, workerSession, "protocol_read", {}, 628)) as Record<string, unknown>;
    const workerMessages = workerBatch.messages as Array<Record<string, unknown>>;
    assert.equal(workerMessages.length, 1);
    assert.equal(workerMessages[0].type, "sandbox_permission_response");

    await callTool(result.port, leadSession, "protocol_ack", { deliveryId: leadBatch.deliveryId }, 629);
    await callTool(result.port, workerSession, "protocol_ack", { deliveryId: workerBatch.deliveryId }, 630);
  });

  it("rejects structured protocol broadcast targets", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const lead = Array.from(team.agents.values())[0];
    const leadSession = await initializeAgent(result.port, lead.id);

    const response = await callTool(
      result.port,
      leadSession,
      "protocol_send",
      { toAgentId: "*", type: "shutdown_request", data: { reason: "done" } },
      63,
    );
    const resultBody = response.result as Record<string, unknown>;
    assert.equal(resultBody.isError, true);
    const content = resultBody.content as Array<Record<string, unknown>>;
    assert.match(content[0].text as string, /cannot be broadcast/i);
  });

  it("routes plan approval requests through lead for review instead of auto-approving", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const codex = new CodexClientManager();
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "planner", sandbox: "plan-mode" }]);
    const result = await startCommsServer(messages, state, codex);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id, codex.generateAgentToken(lead.id));
    const workerSession = await initializeAgent(result.port, worker.id, codex.generateAgentToken(worker.id));

    const sendResult = await callTool(
      result.port,
      workerSession,
      "protocol_send",
      {
        toAgentId: lead.id,
        type: "plan_approval_request",
        data: {
          summary: "Implement API wiring",
          steps: ["Inspect handlers", "Patch routes", "Run tests"],
          taskIds: [],
        },
      },
      23,
    );
    const sendContent = (sendResult.result as Record<string, unknown>).content as Array<Record<string, unknown>>;
    assert.match(sendContent[0].text as string, /sent to lead/i);

    const contextBeforeRead = parseToolText(await callTool(result.port, leadSession, "get_team_context", {}, 24));
    const planner = ((contextBeforeRead.yourTeam as Record<string, unknown>).teammates as Array<Record<string, unknown>>)
      .find((teammate) => teammate.id === worker.id)!;
    assert.equal(planner.awaitingPlanApproval, true);

    const leadProtocol = parseToolText(await callTool(result.port, leadSession, "protocol_read", {}, 25)) as Record<string, unknown>;
    const leadMessages = leadProtocol.messages as Array<Record<string, unknown>>;
    assert.equal(leadMessages.length, 1);
    assert.equal(leadMessages[0].type, "plan_approval_request");

    const workerProtocolBeforeApproval = parseToolText(await callTool(result.port, workerSession, "protocol_read", {}, 26)) as Record<string, unknown>;
    assert.equal((workerProtocolBeforeApproval.messages as unknown[]).length, 0);

    await callTool(
      result.port,
      leadSession,
      "protocol_send",
      {
        toAgentId: worker.id,
        type: "plan_approval_response",
        data: { approved: true },
      },
      27,
    );

    const workerProtocol = parseToolText(await callTool(result.port, workerSession, "protocol_read", {}, 28)) as Record<string, unknown>;
    const workerMessages = workerProtocol.messages as Array<Record<string, unknown>>;
    assert.equal(workerMessages.length, 1);
    assert.equal(workerMessages[0].type, "plan_approval_response");
    assert.equal((workerMessages[0].data as Record<string, unknown>).approved, true);

    const contextAfterWorkerRead = parseToolText(await callTool(result.port, leadSession, "get_team_context", {}, 281));
    const plannerAfterWorkerRead = ((contextAfterWorkerRead.yourTeam as Record<string, unknown>).teammates as Array<Record<string, unknown>>)
      .find((teammate) => teammate.id === worker.id)!;
    assert.equal(plannerAfterWorkerRead.awaitingPlanApproval, true);

    await callTool(result.port, leadSession, "protocol_ack", { deliveryId: leadProtocol.deliveryId }, 29);
    await callTool(result.port, workerSession, "protocol_ack", { deliveryId: workerProtocol.deliveryId }, 30);

    const contextAfterRead = parseToolText(await callTool(result.port, leadSession, "get_team_context", {}, 31));
    const plannerAfterRead = ((contextAfterRead.yourTeam as Record<string, unknown>).teammates as Array<Record<string, unknown>>)
      .find((teammate) => teammate.id === worker.id)!;
    assert.equal(plannerAfterRead.awaitingPlanApproval, undefined);
  });



  it("bridges worker permission requests to the lead and resolves via permission_respond", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const codex = new CodexClientManager();
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state, codex);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());
    const leadSession = await initializeAgent(result.port, lead.id, codex.generateAgentToken(lead.id));
    const workerSession = await initializeAgent(result.port, worker.id, codex.generateAgentToken(worker.id));

    const pendingDecision = codex.beginPermissionRequest(worker.id, {
      kind: "command_execution",
      reason: "Execute npm test",
      command: "npm test",
      cwd: "/tmp/project",
      availableDecisions: ["accept", "decline", "acceptForSession"],
    });

    const leadProtocol = parseToolText(await callTool(result.port, leadSession, "protocol_read", {}, 40)) as Record<string, unknown>;
    const leadMessages = leadProtocol.messages as Array<Record<string, unknown>>;
    assert.equal(leadMessages.length, 1);
    assert.equal(leadMessages[0].type, "permission_request");
    const requestData = leadMessages[0].data as Record<string, unknown>;
    assert.equal(requestData.kind, "command_execution");
    assert.equal(requestData.command, "npm test");

    const contextBefore = parseToolText(await callTool(result.port, leadSession, "get_team_context", {}, 41));
    const pendingRequests = (contextBefore.pendingPermissionRequests as Array<Record<string, unknown>>) ?? [];
    assert.equal(pendingRequests.length, 1);
    assert.equal(pendingRequests[0].id, requestData.requestId);

    const resolved = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "permission_respond",
        { requestId: requestData.requestId, decision: "approve", scope: "session", feedback: "Approved" },
        42,
      ),
    );
    assert.equal((resolved.request as Record<string, unknown>).id, requestData.requestId);
    assert.equal((resolved.decision as Record<string, unknown>).approved, true);
    assert.equal((resolved.decision as Record<string, unknown>).scope, "session");

    const decision = await pendingDecision;
    assert.equal(decision.approved, true);
    assert.equal(decision.scope, "session");

    const workerProtocol = parseToolText(await callTool(result.port, workerSession, "protocol_read", {}, 43)) as Record<string, unknown>;
    const workerMessages = workerProtocol.messages as Array<Record<string, unknown>>;
    assert.equal(workerMessages.length, 1);
    assert.equal(workerMessages[0].type, "permission_response");
    assert.equal((workerMessages[0].data as Record<string, unknown>).requestId, requestData.requestId);
    assert.equal((workerMessages[0].data as Record<string, unknown>).approved, true);

    await callTool(result.port, leadSession, "protocol_ack", { deliveryId: leadProtocol.deliveryId }, 401);
    await callTool(result.port, workerSession, "protocol_ack", { deliveryId: workerProtocol.deliveryId }, 431);

    const contextAfter = parseToolText(await callTool(result.port, leadSession, "get_team_context", {}, 44));
    assert.equal(contextAfter.pendingPermissionRequests, undefined);
  });

  it("rejects shutdown_teammate for non-leads", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const codex = new CodexClientManager();
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const result = await startCommsServer(messages, state, codex);
    httpServer = result.httpServer;

    const worker = Array.from(team.agents.values()).find((agent) => !agent.isLead)!;
    const token = codex.generateAgentToken(worker.id);
    const workerSession = await initializeAgent(result.port, worker.id, token);

    const shutdown = await callTool(
      result.port,
      workerSession,
      "shutdown_teammate",
      { agentId: worker.id, reason: "nope" },
      24,
    );
    const shutdownResult = shutdown.result as Record<string, unknown>;
    assert.equal(shutdownResult.isError, true);
  });

  it("shuts down a worker, recovers tasks, and removes it from team context", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const codex = new CodexClientManager();
    codex.abortAgent = () => true;
    codex.clearLock = () => {};
    codex.cleanupAgent = () => {};

    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }, { role: "reviewer" }]);
    const [lead, target, observer] = Array.from(team.agents.values());
    const task = state.createTask(team.id, target.id, "Finish API");

    const result = await startCommsServer(messages, state, codex);
    httpServer = result.httpServer;

    const leadSession = await initializeAgent(result.port, lead.id, codex.generateAgentToken(lead.id));
    const targetSession = await initializeAgent(result.port, target.id, codex.generateAgentToken(target.id));
    const observerSession = await initializeAgent(result.port, observer.id, codex.generateAgentToken(observer.id));

    const shutdownResult = parseToolText(
      await callTool(
        result.port,
        leadSession,
        "shutdown_teammate",
        { agentId: target.id, reason: "scope complete" },
        25,
      ),
    );
    const shutdown = shutdownResult.shutdown as Record<string, unknown>;
    assert.equal(shutdown.agentId, target.id);
    assert.equal(typeof shutdown.aborted, "boolean");
    assert.equal(shutdown.terminationMode, shutdown.aborted ? "forced" : "graceful");
    assert.equal((shutdown.recoveredTasks as Array<Record<string, unknown>>).length, 1);
    assert.equal(((shutdown.recoveredTasks as Array<Record<string, unknown>>)[0].cause as string), "shutdown");
    assert.equal(state.getAgent(team.id, target.id), undefined);

    const recoveredTask = state.getTask(team.id, task.id)!;
    assert.equal(recoveredTask.status, "pending");
    assert.equal(recoveredTask.owner, null);

    const protocol = parseToolText(await callTool(result.port, leadSession, "protocol_read", {}, 26)) as Record<string, unknown>;
    const protocolMessages = protocol.messages as Array<Record<string, unknown>>;
    assert.equal(protocolMessages[0].type, "shutdown_approved");
    await callTool(result.port, leadSession, "protocol_ack", { deliveryId: protocol.deliveryId }, 262);

    const chat = parseToolText(await callTool(result.port, observerSession, "group_chat_read", {}, 27));
    assert.match((chat as Array<Record<string, unknown>>)[0].text as string, /task_recovery/);

    const context = parseToolText(await callTool(result.port, observerSession, "get_team_context", {}, 28));
    const teammateIds = ((context.yourTeam as Record<string, unknown>).teammates as Array<Record<string, unknown>>)
      .map((teammate) => teammate.id);
    assert.ok(!teammateIds.includes(target.id));

    const removedAgentResult = await callTool(result.port, targetSession, "group_chat_peek", {}, 29);
    assert.equal((removedAgentResult.result as Record<string, unknown>).isError, true);
  });

  it("supports HTTP shutdown endpoint for orchestrator control", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const codex = new CodexClientManager();
    codex.abortAgent = () => false;
    codex.clearLock = () => {};
    codex.cleanupAgent = () => {};

    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const target = Array.from(team.agents.values()).find((agent) => !agent.isLead)!;
    state.createTask(team.id, target.id, "Recover me");

    const result = await startCommsServer(messages, state, codex);
    httpServer = result.httpServer;

    const res = await fetch(`http://127.0.0.1:${result.port}/shutdown`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ teamId: team.id, agentId: target.id, reason: "orchestrator" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.agentId, target.id);
    assert.equal((body.recoveredTasks as Array<Record<string, unknown>>).length, 1);
    assert.equal(body.terminationMode, body.aborted ? "forced" : "graceful");
    assert.equal(state.getAgent(team.id, target.id), undefined);
  });

  it("supports HTTP operator message to a specific agent", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }]);

    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const [lead, worker] = Array.from(team.agents.values());

    const response = await fetch(`http://127.0.0.1:${result.port}/message`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({
        teamId: team.id,
        to: worker.id,
        message: "Please prioritize auth fix",
        summary: "Priority update",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.sent, 1);
    assert.deepEqual(body.recipients, [worker.id]);

    const workerSession = await initializeAgent(result.port, worker.id);
    const leadSession = await initializeAgent(result.port, lead.id);

    const workerDm = parseToolText(await callTool(result.port, workerSession, "dm_read", {}, 90)) as Array<Record<string, unknown>>;
    assert.equal(workerDm.length, 1);
    assert.equal(workerDm[0].from, "orchestrator");
    assert.equal(workerDm[0].text, "Please prioritize auth fix");
    assert.equal(workerDm[0].summary, "Priority update");

    const leadDm = parseToolText(await callTool(result.port, leadSession, "dm_read", {}, 91)) as Array<Record<string, unknown>>;
    assert.equal(leadDm.length, 0);
  });

  it("supports HTTP operator message broadcast", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }, { role: "dev" }, { role: "reviewer" }]);

    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const response = await fetch(`http://127.0.0.1:${result.port}/message`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({
        teamId: team.id,
        to: "*",
        message: "Sync on API contract",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.sent, team.agents.size);
    assert.equal(body.broadcast, true);

    const sessions = await Promise.all(
      Array.from(team.agents.values()).map(async (agent) => ({
        agent,
        session: await initializeAgent(result.port, agent.id),
      })),
    );

    for (const { session } of sessions) {
      const dms = parseToolText(await callTool(result.port, session, "dm_read", {}, 92)) as Array<Record<string, unknown>>;
      assert.equal(dms.length, 1);
      assert.equal(dms[0].from, "orchestrator");
      assert.equal(dms[0].text, "Sync on API contract");
      assert.equal(dms[0].summary, "Sync on API contract");
    }
  });

  it("rejects HTTP operator message for unknown target", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const team = state.createTeam("test-team", [{ role: "lead", isLead: true }]);

    const result = await startCommsServer(messages, state);
    httpServer = result.httpServer;

    const response = await fetch(`http://127.0.0.1:${result.port}/message`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({
        teamId: team.id,
        to: "missing-agent",
        message: "hello",
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as Record<string, unknown>;
    assert.match(String(body.error), /unknown target agent/i);
  });

  it("starts multiple servers on different ports", async () => {
    const state = new TeamManager(taskStoreRoot);
    const messages = new MessageSystem(protocolInboxRoot, chatStoreRoot);
    const result1 = await startCommsServer(messages, state);
    const result2 = await startCommsServer(messages, state);

    assert.ok(result1.port > 0);
    assert.ok(result2.port > 0);
    assert.notEqual(result1.port, result2.port, "Each server should get a unique port");

    result1.httpServer.close();
    result2.httpServer.close();
  });
});
