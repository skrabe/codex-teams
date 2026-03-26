import crypto from "node:crypto";
import { exec } from "node:child_process";
import type { TeamManager } from "./state.js";
import type { CodexClientManager } from "./codex-client.js";
import type { Message, MessageSystem } from "./messages.js";
import type { Agent, Team } from "./types.js";
import { withTimeout, WORKER_TIMEOUT_MS } from "./tool-utils.js";

export type MissionPhase = "executing" | "verifying" | "fixing" | "completed" | "error";

export interface WorkerResult {
  agentId: string;
  role: string;
  status: "success" | "error";
  output: string;
}

export interface VerificationAttempt {
  attempt: number;
  passed: boolean;
  output: string;
}

export interface MissionState {
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
  leadOutput: string;
  error?: string;
  comms?: {
    groupChat: Message[];
    dms: Message[];
    leadChat: Message[];
    sharedArtifacts: Array<{ from: string; data: string; timestamp: Date }>;
  };
}

const missions = new Map<string, MissionState>();

export function getMission(id: string): MissionState | undefined {
  return missions.get(id);
}

export function listMissions(): MissionState[] {
  return Array.from(missions.values());
}

export function buildLeadPrompt(mission: MissionState, team: Team, workers: Agent[], lead: Agent): string {
  const workerList = workers
    .map((w) => `  - @${w.id} (${w.role}${w.specialization ? " — " + w.specialization : ""})`)
    .join("\n");

  return `=== YOU ARE THE TEAM LEAD ===

=== MISSION OBJECTIVE ===
${mission.objective}

=== YOUR WORKERS ===
${workerList}

=== WHAT TO DO RIGHT NOW ===
Your workers are starting up simultaneously. They will read group_chat for your plan and begin
exploring the codebase immediately. Your job: align the team fast, then execute your own work.

1. KICK OFF WITH A PLAN
   Post one clear kickoff message in group_chat with:
   - Problem breakdown: what needs to happen and why
   - Approach: how the work divides, what each worker owns, where pieces connect
   - Dependencies, interfaces, and key risks
   - Concrete assignments per worker — name each by @agent-id, describe exactly what they own,
     and note where their work connects to others' work
   End with: "Raise concrete concerns or blockers now, otherwise execute."
   Do not ask for acknowledgements. Do not wait for every worker to respond — if no one raises
   a concern within their first message cycle, the plan is accepted.

2. EXECUTE YOUR OWN WORK
   You are a coding lead, not a project manager. After posting the plan, start executing your
   own technical assignments immediately. Check group_chat between your own milestones (after
   completing a file, after a test run).
   When a worker posts a blocker or question, respond immediately with a decision or unblock.
   When two workers need to coordinate, connect them directly — don't relay messages.

3. COORDINATE AND UNBLOCK
   - Resolve ambiguity, blockers, and conflicts fast. Close decision loops in one round.
   - Workers should coordinate directly with each other. Step in only for tie-breaks,
     cross-scope decisions, or when a worker is stuck.
   - Use group_chat for decisions/risks that affect multiple workers. Avoid noise.
   - If other teams exist, use lead_chat to coordinate with other leads.
     Check lead_chat_peek between milestones and relay only actionable updates.

4. VERIFY AND CLOSE
   When workers share deliverables, review their artifacts via get_shared(). Check that
   interfaces between workers' code are compatible. If integration issues exist, flag them
   immediately in group_chat with specifics.
   share() your final assessment: key decisions made, integration status, and any remaining work.

Your agent ID: ${lead.id}
Team ID: ${team.id}`;
}

export function buildWorkerPrompt(
  mission: MissionState,
  _team: Team,
  worker: Agent,
): string {
  return `=== MISSION OBJECTIVE ===
${mission.objective}

=== BOOTSTRAP ===
Call group_chat_read() immediately.
- Plan is there → read your assignment and begin execution.
- No plan yet → start exploring the codebase relevant to the objective. Build context
  for what you'll likely need to do. After initial exploration, call wait_for_messages(15000) to catch the plan.
- Plan arrives → read group_chat, find your assignment, and execute.
If the plan has a material issue with your scope, raise it with specifics in group_chat.
If it looks right, execute — do not post just to agree.

Your agent ID: ${worker.id}
Team ID: ${_team.id}`;
}

export function buildFixPrompt(
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

export function runVerifyCommand(command: string, cwd: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 600_000 }, (error, stdout, stderr) => {
      const output = (stdout + "\n" + stderr).trim();
      resolve({ passed: !error, output });
    });
  });
}

export interface MissionProgress {
  phase: MissionPhase;
  detail?: string;
}

export async function runMission(
  mission: MissionState,
  team: Team,
  codex: CodexClientManager,
  state: TeamManager,
  messages: MessageSystem,
  onProgress?: (p: MissionProgress) => void,
): Promise<void> {
  const lead = team.agents.get(mission.leadId)!;
  const workers = mission.workerIds.map((id) => team.agents.get(id)!).filter(Boolean);

  const report = (phase: MissionPhase, detail?: string) => {
    mission.phase = phase;
    onProgress?.({ phase, detail });
  };

  try {
    report("executing", "Sending prompts to lead and workers");

    const leadPrompt = buildLeadPrompt(mission, team, workers, lead);
    const leadPromise = withTimeout(
      (signal) => codex.sendToAgent(lead, leadPrompt, signal),
      WORKER_TIMEOUT_MS,
      `Lead ${lead.id}`,
    );

    const workerPromises = workers.map((worker) => {
      const workerPrompt = buildWorkerPrompt(mission, team, worker);
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

    report("executing", "Workers done, waiting for lead");

    mission.leadOutput = await leadPromise.catch((err) =>
      err instanceof Error ? err.message : String(err),
    );

    if (mission.verifyCommand) {
      report("verifying", `Running: ${mission.verifyCommand}`);

      for (let attempt = 1; attempt <= mission.maxVerifyRetries + 1; attempt++) {
        const verification = await runVerifyCommand(mission.verifyCommand, lead.cwd);
        mission.verificationLog.push({
          attempt,
          passed: verification.passed,
          output: verification.output,
        });

        if (verification.passed) {
          report("verifying", `Verification passed on attempt ${attempt}`);
          break;
        }

        if (attempt <= mission.maxVerifyRetries) {
          report("fixing", `Attempt ${attempt} failed, assigning fixes`);
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

          if (fixAssignments.length === 0) break;

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

          report("verifying", `Re-verifying after fix attempt ${attempt}`);
        }
      }
    }

    report("completed");
  } catch (error) {
    mission.phase = "error";
    mission.error = error instanceof Error ? error.message : String(error);
    onProgress?.({ phase: "error", detail: mission.error });
  } finally {
    const agentIds = [mission.leadId, ...mission.workerIds];
    mission.comms = {
      groupChat: messages.getTeamChatMessages(mission.teamId),
      dms: messages.getAllDmMessages(agentIds),
      leadChat: messages.getLeadChatMessages(agentIds),
      sharedArtifacts: messages.getSharedArtifacts(mission.teamId),
    };
    messages.dissolveTeamWithAgents(mission.teamId, agentIds);
    for (const id of agentIds) codex.cleanupAgent(id);
    state.dissolveTeam(mission.teamId);

    setTimeout(() => missions.delete(mission.id), 30 * 60 * 1000).unref();
  }
}

export interface LaunchMissionParams {
  objective: string;
  workDir: string;
  team: Array<{
    role: string;
    specialization?: string;
    isLead?: boolean;
    sandbox?: "plan-mode" | "workspace-write" | "danger-full-access";
    reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal";
    fastMode?: boolean;
  }>;
  verifyCommand?: string;
  maxVerifyRetries?: number;
}

export function createMission(
  params: LaunchMissionParams,
  state: TeamManager,
): { mission: MissionState; team: Team } {
  const leadCount = params.team.filter((t) => t.isLead).length;
  if (leadCount !== 1) {
    throw new Error(`Team must have exactly one lead (isLead: true), got ${leadCount}`);
  }

  const team = state.createTeam(
    `mission-${crypto.randomUUID().slice(0, 6)}`,
    params.team.map((t) => ({
      role: t.role,
      specialization: t.specialization,
      isLead: t.isLead,
      sandbox: t.sandbox,
      reasoningEffort: t.reasoningEffort,
      fastMode: t.fastMode,
      cwd: params.workDir,
    })),
  );

  const agents = Array.from(team.agents.values());
  const lead = agents.find((a) => a.isLead);
  if (!lead) throw new Error("Failed to create lead agent");

  const mission: MissionState = {
    id: crypto.randomUUID(),
    objective: params.objective,
    teamId: team.id,
    teamName: team.name,
    phase: "executing",
    leadId: lead.id,
    workerIds: agents.filter((a) => !a.isLead).map((a) => a.id),
    workerResults: [],
    verifyCommand: params.verifyCommand,
    maxVerifyRetries: params.maxVerifyRetries ?? 2,
    verificationLog: [],
    leadOutput: "",
  };

  missions.set(mission.id, mission);
  return { mission, team };
}

export function buildSteerPrompt(directive: string): string {
  return `=== DIRECTION CHANGE FROM ORCHESTRATOR ===

Your previous task has been interrupted. Drop what you were doing and follow the new directive below.

=== NEW DIRECTIVE ===
${directive}

=== WHAT TO DO ===
1. Stop any current work immediately.
2. Read group_chat for context from the direction change.
3. Execute the new directive above.
4. Coordinate with teammates — they received the same redirect.`;
}

export async function steerTeam(
  teamId: string,
  directive: string,
  agentIds: string[] | undefined,
  state: TeamManager,
  codex: CodexClientManager,
  messages: MessageSystem,
): Promise<{ aborted: string[]; steered: string[]; failed: Array<{ agentId: string; error: string }> }> {
  const team = state.getTeam(teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);

  const targets = agentIds
    ? agentIds.map((id) => team.agents.get(id)).filter(Boolean)
    : Array.from(team.agents.values());

  if (targets.length === 0) {
    return { aborted: [], steered: [], failed: [] };
  }

  const targetIds = targets.map((a) => a!.id);
  const aborted = codex.abortTeam(targetIds);
  for (const id of aborted) codex.clearLock(id);

  messages.groupChatPost(teamId, "orchestrator", "Orchestrator", `=== DIRECTION CHANGE ===\n${directive}`);

  const steerPrompt = buildSteerPrompt(directive);
  const results = await Promise.allSettled(
    targets.map((agent) => codex.sendToAgent(agent!, steerPrompt)),
  );

  const steered: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];

  results.forEach((r, i) => {
    const agentId = targets[i]!.id;
    if (r.status === "fulfilled") {
      steered.push(agentId);
    } else {
      failed.push({
        agentId,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  return { aborted, steered, failed };
}
