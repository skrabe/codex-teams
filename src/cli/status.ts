import type { Command } from "commander";
import { readMissionState, listMissionStates } from "./state-file.js";
import { getMission } from "../mission.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status [missionId]")
    .description("Check mission status. Without an ID, lists all active missions.")
    .action(async (missionId?: string) => {
      if (!missionId) {
        const states = listMissionStates();
        if (states.length === 0) {
          console.log(JSON.stringify({ activeMissions: [] }, null, 2));
        } else {
          console.log(JSON.stringify({ activeMissions: states }, null, 2));
        }
        return;
      }

      const inMemory = getMission(missionId);
      if (inMemory) {
        console.log(JSON.stringify({
          missionId: inMemory.id,
          phase: inMemory.phase,
          teamId: inMemory.teamId,
          leadId: inMemory.leadId,
          workerIds: inMemory.workerIds,
          error: inMemory.error,
        }, null, 2));
        return;
      }

      const stateFile = readMissionState(missionId);
      if (stateFile) {
        console.log(JSON.stringify(stateFile, null, 2));
      } else {
        console.error(`Mission not found: ${missionId}`);
        process.exit(1);
      }
    });
}
