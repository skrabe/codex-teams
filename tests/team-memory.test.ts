import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TeamMemoryStore, PathTraversalError, SecretDetectedError, MemoryConflictError } from "../src/team-memory.js";
import { scanForSecrets } from "../src/secret-scanner.js";

describe("SecretScanner", () => {
  it("detects GitHub PAT", () => {
    const matches = scanForSecrets("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.ruleId, "github-pat");
  });

  it("detects AWS access token", () => {
    const matches = scanForSecrets("AKIAIOSFODNN7EXAMPLE");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.ruleId, "aws-access-token");
  });

  it("detects private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(100) + "\n-----END RSA PRIVATE KEY-----";
    const matches = scanForSecrets(pem);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.ruleId, "private-key");
  });

  it("detects Slack bot token", () => {
    const matches = scanForSecrets("xoxb-1234567890-1234567890-abcdef");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.ruleId, "slack-bot-token");
  });

  it("returns empty for safe content", () => {
    const matches = scanForSecrets("This is a normal architecture note about the auth module.");
    assert.equal(matches.length, 0);
  });

  it("deduplicates matches by rule ID", () => {
    const matches = scanForSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef5678");
    assert.equal(matches.length, 1);
  });
});

describe("TeamMemoryStore", () => {
  let store: TeamMemoryStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-memory-"));
    store = new TeamMemoryStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await store.cleanup();
  });

  it("writes and reads a private memory entry", async () => {
    const entry = await store.write("auth-notes", "private", "JWT with RS256", "worker-1");
    assert.equal(entry.key, "auth-notes");
    assert.equal(entry.scope, "private");
    assert.equal(entry.content, "JWT with RS256");
    assert.equal(entry.author, "worker-1");
    assert.equal(entry.revision, 1);
    assert.ok(entry.checksum.startsWith("sha256:"));

    const read = await store.read("auth-notes", "private");
    assert.ok(read);
    assert.equal(read.content, "JWT with RS256");
    assert.equal(read.revision, 1);
    assert.equal(read.checksum, entry.checksum);
  });

  it("writes and reads a team memory entry", async () => {
    const entry = await store.write("conventions", "team", "Use ESM imports only", "lead-1");
    assert.equal(entry.scope, "team");

    const read = await store.read("conventions", "team");
    assert.ok(read);
    assert.equal(read.content, "Use ESM imports only");
  });

  it("updates an existing entry preserving createdAt", async () => {
    const first = await store.write("notes", "private", "v1", "agent-a");
    const second = await store.write("notes", "private", "v2", "agent-a");
    assert.equal(second.content, "v2");
    assert.equal(second.createdAt.getTime(), first.createdAt.getTime());
    assert.ok(second.updatedAt.getTime() >= first.updatedAt.getTime());
    assert.equal(second.revision, first.revision + 1);
    assert.notEqual(second.checksum, first.checksum);
  });

  it("lists entries across both scopes", async () => {
    await store.write("key-a", "private", "private data", "worker-1");
    await store.write("key-b", "team", "team data", "worker-2");

    const all = await store.list();
    assert.equal(all.length, 2);

    const privateOnly = await store.list("private");
    assert.equal(privateOnly.length, 1);
    assert.equal(privateOnly[0]!.scope, "private");

    const teamOnly = await store.list("team");
    assert.equal(teamOnly.length, 1);
    assert.equal(teamOnly[0]!.scope, "team");
  });

  it("deletes an entry", async () => {
    await store.write("deleteme", "private", "data", "agent-1");
    const deleted = await store.delete("deleteme", "private");
    assert.ok(deleted);

    const read = await store.read("deleteme", "private");
    assert.equal(read, null);
  });

  it("returns false when deleting nonexistent entry", async () => {
    const deleted = await store.delete("nonexistent", "team");
    assert.equal(deleted, false);
  });

  it("searches entries by content", async () => {
    await store.write("arch", "team", "We use PostgreSQL for the main database", "lead-1");
    await store.write("style", "team", "Follow Airbnb style guide", "lead-1");

    const results = await store.search("PostgreSQL");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.key, "arch");
  });

  it("searches entries by key", async () => {
    await store.write("database-setup", "team", "config here", "lead-1");
    await store.write("auth-setup", "team", "other config", "lead-1");

    const results = await store.search("database");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.key, "database-setup");
  });

  it("rejects secrets in team scope", async () => {
    await assert.rejects(
      () => store.write("creds", "team", "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234", "agent-1"),
      (err: unknown) => {
        assert.ok(err instanceof SecretDetectedError);
        assert.ok(err.message.includes("secrets"));
        return true;
      },
    );
  });

  it("allows secrets in private scope (no scan)", async () => {
    const entry = await store.write("my-token", "private", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234", "agent-1");
    assert.equal(entry.scope, "private");
  });

  it("returns null for nonexistent read", async () => {
    const result = await store.read("does-not-exist", "team");
    assert.equal(result, null);
  });

  it("scopes are isolated", async () => {
    await store.write("same-key", "private", "private version", "agent-1");
    await store.write("same-key", "team", "team version", "agent-2");

    const priv = await store.read("same-key", "private");
    const team = await store.read("same-key", "team");
    assert.ok(priv);
    assert.ok(team);
    assert.equal(priv.content, "private version");
    assert.equal(team.content, "team version");
  });


  it("rejects stale expectedRevision writes", async () => {
    const first = await store.write("conflict", "team", "v1", "lead-1");
    await store.write("conflict", "team", "v2", "lead-1", { expectedRevision: first.revision });

    await assert.rejects(
      () => store.write("conflict", "team", "v3", "lead-1", { expectedRevision: first.revision }),
      (err: unknown) => err instanceof MemoryConflictError,
    );
  });

  it("rejects stale expectedChecksum writes", async () => {
    const first = await store.write("checksum-conflict", "team", "v1", "lead-1");
    await store.write("checksum-conflict", "team", "v2", "lead-1", { expectedChecksum: first.checksum });

    await assert.rejects(
      () => store.write("checksum-conflict", "team", "v3", "lead-1", { expectedChecksum: first.checksum }),
      (err: unknown) => err instanceof MemoryConflictError,
    );
  });
});

describe("Path traversal defense", () => {
  let store: TeamMemoryStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-teams-memory-sec-"));
    store = new TeamMemoryStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await store.cleanup();
  });

  it("rejects null byte in key", async () => {
    await assert.rejects(
      () => store.write("bad\0key", "team", "data", "agent-1"),
      (err: unknown) => err instanceof PathTraversalError,
    );
  });

  it("rejects .. traversal in key", async () => {
    await assert.rejects(
      () => store.write("../../etc/passwd", "team", "data", "agent-1"),
      (err: unknown) => err instanceof PathTraversalError,
    );
  });

  it("rejects absolute path in key", async () => {
    await assert.rejects(
      () => store.write("/etc/passwd", "team", "data", "agent-1"),
      (err: unknown) => err instanceof PathTraversalError,
    );
  });

  it("rejects backslash in key", async () => {
    await assert.rejects(
      () => store.write("dir\\file", "team", "data", "agent-1"),
      (err: unknown) => err instanceof PathTraversalError,
    );
  });

  it("rejects URL-encoded traversal in key", async () => {
    await assert.rejects(
      () => store.write("%2e%2e%2fetc%2fpasswd", "team", "data", "agent-1"),
      (err: unknown) => err instanceof PathTraversalError,
    );
  });
});
