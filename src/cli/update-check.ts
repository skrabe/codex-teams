import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const CACHE_DIR = path.join(os.homedir(), ".codex-teams");
const CACHE_FILE = path.join(CACHE_DIR, "version-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  latest: string;
  checkedAt: number;
}

function readCache(): CacheEntry | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (data.latest && data.checkedAt) return data;
  } catch {}
  return null;
}

function writeCache(entry: CacheEntry): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry));
  } catch {}
}

function fetchLatestVersion(): string | null {
  try {
    return execSync("npm view codex-teams version 2>/dev/null", {
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export function checkForUpdate(currentVersion: string): void {
  try {
    const cache = readCache();
    const now = Date.now();

    if (cache && now - cache.checkedAt < CHECK_INTERVAL_MS) {
      if (isNewer(cache.latest, currentVersion)) {
        printNotice(currentVersion, cache.latest);
      }
      return;
    }

    // Fetch in the foreground but with a short timeout -- won't slow down meaningfully
    const latest = fetchLatestVersion();
    if (latest) {
      writeCache({ latest, checkedAt: now });
      if (isNewer(latest, currentVersion)) {
        printNotice(currentVersion, latest);
      }
    }
  } catch {}
}

function printNotice(current: string, latest: string): void {
  console.error(`codex-teams: update available ${current} → ${latest} — run \`npm install -g codex-teams\` to update`);
}
