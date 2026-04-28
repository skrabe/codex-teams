import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scanForSecrets, type SecretMatch } from "./secret-scanner.js";

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

export class SecretDetectedError extends Error {
  matches: SecretMatch[];
  constructor(matches: SecretMatch[]) {
    const labels = matches.map((m) => m.label).join(", ");
    super(
      `Content contains potential secrets (${labels}) and cannot be written to team memory. ` +
      "Team memory is shared with all teammates. Remove the sensitive content and try again.",
    );
    this.name = "SecretDetectedError";
    this.matches = matches;
  }
}

export class MemoryConflictError extends Error {
  expectedRevision?: number;
  actualRevision?: number;
  expectedChecksum?: string;
  actualChecksum?: string;

  constructor(input: {
    key: string;
    scope: MemoryScope;
    expectedRevision?: number;
    actualRevision?: number;
    expectedChecksum?: string;
    actualChecksum?: string;
  }) {
    const bits: string[] = [];
    if (input.expectedRevision !== undefined) {
      bits.push(`expectedRevision=${input.expectedRevision}`, `actualRevision=${input.actualRevision ?? "none"}`);
    }
    if (input.expectedChecksum !== undefined) {
      bits.push(`expectedChecksum=${input.expectedChecksum}`, `actualChecksum=${input.actualChecksum ?? "none"}`);
    }
    super(`Memory conflict for ${input.scope}/${input.key}: ${bits.join(", ")}`);
    this.name = "MemoryConflictError";
    this.expectedRevision = input.expectedRevision;
    this.actualRevision = input.actualRevision;
    this.expectedChecksum = input.expectedChecksum;
    this.actualChecksum = input.actualChecksum;
  }
}

export type MemoryScope = "private" | "team";
export type TeamMemorySyncModel = "local_machine" | "local_repo_scoped";

export interface TeamMemoryStoreOptions {
  enableSyncWatcher?: boolean;
  syncDebounceMs?: number;
  syncModel?: TeamMemorySyncModel;
}

export interface MemoryWriteOptions {
  expectedRevision?: number;
  expectedChecksum?: string;
}

export interface MemoryEntry {
  key: string;
  scope: MemoryScope;
  content: string;
  author: string;
  checksum: string;
  revision: number;
  updatedAt: Date;
  createdAt: Date;
}

export interface MemoryListEntry {
  key: string;
  scope: MemoryScope;
  author: string;
  size: number;
  checksum: string;
  revision: number;
  updatedAt: Date;
  createdAt: Date;
}

export interface MemorySyncStatus {
  model: TeamMemorySyncModel;
  watcherEnabled: boolean;
  watcherActive: boolean;
  lastSyncAt?: Date;
  suppressedError?: string;
}

interface StoredMemoryEntry {
  key: string;
  scope: MemoryScope;
  content: string;
  author: string;
  checksum?: string;
  revision?: number;
  updatedAt: string;
  createdAt: string;
}

interface SyncIndexEntry {
  scope: MemoryScope;
  key: string;
  checksum: string;
  revision: number;
  updatedAt: string;
}

interface PersistedSyncIndex {
  version: 1;
  model: TeamMemorySyncModel;
  updatedAt: string;
  entries: SyncIndexEntry[];
}

const DEFAULT_SYNC_DEBOUNCE_MS = 2000;
const SYNC_FAILURE_LOG_LIMIT = 3;

function sanitizeKey(key: string): string {
  if (key.includes("\0")) {
    throw new PathTraversalError(`Null byte in memory key: "${key}"`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    decoded = key;
  }
  if (decoded !== key && (decoded.includes("..") || decoded.includes("/"))) {
    throw new PathTraversalError(`URL-encoded traversal in memory key: "${key}"`);
  }
  const normalized = key.normalize("NFKC");
  if (
    normalized !== key &&
    (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0"))
  ) {
    throw new PathTraversalError(`Unicode-normalized traversal in memory key: "${key}"`);
  }
  if (key.includes("\\")) {
    throw new PathTraversalError(`Backslash in memory key: "${key}"`);
  }
  if (key.startsWith("/")) {
    throw new PathTraversalError(`Absolute path in memory key: "${key}"`);
  }
  if (key.includes("..")) {
    throw new PathTraversalError(`Path traversal in memory key: "${key}"`);
  }
  return key;
}


function validateContainment(filePath: string, dir: string): string {
  const resolved = path.resolve(filePath);
  const normalizedDir = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!resolved.startsWith(normalizedDir) && resolved !== normalizedDir.slice(0, -1)) {
    throw new PathTraversalError(`Path escapes memory directory: "${filePath}"`);
  }
  return resolved;
}

async function resolveAndValidateReal(filePath: string, dir: string): Promise<string> {
  const resolved = validateContainment(filePath, dir);
  try {
    const real = await fs.promises.realpath(resolved);
    const realDir = await fs.promises.realpath(dir.replace(/[\/]+$/, ""));
    if (real !== realDir && !real.startsWith(realDir + path.sep)) {
      throw new PathTraversalError(`Path escapes memory directory via symlink: "${filePath}"`);
    }
  } catch (e: unknown) {
    if (e instanceof PathTraversalError) throw e;
  }
  return resolved;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function computeChecksum(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function indexKey(scope: MemoryScope, key: string): string {
  return `${scope}:${key}`;
}

function mapToObject(entries: Map<string, SyncIndexEntry>): PersistedSyncIndex {
  return {
    version: 1,
    model: "local_machine",
    updatedAt: new Date().toISOString(),
    entries: Array.from(entries.values()).sort((a, b) => `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`)),
  };
}

export class TeamMemoryStore {
  private readonly baseDir: string;
  private readonly privateDir: string;
  private readonly teamDir: string;
  private readonly lockfile: string;
  private readonly syncIndexPath: string;
  private readonly enableSyncWatcher: boolean;
  private readonly syncDebounceMs: number;
  private readonly syncModel: TeamMemorySyncModel;

  private watchers: fs.FSWatcher[] = [];
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncInProgress = false;
  private pendingSync = false;
  private lastSyncAt?: Date;
  private indexCache = new Map<string, SyncIndexEntry>();
  private syncFailureState: { key: string; count: number; suppressed: boolean } | null = null;

  constructor(baseDir: string, options: TeamMemoryStoreOptions = {}) {
    this.baseDir = baseDir;
    this.privateDir = path.join(baseDir, "private") + path.sep;
    this.teamDir = path.join(baseDir, "team") + path.sep;
    this.lockfile = path.join(baseDir, ".lock");
    this.syncIndexPath = path.join(baseDir, ".sync-index.json");
    this.enableSyncWatcher = options.enableSyncWatcher ?? true;
    this.syncDebounceMs = options.syncDebounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS;
    this.syncModel = options.syncModel ?? "local_machine";
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.privateDir, { recursive: true });
    await fs.promises.mkdir(this.teamDir, { recursive: true });
    await this.loadSyncIndex();
    await this.rebuildSyncIndex("init");
    this.startSyncWatcher();
  }

  getPrivateDir(): string {
    return this.privateDir;
  }

  getTeamDir(): string {
    return this.teamDir;
  }

  getSyncStatus(): MemorySyncStatus {
    return {
      model: this.syncModel,
      watcherEnabled: this.enableSyncWatcher,
      watcherActive: this.watchers.length > 0,
      lastSyncAt: this.lastSyncAt,
      suppressedError: this.syncFailureState?.suppressed ? this.syncFailureState.key : undefined,
    };
  }

  private scopeDir(scope: MemoryScope): string {
    return scope === "team" ? this.teamDir : this.privateDir;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = this.lockfile;
    let acquired = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        fs.mkdirSync(lockDir, { recursive: false });
        acquired = true;
        break;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
          continue;
        }
        throw e;
      }
    }
    if (!acquired) throw new Error("Failed to acquire memory store lock");
    try {
      return await fn();
    } finally {
      try {
        fs.rmdirSync(lockDir);
      } catch { /* best effort */ }
    }
  }

  async write(
    key: string,
    scope: MemoryScope,
    content: string,
    author: string,
    options: MemoryWriteOptions = {},
  ): Promise<MemoryEntry> {
    const safeKey = sanitizeKey(key);
    const dir = this.scopeDir(scope);

    if (scope === "team") {
      const secrets = scanForSecrets(content);
      if (secrets.length > 0) {
        throw new SecretDetectedError(secrets);
      }
    }

    const written = await this.withLock(async () => {
      const filePath = path.join(dir, safeKey + ".json");
      const resolved = await resolveAndValidateReal(filePath, dir);

      const existing = await this.readStoredEntry(resolved, scope, safeKey);
      if (options.expectedRevision !== undefined && options.expectedRevision !== (existing?.revision ?? undefined)) {
        throw new MemoryConflictError({
          key: safeKey,
          scope,
          expectedRevision: options.expectedRevision,
          actualRevision: existing?.revision,
        });
      }
      if (options.expectedChecksum !== undefined && options.expectedChecksum !== (existing?.checksum ?? undefined)) {
        throw new MemoryConflictError({
          key: safeKey,
          scope,
          expectedChecksum: options.expectedChecksum,
          actualChecksum: existing?.checksum,
        });
      }

      const now = new Date();
      const checksum = computeChecksum(content);
      const revision = existing ? (existing.checksum === checksum ? existing.revision : existing.revision + 1) : 1;
      const entry: MemoryEntry = {
        key: safeKey,
        scope,
        content,
        author,
        checksum,
        revision,
        updatedAt: now,
        createdAt: existing?.createdAt ?? now,
      };

      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, JSON.stringify(this.toStoredEntry(entry), null, 2), "utf-8");
      this.indexCache.set(indexKey(scope, safeKey), {
        scope,
        key: safeKey,
        checksum,
        revision,
        updatedAt: now.toISOString(),
      });
      return entry;
    });

    this.scheduleSyncReindex("write");
    return written;
  }

  async read(key: string, scope: MemoryScope): Promise<MemoryEntry | null> {
    const safeKey = sanitizeKey(key);
    const dir = this.scopeDir(scope);
    const filePath = path.join(dir, safeKey + ".json");
    const resolved = validateContainment(filePath, dir);
    try {
      const raw = await fs.promises.readFile(resolved, "utf-8");
      const parsed = this.parseStoredEntry(raw, scope, safeKey);
      return parsed;
    } catch {
      return null;
    }
  }

  async list(scope?: MemoryScope): Promise<MemoryListEntry[]> {
    const scopes: MemoryScope[] = scope ? [scope] : ["private", "team"];
    const results: MemoryListEntry[] = [];

    for (const s of scopes) {
      const dir = this.scopeDir(s);
      let files: string[];
      try {
        files = await this.walkJsonFiles(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const raw = await fs.promises.readFile(file, "utf-8");
          const parsed = this.parseStoredEntry(raw, s);
          results.push({
            key: parsed.key,
            scope: parsed.scope,
            author: parsed.author,
            size: raw.length,
            checksum: parsed.checksum,
            revision: parsed.revision,
            updatedAt: parsed.updatedAt,
            createdAt: parsed.createdAt,
          });
        } catch { /* skip corrupt entries */ }
      }
    }

    return results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async delete(key: string, scope: MemoryScope): Promise<boolean> {
    const safeKey = sanitizeKey(key);
    const dir = this.scopeDir(scope);
    const deleted = await this.withLock(async () => {
      const filePath = path.join(dir, safeKey + ".json");
      const resolved = validateContainment(filePath, dir);
      try {
        await fs.promises.unlink(resolved);
        return true;
      } catch {
        return false;
      }
    });

    if (deleted) {
      this.indexCache.delete(indexKey(scope, safeKey));
      this.scheduleSyncReindex("delete");
    }
    return deleted;
  }

  async search(query: string, scope?: MemoryScope): Promise<MemoryEntry[]> {
    const all = await this.listFull(scope);
    const lower = query.toLowerCase();
    return all.filter(
      (e) =>
        e.key.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower),
    );
  }

  private async listFull(scope?: MemoryScope): Promise<MemoryEntry[]> {
    const scopes: MemoryScope[] = scope ? [scope] : ["private", "team"];
    const results: MemoryEntry[] = [];

    for (const s of scopes) {
      const dir = this.scopeDir(s);
      let files: string[];
      try {
        files = await this.walkJsonFiles(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const raw = await fs.promises.readFile(file, "utf-8");
          const entry = this.parseStoredEntry(raw, s);
          results.push(entry);
        } catch { /* skip corrupt */ }
      }
    }

    return results;
  }

  private async walkJsonFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walkJsonFiles(full)));
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(full);
      }
    }
    return results;
  }

  private parseStoredEntry(raw: string, fallbackScope: MemoryScope, fallbackKey?: string): MemoryEntry {
    const parsed = JSON.parse(raw) as StoredMemoryEntry;
    const key = typeof parsed.key === "string" && parsed.key.length > 0 ? parsed.key : (fallbackKey ?? "");
    const scope = parsed.scope === "team" || parsed.scope === "private" ? parsed.scope : fallbackScope;
    const content = typeof parsed.content === "string" ? parsed.content : "";
    const checksum = typeof parsed.checksum === "string" && parsed.checksum.length > 0
      ? parsed.checksum
      : computeChecksum(content);

    const cached = this.indexCache.get(indexKey(scope, key));
    const revision = isPositiveInteger(parsed.revision)
      ? parsed.revision
      : cached
        ? (cached.checksum === checksum ? cached.revision : cached.revision + 1)
        : 1;

    const createdAt = new Date(parsed.createdAt);
    const updatedAt = new Date(parsed.updatedAt);

    return {
      key,
      scope,
      content,
      author: typeof parsed.author === "string" ? parsed.author : "unknown",
      checksum,
      revision,
      updatedAt: Number.isNaN(updatedAt.getTime()) ? new Date() : updatedAt,
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
    };
  }

  private toStoredEntry(entry: MemoryEntry): StoredMemoryEntry {
    return {
      key: entry.key,
      scope: entry.scope,
      content: entry.content,
      author: entry.author,
      checksum: entry.checksum,
      revision: entry.revision,
      updatedAt: entry.updatedAt.toISOString(),
      createdAt: entry.createdAt.toISOString(),
    };
  }

  private async readStoredEntry(filePath: string, scope: MemoryScope, key: string): Promise<MemoryEntry | null> {
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      return this.parseStoredEntry(raw, scope, key);
    } catch {
      return null;
    }
  }

  private scheduleSyncReindex(reason: string): void {
    this.pendingSync = true;
    if (this.syncInProgress) return;

    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.flushSync(reason);
    }, this.syncDebounceMs);

    if (this.syncTimer.unref) this.syncTimer.unref();
  }

  private async flushSync(reason: string): Promise<void> {
    if (this.syncInProgress) return;
    this.syncInProgress = true;

    try {
      while (this.pendingSync) {
        this.pendingSync = false;
        try {
          await this.rebuildSyncIndex(reason);
          this.syncFailureState = null;
        } catch (error) {
          this.recordSyncFailure(error);
        }
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  private recordSyncFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.syncFailureState;
    if (!current || current.key !== message) {
      this.syncFailureState = { key: message, count: 1, suppressed: false };
      console.error(`codex-teams: memory-sync warning: ${message}`);
      return;
    }

    current.count += 1;
    if (current.count <= SYNC_FAILURE_LOG_LIMIT) {
      console.error(`codex-teams: memory-sync warning: ${message}`);
      return;
    }

    if (!current.suppressed) {
      current.suppressed = true;
      console.error(`codex-teams: memory-sync warning suppressed for repeated error: ${message}`);
    }
  }

  private async loadSyncIndex(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.syncIndexPath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedSyncIndex;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return;

      const next = new Map<string, SyncIndexEntry>();
      for (const entry of parsed.entries) {
        if (!entry || (entry.scope !== "team" && entry.scope !== "private")) continue;
        if (typeof entry.key !== "string" || entry.key.length === 0) continue;
        if (typeof entry.checksum !== "string" || entry.checksum.length === 0) continue;
        if (!isPositiveInteger(entry.revision)) continue;
        if (typeof entry.updatedAt !== "string") continue;
        next.set(indexKey(entry.scope, entry.key), {
          scope: entry.scope,
          key: entry.key,
          checksum: entry.checksum,
          revision: entry.revision,
          updatedAt: entry.updatedAt,
        });
      }
      this.indexCache = next;
    } catch {
      this.indexCache = new Map();
    }
  }

  private async rebuildSyncIndex(_reason: string): Promise<void> {
    await this.withLock(async () => {
      const next = new Map<string, SyncIndexEntry>();

      for (const scope of ["private", "team"] as MemoryScope[]) {
        const files = await this.walkJsonFiles(this.scopeDir(scope));
        for (const file of files) {
          try {
            const raw = await fs.promises.readFile(file, "utf-8");
            const entry = this.parseStoredEntry(raw, scope);
            next.set(indexKey(entry.scope, entry.key), {
              scope: entry.scope,
              key: entry.key,
              checksum: entry.checksum,
              revision: entry.revision,
              updatedAt: entry.updatedAt.toISOString(),
            });
          } catch {
            continue;
          }
        }
      }

      this.indexCache = next;
      const persisted = mapToObject(next);
      persisted.model = this.syncModel;
      persisted.updatedAt = new Date().toISOString();
      await fs.promises.writeFile(this.syncIndexPath, JSON.stringify(persisted, null, 2), "utf-8");
      this.lastSyncAt = new Date();
    });
  }

  private startSyncWatcher(): void {
    if (!this.enableSyncWatcher || this.watchers.length > 0) return;

    const onEvent = () => this.scheduleSyncReindex("watch");
    for (const dir of [this.privateDir, this.teamDir]) {
      const watcher = this.createWatcher(dir, onEvent);
      if (watcher) this.watchers.push(watcher);
    }
  }

  private createWatcher(dir: string, onEvent: () => void): fs.FSWatcher | null {
    try {
      const watcher = fs.watch(dir, { recursive: true }, onEvent);
      watcher.on("error", (error) => this.recordSyncFailure(error));
      return watcher;
    } catch {
      try {
        const fallback = fs.watch(dir, onEvent);
        fallback.on("error", (error) => this.recordSyncFailure(error));
        return fallback;
      } catch (error) {
        this.recordSyncFailure(error);
        return null;
      }
    }
  }

  private stopSyncWatcher(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch { /* best effort */ }
    }
    this.watchers = [];

    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async cleanup(): Promise<void> {
    this.stopSyncWatcher();
    if (this.pendingSync && !this.syncInProgress) {
      try {
        await this.flushSync("cleanup");
      } catch { /* best effort */ }
    }

    try {
      await fs.promises.rm(this.baseDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}
