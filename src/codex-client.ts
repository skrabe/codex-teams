import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Agent } from "./types.js";
import type { TeamManager } from "./state.js";

const CODEX_TIMEOUT_MS = 60 * 60 * 1000;

export class CodexClientManager {
  private client!: Client;
  private transport!: StdioClientTransport;
  private connected = false;
  private pendingOps = new Set<Promise<unknown>>();
  private commsPort: number | null = null;
  private stateManager: TeamManager | null = null;
  private agentTokens = new Map<string, string>();
  private agentLocks = new Map<string, Promise<unknown>>();
  private reconnectPromise: Promise<void> | null = null;

  setCommsPort(port: number): void {
    this.commsPort = port;
  }

  setStateManager(state: TeamManager): void {
    this.stateManager = state;
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
    this.transport = new StdioClientTransport({
      command: "codex",
      args: ["mcp-server"],
    });

    this.client = new Client({ name: "codex-teams", version: "2.0.0" }, { capabilities: {} });

    this.client.onclose = () => {
      if (this.connected) {
        this.connected = false;
        console.error("codex-teams: codex mcp-server connection lost");
      }
    };

    await this.client.connect(this.transport);
    this.connected = true;
    console.error("codex-teams: connected to codex mcp-server");
  }

  async disconnect(): Promise<void> {
    if (this.pendingOps.size > 0) {
      console.error(`codex-teams: waiting for ${this.pendingOps.size} pending operation(s)...`);
      await Promise.allSettled(this.pendingOps);
    }

    if (this.connected) {
      await this.client.close();
      this.connected = false;
      console.error("codex-teams: disconnected from codex mcp-server");
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  hasPendingOps(): boolean {
    return this.pendingOps.size > 0;
  }

  trackOp(op: Promise<unknown>): void {
    this.pendingOps.add(op);
    op.finally(() => this.pendingOps.delete(op));
  }

  async reconnect(): Promise<void> {
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = (async () => {
      console.error("codex-teams: attempting reconnect...");
      try {
        await this.client.close().catch(() => {});
      } catch {}
      await this.connect();
    })();
    try {
      await this.reconnectPromise;
    } finally {
      this.reconnectPromise = null;
    }
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
    return run;
  }

  private async doSendToAgent(agent: Agent, message: string, signal?: AbortSignal): Promise<string> {
    if (!this.connected) {
      await this.reconnect();
    }

    agent.status = "working";

    try {
      let result;

      if (agent.threadId === null) {
        const config: Record<string, unknown> = {
          model_reasoning_effort: agent.reasoningEffort,
          search: true,
        };
        if (this.commsPort !== null) {
          const token = this.generateAgentToken(agent.id);
          config.mcp_servers = {
            "team-comms": {
              url: `http://localhost:${this.commsPort}/mcp?agent=${encodeURIComponent(agent.id)}&token=${token}`,
              startup_timeout_sec: 120,
              tool_timeout_sec: 60,
            },
          };
        }

        const args: Record<string, unknown> = {
          prompt: message,
          model: agent.model,
          "approval-policy": agent.approvalPolicy,
          sandbox: agent.sandbox,
          cwd: agent.cwd,
          config,
        };
        const instructions = this.resolveInstructions(agent);
        if (instructions) {
          args["base-instructions"] = instructions;
        }

        result = await this.client.callTool({ name: "codex", arguments: args }, undefined, {
          timeout: CODEX_TIMEOUT_MS,
          signal,
        });

        const structured = (result as Record<string, unknown>).structuredContent as
          | { threadId?: string; content?: string }
          | undefined;

        if (structured?.threadId) {
          agent.threadId = structured.threadId;
        }
      } else {
        result = await this.client.callTool(
          {
            name: "codex-reply",
            arguments: {
              prompt: message,
              threadId: agent.threadId,
            },
          },
          undefined,
          { timeout: CODEX_TIMEOUT_MS, signal },
        );
      }

      const r = result as Record<string, unknown>;
      if (r.isError) {
        const errorText = this.extractOutput(result);
        throw new Error(errorText);
      }

      const output = this.extractOutput(result);
      agent.lastOutput = output;
      agent.status = "idle";
      return output;
    } catch (error) {
      agent.status = "error";
      const msg = error instanceof Error ? error.message : String(error);
      agent.lastOutput = `Error: ${msg}`;

      if (msg.includes("thread") || msg.includes("not found")) {
        agent.threadId = null;
      }

      throw new Error(`Codex agent ${agent.id} error: ${msg}`);
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
