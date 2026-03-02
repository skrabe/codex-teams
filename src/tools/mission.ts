import crypto from "node:crypto";
import { exec } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";
import type { CodexClientManager } from "../codex-client.js";
import type { Message, MessageSystem } from "../messages.js";
import type { Agent, Team } from "../types.js";
import { withTimeout, WORKER_TIMEOUT_MS, toolError, toolJson } from "../tool-utils.js";

type MissionPhase = "executing" | "verifying" | "fixing" | "reviewing" | "completed" | "error";

interface WorkerResult {
  agentId: string;
  role: string;
  status: "success" | "error";
  output: string;
}

interface VerificationAttempt {
  attempt: number;
  passed: boolean;
  output: string;
}

interface MissionState {
  id: string;
  objective: string;
  teamId: string;
  teamName: string;
  phase: MissionPhase;
  leadId: string;
  workerIds: string[];
  workerResults: WorkerResult[];
  verifyCommand?: string;
  maxVerifyRetries: number;
  verificationLog: VerificationAttempt[];
  finalReport: string;
  error?: string;
  comms?: {
    groupChat: Message[];
    dms: Message[];
    leadChat: Message[];
    sharedArtifacts: Array<{ from: string; data: string; timestamp: Date }>;
  };
}

const missions = new Map<string, MissionState>();

function buildLeadPrompt(mission: MissionState, team: Team, workers: Agent[], lead: Agent): string {
  const workerList = workers
    .map((w) => `  - @${w.id} (${w.role}${w.specialization ? " — " + w.specialization : ""})`)
    .join("\n");

  return `=== YOU ARE THE TEAM LEAD ===

=== MISSION OBJECTIVE ===
${mission.objective}

=== YOUR WORKERS ===
${workerList}

=== WHAT TO DO RIGHT NOW ===
Your workers are starting up now. They will read group_chat and begin exploring immediately.
Your job is to align quickly, then keep execution moving.

1. KICK OFF WITH A PLAN
   Post one clear kickoff message in group_chat with:
   - Problem breakdown: what needs to happen and why
   - Approach: how the work divides, what each worker owns, where pieces connect
   - Dependencies, interfaces, and key risks
   - Concrete assignments per worker based on their role/specialization
   End with: "Raise concrete concerns or blockers now, otherwise execute."
   Do not ask for acknowledgements.

2. HANDLE OBJECTIONS AND GO
   If workers raise material concerns, adapt and close the decision quickly.
   Do not wait for explicit agreement from everyone. Silence means execute.
   Aim for alignment, not endless consensus.

3. DURING EXECUTION
   - Resolve ambiguity, blockers, and conflicts fast.
   - Connect workers who need to coordinate.
   - Use group_chat for decisions/risks that affect multiple workers.
   - Avoid noise and avoid micromanagement.

4. ENCOURAGE PEER INTERACTION
   Workers should coordinate directly with each other.
   Step in when they need a tiebreaker or when a decision affects the whole team.

5. CROSS-TEAM COORDINATION
   If other teams exist, use lead_chat_post/lead_chat_read/lead_chat_peek to coordinate
   with other team leads. Check lead_chat_peek periodically and relay only actionable updates.

You will receive a follow-up message after all workers complete, asking you to compile a final report.

Follow the work methodology in your base instructions.

Your agent ID: ${lead.id}
Team ID: ${team.id}`;
}

function buildWorkerPrompt(
  mission: MissionState,
  team: Team,
  worker: Agent,
  lead: Agent,
  allWorkers: Agent[],
): string {
  const teammateList = allWorkers
    .filter((w) => w.id !== worker.id)
    .map((w) => `  - @${w.id} (${w.role}${w.specialization ? " — " + w.specialization : ""})`)
    .join("\n");

  return `=== YOUR ROLE ===
You are ${worker.id} (${worker.role}${worker.specialization ? " — " + worker.specialization : ""}).
You're a senior engineer on this team — not just a task executor. You think about the problem,
contribute ideas, and help your teammates succeed.

=== MISSION OBJECTIVE ===
${mission.objective}

=== YOUR TEAM ===
Lead: @${lead.id} (${lead.role})
Teammates:
${teammateList || "  (none — you are the only worker)"}

=== WHAT TO DO RIGHT NOW ===

1. GET THE PLAN
   Call group_chat_read for the lead's plan. The lead (@${lead.id}) will post assignments.
   While waiting, start exploring the codebase to build context.
   When the plan appears: if you see a problem or have context that changes the approach,
   speak up with specifics. If it looks right, execute — do not post just to agree.

   If the lead has not posted yet, share only material findings that affect planning.

2. EXECUTE WITH CONFIDENCE
   You're a senior engineer. Own your piece. Make decisions within your scope without asking permission.
   Stay aware of interfaces and integration points with others.

3. COMMUNICATE AT BOUNDARIES
   Post to group_chat when:
   - You discover something that changes a teammate's approach
   - You make or need a decision with team impact
   - You find a risk that affects delivery or integration
   - You are blocked and need a specific person to respond
   DM when it affects one person specifically.

   Use share() for structured evidence/artifacts. Reference them briefly in chat — don't duplicate.
   Use get_shared() before duplicating work.
   When a teammate's message relates to your work, respond with substance.
   Do not send acknowledgment-only messages.

4. HELP YOUR TEAMMATES AND WRAP UP
   - Answer questions if you know the answer — don't wait for the lead.
   - If you finish early, offer targeted help.
   - share() your final deliverable with outcomes, key decisions, and gotchas.
   - Check if your work integrates with teammates' work before declaring done.

Stay responsive: peek for messages frequently (after each atomic step of work). A teammate
may need you right now. Full communication guidelines are in your base instructions.

Your agent ID: ${worker.id}
Team ID: ${team.id}`;
}

function buildCompilationPrompt(
  mission: MissionState,
  workerResults: WorkerResult[],
  verificationOutput?: string,
): string {
  const resultsSummary = workerResults
    .map((r) => `--- ${r.agentId} (${r.role}) — ${r.status.toUpperCase()} ---\n${r.output}`)
    .join("\n\n");

  let verificationSection = "";
  if (verificationOutput !== undefined) {
    verificationSection = `\n=== VERIFICATION RESULTS ===\n${verificationOutput}\n`;
  }

  return `=== MISSION COMPILATION ===
All workers have completed their tasks. It's time to compile the final report.

=== MISSION OBJECTIVE ===
${mission.objective}

=== WORKER RESULTS ===
${resultsSummary}
${verificationSection}
=== WHAT TO DO NOW ===
1. Call group_chat_read to see the full conversation history.
2. Call get_shared to review all shared artifacts and deliverables.
3. Write a structured FINAL REPORT with:
   - Mission objective (1 line)
   - Key findings and conclusions — synthesize across workers, don't just list per-worker summaries
   - Important decisions made and their rationale
   - Actionable recommendations or deliverables
   - Remaining work or known issues (if any)${verificationOutput !== undefined ? "\n   - Verification results and status" : ""}

   IMPORTANT: Write for the person who commissioned this work — they want outcomes and prioritized
   recommendations, not a narrative of what each worker did.
   Reference shared artifacts by name/title rather than repeating their full content inline.
   The reader has access to the raw artifacts and comms via get_mission_comms — your report should
   synthesize and prioritize, not rehash everything. Focus on what matters most and why.`;
}

function buildFixPrompt(
  mission: MissionState,
  verifyOutput: string,
  attempt: number,
  maxRetries: number,
): string {
  const workerList = mission.workerIds.map((id) => `  - ${id}`).join("\n");

  return `=== VERIFICATION FAILED (attempt ${attempt}/${maxRetries}) ===

The verification command failed with the following output:

---
${verifyOutput}
---

=== YOUR WORKERS ===
${workerList}

Review the errors above and assign fix tasks to your workers. Respond with a JSON array of assignments:
[{"agentId": "worker-id", "task": "Detailed description of what to fix"}]

Only output the JSON array, nothing else. If you believe the errors are unfixable, respond with an empty array: []`;
}

function runVerifyCommand(command: string, cwd: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 600_000 }, (error, stdout, stderr) => {
      const output = (stdout + "\n" + stderr).trim();
      resolve({ passed: !error, output });
    });
  });
}

async function runMission(
  mission: MissionState,
  team: Team,
  codex: CodexClientManager,
  state: TeamManager,
  messages: MessageSystem,
): Promise<void> {
  const lead = team.agents.get(mission.leadId)!;
  const workers = mission.workerIds.map((id) => team.agents.get(id)!).filter(Boolean);

  try {
    mission.phase = "executing";

    const leadPrompt = buildLeadPrompt(mission, team, workers, lead);
    const leadPromise = withTimeout(
      (signal) => codex.sendToAgent(lead, leadPrompt, signal),
      WORKER_TIMEOUT_MS,
      `Lead ${lead.id}`,
    );

    const workerPromises = workers.map((worker) => {
      const workerPrompt = buildWorkerPrompt(mission, team, worker, lead, workers);
      return withTimeout((signal) => codex.sendToAgent(worker, workerPrompt, signal), WORKER_TIMEOUT_MS, `Worker ${worker.id}`)
        .then((output) => ({
          agentId: worker.id,
          role: worker.role,
          status: "success" as const,
          output,
        }))
        .catch((err) => ({
          agentId: worker.id,
          role: worker.role,
          status: "error" as const,
          output: err instanceof Error ? err.message : String(err),
        }));
    });

    const workerResults = await Promise.all(workerPromises);
    mission.workerResults = workerResults;

    await leadPromise.catch(() => {});

    if (mission.verifyCommand) {
      mission.phase = "verifying";
      let lastVerifyOutput = "";

      for (let attempt = 1; attempt <= mission.maxVerifyRetries + 1; attempt++) {
        const verification = await runVerifyCommand(mission.verifyCommand, lead.cwd);
        mission.verificationLog.push({
          attempt,
          passed: verification.passed,
          output: verification.output,
        });
        lastVerifyOutput = verification.output;

        if (verification.passed) break;

        if (attempt <= mission.maxVerifyRetries) {
          mission.phase = "fixing";
          const fixPrompt = buildFixPrompt(mission, verification.output, attempt, mission.maxVerifyRetries);
          const fixResponse = await codex.sendToAgent(lead, fixPrompt);

          let fixAssignments: Array<{ agentId: string; task: string }> = [];
          try {
            const jsonMatch = fixResponse.match(/\[[\s\S]*\]/);
            fixAssignments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          } catch (e) {
            console.error(`Failed to parse fix assignments: ${e}`);
          }
          fixAssignments = fixAssignments.filter((a) => mission.workerIds.includes(a.agentId));

          if (fixAssignments.length > 0) {
            const fixResults = await Promise.allSettled(
              fixAssignments.map(({ agentId, task }) => {
                const worker = team.agents.get(agentId);
                if (!worker) return Promise.reject(new Error(`Agent not found: ${agentId}`));
                return codex.sendToAgent(worker, task);
              }),
            );

            for (let i = 0; i < fixAssignments.length; i++) {
              const r = fixResults[i];
              const existing = mission.workerResults.find((wr) => wr.agentId === fixAssignments[i].agentId);
              if (existing) {
                existing.status = r.status === "fulfilled" ? "success" : "error";
                existing.output =
                  r.status === "fulfilled"
                    ? (r.value as string)
                    : r.reason instanceof Error
                      ? r.reason.message
                      : String(r.reason);
              }
            }
          }

          mission.phase = "verifying";
        }
      }

      mission.phase = "reviewing";
      const lastVerification = mission.verificationLog[mission.verificationLog.length - 1];
      const compilationPrompt = buildCompilationPrompt(
        mission,
        mission.workerResults,
        `${lastVerification.passed ? "PASSED" : "FAILED"}\n${lastVerifyOutput}`,
      );
      mission.finalReport = await codex.sendToAgent(lead, compilationPrompt);
    } else {
      mission.phase = "reviewing";
      const compilationPrompt = buildCompilationPrompt(mission, mission.workerResults);
      mission.finalReport = await codex.sendToAgent(lead, compilationPrompt);
    }

    mission.phase = "completed";
  } catch (error) {
    mission.phase = "error";
    mission.error = error instanceof Error ? error.message : String(error);
  } finally {
    const agentIds = [mission.leadId, ...mission.workerIds];
    mission.comms = {
      groupChat: messages.getTeamChatMessages(mission.teamId),
      dms: messages.getAllDmMessages(agentIds),
      leadChat: messages.getLeadChatMessages(agentIds),
      sharedArtifacts: messages.getSharedArtifacts(mission.teamId),
    };
    messages.dissolveTeamWithAgents(mission.teamId, agentIds);
    state.dissolveTeam(mission.teamId);

    setTimeout(() => missions.delete(mission.id), 30 * 60 * 1000).unref();
  }
}

function waitForMission(missionId: string, pollMs = 3000, timeoutMs = 3600000): Promise<MissionState> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const mission = missions.get(missionId);
      if (!mission) return reject(new Error(`Mission not found: ${missionId}`));
      if (mission.phase === "completed" || mission.phase === "error") return resolve(mission);
      if (Date.now() - start > timeoutMs) return reject(new Error("await_mission timeout"));
      setTimeout(check, pollMs);
    };
    check();
  });
}

export function registerMissionTools(
  server: McpServer,
  state: TeamManager,
  codex: CodexClientManager,
  messages: MessageSystem,
) {
  server.registerTool(
    "launch_mission",
    {
      description:
        "Launch a fully async mission. All agents (lead + workers) start simultaneously and communicate via group chat and DMs. The lead assigns tasks, workers execute autonomously. Returns a missionId immediately.",
      inputSchema: {
        objective: z.string().describe("Mission objective"),
        workDir: z.string().describe("Working directory"),
        team: z
          .array(
            z.object({
              role: z.string().describe("Agent role"),
              specialization: z.string().optional().describe("Agent specialization"),
              isLead: z.boolean().optional().describe("Is this the team lead? Exactly one must be true."),
              sandbox: z
                .enum(["read-only", "workspace-write", "danger-full-access"])
                .optional()
                .describe("Sandbox mode"),
              reasoningEffort: z
                .enum(["xhigh", "high", "medium", "low", "minimal"])
                .optional()
                .describe("Reasoning effort level (default: xhigh for lead, high for workers)"),
            }),
          )
          .describe("Team composition"),
        verifyCommand: z
          .string()
          .optional()
          .describe(
            "Shell command to run after workers complete (e.g. 'npm test'). If it fails, lead assigns fixes and workers retry.",
          ),
        maxVerifyRetries: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Max verification retry attempts (default: 2)"),
      },
    },
    async ({ objective, workDir, team: teamConfigs, verifyCommand, maxVerifyRetries }) => {
      try {
        const leadCount = teamConfigs.filter((t) => t.isLead).length;
        if (leadCount !== 1) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Team must have exactly one lead (isLead: true), got ${leadCount}`,
              },
            ],
          };
        }

        const team = state.createTeam(
          `mission-${crypto.randomUUID().slice(0, 6)}`,
          teamConfigs.map((t) => ({
            role: t.role,
            specialization: t.specialization,
            isLead: t.isLead,
            sandbox: t.sandbox,
            reasoningEffort: t.reasoningEffort,
            cwd: workDir,
          })),
        );

        const agents = Array.from(team.agents.values());
        const lead = agents.find((a) => a.isLead);
        if (!lead) {
          return { isError: true, content: [{ type: "text" as const, text: "Failed to create lead agent" }] };
        }

        const missionId = crypto.randomUUID();
        const mission: MissionState = {
          id: missionId,
          objective,
          teamId: team.id,
          teamName: team.name,
          phase: "executing",
          leadId: lead.id,
          workerIds: agents.filter((a) => !a.isLead).map((a) => a.id),
          workerResults: [],
          verifyCommand,
          maxVerifyRetries: maxVerifyRetries ?? 2,
          verificationLog: [],
          finalReport: "",
        };

        missions.set(missionId, mission);

        const missionOp = runMission(mission, team, codex, state, messages).catch((err) => {
          mission.phase = "error";
          mission.error = err instanceof Error ? err.message : String(err);
        });
        codex.trackOp(missionOp);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  missionId,
                  teamId: team.id,
                  leadId: lead.id,
                  workerIds: mission.workerIds,
                  status: "launched",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`launch_mission error: ${msg}`);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "mission_status",
    {
      description: "Check the status of a launched mission",
      inputSchema: {
        missionId: z.string().describe("Mission ID returned by launch_mission"),
      },
    },
    async ({ missionId }) => {
      const mission = missions.get(missionId);
      if (!mission) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Mission not found: ${missionId}` }],
        };
      }

      return toolJson({
        missionId: mission.id,
        phase: mission.phase,
        teamId: mission.teamId,
        leadId: mission.leadId,
        workerIds: mission.workerIds,
        finalReport: mission.finalReport || undefined,
        error: mission.error,
      });
    },
  );

  server.registerTool(
    "await_mission",
    {
      description:
        "Block until a mission completes (or errors). Returns the lead's final report. Use get_mission_comms for raw communication logs.",
      inputSchema: {
        missionId: z.string().describe("Mission ID returned by launch_mission"),
        pollIntervalMs: z.number().optional().describe("Poll interval in ms (default: 3000)"),
        timeoutMs: z.number().optional().describe("Timeout in ms (default: 3600000 = 60min)"),
      },
    },
    async ({ missionId, pollIntervalMs, timeoutMs }) => {
      try {
        const mission = await waitForMission(missionId, pollIntervalMs ?? 3000, timeoutMs ?? 3600000);

        return toolJson({
          missionId: mission.id,
          phase: mission.phase,
          finalReport: mission.finalReport,
          error: mission.error,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );

  server.registerTool(
    "get_mission_comms",
    {
      description:
        "Get communication logs and raw worker outputs for a completed mission. Available for 30 minutes after mission completion. Use get_team_comms instead for active (in-progress) teams.",
      inputSchema: {
        missionId: z.string().describe("Mission ID returned by launch_mission"),
      },
    },
    async ({ missionId }) => {
      const mission = missions.get(missionId);
      if (!mission) return toolError(`Mission not found: ${missionId}`);
      if (!mission.comms)
        return toolError(
          `Mission ${missionId} has not completed yet — use get_team_comms with teamId instead`,
        );

      const formatMsg = (m: Message) => ({
        from: `${m.fromRole} (${m.from})`,
        text: m.text,
        time: m.timestamp.toISOString(),
      });

      return toolJson({
        missionId: mission.id,
        phase: mission.phase,
        groupChat: mission.comms.groupChat.map(formatMsg),
        dms: mission.comms.dms.map(formatMsg),
        leadChat: mission.comms.leadChat.map(formatMsg),
        sharedArtifacts: mission.comms.sharedArtifacts.map((a) => ({
          from: a.from,
          data: a.data,
          time: a.timestamp.toISOString(),
        })),
        workerResults: mission.workerResults,
        verificationLog: mission.verificationLog,
      });
    },
  );

  server.registerTool(
    "get_team_comms",
    {
      description:
        "View all communication for a team: group chat messages, DMs between agents, lead chat, and shared artifacts. Use this to see what agents said to each other.",
      inputSchema: {
        teamId: z.string().describe("Team ID"),
      },
    },
    async ({ teamId }) => {
      const team = state.listTeams().find((t) => t.id === teamId);
      if (!team) {
        return { isError: true, content: [{ type: "text" as const, text: `Team not found: ${teamId}` }] };
      }

      const agentIds = Array.from(team.agents.values()).map((a) => a.id);

      const comms = {
        groupChat: messages.getTeamChatMessages(teamId).map((m) => ({
          from: `${m.fromRole} (${m.from})`,
          text: m.text,
          time: m.timestamp.toISOString(),
        })),
        dms: messages.getAllDmMessages(agentIds).map((m) => ({
          from: `${m.fromRole} (${m.from})`,
          text: m.text,
          time: m.timestamp.toISOString(),
        })),
        leadChat: messages.getLeadChatMessages(agentIds).map((m) => ({
          from: `${m.fromRole} (${m.from})`,
          text: m.text,
          time: m.timestamp.toISOString(),
        })),
        sharedArtifacts: messages.getSharedArtifacts(teamId).map((a) => ({
          from: a.from,
          data: a.data,
          time: a.timestamp.toISOString(),
        })),
      };

      const totalMessages = comms.groupChat.length + comms.dms.length + comms.leadChat.length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                teamId,
                teamName: team.name,
                totalMessages,
                sharedArtifactCount: comms.sharedArtifacts.length,
                ...comms,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

export { buildLeadPrompt, buildWorkerPrompt, buildCompilationPrompt, buildFixPrompt, runVerifyCommand };
export type { MissionState, WorkerResult, VerificationAttempt };
