import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/state.js";

function has(text: string, ...needles: string[]) {
  for (const n of needles) {
    assert.ok(text.includes(n), `Missing: "${n}"`);
  }
}

function lacks(text: string, ...needles: string[]) {
  for (const n of needles) {
    assert.ok(!text.includes(n), `Should not contain: "${n}"`);
  }
}

describe("buildInstructions", () => {
  let state: TeamManager;

  beforeEach(() => {
    state = new TeamManager();
  });

  it("includes agent identity section", () => {
    const team = state.createTeam("test-team", [{ role: "developer", specialization: "React components" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    has(instr, "=== IDENTITY ===", `Agent ID: ${agent.id}`, "Role: developer", "Specialization: React components", "Team Member");
  });

  it("marks leads as TEAM LEAD", () => {
    const team = state.createTeam("test-team", [
      { role: "architect", isLead: true, specialization: "System design" },
    ]);
    const lead = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(lead, team.id);

    has(instr, "TEAM LEAD");
    lacks(instr, "Status: Team Member");
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

    has(instr, `=== YOUR TEAM: "full-team" ===`, "(you)", "[LEAD]");
    for (const a of agents) {
      has(instr, a.id, a.role);
    }
  });

  it("includes other teams section for leads", () => {
    const team1 = state.createTeam("frontend", [{ role: "fe-lead", isLead: true }]);
    const team2 = state.createTeam("backend", [{ role: "be-lead", isLead: true }]);

    const feLead = Array.from(team1.agents.values())[0];
    const beLead = Array.from(team2.agents.values())[0];
    const instr = state.buildInstructions(feLead, team1.id);

    has(instr, "=== OTHER TEAMS ===", '"backend"', beLead.id);
  });

  it("does NOT include other teams section for workers", () => {
    state.createTeam("frontend", [{ role: "fe-lead", isLead: true }, { role: "fe-dev" }]);
    state.createTeam("backend", [{ role: "be-lead", isLead: true }]);

    const team1 = state.listTeams()[0];
    const worker = Array.from(team1.agents.values()).find((a) => !a.isLead)!;
    const instr = state.buildInstructions(worker, team1.id);

    lacks(instr, "=== OTHER TEAMS ===");
  });

  it("includes comms tools documentation", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    has(instr,
      "=== COMMS TOOLS ===",
      "group_chat_post", "group_chat_read", "group_chat_peek",
      "dm_send", "dm_read", "dm_peek",
      "share(", "get_shared(", "wait_for_messages",
    );
  });

  it("includes lead chat tools only for leads", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "worker" }]);
    const agents = Array.from(team.agents.values());
    const lead = agents.find((a) => a.isLead)!;
    const worker = agents.find((a) => !a.isLead)!;

    has(state.buildInstructions(lead, team.id), "lead_chat_post", "lead_chat_read", "lead_chat_peek");
    lacks(state.buildInstructions(worker, team.id), "lead_chat_post", "lead_chat_read", "lead_chat_peek");
  });

  it("includes agent ID in identity section", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];

    has(state.buildInstructions(agent, team.id), `Agent ID: ${agent.id}`);
  });

  it("includes execution, communication, and anti-patterns sections", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    has(instr,
      "=== HOW YOU WORK ===",
      "--- EXECUTION ---", "--- COMMUNICATION ---", "ANTI-PATTERNS",
      "group_chat", "share()", "get_shared", "wait_for_messages",
    );
  });

  it("includes LEAD RESPONSIBILITIES for leads", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const lead = Array.from(team.agents.values()).find((a) => a.isLead)!;

    has(state.buildInstructions(lead, team.id), "LEAD RESPONSIBILITIES", "lead_chat_post", "lead_chat_read", "lead_chat_peek");
  });

  it("does NOT include LEAD RESPONSIBILITIES for workers", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const worker = Array.from(team.agents.values()).find((a) => !a.isLead)!;

    lacks(state.buildInstructions(worker, team.id), "LEAD RESPONSIBILITIES", "lead_chat_post");
  });

  it("includes custom baseInstructions in additional section", () => {
    const team = state.createTeam("t", [
      { role: "dev", baseInstructions: "Focus on TypeScript. Use strict mode." },
    ]);
    const agent = Array.from(team.agents.values())[0];

    has(state.buildInstructions(agent, team.id), "=== ADDITIONAL INSTRUCTIONS ===", "Focus on TypeScript. Use strict mode.");
  });

  it("does NOT include additional section when no custom instructions", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];

    lacks(state.buildInstructions(agent, team.id), "=== ADDITIONAL INSTRUCTIONS ===");
  });

  it("returns basic instructions for unknown teamId", () => {
    const team = state.createTeam("t", [{ role: "dev", baseInstructions: "fallback" }]);
    const agent = Array.from(team.agents.values())[0];

    assert.equal(state.buildInstructions(agent, "nonexistent-team-id"), "fallback");
  });

  it("shows specialization for teammates", () => {
    const team = state.createTeam("t", [
      { role: "lead", isLead: true, specialization: "Architecture" },
      { role: "dev-a", specialization: "React" },
      { role: "dev-b", specialization: "PostgreSQL" },
    ]);
    const devA = Array.from(team.agents.values()).find((a) => a.role === "dev-a")!;

    has(state.buildInstructions(devA, team.id), "Architecture", "React", "PostgreSQL");
  });

  it("handles team with no lead", () => {
    const team = state.createTeam("leadless", [{ role: "dev-a" }, { role: "dev-b" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    has(instr, "Team Member");
    lacks(instr, "[LEAD]");
  });

  it("includes code quality and constraints sections", () => {
    const team = state.createTeam("t", [{ role: "dev" }]);
    const agent = Array.from(team.agents.values())[0];
    const instr = state.buildInstructions(agent, team.id);

    has(instr,
      "--- CODE QUALITY ---", "reading files first", "Read before proposing edits",
      "Context7 MCP", "web search", "self-documenting", "--- CONSTRAINTS ---",
    );
  });

  it("generates different instructions for different agents on same team", () => {
    const team = state.createTeam("t", [{ role: "lead", isLead: true }, { role: "dev" }]);
    const agents = Array.from(team.agents.values());
    const lead = agents.find((a) => a.isLead)!;
    const dev = agents.find((a) => !a.isLead)!;

    const leadInstr = state.buildInstructions(lead, team.id);
    const devInstr = state.buildInstructions(dev, team.id);

    assert.notEqual(leadInstr, devInstr);
    has(leadInstr, "TEAM LEAD", "lead_chat_post");
    has(devInstr, "Team Member");
    lacks(devInstr, "lead_chat_post");
  });
});
