import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PersistedMissionState } from "../mission.js";
import { TaskStore, getTaskStoreRoot } from "../task-store.js";
import { isProcessAlive } from "./pid-check.js";

function getStateDir(): string {
  return process.env.CODEX_TEAMS_STATE_DIR ?? path.join(os.homedir(), ".codex-teams", "missions");
}

export interface MissionStateFile extends PersistedMissionState {
  commsPort: number;
  pid: number;
}

function ensureDir(): void {
  fs.mkdirSync(getStateDir(), { recursive: true });
}

function statePath(missionId: string): string {
  return path.join(getStateDir(), `${missionId}.json`);
}

export function writeMissionState(missionId: string, state: MissionStateFile): void {
  ensureDir();
  fs.writeFileSync(statePath(missionId), JSON.stringify(state, null, 2));
}

export function readMissionState(missionId: string): MissionStateFile | null {
  try {
    const data = fs.readFileSync(statePath(missionId), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function removeMissionState(missionId: string): void {
  try {
    fs.unlinkSync(statePath(missionId));
  } catch {}
}

export function listMissionStates(): MissionStateFile[] {
  ensureDir();
  const stateDir = getStateDir();
  const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf-8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function purgeOrphanedMissions(): { purged: string[]; alive: string[] } {
  const states = listMissionStates();
  const purged: string[] = [];
  const alive: string[] = [];

  for (const mission of states) {
    if (mission.pid && isProcessAlive(mission.pid)) {
      alive.push(mission.missionId);
      continue;
    }

    try {
      const store = new TaskStore(mission.taskListId, getTaskStoreRoot());
      if (store.exists()) store.deleteTaskList();
    } catch {}

    removeMissionState(mission.missionId);
    purged.push(mission.missionId);
  }

  return { purged, alive };
}
