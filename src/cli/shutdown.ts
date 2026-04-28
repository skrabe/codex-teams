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

export function registerShutdownCommand(program: Command): void {
  program
    .command("shutdown <missionId>")
    .description("Gracefully shut down a worker and recover its unfinished tasks")
    .requiredOption("--agent <id>", "Worker agent ID to shut down")
    .option("--reason <text>", "Optional shutdown reason")
    .action(async (missionId: string, opts) => {
      const stateFile = readMissionState(missionId);
      if (!stateFile) {
        console.error(`No active mission found: ${missionId}`);
        process.exit(1);
      }

      try {
        const result = await postJson(stateFile.commsPort, "/shutdown", {
          teamId: stateFile.teamId,
          agentId: opts.agent,
          reason: opts.reason,
          requestedBy: "orchestrator",
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to shut down teammate: ${msg}`);
        process.exit(1);
      }
    });
}
