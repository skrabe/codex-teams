import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";

describe("buildInstructions", () => {
  let state: TeamManager;

  beforeEach(() => {
    state = new TeamManager();
  });

  it("includes agent identity section", () => {
    const team = state.createTeam("test-team", [{ role: "developer", specialization: "React components" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(instr.includes("=== IDENTITY ==="));
    assert.ok(instr.includes(`Agent ID: ${agent.id}`));
    assert.ok(instr.includes("Role: developer"));
    assert.ok(instr.includes("Specialization: React components"));
    assert.ok(instr.includes("Team Member"));
  });

  it("marks leads as TEAM LEAD", () => {
    const team = state.createTeam("test-team", [
      { role: "architect", isLead: true, specialization: "System design" },
    ]);
    const lead = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(lead, team.id);

    assert.ok(instr.includes("TEAM LEAD"));
    assert.ok(!instr.includes("Status: Team Member"));
  });

  it("lists all teammates", () => {
    const team = state.createTeam("full-team", [
      { role: "lead", isLead: true },
      { role: "dev-a", specialization: "Frontend" },
      { role: "dev-b", specialization: "Backend" },
    ]);
    const agents = Array.from(team.agents.values());
    const devA = agents.find((a) => a.role === "dev-a")!;
    const instr = state.buildInstructions(devA, team.id);

    assert.ok(instr.includes(`=== YOUR TEAM: "full-team" ===`));
    for (const a of agents) {
      assert.ok(instr.includes(a.id), `Should include agent ${a.id}`);
      assert.ok(instr.includes(a.role), `Should include role ${a.role}`);
    }

    assert.ok(instr.includes("(you)"));
    assert.ok(instr.includes("[LEAD]"));
  });

  it("includes other teams section for leads", () => {
    const team1 = state.createTeam("frontend", [{ role: "fe-lead", isLead: true }]);
    const team2 = state.createTeam("backend", [{ role: "be-lead", isLead: true }]);

    const feLead = Array.from(team1.agents.values())[0];
    const instr = state.buildInstructions(feLead, team1.id);

    assert.ok(instr.includes("=== OTHER TEAMS ==="));
    assert.ok(instr.includes('"backend"'));
    const beLead = Array.from(team2.agents.values())[0];
    assert.ok(instr.includes(beLead.id));
  });

  it("does NOT include other teams section for workers", () => {
    state.createTeam("frontend", [{ role: "fe-lead", isLead: true }, { role: "fe-dev" }]);
    state.createTeam("backend", [{ role: "be-lead", isLead: true }]);

    const team1 = state.listTeams()[0];
    const worker = Array.from(team1.agents.values()).find((a) => !a.isLead)!;
    const instr = state.buildInstructions(worker, team1.id);

    assert.ok(!instr.includes("=== OTHER TEAMS ==="));
  });

  it("includes communication tools documentation", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(instr.includes("=== COMMUNICATION ==="));
    assert.ok(instr.includes("group_chat_post"));
    assert.ok(instr.includes("group_chat_read"));
    assert.ok(instr.includes("group_chat_peek"));
    assert.ok(instr.includes("dm_send"));
    assert.ok(instr.includes("dm_read"));
    assert.ok(instr.includes("dm_peek"));
    assert.ok(instr.includes("share("));
    assert.ok(instr.includes("get_shared("));
  });

  it("includes lead chat tools only for leads", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "worker" }]);
    const agents = Array.from(team.agents.values());
    const lead = agents.find((a) => a.isLead)!;
    const worker = agents.find((a) => !a.isLead)!;

    const leadInstr = state.buildInstructions(lead, team.id);
    assert.ok(leadInstr.includes("lead_chat_post"));
    assert.ok(leadInstr.includes("lead_chat_read"));
    assert.ok(leadInstr.includes("lead_chat_peek"));

    const workerInstr = state.buildInstructions(worker, team.id);
    assert.ok(!workerInstr.includes("lead_chat_post"));
    assert.ok(!workerInstr.includes("lead_chat_read"));
    assert.ok(!workerInstr.includes("lead_chat_peek"));
  });

  it("includes agent ID for tool calls", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(instr.includes(`Your agent ID for all tool calls: ${agent.id}`));
  });

  it("includes workflow rules", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(instr.includes("=== HOW YOU WORK ==="));
    assert.ok(instr.includes("senior engineer"));
    assert.ok(instr.includes("--- RULES ---"));
    assert.ok(instr.includes("group_chat"));
    assert.ok(instr.includes("dm_peek"));
    assert.ok(instr.includes("PLANNING"));
    assert.ok(instr.includes("WORKING OUT LOUD"));
    assert.ok(instr.includes("share()"));
    assert.ok(instr.includes("get_shared"));
    assert.ok(instr.includes("STAYING RESPONSIVE"));
    assert.ok(instr.includes("ANTI-PATTERNS"));
  });

  it("includes LEAD RESPONSIBILITIES for leads", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const lead = Array.from(team.agents.values()).find((a) => a.isLead)!;
    const instr = state.buildInstructions(lead, team.id);

    assert.ok(instr.includes("LEAD RESPONSIBILITIES"));
    assert.ok(instr.includes("lead_chat_post"));
    assert.ok(instr.includes("lead_chat_read"));
    assert.ok(instr.includes("lead_chat_peek"));
  });

  it("does NOT include LEAD RESPONSIBILITIES for workers", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const worker = Array.from(team.agents.values()).find((a) => !a.isLead)!;
    const instr = state.buildInstructions(worker, team.id);

    assert.ok(!instr.includes("LEAD RESPONSIBILITIES"));
    assert.ok(!instr.includes("lead_chat_post"));
  });

  it("includes custom baseInstructions in additional section", () => {
    const team = state.createTeam("t", [
      { role: "dev", baseInstructions: "Focus on TypeScript. Use strict mode." },
    ]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(instr.includes("=== ADDITIONAL INSTRUCTIONS ==="));
    assert.ok(instr.includes("Focus on TypeScript. Use strict mode."));
  });

  it("does NOT include additional section when no custom instructions", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(!instr.includes("=== ADDITIONAL INSTRUCTIONS ==="));
  });

  it("returns basic instructions for unknown teamId", () => {
    const team = state.createTeam("t", [{ role: "dev", baseInstructions: "fallback" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, "nonexistent-team-id");

    assert.equal(instr, "fallback");
  });

  it("shows specialization for teammates", () => {
    const team = state.createTeam("t", [
      { role: "lead", isLead: true, specialization: "Architecture" },
      { role: "dev-a", specialization: "React" },
      { role: "dev-b", specialization: "PostgreSQL" },
    ]);
    const agents = Array.from(team.agents.values());
    const devA = agents.find((a) => a.role === "dev-a")!;
    const instr = state.buildInstructions(devA, team.id);

    assert.ok(instr.includes("Architecture"));
    assert.ok(instr.includes("React"));
    assert.ok(instr.includes("PostgreSQL"));
  });

  it("handles team with no lead", () => {
    const team = state.createTeam("leadless", [{ role: "dev-a" }, { role: "dev-b" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(instr.includes("Team Member"));
    assert.ok(!instr.includes("[LEAD]"));
  });

  it("includes work methodology section", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    assert.ok(instr.includes("=== WORK METHODOLOGY ==="));
    assert.ok(instr.includes("Never assume code exists"));
    assert.ok(instr.includes("Read before proposing edits"));
    assert.ok(instr.includes("Context7 MCP"));
    assert.ok(instr.includes("web search"));
    assert.ok(instr.includes("self-documenting"));
    assert.ok(instr.includes("run the checks and tests"));
  });

  it("generates different instructions for different agents on same team", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const agents = Array.from(team.agents.values());
    const lead = agents.find((a) => a.isLead)!;
    const dev = agents.find((a) => !a.isLead)!;

    const leadInstr = state.buildInstructions(lead, team.id);
    const devInstr = state.buildInstructions(dev, team.id);

    assert.notEqual(leadInstr, devInstr);
    assert.ok(leadInstr.includes("TEAM LEAD"));
    assert.ok(devInstr.includes("Team Member"));
    assert.ok(leadInstr.includes("lead_chat_post"));
    assert.ok(!devInstr.includes("lead_chat_post"));
  });
});
