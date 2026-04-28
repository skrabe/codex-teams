import type { Command } from "commander";
import { readMissionState, listMissionStates } from "./state-file.js";
import { getMission, serializeMissionState } from "../mission.js";
import { isProcessAlive } from "./pid-check.js";

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
          const enriched = states.map((s) => ({ ...s, alive: s.pid ? isProcessAlive(s.pid) : false }));
          console.log(JSON.stringify({ activeMissions: enriched }, null, 2));
        }
        return;
      }

      const inMemory = getMission(missionId);
      if (inMemory) {
        console.log(JSON.stringify({
          ...serializeMissionState(inMemory),
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
