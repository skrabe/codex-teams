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
});
