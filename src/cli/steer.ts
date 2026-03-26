import http from "node:http";
import type { Command } from "commander";
import { readMissionState } from "./state-file.js";

function postJson(port: number, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(buf);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export function registerSteerCommand(program: Command): void {
  program
    .command("steer <missionId>")
    .description("Interrupt agents and redirect them with a new directive")
    .requiredOption("--directive <text>", "New directive for the agents")
    .option("--agents <ids...>", "Subset of agent IDs to steer (default: all)")
    .action(async (missionId: string, opts) => {
      const stateFile = readMissionState(missionId);
      if (!stateFile) {
        console.error(`No active mission found: ${missionId}`);
        process.exit(1);
      }

      try {
        const result = await postJson(stateFile.commsPort, "/steer", {
          teamId: stateFile.teamId,
          directive: opts.directive,
          agentIds: opts.agents,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to steer mission: ${msg}`);
        process.exit(1);
      }
    });
}
