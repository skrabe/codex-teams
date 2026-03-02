import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

interface McpRequest extends IncomingMessage {
  body?: unknown;
  url: string;
}

interface McpResponse extends ServerResponse {
  status(code: number): McpResponse;
  json(body: unknown): void;
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { MessageSystem } from "./messages.js";
import type { TeamManager } from "./state.js";
import type { CodexClientManager } from "./codex-client.js";

function findAgentContext(state: TeamManager, agentId: string) {
  for (const team of state.listTeams()) {
    const agent = team.agents.get(agentId);
    if (agent) return { team, agent };
  }
  return null;
}

export function registerCommsTools(
  server: McpServer,
  messages: MessageSystem,
  state: TeamManager,
  boundAgentId?: string,
) {
  const err = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

  function resolve() {
    if (!boundAgentId) return null;
    return findAgentContext(state, boundAgentId);
  }

  server.registerTool(
    "group_chat_post",
    {
      description: "Post a message to your team's group chat",
      inputSchema: {
        message: z.string().max(50000).describe("Message to post"),
      },
    },
    async ({ message }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      messages.groupChatPost(ctx.team.id, boundAgentId!, ctx.agent.role, message);
      return { content: [{ type: "text" as const, text: "Posted to group chat" }] };
    },
  );

  server.registerTool(
    "group_chat_read",
    {
      description: "Read unread group chat messages",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const msgs = messages.groupChatRead(ctx.team.id, boundAgentId!);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              msgs.map((m) => ({
                from: m.from,
                role: m.fromRole,
                text: m.text,
                at: m.timestamp.toISOString(),
              })),
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "group_chat_peek",
    {
      description: "Check how many unread group chat messages you have",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const count = messages.groupChatPeek(ctx.team.id, boundAgentId!);
      return { content: [{ type: "text" as const, text: JSON.stringify({ unread: count }) }] };
    },
  );

  server.registerTool(
    "dm_send",
    {
      description: "Send a direct message to another agent",
      inputSchema: {
        toAgentId: z.string().describe("Target agent ID"),
        message: z.string().max(50000).describe("Message to send"),
      },
    },
    async ({ toAgentId, message }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const toCtx = findAgentContext(state, toAgentId);
      if (!toCtx) return err(`Unknown target agent: ${toAgentId}`);

      const sameTeam = ctx.team.id === toCtx.team.id;
      const bothLeads = ctx.agent.isLead && toCtx.agent.isLead;
      if (!sameTeam && !bothLeads) {
        return err(`Cannot DM agent outside your team unless both are leads`);
      }

      messages.dmSend(boundAgentId!, toAgentId, ctx.agent.role, message);
      return { content: [{ type: "text" as const, text: `DM sent to ${toAgentId}` }] };
    },
  );

  server.registerTool(
    "dm_read",
    {
      description: "Read your unread direct messages",
      inputSchema: {
        fromAgentId: z.string().optional().describe("Filter by sender agent ID"),
      },
    },
    async ({ fromAgentId }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const msgs = messages.dmRead(boundAgentId!, fromAgentId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              msgs.map((m) => ({
                from: m.from,
                role: m.fromRole,
                text: m.text,
                at: m.timestamp.toISOString(),
              })),
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "dm_peek",
    {
      description: "Check unread DM count",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const count = messages.dmPeek(boundAgentId!);
      return { content: [{ type: "text" as const, text: JSON.stringify({ unread: count }) }] };
    },
  );

  server.registerTool(
    "share",
    {
      description: "Share info/file paths with the team",
      inputSchema: {
        data: z.string().max(100000).describe("Data to share (file paths, context, etc)"),
      },
    },
    async ({ data }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      messages.shareArtifact(ctx.team.id, boundAgentId!, data);
      return { content: [{ type: "text" as const, text: "Shared with team" }] };
    },
  );

  server.registerTool(
    "get_shared",
    {
      description: "See everything the team has shared",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const artifacts = messages.getSharedArtifacts(ctx.team.id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              artifacts.map((a) => ({ from: a.from, data: a.data, at: a.timestamp.toISOString() })),
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "lead_chat_post",
    {
      description: "Post to the cross-team lead channel (leads only)",
      inputSchema: {
        message: z.string().max(50000).describe("Message to post"),
      },
    },
    async ({ message }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);
      if (!ctx.agent.isLead) return err(`Only leads can use lead_chat`);

      messages.leadChatPost(boundAgentId!, ctx.agent.role, ctx.team.name, message);
      return { content: [{ type: "text" as const, text: "Posted to lead chat" }] };
    },
  );

  server.registerTool(
    "lead_chat_read",
    {
      description: "Read unread cross-team lead messages (leads only)",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);
      if (!ctx.agent.isLead) return err(`Only leads can use lead_chat`);

      const msgs = messages.leadChatRead(boundAgentId!);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              msgs.map((m) => ({
                from: m.from,
                role: m.fromRole,
                text: m.text,
                at: m.timestamp.toISOString(),
              })),
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "lead_chat_peek",
    {
      description: "Check unread cross-team lead message count (leads only)",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);
      if (!ctx.agent.isLead) return err(`Only leads can use lead_chat`);

      const count = messages.leadChatPeek(boundAgentId!);
      return { content: [{ type: "text" as const, text: JSON.stringify({ unread: count }) }] };
    },
  );

  server.registerTool(
    "get_team_context",
    {
      description:
        "Get your team's full context: all teammates, their roles, specializations, current status, and assigned tasks. Call this BEFORE searching independently for non-trivial information — a teammate may already be working in that scope.",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      function mapAgents(team: ReturnType<typeof state.getTeam>, excludeId?: string) {
        return Array.from(team!.agents.values())
          .filter((a) => a.id !== excludeId)
          .map((a) => {
            const agentTasks = a.tasks
              .map((taskId) => team!.tasks.get(taskId))
              .filter(Boolean)
              .map((t) => ({ id: t!.id, description: t!.description, status: t!.status }));
            return {
              id: a.id,
              role: a.role,
              specialization: a.specialization || undefined,
              isLead: a.isLead,
              status: a.status,
              tasks: agentTasks.length > 0 ? agentTasks : undefined,
            };
          });
      }

      const otherTeams = state
        .listTeams()
        .filter((t) => t.id !== ctx.team.id)
        .map((t) => ({
          teamId: t.id,
          teamName: t.name,
          agents: mapAgents(t),
        }));

      const result: Record<string, unknown> = {
        yourTeam: {
          teamId: ctx.team.id,
          teamName: ctx.team.name,
          you: { id: boundAgentId, role: ctx.agent.role, isLead: ctx.agent.isLead },
          teammates: mapAgents(ctx.team, boundAgentId),
        },
        otherTeams: otherTeams.length > 0 ? otherTeams : undefined,
        howToReach:
          "Same team: DM them directly with dm_send. Other team: DM your lead and ask them to relay via lead_chat.",
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "wait_for_messages",
    {
      description:
        "Block until new messages arrive or timeout. Use instead of polling peek(). Returns unread counts.",
      inputSchema: {
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(60000)
          .optional()
          .describe("Max wait time in ms (default 30000, max 60000)"),
      },
    },
    async ({ timeoutMs }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const timeout = timeoutMs ?? 30000;
      const teamId = ctx.team.id;
      const agentId = boundAgentId!;
      const isLead = ctx.agent.isLead;

      function getCounts() {
        return {
          groupChat: messages.groupChatPeek(teamId, agentId),
          dms: messages.dmPeek(agentId),
          leadChat: isLead ? messages.leadChatPeek(agentId) : 0,
        };
      }

      const initial = getCounts();
      if (initial.groupChat > 0 || initial.dms > 0 || initial.leadChat > 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ timedOut: false, ...initial }) }],
        };
      }

      return new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;

        const cleanup = messages.onMessage((target) => {
          if (settled) return;

          const relevant =
            target.type === "dissolve"
              ? target.id === agentId
              : target.type === "team"
                ? target.id === teamId
                : target.type === "dm"
                  ? target.id === agentId
                  : target.type === "lead"
                    ? isLead
                    : false;

          if (!relevant) return;

          if (target.type === "dissolve") {
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ timedOut: false, dissolved: true, groupChat: 0, dms: 0, leadChat: 0 }),
                },
              ],
            });
            return;
          }

          const counts = getCounts();
          if (counts.groupChat > 0 || counts.dms > 0 || counts.leadChat > 0) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve({ content: [{ type: "text" as const, text: JSON.stringify({ timedOut: false, ...counts }) }] });
          }
        });

        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const counts = getCounts();
          resolve({ content: [{ type: "text" as const, text: JSON.stringify({ timedOut: true, ...counts }) }] });
        }, timeout);
      });
    },
  );
}

export async function startCommsServer(
  messages: MessageSystem,
  state: TeamManager,
  codex?: CodexClientManager,
): Promise<{ httpServer: Server; port: number }> {
  const app = createMcpExpressApp();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionAgents = new Map<string, string>();

  app.post("/mcp", async (req: McpRequest, res: McpResponse) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const existing = transports.get(sessionId)!;
      await existing.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const url = new URL(req.url, `http://localhost`);
      const agentId = url.searchParams.get("agent");
      const token = url.searchParams.get("token");

      if (codex) {
        if (!agentId || !token) {
          res.status(401).json({ error: "Missing agent/token" });
          return;
        }
        if (!codex.validateAgentToken(agentId, token)) {
          res.status(403).json({ error: "Invalid agent token" });
          return;
        }
      }

      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
          if (agentId) sessionAgents.set(sid, agentId);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          sessionAgents.delete(transport.sessionId);
        }
      };

      const boundAgentId = agentId ?? undefined;
      const server = new McpServer({ name: "team-comms", version: "2.0.0" });
      registerCommsTools(server, messages, state, boundAgentId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ error: "Invalid request" });
  });

  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.on("listening", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  console.error(`codex-teams: team-comms HTTP server listening on port ${port}`);

  return { httpServer, port };
}
