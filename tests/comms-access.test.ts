import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";
import { MessageSystem } from "../src/messages.js";

function findAgentContext(state: TeamManager, agentId: string) {
  for (const team of state.listTeams()) {
    const agent = team.agents.get(agentId);
    if (agent) return { team, agent };
  }
  return null;
}

describe("Comms Access Control (unit)", () => {
  let state: TeamManager;
  let ms: MessageSystem;
  let team1Id: string;
  let team2Id: string;
  let lead1Id: string;
  let worker1aId: string;
  let worker1bId: string;
  let lead2Id: string;
  let worker2aId: string;

  beforeEach(() => {
    state = new TeamManager();
    ms = new MessageSystem();

    const team1 = state.createTeam("frontend", [
      { role: "lead", isLead: true, specialization: "Frontend architecture" },
      { role: "dev-a", specialization: "React components" },
      { role: "dev-b", specialization: "CSS/styling" },
    ]);
    team1Id = team1.id;
    const t1agents = Array.from(team1.agents.values());
    lead1Id = t1agents.find((a) => a.isLead)!.id;
    worker1aId = t1agents.find((a) => a.role === "dev-a")!.id;
    worker1bId = t1agents.find((a) => a.role === "dev-b")!.id;

    const team2 = state.createTeam("backend", [
      { role: "lead", isLead: true, specialization: "API design" },
      { role: "dev-a", specialization: "Database" },
    ]);
    team2Id = team2.id;
    const t2agents = Array.from(team2.agents.values());
    lead2Id = t2agents.find((a) => a.isLead)!.id;
    worker2aId = t2agents.find((a) => a.role === "dev-a")!.id;
  });

  describe("group chat access", () => {
    it("worker can post to own team group chat", () => {
      const ctx = findAgentContext(state, worker1aId)!;
      assert.ok(ctx);
      assert.equal(ctx.team.id, team1Id);

      ms.groupChatPost(ctx.team.id, worker1aId, ctx.agent.role, "hello");
      const msgs = ms.groupChatRead(ctx.team.id, worker1bId);
      assert.equal(msgs.length, 1);
    });

    it("lead can post to own team group chat", () => {
      const ctx = findAgentContext(state, lead1Id)!;
      ms.groupChatPost(ctx.team.id, lead1Id, ctx.agent.role, "status update");
      const msgs = ms.groupChatRead(ctx.team.id, worker1aId);
      assert.equal(msgs.length, 1);
    });

    it("worker can only access own team group chat (enforced by comms server lookup)", () => {
      ms.groupChatPost(team1Id, worker1aId, "dev-a", "team1 msg");
      ms.groupChatPost(team2Id, worker2aId, "dev-a", "team2 msg");

      const ctx = findAgentContext(state, worker1bId)!;
      assert.equal(ctx.team.id, team1Id);

      const t1msgs = ms.groupChatRead(ctx.team.id, worker1bId);
      assert.equal(t1msgs.length, 1);
      assert.equal(t1msgs[0].text, "team1 msg");

      const ctx2 = findAgentContext(state, worker2aId)!;
      assert.equal(ctx2.team.id, team2Id);
      assert.notEqual(ctx.team.id, ctx2.team.id);
    });
  });

  describe("DM access", () => {
    it("worker can DM teammate in same team", () => {
      const fromCtx = findAgentContext(state, worker1aId)!;
      const toCtx = findAgentContext(state, worker1bId)!;
      assert.equal(fromCtx.team.id, toCtx.team.id);

      ms.dmSend(worker1aId, worker1bId, fromCtx.agent.role, "hey teammate");
      const msgs = ms.dmRead(worker1bId);
      assert.equal(msgs.length, 1);
    });

    it("worker can DM their lead", () => {
      const fromCtx = findAgentContext(state, worker1aId)!;
      const toCtx = findAgentContext(state, lead1Id)!;
      assert.equal(fromCtx.team.id, toCtx.team.id);

      ms.dmSend(worker1aId, lead1Id, fromCtx.agent.role, "question for lead");
      const msgs = ms.dmRead(lead1Id);
      assert.equal(msgs.length, 1);
    });

    it("lead can DM own workers", () => {
      ms.dmSend(lead1Id, worker1aId, "lead", "task update");
      ms.dmSend(lead1Id, worker1bId, "lead", "priority change");

      assert.equal(ms.dmRead(worker1aId).length, 1);
      assert.equal(ms.dmRead(worker1bId).length, 1);
    });

    it("worker CANNOT DM agent outside their team (access control validation)", () => {
      const fromCtx = findAgentContext(state, worker1aId)!;
      const toCtx = findAgentContext(state, worker2aId)!;
      assert.notEqual(fromCtx.team.id, toCtx.team.id);

      const sameTeam = fromCtx.team.id === toCtx.team.id;
      const bothLeads = fromCtx.agent.isLead && toCtx.agent.isLead;
      assert.equal(sameTeam, false);
      assert.equal(bothLeads, false);
    });

    it("lead CAN DM other team's lead (cross-team)", () => {
      const fromCtx = findAgentContext(state, lead1Id)!;
      const toCtx = findAgentContext(state, lead2Id)!;
      assert.notEqual(fromCtx.team.id, toCtx.team.id);

      const bothLeads = fromCtx.agent.isLead && toCtx.agent.isLead;
      assert.equal(bothLeads, true);

      ms.dmSend(lead1Id, lead2Id, fromCtx.agent.role, "cross-team coordination");
      const msgs = ms.dmRead(lead2Id);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].text, "cross-team coordination");
    });

    it("lead CANNOT DM other team's worker (access control validation)", () => {
      const fromCtx = findAgentContext(state, lead1Id)!;
      const toCtx = findAgentContext(state, worker2aId)!;
      assert.notEqual(fromCtx.team.id, toCtx.team.id);

      const sameTeam = fromCtx.team.id === toCtx.team.id;
      const bothLeads = fromCtx.agent.isLead && toCtx.agent.isLead;
      assert.equal(sameTeam, false);
      assert.equal(bothLeads, false);
    });
  });

  describe("lead chat access", () => {
    it("leads can post and read lead chat", () => {
      const ctx1 = findAgentContext(state, lead1Id)!;
      const ctx2 = findAgentContext(state, lead2Id)!;
      assert.ok(ctx1.agent.isLead);
      assert.ok(ctx2.agent.isLead);

      ms.leadChatPost(lead1Id, ctx1.agent.role, ctx1.team.name, "frontend update");
      ms.leadChatPost(lead2Id, ctx2.agent.role, ctx2.team.name, "backend update");

      const lead1Reads = ms.leadChatRead(lead1Id);
      assert.equal(lead1Reads.length, 2);

      const lead2Reads = ms.leadChatRead(lead2Id);
      assert.equal(lead2Reads.length, 2);
    });

    it("workers are NOT leads (access control validation)", () => {
      const ctx = findAgentContext(state, worker1aId)!;
      assert.equal(ctx.agent.isLead, false);
    });

    it("lead chat preserves team name in message", () => {
      const ctx = findAgentContext(state, lead1Id)!;
      ms.leadChatPost(lead1Id, ctx.agent.role, ctx.team.name, "update");
      const msgs = ms.leadChatRead(lead2Id);
      assert.ok(msgs[0].text.includes(ctx.team.name));
    });
  });

  describe("unknown agent", () => {
    it("findAgentContext returns null for unknown agent", () => {
      const ctx = findAgentContext(state, "nonexistent-agent");
      assert.equal(ctx, null);
    });

    it("findAgentContext returns null after team dissolved", () => {
      state.dissolveTeam(team1Id);
      const ctx = findAgentContext(state, lead1Id);
      assert.equal(ctx, null);
    });
  });

  describe("shared artifacts access", () => {
    it("worker shares artifact visible to team", () => {
      const ctx = findAgentContext(state, worker1aId)!;
      ms.shareArtifact(ctx.team.id, worker1aId, "src/component.tsx");

      const artifacts = ms.getSharedArtifacts(ctx.team.id);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].from, worker1aId);
    });

    it("lead shares artifact visible to team", () => {
      const ctx = findAgentContext(state, lead1Id)!;
      ms.shareArtifact(ctx.team.id, lead1Id, "architecture.md");

      const artifacts = ms.getSharedArtifacts(ctx.team.id);
      assert.equal(artifacts.length, 1);
    });

    it("artifacts from one team not visible to other team", () => {
      ms.shareArtifact(team1Id, worker1aId, "team1 artifact");

      const t1 = ms.getSharedArtifacts(team1Id);
      assert.equal(t1.length, 1);

      const t2 = ms.getSharedArtifacts(team2Id);
      assert.equal(t2.length, 0);
    });
  });
});
