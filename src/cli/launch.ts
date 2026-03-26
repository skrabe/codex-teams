import type { Command } from "commander";
import { TeamManager } from "../state.js";
import { CodexClientManager } from "../codex-client.js";
import { MessageSystem } from "../messages.js";
import { startCommsServer } from "../comms-server.js";
import { createMission, runMission } from "../mission.js";
import { writeMissionState, removeMissionState } from "./state-file.js";

export function registerLaunchCommand(program: Command): void {
  program
    .command("launch")
    .description("Launch a coordinated mission with a lead + workers")
    .requiredOption("--objective <text>", "Mission objective")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--lead <role>", "Lead agent role", "Lead")
    .option("--worker <roles...>", "Worker agent roles (repeatable)")
    .option("--verify <command>", "Shell command to verify after completion (e.g. 'npm test')")
    .option("--max-retries <n>", "Max verification retry attempts", "2")
    .option("--sandbox <mode>", "Sandbox mode: plan-mode | workspace-write | danger-full-access", "workspace-write")
    .option("--reasoning <effort>", "Reasoning effort: xhigh | high | medium | low | minimal")
    .option("--fast", "Enable fast output mode (service_tier=fast)")
    .option("--team-json <json>", "Full team config as JSON (overrides --lead/--worker)")
    .action(async (opts) => {
      const state = new TeamManager();
      const messages = new MessageSystem();
      const codex = new CodexClientManager();

      let httpServer: ReturnType<typeof startCommsServer> extends Promise<infer T> ? T : never;

      try {
        await codex.connect();
        httpServer = await startCommsServer(messages, state, codex);
        codex.setCommsPort(httpServer.port);
        codex.setStateManager(state);

        let teamConfig: Array<{
          role: string;
          specialization?: string;
          isLead?: boolean;
          sandbox?: "plan-mode" | "workspace-write" | "danger-full-access";
          reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal";
          fastMode?: boolean;
        }>;

        if (opts.teamJson) {
          teamConfig = JSON.parse(opts.teamJson);
        } else {
          const workers = (opts.worker ?? []) as string[];
          if (workers.length === 0) {
            console.error("Error: At least one --worker is required (or use --team-json)");
            process.exit(1);
          }
          teamConfig = [
            {
              role: opts.lead,
              isLead: true,
              sandbox: opts.sandbox,
              reasoningEffort: opts.reasoning,
              fastMode: opts.fast ?? false,
            },
            ...workers.map((role: string) => ({
              role,
              isLead: false,
              sandbox: opts.sandbox,
              reasoningEffort: opts.reasoning,
              fastMode: opts.fast ?? false,
            })),
          ];
        }

        const { mission, team } = createMission(
          {
            objective: opts.objective,
            workDir: opts.workDir,
            team: teamConfig,
            verifyCommand: opts.verify,
            maxVerifyRetries: parseInt(opts.maxRetries, 10),
          },
          state,
        );

        writeMissionState(mission.id, {
          missionId: mission.id,
          teamId: team.id,
          leadId: mission.leadId,
          workerIds: mission.workerIds,
          phase: mission.phase,
          commsPort: httpServer.port,
          pid: process.pid,
        });

        console.error(`codex-teams: mission ${mission.id} launched`);
        console.error(`codex-teams: team ${team.id} — lead: ${mission.leadId}, workers: ${mission.workerIds.join(", ")}`);

        await runMission(mission, team, codex, state, messages, (p) => {
          console.error(`codex-teams: [${p.phase}] ${p.detail ?? ""}`);
          writeMissionState(mission.id, {
            missionId: mission.id,
            teamId: team.id,
            leadId: mission.leadId,
            workerIds: mission.workerIds,
            phase: p.phase,
            commsPort: httpServer.port,
            pid: process.pid,
          });
        });

        const formatMsg = (m: { from: string; fromRole: string; text: string; timestamp: Date }) => ({
          from: `${m.fromRole} (${m.from})`,
          text: m.text,
          time: m.timestamp.toISOString(),
        });

        const result = {
          missionId: mission.id,
          phase: mission.phase,
          leadOutput: mission.leadOutput || undefined,
          workerResults: mission.workerResults,
          sharedArtifacts: mission.comms?.sharedArtifacts.map((a) => ({
            from: a.from,
            data: a.data,
            time: a.timestamp.toISOString(),
          })),
          verificationLog: mission.verificationLog.length > 0 ? mission.verificationLog : undefined,
          recentChat: mission.comms?.groupChat.slice(-20).map(formatMsg),
          error: mission.error,
        };

        console.log(JSON.stringify(result, null, 2));
        removeMissionState(mission.id);
        process.exit(mission.phase === "completed" ? 0 : 1);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`codex-teams: fatal error: ${msg}`);
        console.log(JSON.stringify({ error: msg }, null, 2));
        process.exit(1);
      } finally {
        // @ts-expect-error httpServer may not be assigned
        if (httpServer) httpServer.httpServer.close();
        await codex.disconnect().catch(() => {});
      }
    });
}
