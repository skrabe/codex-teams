import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { TeamManager } from "../state.js";
import { CodexClientManager } from "../codex-client.js";
import { MessageSystem } from "../messages.js";
import { startCommsServer } from "../comms-server.js";
import { buildTaskBoardSnapshot, createMission, registerMissionPersistence, runMission, serializeMissionState } from "../mission.js";
import { TeamMemoryStore } from "../team-memory.js";
import { writeMissionState, removeMissionState, purgeOrphanedMissions } from "./state-file.js";
import { cleanupMissionRuntime, installRuntimeCleanupHandlers, type RuntimeCleanupContext } from "./runtime-cleanup.js";
import { emitLaunchWarnings } from "./launch-heuristics.js";
import { findGitRoot } from "../worktree.js";

export function registerLaunchCommand(program: Command): void {
  program
    .command("launch")
    .description("Launch a coordinated mission with a lead + workers")
    .requiredOption("--objective <text>", "Mission objective")
    .option("--work-dir <path>", "Working directory", process.cwd())
    .option("--lead <role>", "Lead agent role", "Lead")
    .option("--worker <roles...>", "Worker agent roles (repeatable)")
    .option("--verify <command>", "Shell command to verify after completion (e.g. 'npm test')")
    .option("--verifier <role>", "Run independent verifier agent with the given role name")
    .option("--max-retries <n>", "Max verification retry attempts", "2")
    .option("--sandbox <mode>", "Sandbox mode: plan-mode | workspace-write | danger-full-access", "workspace-write")
    .option("--model <model>", "Codex model", "gpt-5.5")
    .option("--reasoning <effort>", "Reasoning effort: none | minimal | low | medium | high | xhigh", "none")
    .option("--fast", "Enable fast output mode (service_tier=fast)")
    .option("--team-json <json>", "Full team config as JSON (overrides --lead/--worker)")
    .option("--teams-json <json>", "Multiple teams as JSON: [{name, objective?, team:[...]}]")
    .option("--hook-task-created <command>", "Shell command for TaskCreated hook")
    .option("--hook-task-completed <command>", "Shell command for TaskCompleted hook")
    .option("--hook-teammate-idle <command>", "Shell command for TeammateIdle hook")
    .option("--stale-threshold <minutes>", "Auto-reassign tasks stuck in-progress beyond this many minutes (0 to disable)", "15")
    .option("--isolation <mode>", "Agent isolation mode: worktree (each worker gets a git worktree)")
    .option("--symlink-dirs <dirs>", "Comma-separated directories to symlink in worktrees (default: auto-detect)")
    .option("--no-hints", "Suppress launch heuristic warnings")
    .action(async (opts) => {
      const state = new TeamManager();
      const messages = new MessageSystem();
      const codex = new CodexClientManager();

      let httpServer: ReturnType<typeof startCommsServer> extends Promise<infer T> ? T : never;
      let uninstallCleanupHandlers: (() => void) | undefined;
      let cleanupContext: RuntimeCleanupContext | undefined;
      let exitCode = 1;

      try {
        const orphans = purgeOrphanedMissions();
        for (const id of orphans.purged) {
          console.error(`codex-teams: [cleanup] purged orphaned mission ${id}`);
        }

        await codex.connect();

        const memoryRepoRoot = findGitRoot(opts.workDir) ?? path.resolve(opts.workDir);
        const memoryScopeId = createHash("sha256").update(memoryRepoRoot, "utf8").digest("hex").slice(0, 16);
        const memoryBaseDir = path.join(os.homedir(), ".codex-teams", "memory", memoryScopeId);
        const memoryStore = new TeamMemoryStore(memoryBaseDir, { syncModel: "local_repo_scoped" });
        await memoryStore.init();

        httpServer = await startCommsServer(messages, state, codex, memoryStore);
        codex.setCommsPort(httpServer.port);

        const isolationMode = opts.isolation as "worktree" | undefined;
        const symlinkDirs = opts.symlinkDirs ? (opts.symlinkDirs as string).split(",").map((d: string) => d.trim()) : undefined;

        if (opts.teamsJson && opts.teamJson) {
          throw new Error("Use either --teams-json or --team-json, not both");
        }

        const hookCommands = {
          taskCreated: opts.hookTaskCreated as string | undefined,
          taskCompleted: opts.hookTaskCompleted as string | undefined,
          teammateIdle: opts.hookTeammateIdle as string | undefined,
        };
        const hasHooks = Object.values(hookCommands).some(Boolean);

        const formatMsg = (m: { from: string; fromRole: string; text: string; timestamp: Date }) => ({
          from: `${m.fromRole} (${m.from})`,
          text: m.text,
          time: m.timestamp.toISOString(),
        });

        if (opts.teamsJson) {
          const teamSpecs = JSON.parse(opts.teamsJson) as Array<{
            name?: string;
            objective?: string;
            team: Array<{
              role: string;
              specialization?: string;
              isLead?: boolean;
              sandbox?: "plan-mode" | "workspace-write" | "danger-full-access";
              model?: string;
              reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
              fastMode?: boolean;
              isolation?: "worktree";
              symlinkDirs?: string[];
            }>;
          }>;
          if (!Array.isArray(teamSpecs) || teamSpecs.length === 0) {
            throw new Error("--teams-json must be a non-empty array");
          }

          for (const spec of teamSpecs) {
            if (opts.hints !== false) {
              const warnings = emitLaunchWarnings({
                team: spec.team,
                verify: opts.verify,
                verifier: opts.verifier,
              });
              for (const warning of warnings) {
                console.error(`codex-teams: [hint] ${spec.name ? `${spec.name}: ` : ""}${warning}`);
              }
            }
          }

          const runs = teamSpecs.map((spec, index) => {
            const { mission, team } = createMission(
              {
                objective: spec.objective ?? opts.objective,
                workDir: opts.workDir,
                teamName: spec.name,
                team: spec.team.map((member) => ({
                  ...member,
                  model: member.model ?? opts.model,
                  sandbox: member.sandbox ?? opts.sandbox,
                  reasoningEffort: member.reasoningEffort ?? opts.reasoning,
                  fastMode: member.fastMode ?? (opts.fast ?? false),
                  approvalPolicy: member.isLead ? "never" : "on-request",
                })),
                hooks: hasHooks ? hookCommands : undefined,
                verifyCommand: opts.verify,
                verifierRole: opts.verifier as string | undefined,
                maxVerifyRetries: parseInt(opts.maxRetries, 10),
                staleThresholdMs: parseInt(opts.staleThreshold, 10) * 60_000 || undefined,
              },
              state,
            );

            registerMissionPersistence(mission, (snapshot) => {
              writeMissionState(mission.id, {
                ...snapshot,
                commsPort: httpServer.port,
                pid: process.pid,
              });
            });

            if (index === 0) {
              cleanupContext = {
                mission,
                team,
                state,
                codex,
                messages,
                httpServer: httpServer.httpServer,
              };
              uninstallCleanupHandlers = installRuntimeCleanupHandlers(cleanupContext);
            }

            console.error(`codex-teams: mission ${mission.id} launched (${team.name})`);
            console.error(`codex-teams: team ${team.id} — lead: ${mission.leadId}, workers: ${mission.workerIds.join(", ")}`);
            return { mission, team };
          });

          await Promise.all(runs.map(({ mission, team }) =>
            runMission(mission, team, codex, state, messages, (p) => {
              console.error(`codex-teams: [${team.name}:${p.phase}] ${p.detail ?? ""}`);
              writeMissionState(mission.id, {
                ...serializeMissionState(mission),
                phase: p.phase,
                commsPort: httpServer.port,
                pid: process.pid,
              });
            }),
          ));

          const teamResults = runs.map(({ mission }) => ({
            missionId: mission.id,
            teamName: mission.teamName,
            taskListId: mission.taskListId,
            phase: mission.phase,
            createdAt: mission.createdAt.toISOString(),
            updatedAt: mission.updatedAt.toISOString(),
            agents: serializeMissionState(mission).agents,
            leadOutput: mission.leadOutput || undefined,
            workerResults: mission.workerResults,
            shutdowns: mission.shutdowns.length > 0
              ? mission.shutdowns.map((shutdown) => ({
                  agentId: shutdown.agentId,
                  requestedBy: shutdown.requestedBy,
                  approvedBy: shutdown.approvedBy,
                  reason: shutdown.reason,
                  aborted: shutdown.aborted,
                  recoveredTasks: shutdown.recoveredTasks,
                  notification: shutdown.notification,
                  time: shutdown.timestamp.toISOString(),
                }))
              : undefined,
            protocolMessages: mission.comms?.protocol.map((m) => ({
              type: m.type,
              from: m.from,
              to: m.to,
              data: m.data,
              time: m.timestamp.toISOString(),
            })),
            leadChat: mission.comms?.leadChat.map(formatMsg),
            sharedArtifacts: mission.comms?.sharedArtifacts.map((a) => ({
              from: a.from,
              data: a.data,
              time: a.timestamp.toISOString(),
            })),
            taskBoard: buildTaskBoardSnapshot(mission.taskListId),
            verificationLog: mission.verificationLog.length > 0 ? mission.verificationLog : undefined,
            recentChat: mission.comms?.groupChat.slice(-20).map(formatMsg),
            error: mission.error,
          }));

          console.log(JSON.stringify({ teams: teamResults }, null, 2));
          uninstallCleanupHandlers?.();
          for (const { mission } of runs) removeMissionState(mission.id);
          exitCode = teamResults.every((result) => result.phase === "completed")
            ? 0
            : teamResults.some((result) => result.phase === "error")
              ? 1
              : 2;
          return;
        }

        let teamConfig: Array<{
          role: string;
          specialization?: string;
          isLead?: boolean;
          sandbox?: "plan-mode" | "workspace-write" | "danger-full-access";
          model?: string;
          reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
          fastMode?: boolean;
          isolation?: "worktree";
          symlinkDirs?: string[];
        }>;

        if (opts.teamJson) {
          teamConfig = JSON.parse(opts.teamJson);
        } else {
          const workers = (opts.worker ?? []) as string[];
          if (workers.length === 0) {
            console.error("Error: At least one --worker is required (or use --team-json)");
            exitCode = 1;
            return;
          }
          teamConfig = [
            {
              role: opts.lead,
              isLead: true,
              model: opts.model,
              sandbox: opts.sandbox,
              reasoningEffort: opts.reasoning,
              fastMode: opts.fast ?? false,
            },
            ...workers.map((role: string) => ({
              role,
              isLead: false,
              model: opts.model,
              sandbox: opts.sandbox,
              reasoningEffort: opts.reasoning,
              fastMode: opts.fast ?? false,
              isolation: isolationMode,
              symlinkDirs,
            })),
          ];
        }

        if (opts.hints !== false) {
          const warnings = emitLaunchWarnings({
            team: teamConfig,
            verify: opts.verify,
            verifier: opts.verifier,
          });
          for (const warning of warnings) {
            console.error(`codex-teams: [hint] ${warning}`);
          }
        }

        const { mission, team } = createMission(
          {
            objective: opts.objective,
            workDir: opts.workDir,
            team: teamConfig.map((member) => ({
              ...member,
              approvalPolicy: member.isLead ? "never" : "on-request",
            })),
            hooks: hasHooks ? hookCommands : undefined,
            verifyCommand: opts.verify,
            verifierRole: opts.verifier as string | undefined,
            maxVerifyRetries: parseInt(opts.maxRetries, 10),
            staleThresholdMs: parseInt(opts.staleThreshold, 10) * 60_000 || undefined,
          },
          state,
        );

        registerMissionPersistence(mission, (snapshot) => {
          writeMissionState(mission.id, {
            ...snapshot,
            commsPort: httpServer.port,
            pid: process.pid,
          });
        });
        cleanupContext = {
          mission,
          team,
          state,
          codex,
          messages,
          httpServer: httpServer.httpServer,
        };
        uninstallCleanupHandlers = installRuntimeCleanupHandlers(cleanupContext);

        console.error(`codex-teams: mission ${mission.id} launched`);
        console.error(`codex-teams: team ${team.id} — lead: ${mission.leadId}, workers: ${mission.workerIds.join(", ")}`);

        await runMission(mission, team, codex, state, messages, (p) => {
          console.error(`codex-teams: [${p.phase}] ${p.detail ?? ""}`);
          writeMissionState(mission.id, {
            ...serializeMissionState(mission),
            phase: p.phase,
            commsPort: httpServer.port,
            pid: process.pid,
          });
        });

        const result = {
          missionId: mission.id,
          taskListId: mission.taskListId,
          phase: mission.phase,
          createdAt: mission.createdAt.toISOString(),
          updatedAt: mission.updatedAt.toISOString(),
          agents: serializeMissionState(mission).agents,
          leadOutput: mission.leadOutput || undefined,
          workerResults: mission.workerResults,
          planApprovals: mission.planApprovals.length > 0
            ? mission.planApprovals.map((approval) => ({
                agentId: approval.agentId,
                leadId: approval.leadId,
                request: approval.request,
                response: approval.response,
                autoApproved: approval.autoApproved,
                time: approval.timestamp.toISOString(),
              }))
            : undefined,
          shutdowns: mission.shutdowns.length > 0
            ? mission.shutdowns.map((shutdown) => ({
                agentId: shutdown.agentId,
                requestedBy: shutdown.requestedBy,
                approvedBy: shutdown.approvedBy,
                reason: shutdown.reason,
                aborted: shutdown.aborted,
                recoveredTasks: shutdown.recoveredTasks,
                notification: shutdown.notification,
                time: shutdown.timestamp.toISOString(),
              }))
            : undefined,
          protocolMessages: mission.comms?.protocol.map((m) => ({
            type: m.type,
            from: m.from,
            to: m.to,
            data: m.data,
            time: m.timestamp.toISOString(),
          })),
          sharedArtifacts: mission.comms?.sharedArtifacts.map((a) => ({
            from: a.from,
            data: a.data,
            time: a.timestamp.toISOString(),
          })),
          taskBoard: buildTaskBoardSnapshot(mission.taskListId),
          verificationLog: mission.verificationLog.length > 0 ? mission.verificationLog : undefined,
          verifierAttempts: mission.verifierAttempts.length > 0 ? mission.verifierAttempts : undefined,
          verifierResult: mission.verifierResult ?? undefined,
          recentChat: mission.comms?.groupChat.slice(-20).map(formatMsg),
          worktrees: mission.worktreeResults?.filter((w) => w.hasChanges).map((w) => ({
            agentId: w.agentId,
            path: w.path,
            branch: w.branch,
          })),
          error: mission.error,
        };

        console.log(JSON.stringify(result, null, 2));
        uninstallCleanupHandlers?.();
        removeMissionState(mission.id);
        exitCode = mission.phase === "completed" ? 0 : mission.phase === "completed_with_failures" ? 2 : 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`codex-teams: fatal error: ${msg}`);
        console.log(JSON.stringify({ error: msg }, null, 2));
        uninstallCleanupHandlers?.();
        if (cleanupContext) await cleanupMissionRuntime(cleanupContext, "launch_failure");
        exitCode = 1;
      } finally {
        const forceExit = setTimeout(() => process.exit(exitCode), 15_000);
        uninstallCleanupHandlers?.();
        await codex.disconnect().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        // @ts-expect-error httpServer may not be assigned
        if (httpServer) httpServer.httpServer.close();
        clearTimeout(forceExit);
      }
      process.exit(exitCode);
    });
}
