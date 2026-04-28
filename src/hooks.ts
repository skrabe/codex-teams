import { spawn } from "node:child_process";
import type { HookCommands, HookEvent, Task } from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
export const HOOK_BLOCK_PREFIX = "[HOOK_BLOCK]";

export interface HookPayload {
  event: HookEvent;
  missionId?: string;
  teamId: string;
  timestamp: string;
  triggeredBy?: string;
  agent?: {
    id: string;
    role: string;
    isLead: boolean;
  };
  task?: {
    id: string;
    subject: string;
    description: string;
    status: Task["status"];
    owner: string | null;
    dependencies: string[];
    blockedBy: string[];
    result?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
  };
}

export interface HookResult {
  blocked: boolean;
  message?: string;
}

function resolveHookCommand(hooks: HookCommands | undefined, event: HookEvent): string | undefined {
  if (!hooks) return undefined;

  if (event === "TaskCreated") return hooks.taskCreated;
  if (event === "TaskCompleted") return hooks.taskCompleted;
  return hooks.teammateIdle;
}

function parseHookStdout(stdout: string): HookResult {
  const trimmed = stdout.trim();
  if (!trimmed) return { blocked: false };

  try {
    const parsed = JSON.parse(trimmed) as { decision?: string; message?: string };
    if (parsed.decision === "block") {
      return { blocked: true, message: parsed.message || "Hook blocked continuation" };
    }
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}

export async function runHook(
  hooks: HookCommands | undefined,
  event: HookEvent,
  payload: HookPayload,
): Promise<HookResult> {
  const command = resolveHookCommand(hooks, event);
  if (!command) return { blocked: false };

  return new Promise<HookResult>((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ blocked: true, message: `${event} hook timed out after ${hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS}ms` });
    }, hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ blocked: true, message: `${event} hook failed to start: ${error.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        resolve({ blocked: true, message: `${event} hook failed: ${detail}` });
        return;
      }

      resolve(parseHookStdout(stdout));
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
