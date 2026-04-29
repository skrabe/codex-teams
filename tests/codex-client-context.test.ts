import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodexClientManager } from "../src/codex-client.js";
import { TeamManager } from "../src/state.js";
import type { Agent } from "../src/types.js";

class RecordingCodexClient extends CodexClientManager {
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  override async connect() {
    (this as { connected: boolean }).connected = true;
  }

  primeAgentSession(agentId: string): void {
    const session = {
      connected: true,
      client: {
        callTool: async ({
          name,
          arguments: args,
        }: {
          name: string;
          arguments: Record<string, unknown>;
        }) => {
          this.toolCalls.push({ name, arguments: args });
          if (name === "codex") {
            return {
              structuredContent: {
                threadId: `thread-${agentId}`,
                content: "spawned",
              },
            };
          }

          return {
            structuredContent: {
              content: "continued",
            },
          };
        },
        close: async () => {},
        setRequestHandler: () => {},
      },
      transport: {},
    };

    (this as { agentSessions: Map<string, unknown> }).agentSessions.set(agentId, session);
  }
}

describe("codex-client startup context hygiene", () => {
  let state: TeamManager;
  let worker: Agent;
  let codex: RecordingCodexClient;

  beforeEach(() => {
    state = new TeamManager();
    const team = state.createTeam("context-team", [
      { role: "lead", isLead: true },
      { role: "worker", baseInstructions: "Focus on the assigned scope only." },
    ]);
    worker = Array.from(team.agents.values()).find((agent) => !agent.isLead)!;
    worker.lastOutput = "FULL PARENT TRANSCRIPT SHOULD NOT LEAK";
    codex = new RecordingCodexClient();
    codex.setStateManager(state);
    codex.primeAgentSession(worker.id);
  });

  it("wraps first spawn prompts in an explicit minimal-context contract", async () => {
    await codex.sendToAgent(worker, "=== MISSION OBJECTIVE ===\nShip the parser safely.");

    assert.equal(codex.toolCalls.length, 1);
    assert.equal(codex.toolCalls[0].name, "codex");

    const prompt = String(codex.toolCalls[0].arguments.prompt);
    assert.match(prompt, /STARTUP CONTEXT CONTRACT/);
    assert.match(prompt, /Ship the parser safely/);
    assert.doesNotMatch(prompt, /FULL PARENT TRANSCRIPT SHOULD NOT LEAK/);

    const baseInstructions = String(codex.toolCalls[0].arguments["base-instructions"]);
    assert.match(baseInstructions, /startup prompt is intentionally scoped/i);
  });

  it("uses codex-reply without replaying prior prompt history", async () => {
    await codex.sendToAgent(worker, "Initial scoped startup payload");

    codex.toolCalls.length = 0;
    await codex.sendToAgent(worker, "Only update the parser tests.");

    assert.equal(codex.toolCalls.length, 1);
    assert.equal(codex.toolCalls[0].name, "codex-reply");
    assert.deepEqual(codex.toolCalls[0].arguments, {
      prompt: "Only update the parser tests.",
      threadId: `thread-${worker.id}`,
    });
  });

  it("uses GPT-5.5 with no reasoning by default", async () => {
    await codex.sendToAgent(worker, "Initial scoped startup payload");

    assert.equal(codex.toolCalls[0].arguments.model, "gpt-5.5");
    assert.deepEqual(codex.toolCalls[0].arguments.config, {
      model_reasoning_effort: "none",
      search: true,
      model_reasoning_summary: "none",
    });
  });

  it("passes explicit reasoning effort when configured", async () => {
    worker.reasoningEffort = "medium";

    await codex.sendToAgent(worker, "Initial scoped startup payload");

    assert.equal(codex.toolCalls[0].arguments.model, "gpt-5.5");
    assert.deepEqual(codex.toolCalls[0].arguments.config, {
      model_reasoning_effort: "medium",
      search: true,
    });
  });

  it("bounds disconnect while agent operations are still pending", async () => {
    const originalGrace = process.env.CODEX_TEAMS_DISCONNECT_GRACE_MS;
    process.env.CODEX_TEAMS_DISCONNECT_GRACE_MS = "10";
    const stuck = new CodexClientManager();
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener("abort", () => {
      aborted = true;
    });
    (stuck as unknown as { pendingOps: Set<Promise<unknown>> }).pendingOps.add(new Promise(() => {}));
    (stuck as unknown as { activeControllers: Map<string, AbortController> }).activeControllers.set("agent-1", controller);
    (stuck as unknown as { agentLocks: Map<string, Promise<unknown>> }).agentLocks.set("agent-1", Promise.resolve());

    try {
      const started = Date.now();
      await stuck.disconnect();

      assert.equal(aborted, true);
      assert.equal((stuck as unknown as { activeControllers: Map<string, AbortController> }).activeControllers.size, 0);
      assert.equal((stuck as unknown as { agentLocks: Map<string, Promise<unknown>> }).agentLocks.size, 0);
      assert.ok(Date.now() - started < 1_000);
    } finally {
      if (originalGrace === undefined) delete process.env.CODEX_TEAMS_DISCONNECT_GRACE_MS;
      else process.env.CODEX_TEAMS_DISCONNECT_GRACE_MS = originalGrace;
    }
  });
});
