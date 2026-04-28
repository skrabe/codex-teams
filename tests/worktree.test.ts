import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  validateWorktreeSlug,
  findGitRoot,
  createWorktree,
  hasWorktreeChanges,
  removeWorktree,
  mergeWorktreeBranches,
  cleanupIntegrationBranch,
} from "../src/worktree.js";

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  return dir;
}

let repoDir: string;

before(() => {
  repoDir = makeGitRepo();
});

after(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("validateWorktreeSlug", () => {
  it("accepts valid slugs", () => {
    assert.doesNotThrow(() => validateWorktreeSlug("wt-abc123"));
    assert.doesNotThrow(() => validateWorktreeSlug("worker-a1b2c3d4e5f6"));
    assert.doesNotThrow(() => validateWorktreeSlug("a"));
  });

  it("rejects empty slug", () => {
    assert.throws(() => validateWorktreeSlug(""), /Invalid worktree slug/);
  });

  it("rejects path traversal", () => {
    assert.throws(() => validateWorktreeSlug(".."), /Invalid worktree slug/);
    assert.throws(() => validateWorktreeSlug("."), /Invalid worktree slug/);
  });

  it("rejects special characters", () => {
    assert.throws(() => validateWorktreeSlug("foo/bar"), /Invalid worktree slug/);
    assert.throws(() => validateWorktreeSlug("foo bar"), /Invalid worktree slug/);
    assert.throws(() => validateWorktreeSlug("foo..bar"), /Invalid worktree slug/);
  });

  it("rejects overly long slugs", () => {
    assert.throws(() => validateWorktreeSlug("a".repeat(65)), /Invalid worktree slug/);
  });
});

describe("findGitRoot", () => {
  it("finds git root for a repo", () => {
    const root = findGitRoot(repoDir);
    assert.ok(root);
    assert.ok(root.includes("wt-test-"));
  });

  it("returns null for non-repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "no-git-"));
    const root = findGitRoot(tmp);
    assert.equal(root, null);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("createWorktree", () => {
  let wtInfo: ReturnType<typeof createWorktree>;

  after(() => {
    if (wtInfo) {
      try { removeWorktree(wtInfo.worktreePath, wtInfo.branch, wtInfo.gitRoot); } catch {}
    }
  });

  it("creates a worktree and returns info", () => {
    wtInfo = createWorktree(repoDir, "test-create");
    assert.ok(existsSync(wtInfo.worktreePath));
    assert.equal(wtInfo.branch, "worktree-test-create");
    assert.ok(wtInfo.headCommit.length >= 7);
    assert.ok(existsSync(join(wtInfo.worktreePath, "README.md")));
  });
});

describe("hasWorktreeChanges", () => {
  let wtInfo: ReturnType<typeof createWorktree>;

  before(() => {
    wtInfo = createWorktree(repoDir, "test-changes");
  });

  after(() => {
    try { removeWorktree(wtInfo.worktreePath, wtInfo.branch, wtInfo.gitRoot); } catch {}
  });

  it("returns false for clean worktree", () => {
    assert.equal(hasWorktreeChanges(wtInfo.worktreePath, wtInfo.headCommit), false);
  });

  it("returns true for dirty worktree", () => {
    writeFileSync(join(wtInfo.worktreePath, "new-file.txt"), "hello");
    assert.equal(hasWorktreeChanges(wtInfo.worktreePath, wtInfo.headCommit), true);
  });

  it("returns true for committed changes", () => {
    execFileSync("git", ["add", "."], { cwd: wtInfo.worktreePath });
    execFileSync("git", ["commit", "-m", "test commit"], { cwd: wtInfo.worktreePath });
    assert.equal(hasWorktreeChanges(wtInfo.worktreePath, wtInfo.headCommit), true);
  });
});

describe("removeWorktree", () => {
  it("removes a worktree and branch", () => {
    const wt = createWorktree(repoDir, "test-remove");
    assert.ok(existsSync(wt.worktreePath));
    const result = removeWorktree(wt.worktreePath, wt.branch, wt.gitRoot);
    assert.equal(result, true);
    assert.equal(existsSync(wt.worktreePath), false);
  });

  it("returns false for non-existent worktree", () => {
    const result = removeWorktree("/tmp/nonexistent-wt-path", "fake-branch", repoDir);
    assert.equal(result, false);
  });
});

describe("mergeWorktreeBranches", () => {
  let wt1: ReturnType<typeof createWorktree>;
  let wt2: ReturnType<typeof createWorktree>;

  before(() => {
    wt1 = createWorktree(repoDir, "test-merge-1");
    wt2 = createWorktree(repoDir, "test-merge-2");
  });

  after(() => {
    try { removeWorktree(wt1.worktreePath, wt1.branch, wt1.gitRoot); } catch {}
    try { removeWorktree(wt2.worktreePath, wt2.branch, wt2.gitRoot); } catch {}
    cleanupIntegrationBranch(repoDir, "integration-test");
  });

  it("merges non-conflicting worktree branches", () => {
    writeFileSync(join(wt1.worktreePath, "file1.txt"), "from wt1");
    execFileSync("git", ["add", "."], { cwd: wt1.worktreePath });
    execFileSync("git", ["commit", "-m", "wt1 change"], { cwd: wt1.worktreePath });

    writeFileSync(join(wt2.worktreePath, "file2.txt"), "from wt2");
    execFileSync("git", ["add", "."], { cwd: wt2.worktreePath });
    execFileSync("git", ["commit", "-m", "wt2 change"], { cwd: wt2.worktreePath });

    const result = mergeWorktreeBranches(repoDir, "integration-test", [wt1.branch, wt2.branch]);
    assert.equal(result.ok, true);
    cleanupIntegrationBranch(repoDir, "integration-test");
  });

  it("detects merge conflicts", () => {
    writeFileSync(join(wt1.worktreePath, "README.md"), "wt1 version");
    execFileSync("git", ["add", "."], { cwd: wt1.worktreePath });
    execFileSync("git", ["commit", "-m", "wt1 readme"], { cwd: wt1.worktreePath });

    writeFileSync(join(wt2.worktreePath, "README.md"), "wt2 version");
    execFileSync("git", ["add", "."], { cwd: wt2.worktreePath });
    execFileSync("git", ["commit", "-m", "wt2 readme"], { cwd: wt2.worktreePath });

    const result = mergeWorktreeBranches(repoDir, "integration-conflict", [wt1.branch, wt2.branch]);
    assert.equal(result.ok, false);
    assert.ok(result.conflictBranch);
    cleanupIntegrationBranch(repoDir, "integration-conflict");
  });
});

describe("symlink auto-detection", () => {
  it("symlinks node_modules when present", () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "exists");

    const wt = createWorktree(repo, "test-symlink");
    assert.ok(existsSync(join(wt.worktreePath, "node_modules")));
    assert.ok(existsSync(join(wt.worktreePath, "node_modules", "marker.txt")));

    removeWorktree(wt.worktreePath, wt.branch, wt.gitRoot);
    rmSync(repo, { recursive: true, force: true });
  });
});
