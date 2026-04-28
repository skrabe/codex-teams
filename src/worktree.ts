import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type IsolationMode = "worktree";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
}

export interface WorktreeResult {
  agentId: string;
  path: string;
  branch: string;
  hasChanges: boolean;
}

const WORKTREE_DIR = ".codex-teams-worktrees";

export function validateWorktreeSlug(slug: string): void {
  if (!slug || slug.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(
      `Invalid worktree slug "${slug}": must be 1-64 chars of [a-zA-Z0-9_-]`,
    );
  }
  if (slug === "." || slug === "..") {
    throw new Error(`Invalid worktree slug: path traversal detected`);
  }
}

export function findGitRoot(cwd: string): string | null {
  try {
    const result = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

export function createWorktree(
  gitRoot: string,
  slug: string,
  symlinkDirs?: string[],
): WorktreeInfo {
  validateWorktreeSlug(slug);

  const worktreesDir = join(gitRoot, WORKTREE_DIR);
  mkdirSync(worktreesDir, { recursive: true });

  const worktreePath = join(worktreesDir, slug);
  const branch = `worktree-${slug}`;

  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: gitRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  execFileSync(
    "git",
    ["worktree", "add", "-B", branch, worktreePath, "HEAD"],
    { cwd: gitRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  const dirs = symlinkDirs ?? autoDetectSymlinkDirs(gitRoot);
  for (const dir of dirs) {
    if (dir.includes("..") || dir.startsWith("/")) continue;
    const src = join(gitRoot, dir);
    const dest = join(worktreePath, dir);
    try {
      if (existsSync(src) && !existsSync(dest)) {
        symlinkSync(resolve(src), dest, "dir");
      }
    } catch {}
  }

  return { worktreePath, branch, headCommit, gitRoot };
}

export function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): boolean {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (status.trim().length > 0) return true;
  } catch {
    return true;
  }

  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `${headCommit}..HEAD`],
      {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (parseInt(count.trim(), 10) > 0) return true;
  } catch {
    return true;
  }

  return false;
}

export function removeWorktree(
  worktreePath: string,
  branch: string,
  gitRoot: string,
): boolean {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return false;
  }

  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {}

  return true;
}

export function mergeWorktreeBranches(
  gitRoot: string,
  integrationBranch: string,
  branches: string[],
): { ok: boolean; conflictBranch?: string; error?: string } {
  const originalBranch = execFileSync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: gitRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();

  try {
    execFileSync(
      "git",
      ["checkout", "-b", integrationBranch],
      { cwd: gitRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    for (const branch of branches) {
      try {
        execFileSync(
          "git",
          ["merge", "--no-edit", branch],
          { cwd: gitRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch {
        try {
          execFileSync("git", ["merge", "--abort"], {
            cwd: gitRoot,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {}
        return { ok: false, conflictBranch: branch, error: `Merge conflict with ${branch}` };
      }
    }
    return { ok: true };
  } finally {
    try {
      execFileSync("git", ["checkout", originalBranch], {
        cwd: gitRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {}
  }
}

export function cleanupIntegrationBranch(
  gitRoot: string,
  integrationBranch: string,
): void {
  try {
    execFileSync("git", ["branch", "-D", integrationBranch], {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {}
}

function autoDetectSymlinkDirs(gitRoot: string): string[] {
  const candidates = ["node_modules", ".next", "vendor"];
  return candidates.filter((d) => existsSync(join(gitRoot, d)));
}
