import type { Command } from "commander";
import { purgeOrphanedMissions } from "./state-file.js";

export function registerCleanupCommand(program: Command): void {
  program
    .command("cleanup")
    .description("Remove orphaned mission state and task files from dead processes")
    .action(() => {
      const result = purgeOrphanedMissions();
      if (result.purged.length > 0) {
        for (const id of result.purged) {
          console.error(`codex-teams: [cleanup] purged orphaned mission ${id}`);
        }
      }
      console.log(JSON.stringify(result, null, 2));
    });
}
