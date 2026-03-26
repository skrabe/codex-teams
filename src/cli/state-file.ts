import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".codex-teams", "missions");

export interface MissionStateFile {
  missionId: string;
  teamId: string;
  leadId: string;
  workerIds: string[];
  phase: string;
  commsPort: number;
  pid: number;
}

function ensureDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function statePath(missionId: string): string {
  return path.join(STATE_DIR, `${missionId}.json`);
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
  const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), "utf-8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
}
