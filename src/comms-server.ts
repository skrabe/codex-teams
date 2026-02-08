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

function registerCommsTools(
  server: McpServer,
  messages: MessageSystem,
  state: TeamManager,
  boundAgentId?: string,
) {
  function enforceIdentity(claimedId: string): string | null {
    if (boundAgentId && claimedId !== boundAgentId)
      return `Agent ID mismatch: session bound to ${boundAgentId}, got ${claimedId}`;
    return null;
  }

  server.registerTool(
    "group_chat_post",
    {
      description: "Post a message to your team's group chat",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
        message: z.string().max(50000).describe("Message to post"),
      },
    },
    async ({ myAgentId, message }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

      messages.groupChatPost(ctx.team.id, myAgentId, ctx.agent.role, message);
      return { content: [{ type: "text" as const, text: "Posted to group chat" }] };
    },
  );

  server.registerTool(
    "group_chat_read",
    {
      description: "Read unread group chat messages",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
      },
    },
    async ({ myAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

      const msgs = messages.groupChatRead(ctx.team.id, myAgentId);
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
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
      },
    },
    async ({ myAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

      const count = messages.groupChatPeek(ctx.team.id, myAgentId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ unread: count }) }] };
    },
  );

  server.registerTool(
    "dm_send",
    {
      description: "Send a direct message to another agent",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
        toAgentId: z.string().describe("Target agent ID"),
        message: z.string().max(50000).describe("Message to send"),
      },
    },
    async ({ myAgentId, toAgentId, message }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

      const toCtx = findAgentContext(state, toAgentId);
      if (!toCtx)
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unknown target agent: ${toAgentId}` }],
        };

      const sameTeam = ctx.team.id === toCtx.team.id;
      const bothLeads = ctx.agent.isLead && toCtx.agent.isLead;
      if (!sameTeam && !bothLeads) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Cannot DM agent outside your team unless both are leads` },
          ],
        };
      }

      messages.dmSend(myAgentId, toAgentId, ctx.agent.role, message);
      return { content: [{ type: "text" as const, text: `DM sent to ${toAgentId}` }] };
    },
  );

  server.registerTool(
    "dm_read",
    {
      description: "Read your unread direct messages",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
        fromAgentId: z.string().optional().describe("Filter by sender agent ID"),
      },
    },
    async ({ myAgentId, fromAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

      const msgs = messages.dmRead(myAgentId, fromAgentId);
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
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
      },
    },
    async ({ myAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

      const count = messages.dmPeek(myAgentId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ unread: count }) }] };
    },
  );

  server.registerTool(
    "share",
    {
      description: "Share info/file paths with the team",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
        data: z.string().max(100000).describe("Data to share (file paths, context, etc)"),
      },
    },
    async ({ myAgentId, data }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

      messages.shareArtifact(ctx.team.id, myAgentId, data);
      return { content: [{ type: "text" as const, text: "Shared with team" }] };
    },
  );

  server.registerTool(
    "get_shared",
    {
      description: "See everything the team has shared",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
      },
    },
    async ({ myAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

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
        myAgentId: z.string().describe("Your agent ID"),
        message: z.string().max(50000).describe("Message to post"),
      },
    },
    async ({ myAgentId, message }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };
      if (!ctx.agent.isLead)
        return { isError: true, content: [{ type: "text" as const, text: `Only leads can use lead_chat` }] };

      messages.leadChatPost(myAgentId, ctx.agent.role, ctx.team.name, message);
      return { content: [{ type: "text" as const, text: "Posted to lead chat" }] };
    },
  );

  server.registerTool(
    "lead_chat_read",
    {
      description: "Read unread cross-team lead messages (leads only)",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
      },
    },
    async ({ myAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };
      if (!ctx.agent.isLead)
        return { isError: true, content: [{ type: "text" as const, text: `Only leads can use lead_chat` }] };

      const msgs = messages.leadChatRead(myAgentId);
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
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
      },
    },
    async ({ myAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };
      if (!ctx.agent.isLead)
        return { isError: true, content: [{ type: "text" as const, text: `Only leads can use lead_chat` }] };

      const count = messages.leadChatPeek(myAgentId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ unread: count }) }] };
    },
  );

  server.registerTool(
    "get_team_context",
    {
      description:
        "Get your team's full context: all teammates, their roles, specializations, current status, and assigned tasks. Call this BEFORE searching independently for non-trivial information — a teammate may already be working in that scope.",
      inputSchema: {
        myAgentId: z.string().describe("Your agent ID"),
      },
    },
    async ({ myAgentId }) => {
      const err = enforceIdentity(myAgentId);
      if (err) return { isError: true, content: [{ type: "text" as const, text: err }] };
      const ctx = findAgentContext(state, myAgentId);
      if (!ctx)
        return { isError: true, content: [{ type: "text" as const, text: `Unknown agent: ${myAgentId}` }] };

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
          you: { id: myAgentId, role: ctx.agent.role, isLead: ctx.agent.isLead },
          teammates: mapAgents(ctx.team, myAgentId),
        },
        otherTeams: otherTeams.length > 0 ? otherTeams : undefined,
        howToReach:
          "Same team: DM them directly with dm_send. Other team: DM your lead and ask them to relay via lead_chat.",
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

export function startCommsServer(
  messages: MessageSystem,
  state: TeamManager,
  codex?: CodexClientManager,
): { httpServer: Server; port: number } {
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
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  console.error(`codex-teams: team-comms HTTP server listening on port ${port}`);

  return { httpServer, port };
}
