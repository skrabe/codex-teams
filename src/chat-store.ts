import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CHAT_STORE_ROOT = path.join(os.homedir(), ".codex-teams", "chats");
const LOCK_WAIT_BUFFER = new SharedArrayBuffer(4);
const LOCK_WAIT_ARRAY = new Int32Array(LOCK_WAIT_BUFFER);

export interface StoredChatMessage {
  id: string;
  from: string;
  fromRole: string;
  text: string;
  summary?: string;
  timestamp: string;
}

export interface StoredDmMessage extends StoredChatMessage {
  readBy: string[];
}

export interface StoredArtifact {
  from: string;
  data: string;
  timestamp: string;
}

function sleepMs(ms: number): void {
  Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, ms);
}

export class ChatStore {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? DEFAULT_CHAT_STORE_ROOT;
  }

  private teamDir(teamId: string): string {
    return path.join(this.rootDir, teamId);
  }

  private ensureTeamDir(teamId: string): void {
    fs.mkdirSync(this.teamDir(teamId), { recursive: true });
  }

  private ensureDmDir(teamId: string): void {
    fs.mkdirSync(path.join(this.teamDir(teamId), "dms"), { recursive: true });
  }

  private channelPath(teamId: string, channel: string): string {
    return path.join(this.teamDir(teamId), `${channel}.jsonl`);
  }

  private dmPath(teamId: string, key: string): string {
    return path.join(this.teamDir(teamId), "dms", `${key}.jsonl`);
  }

  private cursorsPath(teamId: string): string {
    return path.join(this.teamDir(teamId), "cursors.json");
  }

  private lockDir(teamId: string, scope: string): string {
    return path.join(this.teamDir(teamId), `.${scope}.lock`);
  }

  private withLock<T>(teamId: string, scope: string, callback: () => T): T {
    this.ensureTeamDir(teamId);
    const lock = this.lockDir(teamId, scope);
    const start = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() - start > 5_000) throw new Error(`Lock timeout: ${scope}`);
        sleepMs(10);
      }
    }
    try {
      return callback();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  private appendLine(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(data) + "\n");
  }

  private readLines<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as T);
  }

  private readCursors(teamId: string): Record<string, Record<string, number>> {
    const p = this.cursorsPath(teamId);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  private writeCursors(teamId: string, cursors: Record<string, Record<string, number>>): void {
    this.ensureTeamDir(teamId);
    fs.writeFileSync(this.cursorsPath(teamId), JSON.stringify(cursors, null, 2));
  }

  appendGroupChat(teamId: string, msg: StoredChatMessage): void {
    this.ensureTeamDir(teamId);
    this.appendLine(this.channelPath(teamId, "group-chat"), msg);
  }

  readGroupChat(teamId: string, agentId: string): StoredChatMessage[] {
    return this.withLock(teamId, "cursors", () => {
      const all = this.readLines<StoredChatMessage>(this.channelPath(teamId, "group-chat"));
      const cursors = this.readCursors(teamId);
      const agentCursors = cursors[agentId] ?? {};
      const cursor = agentCursors.groupChat ?? 0;
      const unread = all.slice(cursor).filter((m) => m.from !== agentId);
      agentCursors.groupChat = all.length;
      cursors[agentId] = agentCursors;
      this.writeCursors(teamId, cursors);
      return unread;
    });
  }

  peekGroupChat(teamId: string, agentId: string): number {
    const all = this.readLines<StoredChatMessage>(this.channelPath(teamId, "group-chat"));
    const cursors = this.readCursors(teamId);
    const cursor = cursors[agentId]?.groupChat ?? 0;
    let count = 0;
    for (let i = cursor; i < all.length; i++) {
      if (all[i].from !== agentId) count++;
    }
    return count;
  }

  getAllGroupChat(teamId: string): StoredChatMessage[] {
    return this.readLines<StoredChatMessage>(this.channelPath(teamId, "group-chat"));
  }

  appendLeadChat(msg: StoredChatMessage): void {
    const dir = path.join(this.rootDir, "_lead");
    fs.mkdirSync(dir, { recursive: true });
    this.appendLine(path.join(dir, "lead-chat.jsonl"), msg);
  }

  readLeadChat(agentId: string): StoredChatMessage[] {
    const lockScope = "lead-cursors";
    const dir = path.join(this.rootDir, "_lead");
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, `.${lockScope}.lock`);
    const cursorsPath = path.join(dir, "cursors.json");
    const chatPath = path.join(dir, "lead-chat.jsonl");

    const start = Date.now();
    for (;;) {
      try { fs.mkdirSync(lockPath); break; } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() - start > 5_000) throw new Error("Lock timeout: lead-cursors");
        sleepMs(10);
      }
    }
    try {
      const all = this.readLines<StoredChatMessage>(chatPath);
      const cursors: Record<string, number> = fs.existsSync(cursorsPath)
        ? JSON.parse(fs.readFileSync(cursorsPath, "utf8"))
        : {};
      const cursor = cursors[agentId] ?? 0;
      const unread = all.slice(cursor).filter((m) => m.from !== agentId);
      cursors[agentId] = all.length;
      fs.writeFileSync(cursorsPath, JSON.stringify(cursors, null, 2));
      return unread;
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  peekLeadChat(agentId: string): number {
    const chatPath = path.join(this.rootDir, "_lead", "lead-chat.jsonl");
    const cursorsPath = path.join(this.rootDir, "_lead", "cursors.json");
    const all = this.readLines<StoredChatMessage>(chatPath);
    const cursors: Record<string, number> = fs.existsSync(cursorsPath)
      ? JSON.parse(fs.readFileSync(cursorsPath, "utf8"))
      : {};
    const cursor = cursors[agentId] ?? 0;
    let count = 0;
    for (let i = cursor; i < all.length; i++) {
      if (all[i].from !== agentId) count++;
    }
    return count;
  }

  getAllLeadChat(agentIds?: string[]): StoredChatMessage[] {
    const chatPath = path.join(this.rootDir, "_lead", "lead-chat.jsonl");
    const all = this.readLines<StoredChatMessage>(chatPath);
    if (!agentIds) return all;
    const set = new Set(agentIds);
    return all.filter((m) => set.has(m.from));
  }

  dmKey(a: string, b: string): string {
    return a < b ? `${a}__${b}` : `${b}__${a}`;
  }

  appendDm(teamId: string, key: string, msg: StoredDmMessage): void {
    this.ensureDmDir(teamId);
    this.appendLine(this.dmPath(teamId, key), msg);
  }

  readDms(teamId: string, agentId: string, fromAgentId?: string): StoredDmMessage[] {
    return this.withLock(teamId, "dm-read", () => {
      const dmDir = path.join(this.teamDir(teamId), "dms");
      if (!fs.existsSync(dmDir)) return [];

      const allUnread: StoredDmMessage[] = [];
      const files = fs.readdirSync(dmDir).filter((f) => f.endsWith(".jsonl"));

      for (const file of files) {
        const key = file.replace(".jsonl", "");
        if (!this.isDmParticipant(key, agentId)) continue;
        const messages = this.readLines<StoredDmMessage>(path.join(dmDir, file));

        for (const msg of messages) {
          if (msg.from === agentId) continue;
          if (fromAgentId && msg.from !== fromAgentId) continue;
          if (msg.readBy.includes(agentId)) continue;
          msg.readBy.push(agentId);
          allUnread.push(msg);
        }

        this.writeLines(path.join(dmDir, file), messages);
      }

      return allUnread.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    });
  }

  peekDms(teamId: string, agentId: string): number {
    const dmDir = path.join(this.teamDir(teamId), "dms");
    if (!fs.existsSync(dmDir)) return 0;
    let total = 0;
    for (const file of fs.readdirSync(dmDir).filter((f) => f.endsWith(".jsonl"))) {
      const key = file.replace(".jsonl", "");
      if (!this.isDmParticipant(key, agentId)) continue;
      const messages = this.readLines<StoredDmMessage>(path.join(dmDir, file));
      for (const msg of messages) {
        if (msg.from !== agentId && !msg.readBy.includes(agentId)) total++;
      }
    }
    return total;
  }

  getAllDms(teamId: string, agentIds: string[]): StoredChatMessage[] {
    const dmDir = path.join(this.teamDir(teamId), "dms");
    if (!fs.existsSync(dmDir)) return [];
    const agentSet = new Set(agentIds);
    const all: StoredChatMessage[] = [];
    for (const file of fs.readdirSync(dmDir).filter((f) => f.endsWith(".jsonl"))) {
      const key = file.replace(".jsonl", "");
      const parts = key.split("__");
      if (agentSet.has(parts[0]) || agentSet.has(parts[1])) {
        all.push(...this.readLines<StoredChatMessage>(path.join(dmDir, file)));
      }
    }
    return all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  getLastPeerDmSent(teamId: string, fromAgentId: string, excludeRecipientId: string): { message: StoredDmMessage; toAgentId: string } | undefined {
    const dmDir = path.join(this.teamDir(teamId), "dms");
    if (!fs.existsSync(dmDir)) return undefined;

    let latestMsg: StoredDmMessage | undefined;
    let latestRecipient: string | undefined;
    let latestTime = 0;

    for (const file of fs.readdirSync(dmDir).filter((f) => f.endsWith(".jsonl"))) {
      const key = file.replace(".jsonl", "");
      if (!this.isDmParticipant(key, fromAgentId)) continue;
      const parts = key.split("__");
      const otherParty = parts[0] === fromAgentId ? parts[1] : parts[0];
      if (otherParty === excludeRecipientId) continue;

      const messages = this.readLines<StoredDmMessage>(path.join(dmDir, file));
      for (const msg of messages) {
        if (msg.from !== fromAgentId) continue;
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime > latestTime) {
          latestTime = msgTime;
          latestMsg = msg;
          latestRecipient = otherParty;
        }
      }
    }

    if (!latestMsg || !latestRecipient) return undefined;
    return { message: latestMsg, toAgentId: latestRecipient };
  }

  appendArtifact(teamId: string, artifact: StoredArtifact): void {
    this.ensureTeamDir(teamId);
    this.appendLine(this.channelPath(teamId, "artifacts"), artifact);
  }

  getArtifacts(teamId: string): StoredArtifact[] {
    return this.readLines<StoredArtifact>(this.channelPath(teamId, "artifacts"));
  }

  deleteTeam(teamId: string): void {
    const dir = this.teamDir(teamId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  deleteAll(teamId: string, agentIds: string[]): void {
    this.deleteTeam(teamId);
    if (teamId !== "default") this.deleteDmsForAgents("default", agentIds);
    const leadDir = path.join(this.rootDir, "_lead");
    if (!fs.existsSync(leadDir)) return;
    const chatPath = path.join(leadDir, "lead-chat.jsonl");
    if (fs.existsSync(chatPath)) {
      const messages = this.readLines<StoredChatMessage>(chatPath);
      const agentSet = new Set(agentIds);
      const filtered = messages.filter((m) => !agentSet.has(m.from));
      if (filtered.length === 0) {
        fs.rmSync(chatPath, { force: true });
      } else {
        this.writeLines(chatPath, filtered);
      }
    }
    const cursorsPath = path.join(leadDir, "cursors.json");
    if (fs.existsSync(cursorsPath)) {
      const cursors: Record<string, number> = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
      for (const id of agentIds) delete cursors[id];
      fs.writeFileSync(cursorsPath, JSON.stringify(cursors, null, 2));
    }
  }

  deleteDmsForAgents(teamId: string, agentIds: string[]): void {
    const dmDir = path.join(this.teamDir(teamId), "dms");
    if (!fs.existsSync(dmDir)) return;
    const agentSet = new Set(agentIds);
    for (const file of fs.readdirSync(dmDir).filter((f) => f.endsWith(".jsonl"))) {
      const key = file.replace(".jsonl", "");
      const parts = key.split("__");
      if (agentSet.has(parts[0]) && agentSet.has(parts[1])) {
        fs.rmSync(path.join(dmDir, file), { force: true });
      }
    }
  }

  private isDmParticipant(key: string, agentId: string): boolean {
    const parts = key.split("__");
    return parts[0] === agentId || parts[1] === agentId;
  }

  private writeLines<T>(filePath: string, items: T[]): void {
    fs.writeFileSync(filePath, items.map((item) => JSON.stringify(item)).join("\n") + (items.length > 0 ? "\n" : ""));
  }
}
