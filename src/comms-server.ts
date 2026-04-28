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
import type { MessageSystem, ProtocolMessageType } from "./messages.js";
import type { TeamManager } from "./state.js";
import type { CodexClientManager } from "./codex-client.js";
import type { Task } from "./types.js";
import { runHook } from "./hooks.js";
import { syncMissionAgentState, syncMissionControlPlaneState } from "./mission.js";
import type { TeamMemoryStore, MemoryScope } from "./team-memory.js";

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
  codex?: CodexClientManager,
  memory?: TeamMemoryStore,
) {
  const err = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });
  const taskStatusSchema = z.enum(["pending", "in-progress", "completed"]);
  const protocolTypeSchema = z.enum([
    "idle_notification",
    "permission_request",
    "permission_response",
    "sandbox_permission_request",
    "sandbox_permission_response",
    "plan_approval_request",
    "plan_approval_response",
    "shutdown_request",
    "shutdown_approved",
    "shutdown_rejected",
    "task_assignment",
    "mode_set_request",
    "team_permission_update",
  ]);

  let agentTeamRegistered = false;
  function resolve() {
    if (!boundAgentId) return null;
    const ctx = findAgentContext(state, boundAgentId);
    if (ctx && !agentTeamRegistered) {
      messages.registerAgentTeam(boundAgentId, ctx.team.id);
      agentTeamRegistered = true;
    }
    return ctx;
  }

  function requireProtocolDataObject(type: ProtocolMessageType, data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!data || typeof data !== "object") {
      throw new Error(`protocol_send ${type} requires an object data payload`);
    }
    return data;
  }

  function validateProtocolPayload(type: ProtocolMessageType, data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const objectSchema = z.record(z.string(), z.unknown());

    switch (type) {
      case "idle_notification":
        return data ? objectSchema.parse(data) : undefined;
      case "permission_request":
      case "sandbox_permission_request": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ requestId: z.string() }).passthrough().parse(payload);
      }
      case "permission_response":
      case "sandbox_permission_response": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ requestId: z.string(), approved: z.boolean() }).passthrough().parse(payload);
      }
      case "plan_approval_request": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ agentId: z.string(), requestedAt: z.string() }).passthrough().parse(payload);
      }
      case "plan_approval_response": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ approved: z.boolean() }).passthrough().parse(payload);
      }
      case "shutdown_request": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ reason: z.string() }).passthrough().parse(payload);
      }
      case "shutdown_approved": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ autoApproved: z.boolean().optional(), reason: z.string().optional() }).passthrough().parse(payload);
      }
      case "shutdown_rejected": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ reason: z.string() }).passthrough().parse(payload);
      }
      case "task_assignment": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ taskId: z.string() }).passthrough().parse(payload);
      }
      case "mode_set_request": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ mode: z.string() }).passthrough().parse(payload);
      }
      case "team_permission_update": {
        const payload = requireProtocolDataObject(type, data);
        return z.object({ permissionMode: z.string() }).passthrough().parse(payload);
      }
    }
  }

  function validateProtocolAuthority(
    type: ProtocolMessageType,
    sender: NonNullable<ReturnType<typeof resolve>>,
    receiver: NonNullable<ReturnType<typeof findAgentContext>>,
  ): void {
    if ((type === "mode_set_request" || type === "team_permission_update") && !sender.agent.isLead) {
      throw new Error(`${type} can only be sent by a lead`);
    }
    if (type === "plan_approval_response") {
      if (!sender.agent.isLead) throw new Error("plan_approval_response can only be sent by a lead");
      if (receiver.agent.isLead) throw new Error("plan_approval_response must target a worker");
    }
  }

  function validateOwner(teamId: string, owner: string | null | undefined): string | null | undefined {
    if (owner === undefined || owner === null) return owner;
    const team = state.getTeam(teamId);
    if (!team?.agents.has(owner)) {
      throw new Error(`Unknown owner agent: ${owner}`);
    }
    return owner;
  }

  function formatTask(task: Task) {
    return {
      id: task.id,
      subject: task.subject,
      description: task.description,
      activeForm: task.activeForm,
      status: task.status,
      owner: task.owner,
      dependencies: task.dependencies,
      blockedBy: task.blockedBy,
      result: task.result,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString(),
    };
  }


  function parseTaskOrderId(task: Task): number {
    const parsed = Number.parseInt(task.id, 10);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  function isClaimableTask(task: Task, agentId: string): boolean {
    if (task.status !== "pending") return false;
    if (task.blockedBy.length > 0) return false;
    return task.owner === null || task.owner === agentId;
  }

  function taskPriorityGroup(task: Task, agentId: string): number {
    if (isClaimableTask(task, agentId)) return 0;
    if (task.status === "in-progress" && task.owner === agentId) return 1;
    if (task.status === "pending") return 2;
    if (task.status === "in-progress") return 3;
    return 4;
  }

  function sortTasksForExecution(tasks: Task[], agentId: string): Task[] {
    return [...tasks].sort((left, right) => {
      const groupDelta = taskPriorityGroup(left, agentId) - taskPriorityGroup(right, agentId);
      if (groupDelta !== 0) return groupDelta;

      const idDelta = parseTaskOrderId(left) - parseTaskOrderId(right);
      if (idDelta !== 0) return idDelta;

      return left.createdAt.getTime() - right.createdAt.getTime();
    });
  }

  function formatListedTask(task: Task, agentId: string, recommendedTaskId?: string) {
    return {
      ...formatTask(task),
      claimable: isClaimableTask(task, agentId),
      recommended: task.id === recommendedTaskId,
    };
  }

  async function runTaskHook(
    ctx: NonNullable<ReturnType<typeof resolve>>,
    event: "TaskCreated" | "TaskCompleted",
    task: Task,
  ): Promise<string | undefined> {
    const result = await runHook(ctx.team.hookCommands, event, {
      event,
      missionId: ctx.team.missionId,
      teamId: ctx.team.id,
      timestamp: new Date().toISOString(),
      triggeredBy: boundAgentId,
      agent: {
        id: ctx.agent.id,
        role: ctx.agent.role,
        isLead: ctx.agent.isLead,
      },
      task: {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        owner: task.owner,
        dependencies: task.dependencies,
        blockedBy: task.blockedBy,
        result: task.result,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
        completedAt: task.completedAt?.toISOString(),
      },
    });

    if (result.blocked) return result.message ?? `${event} hook blocked`;
    return undefined;
  }

  function emitTaskAssignment(
    previousOwner: string | null | undefined,
    task: Task,
    initiatorAgentId: string,
  ) {
    if (!task.owner || task.owner === previousOwner) return;
    messages.protocolSend(initiatorAgentId, task.owner, "task_assignment", {
      taskId: task.id,
      subject: task.subject,
      description: task.description,
      previousOwner,
      status: task.status,
    });
    syncMissionControlPlaneState(findAgentContext(state, task.owner)?.team.id ?? "default", task.owner, messages);
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
        summary: z.string().trim().min(1).max(200).describe("Short preview summary for the recipient"),
      },
    },
    async ({ toAgentId, message, summary }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const toCtx = findAgentContext(state, toAgentId);
      if (!toCtx) return err(`Unknown target agent: ${toAgentId}`);

      const sameTeam = ctx.team.id === toCtx.team.id;
      const bothLeads = ctx.agent.isLead && toCtx.agent.isLead;
      if (!sameTeam && !bothLeads) {
        return err(`Cannot DM agent outside your team unless both are leads`);
      }

      messages.dmSend(boundAgentId!, toAgentId, ctx.agent.role, message, summary);
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
                summary: m.summary,
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
    "protocol_send",
    {
      description: "Send a structured control-plane message to another agent",
      inputSchema: {
        toAgentId: z.string().describe("Target agent ID"),
        type: protocolTypeSchema.describe("Structured protocol message type"),
        data: z.record(z.string(), z.unknown()).optional().describe("Structured payload for the recipient"),
      },
    },
    async ({ toAgentId, type, data }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);
      if (toAgentId === "*") return err("Structured protocol messages cannot be broadcast");

      const toCtx = findAgentContext(state, toAgentId);
      if (!toCtx) return err(`Unknown target agent: ${toAgentId}`);

      const sameTeam = ctx.team.id === toCtx.team.id;
      const bothLeads = ctx.agent.isLead && toCtx.agent.isLead;
      if (!sameTeam && !bothLeads) {
        return err(`Cannot send protocol message outside your team unless both are leads`);
      }
      try {
        validateProtocolAuthority(type as ProtocolMessageType, ctx, toCtx);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }

      if (type === "plan_approval_request") {
        if (ctx.agent.isLead) return err("Only workers can request plan approval");
        if (ctx.agent.sandbox !== "plan-mode") return err("Plan approval requests require plan-mode workers");
        if (!toCtx.agent.isLead) return err("Plan approval requests must target your lead");

        const requestPayload = { ...(data ?? {}), agentId: boundAgentId!, requestedAt: new Date().toISOString() };

        let validatedRequestPayload: Record<string, unknown>;
        try {
          validatedRequestPayload = validateProtocolPayload(type as ProtocolMessageType, requestPayload) ?? {};
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error));
        }

        state.setAwaitingPlanApproval(ctx.team.id, boundAgentId!, true);
        syncMissionAgentState(ctx.team.id, state.getAgent(ctx.team.id, boundAgentId!)!);
        messages.protocolSend(boundAgentId!, toAgentId, type as ProtocolMessageType, validatedRequestPayload);
        syncMissionControlPlaneState(ctx.team.id, toAgentId, messages);

        return {
          content: [
            {
              type: "text" as const,
              text: `Plan approval request sent to lead ${toAgentId}. Use wait_for_messages() then protocol_read() for the response.`,
            },
          ],
        };
      }

      if (type === "plan_approval_response") {
        if (!ctx.agent.isLead) return err("Only the lead can send plan_approval_response");
        if (toCtx.agent.isLead) return err("plan_approval_response must target a worker");

        const responsePayload = { ...(data ?? {}), respondedAt: new Date().toISOString() };
        let validatedResponsePayload: Record<string, unknown>;
        try {
          validatedResponsePayload = validateProtocolPayload(type as ProtocolMessageType, responsePayload) ?? {};
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error));
        }

        messages.protocolSend(boundAgentId!, toAgentId, type as ProtocolMessageType, validatedResponsePayload);
        syncMissionControlPlaneState(ctx.team.id, toAgentId, messages);

        const { recordPlanApproval } = await import("./mission.js");
        recordPlanApproval(ctx.team.id, {
          agentId: toAgentId,
          leadId: boundAgentId!,
          request: {},
          response: validatedResponsePayload,
          autoApproved: false,
          timestamp: new Date(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Plan approval response sent to ${toAgentId}`,
            },
          ],
        };
      }

      let validatedPayload: Record<string, unknown> | undefined;
      try {
        validatedPayload = validateProtocolPayload(type as ProtocolMessageType, data);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }

      messages.protocolSend(boundAgentId!, toAgentId, type as ProtocolMessageType, validatedPayload);
      syncMissionControlPlaneState(ctx.team.id, toAgentId, messages);
      return { content: [{ type: "text" as const, text: `Protocol message sent to ${toAgentId}` }] };
    },
  );

  server.registerTool(
    "protocol_read",
    {
      description: "Read pending structured control-plane messages addressed to you",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const batch = messages.protocolRead(boundAgentId!);
      syncMissionControlPlaneState(ctx.team.id, boundAgentId!, messages);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              deliveryId: batch.deliveryId,
              messages: batch.messages.map((m) => ({
                id: m.id,
                type: m.type,
                from: m.from,
                to: m.to,
                data: m.data,
                at: m.timestamp.toISOString(),
              })),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "protocol_ack",
    {
      description: "Acknowledge a protocol delivery batch after successful handling",
      inputSchema: {
        deliveryId: z.string().min(1).describe("Delivery batch ID returned by protocol_read"),
      },
    },
    async ({ deliveryId }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const acknowledged = messages.protocolAck(boundAgentId!, deliveryId);
      syncMissionControlPlaneState(ctx.team.id, boundAgentId!, messages);
      if (acknowledged.some((message) => message.type === "plan_approval_response")) {
        state.setAwaitingPlanApproval(ctx.team.id, boundAgentId!, false);
        syncMissionAgentState(ctx.team.id, state.getAgent(ctx.team.id, boundAgentId!)!);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              acknowledged: acknowledged.length,
              deliveryId,
              messageIds: acknowledged.map((message) => message.id),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "protocol_peek",
    {
      description: "Check pending structured control-plane message count",
      inputSchema: {},
    },
    async () => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const count = messages.protocolPeek(boundAgentId!);
      return { content: [{ type: "text" as const, text: JSON.stringify({ pending: count, unread: count }) }] };
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
    "task_create",
    {
      description: "Create a task in your team's shared task list",
      inputSchema: {
        subject: z.string().max(500).optional().describe("Short task title"),
        description: z.string().max(20000).describe("Detailed task description"),
        activeForm: z.string().max(200).optional().describe("Present continuous form for status display (e.g., 'Running tests')"),
        owner: z.string().nullable().optional().describe("Initial owner agent ID or null for unowned"),
        dependencies: z.array(z.string()).max(100).optional().describe("Task IDs that must complete first"),
      },
    },
    async ({ subject, description, activeForm, owner, dependencies }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      try {
        const previousOwner: string | null =
          owner === undefined ? null : (validateOwner(ctx.team.id, owner) ?? null);
        const task = state.createTask(
          ctx.team.id,
          previousOwner ?? boundAgentId!,
          description,
          dependencies,
        );

        if (owner === null || owner === undefined) {
          state.unassignTask(ctx.team.id, task.id);
        }

        let updatedTask = state.getTask(ctx.team.id, task.id)!;
        if (subject !== undefined || activeForm !== undefined || owner !== undefined) {
          updatedTask = state.updateTask(ctx.team.id, task.id, {
            subject,
            activeForm,
            owner: previousOwner,
          });
        }
        const hookError = await runTaskHook(ctx, "TaskCreated", updatedTask);
        if (hookError) {
          state.deleteTask(ctx.team.id, updatedTask.id);
          return err(`TaskCreated hook blocked: ${hookError}`);
        }
        emitTaskAssignment(null, updatedTask, boundAgentId!);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ task: formatTask(updatedTask) }),
            },
          ],
        };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "task_list",
    {
      description: "List tasks in your team's shared task list",
      inputSchema: {
        status: taskStatusSchema.optional().describe("Filter by task status"),
        owner: z.string().nullable().optional().describe("Filter by owner agent ID or null for unowned tasks"),
        includeCompleted: z.boolean().optional().describe("Include completed tasks (default false)"),
      },
    },
    async ({ status, owner, includeCompleted }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      try {
        const validatedOwner = validateOwner(ctx.team.id, owner);
        const tasks = state.listTasksFiltered(ctx.team.id, {
          status,
          owner: validatedOwner,
          includeCompleted,
        });
        const agentId = ctx.agent.id;
        const orderedTasks = sortTasksForExecution(tasks, agentId);
        const recommendedTask = orderedTasks.find((task) => isClaimableTask(task, agentId));
        const blockedCount = orderedTasks.filter((task) => task.status === "pending" && task.blockedBy.length > 0).length;
        const claimableCount = orderedTasks.filter((task) => isClaimableTask(task, agentId)).length;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                tasks: orderedTasks.map((task) => formatListedTask(task, agentId, recommendedTask?.id)),
                recommendedTaskId: recommendedTask?.id,
                claimableCount,
                blockedCount,
              }),
            },
          ],
        };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "task_get",
    {
      description: "Get a single task from your team's shared task list",
      inputSchema: {
        taskId: z.string().describe("Task ID"),
      },
    },
    async ({ taskId }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      const task = state.getTask(ctx.team.id, taskId);
      if (!task) return err(`Task not found: ${taskId}`);

      return { content: [{ type: "text" as const, text: JSON.stringify({ task: formatTask(task) }) }] };
    },
  );

  server.registerTool(
    "task_update",
    {
      description: "Update a task in your team's shared task list",
      inputSchema: {
        taskId: z.string().describe("Task ID"),
        subject: z.string().max(500).optional().describe("Updated task title"),
        description: z.string().max(20000).optional().describe("Updated task description"),
        activeForm: z.string().max(200).optional().describe("Present continuous form for status display (e.g., 'Running tests')"),
        status: taskStatusSchema.optional().describe("Updated task status"),
        owner: z.string().nullable().optional().describe("Updated owner agent ID or null for unowned"),
        result: z.string().max(20000).optional().describe("Completion/result summary"),
      },
    },
    async ({ taskId, subject, description, activeForm, status, owner, result }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      try {
        const existing = state.getTask(ctx.team.id, taskId);
        if (!existing) return err(`Task not found: ${taskId}`);

        const validatedOwner = validateOwner(ctx.team.id, owner);
        const nextOwner =
          status === "in-progress" && owner === undefined && existing.owner === null ? boundAgentId! : validatedOwner;

        if (status === "completed" && existing.status !== "completed") {
          const completedCandidate: Task = {
            ...existing,
            subject: subject ?? existing.subject,
            description: description ?? existing.description,
            activeForm: activeForm ?? existing.activeForm,
            status: "completed",
            owner: nextOwner === undefined ? existing.owner : nextOwner,
            result: result ?? existing.result,
            updatedAt: new Date(),
            completedAt: new Date(),
          };
          const hookError = await runTaskHook(ctx, "TaskCompleted", completedCandidate);
          if (hookError) {
            return err(`TaskCompleted hook blocked: ${hookError}`);
          }
        }

        const task = state.updateTask(ctx.team.id, taskId, {
          subject,
          description,
          activeForm,
          status,
          owner: nextOwner,
          ...(result !== undefined ? { result } : {}),
        });
        emitTaskAssignment(existing.owner, task, boundAgentId!);

        const responsePayload: Record<string, unknown> = { task: formatTask(task) };

        if (status === "completed" && existing.status !== "completed") {
          const allTasks = state.listTasks(ctx.team.id);
          const allCompleted = allTasks.length > 0 && allTasks.every((t) => t.status === "completed");
          if (allCompleted) {
            const hasVerificationTask = allTasks.some((t) => /verif/i.test(t.subject));
            if (allTasks.length >= 3 && !hasVerificationTask) {
              responsePayload.verificationNudge =
                "All tasks completed but none was a verification step. Consider creating a verification task to confirm everything works end-to-end before wrapping up.";
            }
            responsePayload.allTasksCompleted = true;
            responsePayload.nudge = "All tasks are completed. A shutdown_request has been sent. Wrap up and exit.";
            const teamAgents = Array.from(ctx.team.agents.values()).filter((a) => !a.isLead);
            for (const worker of teamAgents) {
              messages.protocolSend("orchestrator", worker.id, "shutdown_request", {
                reason: "all_tasks_completed",
                missionId: ctx.team.missionId,
              });
              syncMissionControlPlaneState(ctx.team.id, worker.id, messages);
            }
          } else {
            responsePayload.nudge = "Task completed. Call task_list() now to find your next available task or see if your work unblocked others.";
          }
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(responsePayload) }] };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "task_claim",
    {
      description: "Claim an unblocked pending task for yourself",
      inputSchema: {
        taskId: z.string().describe("Task ID"),
        checkAgentBusy: z.boolean().optional().describe("Prevent claiming if you already have an in-progress task"),
      },
    },
    async ({ taskId, checkAgentBusy }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      try {
        const task = state.claimTask(ctx.team.id, taskId, boundAgentId!, checkAgentBusy ?? false);
        if (!task) return err(`Task ${taskId} is not claimable`);
        emitTaskAssignment(null, task, boundAgentId!);
        return { content: [{ type: "text" as const, text: JSON.stringify({ task: formatTask(task) }) }] };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "task_reset",
    {
      description: "Reset a task to pending and unowned",
      inputSchema: {
        taskId: z.string().describe("Task ID"),
      },
    },
    async ({ taskId }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      try {
        const task = state.resetTask(ctx.team.id, taskId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ task: formatTask(task) }) }] };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "task_unassign",
    {
      description: "Unassign a specific task or all of your unresolved tasks",
      inputSchema: {
        taskId: z.string().optional().describe("Specific task ID to unassign"),
      },
    },
    async ({ taskId }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);

      try {
        if (taskId) {
          const task = state.unassignTask(ctx.team.id, taskId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ tasks: [formatTask(task)] }) }] };
        }

        const tasks = state.unassignTasksForAgent(ctx.team.id, boundAgentId!);
        return { content: [{ type: "text" as const, text: JSON.stringify({ tasks: tasks.map(formatTask) }) }] };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );



  server.registerTool(
    "permission_respond",
    {
      description: "Lead-only: resolve a pending worker permission request",
      inputSchema: {
        requestId: z.string().describe("Pending permission request ID"),
        decision: z.enum(["approve", "deny"]).describe("Whether to approve or deny the request"),
        feedback: z.string().max(4000).optional().describe("Optional reason or guidance for the worker"),
        scope: z.enum(["turn", "session"]).optional().describe("Grant scope when approving"),
      },
    },
    async ({ requestId, decision, feedback, scope }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);
      if (!ctx.agent.isLead) return err("Only the team lead can respond to permission requests");
      if (!codex) return err("Codex client not available");

      try {
        const pending = codex.getPendingPermissionRequest(requestId);
        if (!pending) return err(`Unknown permission request: ${requestId}`);
        if (pending.teamId !== ctx.team.id) return err(`Permission request does not belong to your team: ${requestId}`);
        if (pending.leadId !== boundAgentId) return err(`Permission request is assigned to a different lead: ${requestId}`);

        const resolved = codex.resolvePermissionRequest(requestId, {
          approved: decision === "approve",
          feedback,
          scope,
          resolvedBy: boundAgentId!,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                request: {
                  id: resolved.id,
                  agentId: resolved.agentId,
                  leadId: resolved.leadId,
                  kind: resolved.kind,
                  reason: resolved.reason,
                  command: resolved.command,
                  cwd: resolved.cwd,
                  createdAt: resolved.createdAt.toISOString(),
                },
                decision: {
                  approved: decision === "approve",
                  scope: scope ?? "turn",
                  feedback: feedback ?? undefined,
                },
              }),
            },
          ],
        };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );
  server.registerTool(
    "shutdown_teammate",
    {
      description: "Lead-only: gracefully retire a worker, auto-recovering its unresolved tasks",
      inputSchema: {
        agentId: z.string().describe("Worker agent ID to shut down"),
        reason: z.string().max(1000).optional().describe("Optional reason for shutdown"),
      },
    },
    async ({ agentId, reason }) => {
      const ctx = resolve();
      if (!ctx) return err(`Unknown agent: ${boundAgentId}`);
      if (!ctx.agent.isLead) return err("Only the team lead can shut down teammates");
      if (!codex) return err("Codex client not available");
      if (agentId === boundAgentId) return err("Lead cannot shut down itself");

      const target = state.getAgent(ctx.team.id, agentId);
      if (!target) return err(`Unknown target agent: ${agentId}`);
      if (target.isLead) return err(`Cannot shut down another lead: ${agentId}`);

      try {
        const { shutdownTeammate } = await import("./mission.js");
        const shutdown = await shutdownTeammate(ctx.team.id, agentId, boundAgentId!, reason, state, codex, messages);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                shutdown: {
                  agentId: shutdown.agentId,
                  requestedBy: shutdown.requestedBy,
                  approvedBy: shutdown.approvedBy,
                  reason: shutdown.reason,
                  aborted: shutdown.aborted,
                  terminationMode: shutdown.terminationMode,
                  recoveredTasks: shutdown.recoveredTasks,
                  notification: shutdown.notification,
                  timestamp: shutdown.timestamp.toISOString(),
                },
              }),
            },
          ],
        };
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
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
            const summary = messages.protocolSummary(a.id);
            const agentTasks = a.tasks
              .map((taskId) => team!.tasks.get(taskId))
              .filter(Boolean)
              .map((t) => ({
                id: t!.id,
                subject: t!.subject,
                description: t!.description,
                status: t!.status,
                blockedBy: t!.blockedBy,
              }));
            return {
              id: a.id,
              role: a.role,
              specialization: a.specialization || undefined,
              isLead: a.isLead,
              status: a.status,
              awaitingPlanApproval: a.awaitingPlanApproval || undefined,
              controlPlane: summary.queued > 0 || summary.leased > 0 || summary.lastDeliveredAt || summary.lastProcessedAt
                ? {
                    queued: summary.queued,
                    leased: summary.leased,
                    nextMessageType: summary.nextMessageType ?? undefined,
                    activeDeliveryId: summary.activeDeliveryId ?? undefined,
                    lastDeliveredAt: summary.lastDeliveredAt?.toISOString(),
                    lastProcessedAt: summary.lastProcessedAt?.toISOString(),
                  }
                : undefined,
              sandbox: a.sandbox,
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

      const pendingPermissionRequests =
        ctx.agent.isLead && codex
          ? codex
              .listPendingPermissionRequests(ctx.team.id)
              .filter((request) => request.leadId === boundAgentId)
              .map((request) => ({
                id: request.id,
                agentId: request.agentId,
                kind: request.kind,
                reason: request.reason,
                command: request.command,
                cwd: request.cwd,
                createdAt: request.createdAt.toISOString(),
              }))
          : [];

      const result: Record<string, unknown> = {
        yourTeam: {
          teamId: ctx.team.id,
          teamName: ctx.team.name,
          you: { id: boundAgentId, role: ctx.agent.role, isLead: ctx.agent.isLead },
          teammates: mapAgents(ctx.team, boundAgentId),
        },
        otherTeams: otherTeams.length > 0 ? otherTeams : undefined,
        pendingPermissionRequests: pendingPermissionRequests.length > 0 ? pendingPermissionRequests : undefined,
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
        "Block until new messages arrive or timeout. Use instead of polling peek(). Returns pending counts.",
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
          protocol: messages.protocolPeek(agentId),
          leadChat: isLead ? messages.leadChatPeek(agentId) : 0,
        };
      }

      const initial = getCounts();
      if (initial.groupChat > 0 || initial.dms > 0 || initial.protocol > 0 || initial.leadChat > 0) {
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
                  : target.type === "protocol"
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
                  text: JSON.stringify({ timedOut: false, dissolved: true, groupChat: 0, dms: 0, protocol: 0, leadChat: 0 }),
                },
              ],
            });
            return;
          }

          const counts = getCounts();
          if (counts.groupChat > 0 || counts.dms > 0 || counts.protocol > 0 || counts.leadChat > 0) {
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

          (async () => {
            if (!ctx.agent.isLead && ctx.team.hookCommands) {
              const hookResult = await runHook(ctx.team.hookCommands, "TeammateIdle", {
                event: "TeammateIdle",
                missionId: ctx.team.missionId,
                teamId: ctx.team.id,
                timestamp: new Date().toISOString(),
                triggeredBy: agentId,
                agent: {
                  id: ctx.agent.id,
                  role: ctx.agent.role,
                  isLead: ctx.agent.isLead,
                },
              });
              if (hookResult.blocked) {
                resolve({
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        timedOut: true,
                        hookBlocked: true,
                        hookMessage: hookResult.message ?? "TeammateIdle hook says keep working",
                        ...getCounts(),
                      }),
                    },
                  ],
                });
                return;
              }
            }
            resolve({ content: [{ type: "text" as const, text: JSON.stringify({ timedOut: true, ...getCounts() }) }] });
          })();
        }, timeout);
      });
    },
  );

  if (memory) {
    const memoryScopeSchema = z.enum(["private", "team"]);

    server.registerTool(
      "memory_write",
      {
        description:
          "Write a memory entry. Use 'team' scope for shared project context visible to all teammates. " +
          "Use 'private' scope for personal notes. Team scope rejects secrets (API keys, tokens, etc).",
        inputSchema: {
          key: z.string().min(1).max(200).describe("Memory key (e.g. 'auth-architecture', 'user-preferences')"),
          scope: memoryScopeSchema.describe("'private' for personal, 'team' for shared"),
          content: z.string().min(1).max(50000).describe("Memory content (markdown recommended)"),
          expectedRevision: z.number().int().positive().optional().describe("Optional optimistic concurrency guard"),
          expectedChecksum: z.string().min(1).optional().describe("Optional optimistic concurrency guard"),
        },
      },
      async ({ key, scope, content, expectedRevision, expectedChecksum }) => {
        if (!boundAgentId) return err("No agent context");
        try {
          const entry = await memory.write(key, scope as MemoryScope, content, boundAgentId, {
            expectedRevision,
            expectedChecksum,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                saved: true,
                key: entry.key,
                scope: entry.scope,
                checksum: entry.checksum,
                revision: entry.revision,
                updatedAt: entry.updatedAt.toISOString(),
              }),
            }],
          };
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    );

    server.registerTool(
      "memory_read",
      {
        description: "Read a memory entry by key and scope",
        inputSchema: {
          key: z.string().min(1).max(200).describe("Memory key"),
          scope: memoryScopeSchema.describe("'private' or 'team'"),
        },
      },
      async ({ key, scope }) => {
        try {
          const entry = await memory.read(key, scope as MemoryScope);
          if (!entry) return err(`Memory not found: ${scope}/${key}`);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                key: entry.key,
                scope: entry.scope,
                content: entry.content,
                author: entry.author,
                checksum: entry.checksum,
                revision: entry.revision,
                updatedAt: entry.updatedAt.toISOString(),
                createdAt: entry.createdAt.toISOString(),
              }),
            }],
          };
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    );

    server.registerTool(
      "memory_list",
      {
        description: "List all memory entries, optionally filtered by scope",
        inputSchema: {
          scope: memoryScopeSchema.optional().describe("Filter by scope (omit for all)"),
        },
      },
      async ({ scope }) => {
        try {
          const entries = await memory.list(scope as MemoryScope | undefined);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(entries.map((e) => ({
                key: e.key,
                scope: e.scope,
                author: e.author,
                size: e.size,
                checksum: e.checksum,
                revision: e.revision,
                updatedAt: e.updatedAt.toISOString(),
              }))),
            }],
          };
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    );

    server.registerTool(
      "memory_delete",
      {
        description: "Delete a memory entry",
        inputSchema: {
          key: z.string().min(1).max(200).describe("Memory key"),
          scope: memoryScopeSchema.describe("'private' or 'team'"),
        },
      },
      async ({ key, scope }) => {
        try {
          const deleted = await memory.delete(key, scope as MemoryScope);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ deleted, key, scope }) }],
          };
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    );

    server.registerTool(
      "memory_search",
      {
        description: "Search memory entries by text query across keys and content",
        inputSchema: {
          query: z.string().min(1).max(500).describe("Search text"),
          scope: memoryScopeSchema.optional().describe("Filter by scope (omit for all)"),
        },
      },
      async ({ query, scope }) => {
        try {
          const results = await memory.search(query, scope as MemoryScope | undefined);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(results.map((e) => ({
                key: e.key,
                scope: e.scope,
                content: e.content,
                author: e.author,
                checksum: e.checksum,
                revision: e.revision,
                updatedAt: e.updatedAt.toISOString(),
              }))),
            }],
          };
        } catch (e: unknown) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }
}

export async function startCommsServer(
  messages: MessageSystem,
  state: TeamManager,
  codex?: CodexClientManager,
  memory?: TeamMemoryStore,
): Promise<{ httpServer: Server; port: number }> {
  codex?.setStateManager(state);
  codex?.setMessageSystem(messages);

  const app = createMcpExpressApp();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionAgents = new Map<string, string>();

  app.post("/steer", async (req: McpRequest, res: McpResponse) => {
    const body = req.body as { teamId?: string; directive?: string; agentIds?: string[] } | undefined;
    if (!body?.teamId || !body?.directive) {
      res.status(400).json({ error: "Missing teamId or directive" });
      return;
    }
    if (!codex) {
      res.status(500).json({ error: "Codex client not available" });
      return;
    }
    try {
      const { steerTeam } = await import("./mission.js");
      const result = await steerTeam(body.teamId, body.directive, body.agentIds, state, codex, messages);
      res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/shutdown", async (req: McpRequest, res: McpResponse) => {
    const body = req.body as { teamId?: string; agentId?: string; reason?: string; requestedBy?: string } | undefined;
    if (!body?.teamId || !body?.agentId) {
      res.status(400).json({ error: "Missing teamId or agentId" });
      return;
    }
    if (!codex) {
      res.status(500).json({ error: "Codex client not available" });
      return;
    }
    try {
      const { shutdownTeammate } = await import("./mission.js");
      const result = await shutdownTeammate(
        body.teamId,
        body.agentId,
        body.requestedBy ?? "orchestrator",
        body.reason,
        state,
        codex,
        messages,
      );
      res.status(200).json({
        agentId: result.agentId,
        requestedBy: result.requestedBy,
        approvedBy: result.approvedBy,
        reason: result.reason,
        aborted: result.aborted,
        terminationMode: result.terminationMode,
        recoveredTasks: result.recoveredTasks,
        notification: result.notification,
        timestamp: result.timestamp.toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/message", async (req: McpRequest, res: McpResponse) => {
    const body = req.body as {
      teamId?: string;
      to?: string;
      message?: string;
      summary?: string;
      from?: string;
      fromRole?: string;
    } | undefined;
    if (!body?.teamId || !body?.to || typeof body.message !== "string" || body.message.trim() === "") {
      res.status(400).json({ error: "Missing teamId, to, or message" });
      return;
    }

    const team = state.getTeam(body.teamId);
    if (!team) {
      res.status(404).json({ error: `Team not found: ${body.teamId}` });
      return;
    }

    const sender = typeof body.from === "string" && body.from.trim() ? body.from.trim() : "orchestrator";
    const senderRole = typeof body.fromRole === "string" && body.fromRole.trim() ? body.fromRole.trim() : "Orchestrator";
    const summary =
      typeof body.summary === "string" && body.summary.trim().length > 0
        ? body.summary.trim()
        : body.message.trim().slice(0, 200);

    const recipients =
      body.to === "*"
        ? Array.from(team.agents.keys())
        : team.agents.has(body.to)
          ? [body.to]
          : null;

    if (!recipients) {
      res.status(400).json({ error: `Unknown target agent: ${body.to}` });
      return;
    }

    for (const agentId of team.agents.keys()) {
      messages.registerAgentTeam(agentId, team.id);
    }
    for (const recipient of recipients) {
      messages.dmSend(sender, recipient, senderRole, body.message, summary);
    }

    res.status(200).json({
      success: true,
      sent: recipients.length,
      recipients,
      summary,
      broadcast: body.to === "*",
    });
  });

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
      registerCommsTools(server, messages, state, boundAgentId, codex, memory);
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
