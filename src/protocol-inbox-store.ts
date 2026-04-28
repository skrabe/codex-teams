import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProtocolMessage } from "./messages.js";

const LOCK_WAIT_BUFFER = new SharedArrayBuffer(4);
const LOCK_WAIT_ARRAY = new Int32Array(LOCK_WAIT_BUFFER);

export const DEFAULT_PROTOCOL_INBOX_ROOT = path.join(os.homedir(), ".codex-teams", "inboxes");

type ProtocolMessageState = "queued" | "leased" | "read";
type ProtocolMessageStateV2 = "unread" | "delivered" | "read";

interface StoredProtocolMessageV2 {
  id: string;
  type: ProtocolMessage["type"];
  from: string;
  to: string;
  data?: Record<string, unknown>;
  timestamp: string;
  state: ProtocolMessageStateV2;
  deliveryId?: string;
  deliveredAt?: string;
  readAt?: string;
}

interface StoredProtocolInboxV2 {
  version: 2;
  messages: StoredProtocolMessageV2[];
}

interface StoredProtocolMessageV3 {
  id: string;
  type: ProtocolMessage["type"];
  from: string;
  to: string;
  data?: Record<string, unknown>;
  timestamp: string;
  state: ProtocolMessageState;
  deliveryId?: string;
  leasedAt?: string;
  readAt?: string;
}

interface StoredProtocolInboxV3 {
  version: 3;
  messages: StoredProtocolMessageV3[];
  activeDeliveryId?: string;
  lastDeliveredAt?: string;
  lastProcessedAt?: string;
}

export interface ProtocolReadBatch {
  deliveryId: string | null;
  messages: ProtocolMessage[];
}

export interface ProtocolQueueSummary {
  queued: number;
  leased: number;
  activeDeliveryId: string | null;
  nextMessageType: ProtocolMessage["type"] | null;
  lastDeliveredAt?: Date;
  lastProcessedAt?: Date;
}

function sleepMs(ms: number): void {
  Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, ms);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function parseStoredMessageV2(value: unknown): StoredProtocolMessageV2 {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid protocol inbox entry: expected object");
  }

  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state !== "unread" && state !== "delivered" && state !== "read") {
    throw new Error("Invalid protocol inbox entry: missing or invalid state");
  }

  if (typeof record.id !== "string") throw new Error("Invalid protocol inbox entry: id");
  if (typeof record.type !== "string") throw new Error("Invalid protocol inbox entry: type");
  if (typeof record.from !== "string") throw new Error("Invalid protocol inbox entry: from");
  if (typeof record.to !== "string") throw new Error("Invalid protocol inbox entry: to");
  if (typeof record.timestamp !== "string") throw new Error("Invalid protocol inbox entry: timestamp");

  const message: StoredProtocolMessageV2 = {
    id: record.id,
    type: record.type as ProtocolMessage["type"],
    from: record.from,
    to: record.to,
    data: record.data as Record<string, unknown> | undefined,
    timestamp: record.timestamp,
    state,
    deliveryId: typeof record.deliveryId === "string" ? record.deliveryId : undefined,
    deliveredAt: typeof record.deliveredAt === "string" ? record.deliveredAt : undefined,
    readAt: typeof record.readAt === "string" ? record.readAt : undefined,
  };

  return message;
}

function parseInboxV2(raw: string): StoredProtocolInboxV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid protocol inbox file: expected valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid protocol inbox file: expected object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 2) {
    throw new Error("Unsupported protocol inbox version; expected version 2");
  }

  if (!Array.isArray(record.messages)) {
    throw new Error("Invalid protocol inbox file: messages must be an array");
  }

  return {
    version: 2,
    messages: record.messages.map(parseStoredMessageV2),
  };
}

function parseStoredMessageV3(value: unknown): StoredProtocolMessageV3 {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid protocol inbox entry: expected object");
  }

  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state !== "queued" && state !== "leased" && state !== "read") {
    throw new Error("Invalid protocol inbox entry: missing or invalid state");
  }

  if (typeof record.id !== "string") throw new Error("Invalid protocol inbox entry: id");
  if (typeof record.type !== "string") throw new Error("Invalid protocol inbox entry: type");
  if (typeof record.from !== "string") throw new Error("Invalid protocol inbox entry: from");
  if (typeof record.to !== "string") throw new Error("Invalid protocol inbox entry: to");
  if (typeof record.timestamp !== "string") throw new Error("Invalid protocol inbox entry: timestamp");

  return {
    id: record.id,
    type: record.type as ProtocolMessage["type"],
    from: record.from,
    to: record.to,
    data: record.data as Record<string, unknown> | undefined,
    timestamp: record.timestamp,
    state,
    deliveryId: typeof record.deliveryId === "string" ? record.deliveryId : undefined,
    leasedAt: typeof record.leasedAt === "string" ? record.leasedAt : undefined,
    readAt: typeof record.readAt === "string" ? record.readAt : undefined,
  };
}

function parseInboxV3(raw: string): StoredProtocolInboxV3 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid protocol inbox file: expected valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid protocol inbox file: expected object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 3) {
    throw new Error("Unsupported protocol inbox version; expected version 3");
  }

  if (!Array.isArray(record.messages)) {
    throw new Error("Invalid protocol inbox file: messages must be an array");
  }

  return {
    version: 3,
    messages: record.messages.map(parseStoredMessageV3),
    activeDeliveryId: typeof record.activeDeliveryId === "string" ? record.activeDeliveryId : undefined,
    lastDeliveredAt: typeof record.lastDeliveredAt === "string" ? record.lastDeliveredAt : undefined,
    lastProcessedAt: typeof record.lastProcessedAt === "string" ? record.lastProcessedAt : undefined,
  };
}

function parseInbox(raw: string): StoredProtocolInboxV3 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid protocol inbox file: expected valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid protocol inbox file: expected object");
  }

  const version = (parsed as Record<string, unknown>).version;
  if (version === 3) {
    return parseInboxV3(raw);
  }

  if (version === 2) {
    const inbox = parseInboxV2(raw);
    return {
      version: 3,
      messages: inbox.messages.map((message) => ({
        id: message.id,
        type: message.type,
        from: message.from,
        to: message.to,
        data: message.data,
        timestamp: message.timestamp,
        state: message.state === "read" ? "read" : "queued",
        readAt: message.readAt,
      })),
    };
  }

  throw new Error("Unsupported protocol inbox version");
}

function toProtocolMessage(message: StoredProtocolMessageV3): ProtocolMessage {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    data: message.data,
    timestamp: new Date(message.timestamp),
  };
}

function protocolPriority(type: ProtocolMessage["type"]): number {
  switch (type) {
    case "shutdown_request":
    case "shutdown_approved":
    case "shutdown_rejected":
      return 0;
    case "plan_approval_response":
    case "permission_response":
    case "sandbox_permission_response":
      return 1;
    case "plan_approval_request":
    case "permission_request":
    case "sandbox_permission_request":
    case "mode_set_request":
    case "team_permission_update":
      return 2;
    case "task_assignment":
      return 3;
    case "idle_notification":
      return 4;
    default:
      return 5;
  }
}

function sortProtocolMessages<T extends StoredProtocolMessageV3>(messages: T[]): T[] {
  return [...messages].sort((left, right) => {
    const priorityDelta = protocolPriority(left.type) - protocolPriority(right.type);
    if (priorityDelta !== 0) return priorityDelta;
    return new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
  });
}

export class ProtocolInboxStore {
  constructor(private readonly rootDir = DEFAULT_PROTOCOL_INBOX_ROOT) {}

  append(message: ProtocolMessage): void {
    this.withInboxLock(message.to, () => {
      const inbox = this.readInboxUnlocked(message.to);
      inbox.messages.push({
        id: message.id,
        type: message.type,
        from: message.from,
        to: message.to,
        data: message.data,
        timestamp: message.timestamp.toISOString(),
        state: "queued",
      });
      this.writeInboxUnlocked(message.to, inbox);
    });
  }

  readForDelivery(agentId: string): ProtocolReadBatch {
    return this.withInboxLock(agentId, () => {
      const inbox = this.readInboxUnlocked(agentId);
      const leased = sortProtocolMessages(inbox.messages.filter((message) => message.state === "leased"));
      if (leased.length > 0) {
        const deliveryId = inbox.activeDeliveryId ?? leased[0]?.deliveryId ?? crypto.randomUUID();
        let mutated = false;
        if (inbox.activeDeliveryId !== deliveryId) {
          inbox.activeDeliveryId = deliveryId;
          mutated = true;
        }
        for (const message of inbox.messages) {
          if (message.state !== "leased") continue;
          if (message.deliveryId === deliveryId) continue;
          message.deliveryId = deliveryId;
          mutated = true;
        }
        if (mutated) {
          this.writeInboxUnlocked(agentId, inbox);
        }
        return {
          deliveryId,
          messages: leased.map(toProtocolMessage),
        };
      }

      const queued = sortProtocolMessages(inbox.messages.filter((message) => message.state === "queued"));
      if (queued.length === 0) {
        return { deliveryId: null, messages: [] };
      }

      const deliveryId = crypto.randomUUID();
      const leasedAt = new Date().toISOString();
      for (const message of inbox.messages) {
        if (message.state !== "queued") continue;
        message.state = "leased";
        message.deliveryId = deliveryId;
        message.leasedAt = leasedAt;
      }
      inbox.activeDeliveryId = deliveryId;
      inbox.lastDeliveredAt = leasedAt;
      this.writeInboxUnlocked(agentId, inbox);

      return {
        deliveryId,
        messages: queued.map(toProtocolMessage),
      };
    });
  }

  ackDelivery(agentId: string, deliveryId: string): ProtocolMessage[] {
    return this.withInboxLock(agentId, () => {
      const inbox = this.readInboxUnlocked(agentId);
      const readAt = new Date().toISOString();
      const acked: StoredProtocolMessageV3[] = [];

      for (const message of inbox.messages) {
        if (message.state !== "leased") continue;
        if (message.deliveryId !== deliveryId) continue;
        message.state = "read";
        message.readAt = readAt;
        acked.push(message);
      }

      if (acked.length > 0) {
        if (inbox.activeDeliveryId === deliveryId) {
          delete inbox.activeDeliveryId;
        }
        inbox.lastProcessedAt = readAt;
        this.writeInboxUnlocked(agentId, inbox);
      }

      return acked.map(toProtocolMessage);
    });
  }

  peek(agentId: string): number {
    return this.withInboxLock(agentId, () => {
      const inbox = this.readInboxUnlocked(agentId);
      return inbox.messages.filter((message) => message.state === "queued" || message.state === "leased").length;
    });
  }

  summary(agentId: string): ProtocolQueueSummary {
    return this.withInboxLock(agentId, () => {
      const inbox = this.readInboxUnlocked(agentId);
      const queued = sortProtocolMessages(inbox.messages.filter((message) => message.state === "queued"));
      const leased = sortProtocolMessages(inbox.messages.filter((message) => message.state === "leased"));
      const next = leased[0] ?? queued[0];
      return {
        queued: queued.length,
        leased: leased.length,
        activeDeliveryId: inbox.activeDeliveryId ?? null,
        nextMessageType: next?.type ?? null,
        lastDeliveredAt: inbox.lastDeliveredAt ? new Date(inbox.lastDeliveredAt) : undefined,
        lastProcessedAt: inbox.lastProcessedAt ? new Date(inbox.lastProcessedAt) : undefined,
      };
    });
  }

  listActionable(agentId: string): ProtocolMessage[] {
    return this.withInboxLock(agentId, () => {
      const inbox = this.readInboxUnlocked(agentId);
      return sortProtocolMessages(
        inbox.messages.filter((message) => message.state === "queued" || message.state === "leased"),
      ).map(toProtocolMessage);
    });
  }

  list(agentId: string): ProtocolMessage[] {
    return this.withInboxLock(agentId, () => sortProtocolMessages(this.readInboxUnlocked(agentId).messages).map(toProtocolMessage));
  }

  deleteInboxes(agentIds: string[]): void {
    this.ensureRootDir();
    for (const agentId of agentIds) {
      fs.rmSync(this.getInboxPath(agentId), { force: true });
      fs.rmSync(this.getLockDir(agentId), { recursive: true, force: true });
    }
    if (fs.existsSync(this.rootDir) && fs.readdirSync(this.rootDir).length === 0) {
      fs.rmSync(this.rootDir, { recursive: true, force: true });
    }
  }

  private withInboxLock<T>(agentId: string, callback: () => T): T {
    this.ensureRootDir();
    const lockDir = this.getLockDir(agentId);
    const start = Date.now();

    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (Date.now() - start > 5_000) {
          throw new Error(`Timed out acquiring protocol inbox lock for ${agentId}`);
        }
        sleepMs(10);
      }
    }

    try {
      return callback();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  private ensureRootDir(): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  private getInboxPath(agentId: string): string {
    return path.join(this.rootDir, `${agentId}.json`);
  }

  private getLockDir(agentId: string): string {
    return path.join(this.rootDir, `${agentId}.lock`);
  }

  private readInboxUnlocked(agentId: string): StoredProtocolInboxV3 {
    const inboxPath = this.getInboxPath(agentId);
    if (!fs.existsSync(inboxPath)) return { version: 3, messages: [] };
    const raw = fs.readFileSync(inboxPath, "utf8");
    return parseInbox(raw);
  }

  private writeInboxUnlocked(agentId: string, inbox: StoredProtocolInboxV3): void {
    fs.writeFileSync(this.getInboxPath(agentId), JSON.stringify(inbox, null, 2));
  }
}
