import crypto from "node:crypto";
import { exec } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeamManager } from "../state.js";
import type { CodexClientManager } from "../codex-client.js";
import type { MessageSystem } from "../messages.js";
import type { Agent, Team } from "../types.js";

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
Your workers are starting up simultaneously alongside you. They will be reading group_chat for their task assignments.

1. POST TASK ASSIGNMENTS IMMEDIATELY via group_chat_post. Address each worker by their ID so they know which task is theirs. Post ALL assignments in a SINGLE message so every worker can see the full task breakdown and knows who is responsible for what. Example format:

   @worker-id-1: [Detailed task description, expected deliverables, files to modify]
   @worker-id-2: [Detailed task description, expected deliverables, files to modify]

2. MONITOR PROGRESS: After posting assignments, periodically call group_chat_read and dm_read to track worker progress. Workers will post updates and may DM you with questions or blockers.

3. RESPOND TO EVERY DM PROMPTLY. A blocked worker is a wasted worker. If someone asks a question, answer it. If someone reports a problem, help them solve it.

4. REVIEW SHARED ARTIFACTS: Workers will call share() when they complete deliverables. Use get_shared to review their work.

5. COORDINATE DEPENDENCIES: If worker B needs worker A's output, monitor A's progress and notify B when A shares their deliverable.

6. PROACTIVELY DM WORKERS: Don't wait for workers to come to you. If you notice ambiguity in their task, DM them with clarifications. If one worker's output affects another, DM them both.

7. CHECK DMs CONSTANTLY: After every tool call, call dm_peek and group_chat_peek. If unread > 0, read immediately. Workers may be blocked waiting on your response — every minute you delay is a minute they waste.

8. CROSS-TEAM COORDINATION: If other teams exist, use lead_chat_post/lead_chat_read/lead_chat_peek to communicate with other team leads. Check lead_chat_peek periodically — another lead may need to coordinate with you.

You will receive a follow-up message after all workers have completed their tasks, asking you to compile a final report.

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

  return `=== YOUR ASSIGNMENT ===
You are ${worker.id} (${worker.role}${worker.specialization ? " — " + worker.specialization : ""}).

=== MISSION OBJECTIVE ===
${mission.objective}

=== YOUR TEAM ===
Lead: @${lead.id} (${lead.role})
Teammates:
${teammateList || "  (none — you are the only worker)"}

=== WHAT TO DO RIGHT NOW ===
1. Call group_chat_read to get your task assignment from the lead (@${lead.id}). Look for a message addressing @${worker.id}. READ THE FULL MESSAGE — it contains ALL workers' assignments, so you know who is responsible for what.

2. If no assignment has been posted yet, start by exploring the codebase to understand the project structure. Then check group_chat_read again after a minute.

3. Once you have your assignment, EXECUTE WITH FULL AUTONOMY. You are a senior engineer — bias to action. Don't wait for permission to make decisions within your task scope.

=== COMMUNICATION PROTOCOL ===
- POST PROGRESS to group_chat after every meaningful step ("Completed API endpoint for /users", "Found bug in auth middleware, fixing now").
- DM the lead (@${lead.id}) immediately if you hit a blocker, need clarification, or need a decision that's outside your scope. When in doubt, DM the lead — asking takes seconds, redoing takes hours.
- Before searching for non-trivial information outside your scope, call get_team_context to check if any agent (your team or another) covers that area. Same-team → DM them directly. Other team → DM your lead to relay via lead_chat.
- Follow through on every message. After DMing a question, do NOT proceed as if you have the answer and never abandon your original intent. Work on other independent parts while waiting, keep calling dm_peek, and act on the reply when it arrives.

CRITICAL — CHECK DMs CONSTANTLY:
After EVERY tool call (file read, file write, shell command, anything), call dm_peek and group_chat_peek.
If unread > 0, call dm_read / group_chat_read BEFORE your next action.
Your lead may have sent you a correction, a teammate may need your help, or priorities may have changed.
A missed DM can mean hours of wasted work. Make peek calls a reflexive habit.

=== WHEN YOU FINISH ===
1. Call share() with your deliverable (file paths, summaries, test results).
2. Post "COMPLETED: [one-line summary of what you delivered]" to group_chat.

Follow the work methodology in your base instructions.

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
1. Call group_chat_read to see the full conversation history — worker progress updates, decisions made, issues resolved.
2. Call get_shared to review all shared artifacts and deliverables.
3. Write a structured FINAL REPORT with:
   - Mission objective (1 line)
   - Summary of what was accomplished
   - Per-worker deliverables
   - Any issues encountered and how they were resolved
   - Remaining work or known issues (if any)${verificationOutput !== undefined ? "\n   - Verification results and status" : ""}`;
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
    exec(command, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
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
    const leadPromise = codex.sendToAgent(lead, leadPrompt);

    const workerPromises = workers.map((worker) => {
      const workerPrompt = buildWorkerPrompt(mission, team, worker, lead, workers);
      return codex
        .sendToAgent(worker, workerPrompt)
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
    messages.dissolveTeamWithAgents(mission.teamId, agentIds);
    state.dissolveTeam(mission.teamId);
  }
}

function waitForMission(missionId: string, pollMs = 3000, timeoutMs = 600000): Promise<MissionState> {
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

        runMission(mission, team, codex, state, messages).catch((err) => {
          mission.phase = "error";
          mission.error = err instanceof Error ? err.message : String(err);
        });

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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                missionId: mission.id,
                phase: mission.phase,
                teamId: mission.teamId,
                leadId: mission.leadId,
                workerIds: mission.workerIds,
                workerResults: mission.workerResults,
                verificationLog: mission.verificationLog,
                finalReport: mission.finalReport || undefined,
                error: mission.error,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "await_mission",
    {
      description:
        "Block until a mission completes (or errors). Returns the final result including comms log. Use this from a background agent to avoid polling loops.",
      inputSchema: {
        missionId: z.string().describe("Mission ID returned by launch_mission"),
        pollIntervalMs: z.number().optional().describe("Poll interval in ms (default: 3000)"),
        timeoutMs: z.number().optional().describe("Timeout in ms (default: 600000 = 10min)"),
      },
    },
    async ({ missionId, pollIntervalMs, timeoutMs }) => {
      try {
        const mission = await waitForMission(missionId, pollIntervalMs ?? 3000, timeoutMs ?? 600000);

        const team = state.listTeams().find((t) => t.id === mission.teamId);
        const agentIds = [mission.leadId, ...mission.workerIds];

        const comms = {
          groupChat: team
            ? messages.getTeamChatMessages(team.id).map((m) => ({
                from: `${m.fromRole} (${m.from})`,
                text: m.text,
                time: m.timestamp.toISOString(),
              }))
            : [],
          dms: messages.getAllDmMessages(agentIds).map((m) => ({
            from: `${m.fromRole} (${m.from})`,
            text: m.text,
            time: m.timestamp.toISOString(),
          })),
          leadChat: messages.getLeadChatMessages().map((m) => ({
            from: `${m.fromRole} (${m.from})`,
            text: m.text,
            time: m.timestamp.toISOString(),
          })),
          sharedArtifacts: team
            ? messages.getSharedArtifacts(team.id).map((a) => ({
                from: a.from,
                data: a.data,
                time: a.timestamp.toISOString(),
              }))
            : [],
        };

        missions.delete(missionId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  missionId: mission.id,
                  phase: mission.phase,
                  finalReport: mission.finalReport,
                  error: mission.error,
                  workerResults: mission.workerResults,
                  verificationLog: mission.verificationLog,
                  comms,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
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
        leadChat: messages.getLeadChatMessages().map((m) => ({
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
