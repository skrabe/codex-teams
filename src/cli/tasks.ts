import type { Command } from "commander";
import { readMissionState } from "./state-file.js";
import { buildTaskBoardSnapshot } from "../mission.js";

export function registerTasksCommand(program: Command): void {
  program
    .command("tasks <missionId>")
    .description("Inspect the shared task board for a mission")
    .option("--status <status>", "Filter by task status: pending | in-progress | completed")
    .option("--owner <agentId>", "Filter by task owner agent ID")
    .action(async (missionId: string, opts) => {
      const stateFile = readMissionState(missionId);
      if (!stateFile) {
        console.error(`No active mission found: ${missionId}`);
        process.exit(1);
      }

      const board = buildTaskBoardSnapshot(stateFile.taskListId);
      if (!board) {
        console.log(JSON.stringify({ tasks: [], stats: { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 } }, null, 2));
        return;
      }

      let tasks = board.tasks;
      if (opts.status) {
        tasks = tasks.filter((t) => t.status === opts.status);
      }
      if (opts.owner) {
        tasks = tasks.filter((t) => t.owner === opts.owner);
      }

      console.log(JSON.stringify({ ...board, tasks }, null, 2));
    });
}
