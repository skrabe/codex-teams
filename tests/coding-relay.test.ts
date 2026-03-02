import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

async function post(client: Client, message: string) {
  await client.callTool({ name: "group_chat_post", arguments: { message } });
}

async function readChat(client: Client): Promise<Array<{ from: string; role: string; text: string }>> {
  const result = await client.callTool({ name: "group_chat_read", arguments: {} }) as ToolResultContent;
  return JSON.parse(result.content[0].text);
}

async function share(client: Client, data: string) {
  await client.callTool({ name: "share", arguments: { data } });
}

async function getShared(client: Client): Promise<Array<{ from: string; data: string }>> {
  const result = await client.callTool({ name: "get_shared", arguments: {} }) as ToolResultContent;
  return JSON.parse(result.content[0].text);
}

async function waitForMsg(client: Client, timeoutMs = 10000) {
  const result = await client.callTool({
    name: "wait_for_messages",
    arguments: { timeoutMs },
  }) as ToolResultContent;
  return parseToolResult(result);
}

async function dm(client: Client, toAgentId: string, message: string) {
  await client.callTool({ name: "dm_send", arguments: { toAgentId, message } });
}

describe("coding relay e2e (real HTTP + file I/O)", () => {
  let httpServer: Server;
  const clients: Client[] = [];
  let workDir: string;

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {});
    clients.length = 0;
    httpServer?.close();
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("backend + frontend coordinate a full feature via comms", async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-relay-"));
    fs.mkdirSync(path.join(workDir, "src", "api"), { recursive: true });
    fs.mkdirSync(path.join(workDir, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(workDir, "src", "data"), { recursive: true });

    const state = new TeamManager();
    const messages = new MessageSystem();
    const team = state.createTeam("feature-team", [
      { role: "backend", isLead: true },
      { role: "frontend" },
    ]);
    const agents = Array.from(team.agents.values());
    const backend = agents.find((a) => a.role === "backend")!;
    const frontend = agents.find((a) => a.role === "frontend")!;

    const server = await startCommsServer(messages, state);
    httpServer = server.httpServer;

    const backendClient = await createAgentClient(server.port, backend.id);
    const frontendClient = await createAgentClient(server.port, frontend.id);
    clients.push(backendClient, frontendClient);

    const timeline: Array<{ step: string; agent: string; elapsed: number }> = [];
    const start = Date.now();
    function mark(step: string, agent: string) {
      timeline.push({ step, agent, elapsed: Date.now() - start });
    }

    async function backendWork() {
      // 1. Post the plan
      await post(backendClient, [
        "PLAN: User dashboard feature.",
        `@${backend.id} (backend): types, seed data, API handlers.`,
        `@${frontend.id} (frontend): components consuming the API.`,
        "I'll share types first so you can start. Then seed data + handlers.",
        "Raise concerns or execute.",
      ].join("\n"));
      mark("posted-plan", "backend");

      // 2. Write types
      const typesContent = [
        "export interface User {",
        "  id: string;",
        "  name: string;",
        "  email: string;",
        "  role: 'admin' | 'member' | 'viewer';",
        "  createdAt: string;",
        "}",
        "",
        "export interface DashboardStats {",
        "  totalUsers: number;",
        "  activeToday: number;",
        "  newThisWeek: number;",
        "}",
        "",
        "export interface ApiResponse<T> {",
        "  data: T;",
        "  error?: string;",
        "  timestamp: string;",
        "}",
      ].join("\n");
      fs.writeFileSync(path.join(workDir, "src", "api", "types.ts"), typesContent);
      mark("wrote-types", "backend");

      await share(backendClient, `src/api/types.ts — User, DashboardStats, ApiResponse<T> interfaces ready`);
      await post(backendClient, `Types ready at src/api/types.ts — @${frontend.id} you can start building components.`);
      mark("shared-types", "backend");

      // 3. Write seed data
      const seedContent = [
        'import type { User } from "../api/types.ts";',
        "",
        "export const users: User[] = [",
        '  { id: "u1", name: "Alice Chen", email: "alice@example.com", role: "admin", createdAt: "2025-01-15T00:00:00Z" },',
        '  { id: "u2", name: "Bob Smith", email: "bob@example.com", role: "member", createdAt: "2025-02-20T00:00:00Z" },',
        '  { id: "u3", name: "Carol Davis", email: "carol@example.com", role: "member", createdAt: "2025-03-01T00:00:00Z" },',
        '  { id: "u4", name: "Dan Wilson", email: "dan@example.com", role: "viewer", createdAt: "2025-03-10T00:00:00Z" },',
        '  { id: "u5", name: "Eve Martinez", email: "eve@example.com", role: "admin", createdAt: "2025-01-05T00:00:00Z" },',
        "];",
        "",
        "export const dashboardStats = {",
        "  totalUsers: users.length,",
        "  activeToday: 3,",
        "  newThisWeek: 2,",
        "};",
      ].join("\n");
      fs.writeFileSync(path.join(workDir, "src", "data", "seed.ts"), seedContent);
      mark("wrote-seed", "backend");

      // 4. Write API handlers
      const handlersContent = [
        'import type { User, DashboardStats, ApiResponse } from "./types.ts";',
        'import { users, dashboardStats } from "../data/seed.ts";',
        "",
        "export function getUsers(): ApiResponse<User[]> {",
        "  return {",
        "    data: users,",
        "    timestamp: new Date().toISOString(),",
        "  };",
        "}",
        "",
        "export function getUserById(id: string): ApiResponse<User | null> {",
        "  return {",
        '    data: users.find((u) => u.id === id) ?? null,',
        "    timestamp: new Date().toISOString(),",
        "  };",
        "}",
        "",
        "export function getStats(): ApiResponse<DashboardStats> {",
        "  return {",
        "    data: dashboardStats,",
        "    timestamp: new Date().toISOString(),",
        "  };",
        "}",
      ].join("\n");
      fs.writeFileSync(path.join(workDir, "src", "api", "handlers.ts"), handlersContent);
      mark("wrote-handlers", "backend");

      await share(backendClient, [
        "src/data/seed.ts — 5 seed users + dashboard stats",
        "src/api/handlers.ts — getUsers(), getUserById(id), getStats()",
      ].join("\n"));
      await post(backendClient, "API layer done. handlers.ts exports getUsers(), getUserById(id), getStats().");
      mark("shared-handlers", "backend");

      // 5. Wait for frontend to finish
      await waitForMsg(backendClient);
      await readChat(backendClient);
      mark("read-frontend-done", "backend");

      // 6. Final review
      await share(backendClient, [
        "BACKEND DELIVERABLE:",
        "  src/api/types.ts — shared types",
        "  src/data/seed.ts — seed data",
        "  src/api/handlers.ts — API handlers",
        "All files written, frontend integrated.",
      ].join("\n"));
      mark("final-share", "backend");
    }

    async function frontendWork() {
      // 1. Wait for plan
      await waitForMsg(frontendClient);
      const plan = await readChat(frontendClient);
      mark("read-plan", "frontend");
      assert.ok(plan.length > 0, "Should have plan message");

      // 2. Wait for types to be shared
      if (plan[plan.length - 1].text.includes("types.ts")) {
        // Types already shared in same batch
      } else {
        await waitForMsg(frontendClient);
        await readChat(frontendClient);
      }
      mark("got-types-notification", "frontend");

      const shared = await getShared(frontendClient);
      assert.ok(shared.some((a) => a.data.includes("types.ts")), "Types should be shared");

      // 3. Read the actual types file
      const typesPath = path.join(workDir, "src", "api", "types.ts");
      assert.ok(fs.existsSync(typesPath), "types.ts should exist");
      mark("verified-types-file", "frontend");

      // 4. Write UserCard component
      const userCardContent = [
        'import type { User } from "../api/types.ts";',
        "",
        "export function UserCard(user: User): string {",
        "  const roleBadge = {",
        '    admin: "🔴",',
        '    member: "🔵",',
        '    viewer: "⚪",',
        "  }[user.role];",
        "",
        "  return `",
        "    <div class=\"user-card\">",
        "      <h3>${roleBadge} ${user.name}</h3>",
        "      <p>${user.email}</p>",
        "      <span class=\"role\">${user.role}</span>",
        "      <time>${user.createdAt}</time>",
        "    </div>",
        "  `;",
        "}",
      ].join("\n");
      fs.writeFileSync(path.join(workDir, "src", "components", "UserCard.ts"), userCardContent);
      mark("wrote-usercard", "frontend");

      // 5. DM backend about an interface question
      await dm(frontendClient, backend.id, "Quick Q: should DashboardStats include a period field? I want to show 'Stats for this week'.");
      mark("sent-dm", "frontend");

      // 6. Write StatsPanel (don't block on DM reply)
      const statsPanelContent = [
        'import type { DashboardStats } from "../api/types.ts";',
        "",
        "export function StatsPanel(stats: DashboardStats): string {",
        "  return `",
        "    <div class=\"stats-panel\">",
        "      <div class=\"stat\">",
        "        <span class=\"value\">${stats.totalUsers}</span>",
        '        <span class="label">Total Users</span>',
        "      </div>",
        "      <div class=\"stat\">",
        "        <span class=\"value\">${stats.activeToday}</span>",
        '        <span class="label">Active Today</span>',
        "      </div>",
        "      <div class=\"stat\">",
        "        <span class=\"value\">${stats.newThisWeek}</span>",
        '        <span class="label">New This Week</span>',
        "      </div>",
        "    </div>",
        "  `;",
        "}",
      ].join("\n");
      fs.writeFileSync(path.join(workDir, "src", "components", "StatsPanel.ts"), statsPanelContent);
      mark("wrote-statspanel", "frontend");

      // 7. Write Dashboard page that ties it together
      const dashboardContent = [
        'import type { User, DashboardStats, ApiResponse } from "../api/types.ts";',
        'import { getUsers, getStats } from "../api/handlers.ts";',
        'import { UserCard } from "./UserCard.ts";',
        'import { StatsPanel } from "./StatsPanel.ts";',
        "",
        "export function Dashboard(): string {",
        "  const usersResponse: ApiResponse<User[]> = getUsers();",
        "  const statsResponse: ApiResponse<DashboardStats> = getStats();",
        "",
        "  const userCards = usersResponse.data.map(UserCard).join('\\n');",
        "",
        "  return `",
        "    <main class=\"dashboard\">",
        "      <h1>User Dashboard</h1>",
        "      ${StatsPanel(statsResponse.data)}",
        "      <section class=\"user-list\">",
        "        ${userCards}",
        "      </section>",
        "      <footer>Last updated: ${statsResponse.timestamp}</footer>",
        "    </main>",
        "  `;",
        "}",
      ].join("\n");
      fs.writeFileSync(path.join(workDir, "src", "components", "Dashboard.ts"), dashboardContent);
      mark("wrote-dashboard", "frontend");

      // 8. Share and announce
      await share(frontendClient, [
        "src/components/UserCard.ts — renders a single user card",
        "src/components/StatsPanel.ts — stats overview panel",
        "src/components/Dashboard.ts — main dashboard, imports API handlers + components",
      ].join("\n"));
      await post(frontendClient, "Frontend done. Dashboard.ts imports getUsers/getStats from handlers.ts and renders UserCard + StatsPanel.");
      mark("shared-frontend", "frontend");
    }

    // Run both agents concurrently
    await Promise.all([backendWork(), frontendWork()]);

    const totalMs = timeline[timeline.length - 1].elapsed;

    // Verify all files exist
    const expectedFiles = [
      "src/api/types.ts",
      "src/api/handlers.ts",
      "src/data/seed.ts",
      "src/components/UserCard.ts",
      "src/components/StatsPanel.ts",
      "src/components/Dashboard.ts",
    ];
    for (const f of expectedFiles) {
      assert.ok(fs.existsSync(path.join(workDir, f)), `${f} should exist`);
    }

    // Verify imports are coherent
    const dashboard = fs.readFileSync(path.join(workDir, "src", "components", "Dashboard.ts"), "utf-8");
    assert.ok(dashboard.includes("getUsers"), "Dashboard should import getUsers");
    assert.ok(dashboard.includes("getStats"), "Dashboard should import getStats");
    assert.ok(dashboard.includes("UserCard"), "Dashboard should import UserCard");
    assert.ok(dashboard.includes("StatsPanel"), "Dashboard should import StatsPanel");

    const handlers = fs.readFileSync(path.join(workDir, "src", "api", "handlers.ts"), "utf-8");
    assert.ok(handlers.includes("ApiResponse"), "Handlers should use ApiResponse type");

    // Verify comms happened correctly
    const allShared = messages.getSharedArtifacts(team.id);
    assert.ok(allShared.length >= 4, `Expected 4+ shared artifacts, got ${allShared.length}`);

    const chatMessages = messages.getTeamChatMessages(team.id);
    assert.ok(chatMessages.length >= 3, `Expected 3+ chat messages, got ${chatMessages.length}`);

    const dms = messages.getAllDmMessages([backend.id, frontend.id]);
    assert.ok(dms.length >= 1, `Expected 1+ DM, got ${dms.length}`);

    // Print timeline
    console.log(`\n    Total: ${totalMs}ms`);
    console.log(`    Comms: ${chatMessages.length} group msgs, ${dms.length} DMs, ${allShared.length} shares`);
    console.log(`    Files: ${expectedFiles.length} written`);
    console.log(`    Timeline:`);
    for (const t of timeline) {
      console.log(`      +${String(t.elapsed).padStart(4)}ms  [${t.agent.padEnd(8)}] ${t.step}`);
    }
    console.log();

    // Verify tmp dir cleanup will work
    assert.ok(fs.existsSync(workDir));
  });
});
