import crypto from "node:crypto";

export interface Message {
  id: string;
  from: string;
  fromRole: string;
  text: string;
  timestamp: Date;
}

interface ChatChannel {
  messages: Message[];
  readCursors: Map<string, number>;
}

interface SharedArtifact {
  from: string;
  data: string;
  timestamp: Date;
}

export class MessageSystem {
  private teamChats = new Map<string, ChatChannel>();
  private dms = new Map<string, ChatChannel>();
  private leadChat: ChatChannel = { messages: [], readCursors: new Map() };
  private sharedArtifacts = new Map<string, SharedArtifact[]>();
  private listeners = new Set<(target: { type: string; id: string }) => void>();

  onMessage(cb: (target: { type: string; id: string }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(type: string, id: string): void {
    for (const cb of this.listeners) cb({ type, id });
  }

  private getOrCreateChannel(map: Map<string, ChatChannel>, key: string): ChatChannel {
    let channel = map.get(key);
    if (!channel) {
      channel = { messages: [], readCursors: new Map() };
      map.set(key, channel);
    }
    return channel;
  }

  private getCursor(channel: ChatChannel, agentId: string): number {
    return channel.readCursors.get(agentId) ?? 0;
  }

  private dmKey(a: string, b: string): string {
    return a < b ? `${a}\0${b}` : `${b}\0${a}`;
  }

  private isDmParticipant(key: string, agentId: string): boolean {
    const sep = key.indexOf("\0");
    const a = key.slice(0, sep);
    const b = key.slice(sep + 1);
    return a === agentId || b === agentId;
  }

  private postMessage(channel: ChatChannel, from: string, fromRole: string, text: string): Message {
    const msg: Message = {
      id: crypto.randomUUID(),
      from,
      fromRole,
      text,
      timestamp: new Date(),
    };
    channel.messages.push(msg);
    return msg;
  }

  private readMessages(channel: ChatChannel, agentId: string): Message[] {
    const cursor = this.getCursor(channel, agentId);
    const result: Message[] = [];
    for (let i = cursor; i < channel.messages.length; i++) {
      if (channel.messages[i].from !== agentId) result.push(channel.messages[i]);
    }
    channel.readCursors.set(agentId, channel.messages.length);
    return result;
  }

  private peekCount(channel: ChatChannel, agentId: string): number {
    const cursor = this.getCursor(channel, agentId);
    let count = 0;
    for (let i = cursor; i < channel.messages.length; i++) {
      if (channel.messages[i].from !== agentId) count++;
    }
    return count;
  }

  groupChatPost(teamId: string, agentId: string, agentRole: string, message: string): void {
    const channel = this.getOrCreateChannel(this.teamChats, teamId);
    this.postMessage(channel, agentId, agentRole, message);
    this.notify("team", teamId);
  }

  groupChatRead(teamId: string, agentId: string): Message[] {
    const channel = this.getOrCreateChannel(this.teamChats, teamId);
    return this.readMessages(channel, agentId);
  }

  groupChatPeek(teamId: string, agentId: string): number {
    const channel = this.getOrCreateChannel(this.teamChats, teamId);
    return this.peekCount(channel, agentId);
  }

  dmSend(fromAgentId: string, toAgentId: string, fromRole: string, message: string): void {
    const key = this.dmKey(fromAgentId, toAgentId);
    const channel = this.getOrCreateChannel(this.dms, key);
    this.postMessage(channel, fromAgentId, fromRole, message);
    this.notify("dm", toAgentId);
  }

  dmRead(agentId: string, fromAgentId?: string): Message[] {
    if (fromAgentId) {
      const key = this.dmKey(agentId, fromAgentId);
      const channel = this.dms.get(key);
      if (!channel) return [];
      const cursor = this.getCursor(channel, agentId);
      const result: Message[] = [];
      for (let i = cursor; i < channel.messages.length; i++) {
        if (channel.messages[i].from === fromAgentId) result.push(channel.messages[i]);
      }
      return result;
    }
    const allUnread: Message[] = [];
    for (const [key, channel] of this.dms) {
      if (!this.isDmParticipant(key, agentId)) continue;
      allUnread.push(...this.readMessages(channel, agentId));
    }
    return allUnread.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  dmPeek(agentId: string): number {
    let total = 0;
    for (const [key, channel] of this.dms) {
      if (!this.isDmParticipant(key, agentId)) continue;
      total += this.peekCount(channel, agentId);
    }
    return total;
  }

  leadChatPost(agentId: string, agentRole: string, teamName: string, message: string): void {
    this.postMessage(this.leadChat, agentId, agentRole, `[${teamName}] ${message}`);
    this.notify("lead", "all");
  }

  leadChatRead(agentId: string): Message[] {
    return this.readMessages(this.leadChat, agentId);
  }

  leadChatPeek(agentId: string): number {
    return this.peekCount(this.leadChat, agentId);
  }

  shareArtifact(teamId: string, agentId: string, data: string): void {
    let artifacts = this.sharedArtifacts.get(teamId);
    if (!artifacts) {
      artifacts = [];
      this.sharedArtifacts.set(teamId, artifacts);
    }
    artifacts.push({ from: agentId, data, timestamp: new Date() });
    this.notify("team", teamId);
  }

  getSharedArtifacts(teamId: string): SharedArtifact[] {
    return [...(this.sharedArtifacts.get(teamId) ?? [])];
  }

  getTeamChatMessages(teamId: string): Message[] {
    return [...(this.teamChats.get(teamId)?.messages ?? [])];
  }

  getLeadChatMessages(agentIds?: string[]): Message[] {
    if (!agentIds) return [...this.leadChat.messages];
    const agentSet = new Set(agentIds);
    return this.leadChat.messages.filter((m) => agentSet.has(m.from));
  }

  getAllDmMessages(agentIds: string[]): Message[] {
    const agentSet = new Set(agentIds);
    const all: Message[] = [];
    for (const [key, channel] of this.dms) {
      const [a, b] = key.split("\0");
      if (agentSet.has(a) || agentSet.has(b)) {
        all.push(...channel.messages);
      }
    }
    return all.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  dissolveTeam(teamId: string): void {
    this.teamChats.delete(teamId);
    this.sharedArtifacts.delete(teamId);

    // DM keys contain agent IDs, not team IDs directly.
    // Use dissolveTeamWithAgents() for full cleanup when agent IDs are available.
  }

  dissolveTeamWithAgents(teamId: string, agentIds: string[]): void {
    for (const id of agentIds) this.notify("dissolve", id);

    this.teamChats.delete(teamId);
    this.sharedArtifacts.delete(teamId);

    const agentSet = new Set(agentIds);
    for (const key of this.dms.keys()) {
      const [a, b] = key.split("\0");
      if (agentSet.has(a) && agentSet.has(b)) {
        this.dms.delete(key);
      }
    }

    this.leadChat.messages = this.leadChat.messages.filter((m) => !agentSet.has(m.from));
    for (const id of agentIds) {
      this.leadChat.readCursors.delete(id);
    }
  }
}
