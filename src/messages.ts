import crypto from "node:crypto";
import { ProtocolInboxStore, type ProtocolQueueSummary } from "./protocol-inbox-store.js";
import { ChatStore, type StoredChatMessage, type StoredDmMessage, type StoredArtifact } from "./chat-store.js";

export interface Message {
  id: string;
  from: string;
  fromRole: string;
  text: string;
  summary?: string;
  timestamp: Date;
}

export type ProtocolMessageType =
  | "idle_notification"
  | "permission_request"
  | "permission_response"
  | "sandbox_permission_request"
  | "sandbox_permission_response"
  | "plan_approval_request"
  | "plan_approval_response"
  | "shutdown_request"
  | "shutdown_approved"
  | "shutdown_rejected"
  | "task_assignment"
  | "mode_set_request"
  | "team_permission_update";

export interface ProtocolMessage {
  id: string;
  type: ProtocolMessageType;
  from: string;
  to: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

export interface ProtocolReadResult {
  deliveryId: string | null;
  messages: ProtocolMessage[];
}

export type { ProtocolQueueSummary } from "./protocol-inbox-store.js";

interface SharedArtifact {
  from: string;
  data: string;
  timestamp: Date;
}

function toMessage(stored: StoredChatMessage): Message {
  return {
    id: stored.id,
    from: stored.from,
    fromRole: stored.fromRole,
    text: stored.text,
    summary: stored.summary,
    timestamp: new Date(stored.timestamp),
  };
}

export class MessageSystem {
  private chatStore: ChatStore;
  private protocolInboxStore: ProtocolInboxStore;
  private listeners = new Set<(target: { type: string; id: string }) => void>();
  private teamIds = new Map<string, string>();

  constructor(protocolInboxRootDir?: string, chatStoreRootDir?: string) {
    this.protocolInboxStore = new ProtocolInboxStore(protocolInboxRootDir);
    this.chatStore = new ChatStore(chatStoreRootDir);
  }

  setTeamId(teamId: string): void {
    this.teamIds.set(teamId, teamId);
  }

  onMessage(cb: (target: { type: string; id: string }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(type: string, id: string): void {
    for (const cb of this.listeners) cb({ type, id });
  }

  groupChatPost(teamId: string, agentId: string, agentRole: string, message: string): void {
    const msg: StoredChatMessage = {
      id: crypto.randomUUID(),
      from: agentId,
      fromRole: agentRole,
      text: message,
      timestamp: new Date().toISOString(),
    };
    this.chatStore.appendGroupChat(teamId, msg);
    this.notify("team", teamId);
  }

  groupChatRead(teamId: string, agentId: string): Message[] {
    return this.chatStore.readGroupChat(teamId, agentId).map(toMessage);
  }

  groupChatPeek(teamId: string, agentId: string): number {
    return this.chatStore.peekGroupChat(teamId, agentId);
  }

  dmSend(fromAgentId: string, toAgentId: string, fromRole: string, message: string, summary?: string): void {
    const teamId = this.resolveTeamForDm(fromAgentId, toAgentId);
    const key = this.chatStore.dmKey(fromAgentId, toAgentId);
    const msg: StoredDmMessage = {
      id: crypto.randomUUID(),
      from: fromAgentId,
      fromRole,
      text: message,
      summary: summary?.trim() || message,
      timestamp: new Date().toISOString(),
      readBy: [],
    };
    this.chatStore.appendDm(teamId, key, msg);
    this.notify("dm", toAgentId);
  }

  dmRead(agentId: string, fromAgentId?: string): Message[] {
    const teamId = this.resolveTeamForAgent(agentId);
    return this.chatStore.readDms(teamId, agentId, fromAgentId).map(toMessage);
  }

  dmPeek(agentId: string): number {
    const teamId = this.resolveTeamForAgent(agentId);
    return this.chatStore.peekDms(teamId, agentId);
  }

  protocolSend(fromAgentId: string, toAgentId: string, type: ProtocolMessageType, data?: Record<string, unknown>): void {
    this.protocolInboxStore.append({
      id: crypto.randomUUID(),
      type,
      from: fromAgentId,
      to: toAgentId,
      data,
      timestamp: new Date(),
    });
    this.notify("protocol", toAgentId);
  }

  protocolRead(agentId: string): ProtocolReadResult {
    return this.protocolInboxStore.readForDelivery(agentId);
  }

  protocolAck(agentId: string, deliveryId: string): ProtocolMessage[] {
    return this.protocolInboxStore.ackDelivery(agentId, deliveryId);
  }

  protocolPeek(agentId: string): number {
    return this.protocolInboxStore.peek(agentId);
  }

  protocolSummary(agentId: string): ProtocolQueueSummary {
    return this.protocolInboxStore.summary(agentId);
  }

  protocolListActionable(agentId: string): ProtocolMessage[] {
    return this.protocolInboxStore.listActionable(agentId);
  }

  protocolPeekAll(agentId: string): ProtocolMessage[] {
    return this.protocolInboxStore.list(agentId);
  }

  leadChatPost(agentId: string, agentRole: string, teamName: string, message: string): void {
    const msg: StoredChatMessage = {
      id: crypto.randomUUID(),
      from: agentId,
      fromRole: agentRole,
      text: `[${teamName}] ${message}`,
      timestamp: new Date().toISOString(),
    };
    this.chatStore.appendLeadChat(msg);
    this.notify("lead", "all");
  }

  leadChatRead(agentId: string): Message[] {
    return this.chatStore.readLeadChat(agentId).map(toMessage);
  }

  leadChatPeek(agentId: string): number {
    return this.chatStore.peekLeadChat(agentId);
  }

  shareArtifact(teamId: string, agentId: string, data: string): void {
    this.chatStore.appendArtifact(teamId, {
      from: agentId,
      data,
      timestamp: new Date().toISOString(),
    });
    this.notify("team", teamId);
  }

  getSharedArtifacts(teamId: string): SharedArtifact[] {
    return this.chatStore.getArtifacts(teamId).map((a) => ({
      from: a.from,
      data: a.data,
      timestamp: new Date(a.timestamp),
    }));
  }

  getTeamChatMessages(teamId: string): Message[] {
    return this.chatStore.getAllGroupChat(teamId).map(toMessage);
  }

  getLeadChatMessages(agentIds?: string[]): Message[] {
    return this.chatStore.getAllLeadChat(agentIds).map(toMessage);
  }

  getAllDmMessages(agentIds: string[]): Message[] {
    const teamId = this.resolveTeamForAgent(agentIds[0]);
    return this.chatStore.getAllDms(teamId, agentIds).map(toMessage);
  }

  getLastPeerDmSummary(fromAgentId: string, excludeRecipientId: string): string | undefined {
    const teamId = this.resolveTeamForAgent(fromAgentId);
    const lastDm = this.chatStore.getLastPeerDmSent(teamId, fromAgentId, excludeRecipientId);
    if (!lastDm) return undefined;
    const summary = lastDm.message.summary ?? lastDm.message.text.slice(0, 80);
    return `[to ${lastDm.toAgentId}] ${summary}`;
  }

  getAllProtocolMessages(agentIds: string[]): ProtocolMessage[] {
    const all: ProtocolMessage[] = [];
    for (const agentId of agentIds) {
      all.push(...this.protocolInboxStore.list(agentId));
    }
    return all.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  dissolveTeam(teamId: string): void {
    this.chatStore.deleteTeam(teamId);
  }

  dissolveTeamWithAgents(teamId: string, agentIds: string[]): void {
    for (const id of agentIds) this.notify("dissolve", id);
    this.chatStore.deleteAll(teamId, agentIds);
    this.protocolInboxStore.deleteInboxes(agentIds);
    for (const id of agentIds) this.agentTeamMap.delete(id);
  }

  registerAgentTeam(agentId: string, teamId: string): void {
    this.agentTeamMap.set(agentId, teamId);
  }

  private agentTeamMap = new Map<string, string>();

  private resolveTeamForAgent(agentId: string): string {
    return this.agentTeamMap.get(agentId) ?? "default";
  }

  private resolveTeamForDm(fromAgentId: string, toAgentId: string): string {
    return this.agentTeamMap.get(fromAgentId) ?? this.agentTeamMap.get(toAgentId) ?? "default";
  }
}
