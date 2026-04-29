import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { Agent } from "./types.js";
import type { TeamManager } from "./state.js";
import type { MessageSystem } from "./messages.js";
import { HOOK_BLOCK_PREFIX, runHook } from "./hooks.js";
import { syncMissionAgentState, syncMissionControlPlaneState } from "./mission.js";

const CODEX_TIMEOUT_MS = 180 * 60 * 1000;
const STARTUP_CONTEXT_CONTRACT = `=== STARTUP CONTEXT CONTRACT ===
This startup payload is intentionally minimal.
- Do not assume you inherited any hidden parent transcript, prior turns, or full team chat history.
- Treat only the startup payload below, your base instructions, and the tools you can call as your initial context.
- Fetch additional scoped context explicitly with task_list(), task_get(), group_chat_read(), protocol_read(), get_shared(), and lead_chat_read() when relevant.`;

const CommandApprovalRequestSchema = z
  .object({
    method: z.literal("item/commandExecution/requestApproval"),
    params: z
      .object({
        itemId: z.string(),
        threadId: z.string(),
        turnId: z.string(),
        approvalId: z.string().optional(),
        reason: z.string(),
        command: z.string().optional(),
        cwd: z.string().optional(),
        availableDecisions: z.array(z.string()).optional(),
        additionalPermissions: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const PermissionsApprovalRequestSchema = z
  .object({
    method: z.literal("item/permissions/requestApproval"),
    params: z
      .object({
        itemId: z.string(),
        threadId: z.string(),
        turnId: z.string(),
        reason: z.string(),
        permissions: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

export type PermissionRequestKind = "command_execution" | "permissions";
export type PermissionResponseScope = "turn" | "session";

export interface PendingPermissionRequest {
  id: string;
  agentId: string;
  leadId: string;
  teamId: string;
  kind: PermissionRequestKind;
  reason: string;
  command?: string;
  cwd?: string;
  permissions?: Record<string, unknown>;
  availableDecisions?: string[];
  createdAt: Date;
}

export interface PermissionDecision {
  approved: boolean;
  scope?: PermissionResponseScope;
  feedback?: string;
}

interface PendingPermissionRequestEntry {
  request: PendingPermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  cleanupAbort: () => void;
}

interface AgentSession {
  client: Client;
  transport: StdioClientTransport;
  connected: boolean;
}

export class CodexClientManager {
  private connected = false;
  private pendingOps = new Set<Promise<unknown>>();
  private commsPort: number | null = null;
  private stateManager: TeamManager | null = null;
  private messages: MessageSystem | null = null;
  private agentTokens = new Map<string, string>();
  private agentLocks = new Map<string, Promise<unknown>>();
  private activeControllers = new Map<string, AbortController>();
  private agentSessions = new Map<string, AgentSession>();
  private pendingPermissionRequests = new Map<string, PendingPermissionRequestEntry>();

  setCommsPort(port: number): void {
    this.commsPort = port;
  }

  setStateManager(state: TeamManager): void {
    this.stateManager = state;
  }

  setMessageSystem(messages: MessageSystem): void {
    this.messages = messages;
  }

  generateAgentToken(agentId: string): string {
    const existing = this.agentTokens.get(agentId);
    if (existing) return existing;
    const token = crypto.randomUUID();
    this.agentTokens.set(agentId, token);
    return token;
  }

  validateAgentToken(agentId: string, token: string): boolean {
    return this.agentTokens.get(agentId) === token;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.pendingOps.size > 0) {
      console.error(`codex-teams: waiting for ${this.pendingOps.size} pending operation(s)...`);
      await Promise.allSettled(this.pendingOps);
    }

    for (const [agentId, session] of this.agentSessions) {
      this.agentSessions.delete(agentId);
      await this.closeSession(session);
      this.agentTokens.delete(agentId);
    }

    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected || this.agentSessions.size > 0;
  }

  hasPendingOps(): boolean {
    return this.pendingOps.size > 0;
  }

  trackOp(op: Promise<unknown>): void {
    this.pendingOps.add(op);
    op.finally(() => this.pendingOps.delete(op)).catch(() => {});
  }

  abortAgent(agentId: string): boolean {
    const controller = this.activeControllers.get(agentId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(agentId);
      return true;
    }
    return false;
  }

  abortTeam(agentIds: string[]): string[] {
    const aborted: string[] = [];
    for (const id of agentIds) {
      if (this.abortAgent(id)) aborted.push(id);
    }
    return aborted;
  }

  cleanupAgent(agentId: string): void {
    this.agentLocks.delete(agentId);
    this.activeControllers.delete(agentId);

    for (const [requestId, entry] of this.pendingPermissionRequests) {
      if (entry.request.agentId !== agentId && entry.request.leadId !== agentId) continue;
      this.pendingPermissionRequests.delete(requestId);
      entry.cleanupAbort();
      entry.resolve({
        approved: false,
        feedback: entry.request.agentId === agentId ? "Agent aborted before approval completed" : "Lead unavailable",
      });
    }

    const session = this.agentSessions.get(agentId);
    if (session) {
      session.connected = false;
    } else {
      this.agentTokens.delete(agentId);
    }
  }

  clearLock(agentId: string): void {
    this.agentLocks.delete(agentId);
  }

  listPendingPermissionRequests(teamId?: string): PendingPermissionRequest[] {
    return Array.from(this.pendingPermissionRequests.values())
      .map((entry) => ({ ...entry.request }))
      .filter((request) => !teamId || request.teamId === teamId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  getPendingPermissionRequest(requestId: string): PendingPermissionRequest | undefined {
    const entry = this.pendingPermissionRequests.get(requestId);
    return entry ? { ...entry.request } : undefined;
  }

  async beginPermissionRequest(
    agentId: string,
    input: {
      id?: string;
      kind: PermissionRequestKind;
      reason: string;
      command?: string;
      cwd?: string;
      permissions?: Record<string, unknown>;
      availableDecisions?: string[];
    },
  ): Promise<PermissionDecision> {
    const ctx = this.findAgentContext(agentId);
    if (!ctx) throw new Error(`Agent not found for permission request: ${agentId}`);
    const messages = this.messages;
    if (!messages) throw new Error("Message system not configured for permission bridge");
    if (ctx.agent.isLead || ctx.lead.id === agentId) {
      return { approved: true, scope: "turn" };
    }

    const requestId = input.id ?? crypto.randomUUID();
    const request: PendingPermissionRequest = {
      id: requestId,
      agentId,
      leadId: ctx.lead.id,
      teamId: ctx.team.id,
      kind: input.kind,
      reason: input.reason,
      command: input.command,
      cwd: input.cwd,
      permissions: input.permissions,
      availableDecisions: input.availableDecisions,
      createdAt: new Date(),
    };

    return new Promise<PermissionDecision>((resolve) => {
      const controller = this.activeControllers.get(agentId);
      const onAbort = () => {
        this.pendingPermissionRequests.delete(requestId);
        if (this.stateManager) {
          const updatedAgent = this.stateManager.updateAgentRuntime(ctx.team.id, agentId, {
            status: "error",
            lifecycle: "error",
            isActive: false,
            terminalReason: "aborted_during_permission_wait",
          });
          syncMissionAgentState(ctx.team.id, updatedAgent);
        }
        resolve({ approved: false, feedback: "Agent aborted before approval completed" });
      };

      if (controller) {
        if (controller.signal.aborted) {
          resolve({ approved: false, feedback: "Agent aborted before approval completed" });
          return;
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }

      const cleanupAbort = () => {
        if (controller) controller.signal.removeEventListener("abort", onAbort);
      };

      this.pendingPermissionRequests.set(requestId, {
        request,
        resolve: (decision) => {
          cleanupAbort();
          if (this.stateManager) {
            const updatedAgent = this.stateManager.updateAgentRuntime(ctx.team.id, agentId, {
              status: "working",
              lifecycle: "working",
              isActive: true,
              terminalReason: null,
            });
            syncMissionAgentState(ctx.team.id, updatedAgent);
          }
          resolve(decision);
        },
        cleanupAbort,
      });

      if (this.stateManager) {
        const updatedAgent = this.stateManager.updateAgentRuntime(ctx.team.id, agentId, {
          lifecycle: "waiting_permission",
          isActive: false,
          terminalReason: null,
        });
        syncMissionAgentState(ctx.team.id, updatedAgent);
      }

      const requestType = request.kind === "permissions" ? "sandbox_permission_request" : "permission_request";
      messages.protocolSend(agentId, ctx.lead.id, requestType, {
        requestId,
        kind: request.kind,
        reason: request.reason,
        command: request.command,
        cwd: request.cwd,
        permissions: request.permissions,
        availableDecisions: request.availableDecisions,
        createdAt: request.createdAt.toISOString(),
      });
      syncMissionControlPlaneState(ctx.team.id, ctx.lead.id, messages);
    });
  }

  resolvePermissionRequest(
    requestId: string,
    response: PermissionDecision & { resolvedBy: string },
  ): PendingPermissionRequest {
    const entry = this.pendingPermissionRequests.get(requestId);
    if (!entry) throw new Error(`Unknown permission request: ${requestId}`);

    this.pendingPermissionRequests.delete(requestId);
    entry.cleanupAbort();

    const responseType = entry.request.kind === "permissions" ? "sandbox_permission_response" : "permission_response";
    this.messages?.protocolSend(response.resolvedBy, entry.request.agentId, responseType, {
      requestId,
      kind: entry.request.kind,
      approved: response.approved,
      feedback: response.feedback,
      scope: response.scope ?? "turn",
      respondedAt: new Date().toISOString(),
    });
    if (this.messages) {
      syncMissionControlPlaneState(entry.request.teamId, entry.request.agentId, this.messages);
    }

    entry.resolve({
      approved: response.approved,
      feedback: response.feedback,
      scope: response.scope ?? "turn",
    });

    return { ...entry.request };
  }

  async sendToAgent(agent: Agent, message: string, signal?: AbortSignal): Promise<string> {
    const prev = this.agentLocks.get(agent.id) ?? Promise.resolve();
    const run = prev.then(
      () => this.doSendToAgent(agent, message, signal),
      () => this.doSendToAgent(agent, message, signal),
    );
    this.agentLocks.set(
      agent.id,
      run.catch(() => {}),
    );
    this.trackOp(run);
    return run;
  }

  private async doSendToAgent(agent: Agent, message: string, signal?: AbortSignal): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.activeControllers.set(agent.id, controller);

    agent.status = "working";
    agent.lifecycle = "working";
    agent.isActive = true;
    agent.lastSeenAt = new Date();
    agent.terminalReason = undefined;
    syncMissionAgentState(this.findAgentContext(agent.id)?.team.id ?? "", agent);

    try {
      const session = await this.getOrCreateSession(agent.id);
      let result;

      if (agent.threadId === null) {
        const config: Record<string, unknown> = {
          model_reasoning_effort: agent.reasoningEffort,
          search: true,
        };
        if (agent.reasoningEffort === "none") {
          config.model_reasoning_summary = "none";
        }
        if (agent.fastMode) {
          config.service_tier = "fast";
        }
        if (this.commsPort !== null) {
          const token = this.generateAgentToken(agent.id);
          config.mcp_servers = {
            "team-comms": {
              url: `http://localhost:${this.commsPort}/mcp?agent=${encodeURIComponent(agent.id)}&token=${token}`,
              startup_timeout_sec: 300,
              tool_timeout_sec: 300,
            },
          };
        }

        const args: Record<string, unknown> = {
          prompt: this.wrapStartupPrompt(message),
          model: agent.model,
          "approval-policy": agent.approvalPolicy,
          sandbox: this.resolveSandbox(agent),
          cwd: agent.cwd,
          config,
        };
        const instructions = this.resolveInstructions(agent);
        if (instructions) {
          args["base-instructions"] = instructions;
        }

        result = await session.client.callTool({ name: "codex", arguments: args }, undefined, {
          timeout: CODEX_TIMEOUT_MS,
          signal: controller.signal,
        });

        const structured = (result as Record<string, unknown>).structuredContent as
          | { threadId?: string; content?: string }
          | undefined;

        if (structured?.threadId) {
          agent.threadId = structured.threadId;
          syncMissionAgentState(this.findAgentContext(agent.id)?.team.id ?? "", agent);
        }
      } else {
        result = await session.client.callTool(
          {
            name: "codex-reply",
            arguments: {
              prompt: message,
              threadId: agent.threadId,
            },
          },
          undefined,
          { timeout: CODEX_TIMEOUT_MS, signal: controller.signal },
        );
      }

      const r = result as Record<string, unknown>;
      if (r.isError) {
        const errorText = this.extractOutput(result);
        throw new Error(errorText);
      }

      const output = this.extractOutput(result);
      await this.runTeammateIdleHook(agent);
      agent.lastOutput = output;
      agent.status = "idle";
      agent.lifecycle = agent.awaitingPlanApproval ? "waiting_plan_approval" : "idle";
      agent.isActive = false;
      agent.lastSeenAt = new Date();
      agent.terminalReason = undefined;
      syncMissionAgentState(this.findAgentContext(agent.id)?.team.id ?? "", agent);
      return output;
    } catch (error) {
      agent.status = "error";
      const msg = error instanceof Error ? error.message : String(error);
      agent.lastOutput = `Error: ${msg}`;
      agent.lifecycle = "error";
      agent.isActive = false;
      agent.lastSeenAt = new Date();
      agent.terminalReason = msg;
      syncMissionAgentState(this.findAgentContext(agent.id)?.team.id ?? "", agent);

      if (msg.includes("thread") || msg.includes("not found")) {
        agent.threadId = null;
        syncMissionAgentState(this.findAgentContext(agent.id)?.team.id ?? "", agent);
      }

      throw new Error(`Codex agent ${agent.id} error: ${msg}`);
    } finally {
      this.activeControllers.delete(agent.id);
    }
  }


  async runTeammateIdleHook(agent: Agent): Promise<void> {
    if (agent.isLead) return;

    const ctx = this.findAgentContext(agent.id);
    if (!ctx) return;

    const result = await runHook(ctx.team.hookCommands, "TeammateIdle", {
      event: "TeammateIdle",
      missionId: ctx.team.missionId,
      teamId: ctx.team.id,
      timestamp: new Date().toISOString(),
      agent: {
        id: agent.id,
        role: agent.role,
        isLead: false,
      },
    });

    if (result.blocked) {
      throw new Error(`${HOOK_BLOCK_PREFIX} TeammateIdle hook blocked for ${agent.id}: ${result.message ?? "blocked"}`);
    }
  }

  private resolveInstructions(agent: Agent): string {
    if (!this.stateManager) return agent.baseInstructions;

    for (const team of this.stateManager.listTeams()) {
      if (team.agents.has(agent.id)) {
        return this.stateManager.buildInstructions(agent, team.id);
      }
    }
    return agent.baseInstructions;
  }

  private resolveSandbox(agent: Agent): Agent["sandbox"] {
    return agent.sandbox === "plan-mode" ? "workspace-write" : agent.sandbox;
  }

  private findAgentContext(agentId: string):
    | { team: ReturnType<TeamManager["listTeams"]>[number]; agent: Agent; lead: Agent }
    | null {
    if (!this.stateManager) return null;

    for (const team of this.stateManager.listTeams()) {
      const agent = team.agents.get(agentId);
      if (!agent) continue;
      const lead = Array.from(team.agents.values()).find((candidate) => candidate.isLead);
      if (!lead) throw new Error(`Lead not found for team ${team.id}`);
      return { team, agent, lead };
    }

    return null;
  }

  private wrapStartupPrompt(message: string): string {
    return `${STARTUP_CONTEXT_CONTRACT}

=== STARTUP PAYLOAD ===
${message}`;
  }

  private async getOrCreateSession(agentId: string): Promise<AgentSession> {
    const existing = this.agentSessions.get(agentId);
    if (existing?.connected) return existing;

    if (existing) {
      this.agentSessions.delete(agentId);
      await this.closeSession(existing);
    }

    const transport = new StdioClientTransport({
      command: "codex",
      args: ["mcp-server"],
    });

    const client = new Client({ name: "codex-teams", version: "2.0.0" }, { capabilities: {} });
    const session: AgentSession = { client, transport, connected: false };

    client.setRequestHandler(CommandApprovalRequestSchema, async (request) => {
      const decision = await this.beginPermissionRequest(agentId, {
        id: request.params.approvalId ?? request.params.itemId,
        kind: "command_execution",
        reason: request.params.reason,
        command: request.params.command,
        cwd: request.params.cwd,
        permissions: request.params.additionalPermissions,
        availableDecisions: request.params.availableDecisions,
      });

      if (
        decision.approved &&
        decision.scope === "session" &&
        request.params.availableDecisions?.includes("acceptForSession")
      ) {
        return { decision: "acceptForSession" };
      }

      return { decision: decision.approved ? "accept" : "decline" };
    });

    client.setRequestHandler(PermissionsApprovalRequestSchema, async (request) => {
      const decision = await this.beginPermissionRequest(agentId, {
        id: request.params.itemId,
        kind: "permissions",
        reason: request.params.reason,
        permissions: request.params.permissions,
      });

      return {
        scope: decision.scope ?? "turn",
        permissions: decision.approved ? request.params.permissions : {},
      };
    });

    client.onclose = () => {
      session.connected = false;
    };

    await client.connect(transport);
    session.connected = true;
    this.agentSessions.set(agentId, session);
    return session;
  }

  private async closeSession(session: AgentSession): Promise<void> {
    session.connected = false;
    try {
      await Promise.race([
        session.client.close(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        }),
      ]);
    } catch {}
  }

  private extractOutput(result: unknown): string {
    const r = result as Record<string, unknown>;

    const structured = r.structuredContent as { content?: string } | undefined;
    if (structured?.content) return structured.content;

    const content = r.content as Array<{ type: string; text?: string }> | undefined;
    if (content && content.length > 0) {
      const textParts = content.filter((c) => c.type === "text" && c.text);
      if (textParts.length > 0) return textParts.map((c) => c.text).join("\n");
    }

    return JSON.stringify(result);
  }
}
