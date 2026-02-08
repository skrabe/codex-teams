import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MessageSystem } from "../src/messages.js";

describe("MessageSystem", () => {
  let ms: MessageSystem;

  beforeEach(() => {
    ms = new MessageSystem();
  });

  describe("group chat", () => {
    it("posts and reads messages", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "hello team");
      ms.groupChatPost("team1", "agent-b", "tester", "hi there");

      const msgs = ms.groupChatRead("team1", "agent-c");
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].from, "agent-a");
      assert.equal(msgs[0].fromRole, "dev");
      assert.equal(msgs[0].text, "hello team");
      assert.equal(msgs[1].from, "agent-b");
      assert.equal(msgs[1].text, "hi there");
    });

    it("read returns only unread messages", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "msg1");
      ms.groupChatPost("team1", "agent-b", "tester", "msg2");

      const first = ms.groupChatRead("team1", "agent-c");
      assert.equal(first.length, 2);

      ms.groupChatPost("team1", "agent-a", "dev", "msg3");

      const second = ms.groupChatRead("team1", "agent-c");
      assert.equal(second.length, 1);
      assert.equal(second[0].text, "msg3");
    });

    it("read advances cursor so subsequent read returns empty", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "msg1");
      ms.groupChatRead("team1", "agent-b");
      const empty = ms.groupChatRead("team1", "agent-b");
      assert.equal(empty.length, 0);
    });

    it("each agent has independent read cursor", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "msg1");
      ms.groupChatPost("team1", "agent-a", "dev", "msg2");

      const agentB = ms.groupChatRead("team1", "agent-b");
      assert.equal(agentB.length, 2);

      const agentC = ms.groupChatRead("team1", "agent-c");
      assert.equal(agentC.length, 2);

      ms.groupChatPost("team1", "agent-a", "dev", "msg3");

      const agentB2 = ms.groupChatRead("team1", "agent-b");
      assert.equal(agentB2.length, 1);

      const agentC2 = ms.groupChatRead("team1", "agent-c");
      assert.equal(agentC2.length, 1);
    });

    it("peek returns unread count without advancing cursor", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "msg1");
      ms.groupChatPost("team1", "agent-a", "dev", "msg2");

      assert.equal(ms.groupChatPeek("team1", "agent-b"), 2);
      assert.equal(ms.groupChatPeek("team1", "agent-b"), 2);

      ms.groupChatRead("team1", "agent-b");
      assert.equal(ms.groupChatPeek("team1", "agent-b"), 0);
    });

    it("peek returns 0 for empty channel", () => {
      assert.equal(ms.groupChatPeek("team1", "agent-a"), 0);
    });

    it("different teams have separate channels", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "team1 msg");
      ms.groupChatPost("team2", "agent-b", "dev", "team2 msg");

      const t1 = ms.groupChatRead("team1", "agent-c");
      assert.equal(t1.length, 1);
      assert.equal(t1[0].text, "team1 msg");

      const t2 = ms.groupChatRead("team2", "agent-c");
      assert.equal(t2.length, 1);
      assert.equal(t2[0].text, "team2 msg");
    });

    it("poster sees their own message on read", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "my msg");
      const msgs = ms.groupChatRead("team1", "agent-a");
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].from, "agent-a");
    });

    it("messages have unique IDs", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "msg1");
      ms.groupChatPost("team1", "agent-a", "dev", "msg2");
      const msgs = ms.groupChatRead("team1", "agent-b");
      assert.notEqual(msgs[0].id, msgs[1].id);
    });

    it("messages have timestamps", () => {
      const before = new Date();
      ms.groupChatPost("team1", "agent-a", "dev", "msg1");
      const after = new Date();
      const msgs = ms.groupChatRead("team1", "agent-b");
      assert.ok(msgs[0].timestamp >= before);
      assert.ok(msgs[0].timestamp <= after);
    });

    it("handles large message volume", () => {
      for (let i = 0; i < 1000; i++) {
        ms.groupChatPost("team1", "agent-a", "dev", `msg-${i}`);
      }

      assert.equal(ms.groupChatPeek("team1", "agent-b"), 1000);

      const first500 = ms.groupChatRead("team1", "agent-b");
      assert.equal(first500.length, 1000);
      assert.equal(first500[0].text, "msg-0");
      assert.equal(first500[999].text, "msg-999");

      assert.equal(ms.groupChatPeek("team1", "agent-b"), 0);

      ms.groupChatPost("team1", "agent-a", "dev", "msg-1000");
      assert.equal(ms.groupChatPeek("team1", "agent-b"), 1);
    });

    it("late joiner gets full history (cursor starts at 0)", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "msg1");
      ms.groupChatPost("team1", "agent-a", "dev", "msg2");
      ms.groupChatPost("team1", "agent-a", "dev", "msg3");

      const msgs = ms.groupChatRead("team1", "new-agent");
      assert.equal(msgs.length, 3);
      assert.equal(msgs[0].text, "msg1");
    });
  });

  describe("DMs", () => {
    it("sends and reads a DM", () => {
      ms.dmSend("agent-a", "agent-b", "dev", "hey b");
      const msgs = ms.dmRead("agent-b");
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].from, "agent-a");
      assert.equal(msgs[0].fromRole, "dev");
      assert.equal(msgs[0].text, "hey b");
    });

    it("DMs are bidirectional on the same channel", () => {
      ms.dmSend("agent-a", "agent-b", "dev", "hi b");
      ms.dmSend("agent-b", "agent-a", "tester", "hi a");

      const aReads = ms.dmRead("agent-a");
      assert.equal(aReads.length, 2);
      assert.equal(aReads[0].text, "hi b");
      assert.equal(aReads[1].text, "hi a");

      const bReads = ms.dmRead("agent-b");
      assert.equal(bReads.length, 2);
    });

    it("each agent has independent DM cursor", () => {
      ms.dmSend("agent-a", "agent-b", "dev", "msg1");

      const aReads = ms.dmRead("agent-a");
      assert.equal(aReads.length, 1);

      const bReads = ms.dmRead("agent-b");
      assert.equal(bReads.length, 1);

      ms.dmSend("agent-b", "agent-a", "tester", "msg2");

      const aReads2 = ms.dmRead("agent-a");
      assert.equal(aReads2.length, 1);
      assert.equal(aReads2[0].text, "msg2");

      const bReads2 = ms.dmRead("agent-b");
      assert.equal(bReads2.length, 1);
      assert.equal(bReads2[0].text, "msg2");
    });

    it("read with fromAgentId filter returns only messages from that sender", () => {
      ms.dmSend("agent-a", "agent-c", "dev", "from a");
      ms.dmSend("agent-b", "agent-c", "tester", "from b");

      const fromA = ms.dmRead("agent-c", "agent-a");
      assert.equal(fromA.length, 1);
      assert.equal(fromA[0].text, "from a");
    });

    it("read without filter returns all unread DMs from all senders", () => {
      ms.dmSend("agent-a", "agent-c", "dev", "from a");
      ms.dmSend("agent-b", "agent-c", "tester", "from b");

      const all = ms.dmRead("agent-c");
      assert.equal(all.length, 2);
    });

    it("read advances cursor for all relevant channels", () => {
      ms.dmSend("agent-a", "agent-c", "dev", "msg1");
      ms.dmSend("agent-b", "agent-c", "tester", "msg2");

      ms.dmRead("agent-c");

      const empty = ms.dmRead("agent-c");
      assert.equal(empty.length, 0);
    });

    it("filtered read only advances cursor for channels with matching messages", () => {
      ms.dmSend("agent-a", "agent-c", "dev", "from a");
      ms.dmSend("agent-b", "agent-c", "tester", "from b");

      ms.dmRead("agent-c", "agent-a");

      const remaining = ms.dmRead("agent-c");
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].from, "agent-b");
    });

    it("peek returns total unread DM count across all senders", () => {
      ms.dmSend("agent-a", "agent-c", "dev", "msg1");
      ms.dmSend("agent-b", "agent-c", "tester", "msg2");
      ms.dmSend("agent-a", "agent-c", "dev", "msg3");

      assert.equal(ms.dmPeek("agent-c"), 3);
    });

    it("peek returns 0 when no DMs", () => {
      assert.equal(ms.dmPeek("agent-x"), 0);
    });

    it("peek does not advance cursor", () => {
      ms.dmSend("agent-a", "agent-b", "dev", "msg");
      assert.equal(ms.dmPeek("agent-b"), 1);
      assert.equal(ms.dmPeek("agent-b"), 1);
    });

    it("DMs between different pairs are independent", () => {
      ms.dmSend("agent-a", "agent-b", "dev", "a-to-b");
      ms.dmSend("agent-a", "agent-c", "dev", "a-to-c");
      ms.dmSend("agent-b", "agent-c", "tester", "b-to-c");

      // agent-b is in two channels: a↔b (1 msg) and b↔c (1 msg)
      const bReads = ms.dmRead("agent-b");
      assert.equal(bReads.length, 2);
      assert.ok(bReads.some((m) => m.text === "a-to-b"));
      assert.ok(bReads.some((m) => m.text === "b-to-c"));

      // agent-c is in two channels: a↔c (1 msg) and b↔c (1 msg)
      const cReads = ms.dmRead("agent-c");
      assert.equal(cReads.length, 2);

      // agent-a is in two channels: a↔b (1 msg) and a↔c (1 msg)
      const aReads = ms.dmRead("agent-a");
      assert.equal(aReads.length, 2);

      // agent-d has no DMs
      const dReads = ms.dmRead("agent-d");
      assert.equal(dReads.length, 0);
    });

    it("DMs sorted by timestamp", () => {
      ms.dmSend("agent-b", "agent-c", "tester", "second");
      ms.dmSend("agent-a", "agent-c", "dev", "first");

      const msgs = ms.dmRead("agent-c");
      assert.equal(msgs.length, 2);
      assert.ok(msgs[0].timestamp <= msgs[1].timestamp);
    });

    it("multiple DMs in same conversation", () => {
      ms.dmSend("agent-a", "agent-b", "dev", "msg1");
      ms.dmSend("agent-a", "agent-b", "dev", "msg2");
      ms.dmSend("agent-b", "agent-a", "tester", "reply1");
      ms.dmSend("agent-a", "agent-b", "dev", "msg3");

      const bReads = ms.dmRead("agent-b");
      assert.equal(bReads.length, 4);
      assert.equal(bReads[0].text, "msg1");
      assert.equal(bReads[1].text, "msg2");
      assert.equal(bReads[2].text, "reply1");
      assert.equal(bReads[3].text, "msg3");
    });

    it("agent reads only their DMs, not others", () => {
      ms.dmSend("agent-a", "agent-b", "dev", "private for b");
      ms.dmSend("agent-c", "agent-d", "lead", "private for d");

      const bReads = ms.dmRead("agent-b");
      assert.equal(bReads.length, 1);
      assert.equal(bReads[0].text, "private for b");

      const dReads = ms.dmRead("agent-d");
      assert.equal(dReads.length, 1);
      assert.equal(dReads[0].text, "private for d");

      const aReads = ms.dmRead("agent-a");
      assert.equal(aReads.length, 1);
      assert.equal(aReads[0].text, "private for b");
    });
  });

  describe("lead chat", () => {
    it("posts and reads lead chat messages", () => {
      ms.leadChatPost("lead-a", "lead", "team-frontend", "frontend ready");
      ms.leadChatPost("lead-b", "lead", "team-backend", "backend ready");

      const msgs = ms.leadChatRead("lead-a");
      assert.equal(msgs.length, 2);
      assert.equal(msgs[0].from, "lead-a");
      assert.ok(msgs[0].text.includes("[team-frontend]"));
      assert.ok(msgs[0].text.includes("frontend ready"));
      assert.equal(msgs[1].from, "lead-b");
      assert.ok(msgs[1].text.includes("[team-backend]"));
    });

    it("read returns only unread", () => {
      ms.leadChatPost("lead-a", "lead", "team1", "msg1");
      ms.leadChatRead("lead-b");
      ms.leadChatPost("lead-a", "lead", "team1", "msg2");

      const msgs = ms.leadChatRead("lead-b");
      assert.equal(msgs.length, 1);
      assert.ok(msgs[0].text.includes("msg2"));
    });

    it("peek returns unread count", () => {
      ms.leadChatPost("lead-a", "lead", "team1", "msg1");
      ms.leadChatPost("lead-b", "lead", "team2", "msg2");

      assert.equal(ms.leadChatPeek("lead-c"), 2);
      assert.equal(ms.leadChatPeek("lead-c"), 2);

      ms.leadChatRead("lead-c");
      assert.equal(ms.leadChatPeek("lead-c"), 0);
    });

    it("each lead has independent cursor", () => {
      ms.leadChatPost("lead-a", "lead", "t1", "msg");

      ms.leadChatRead("lead-b");
      const forC = ms.leadChatRead("lead-c");
      assert.equal(forC.length, 1);
    });

    it("lead sees own messages", () => {
      ms.leadChatPost("lead-a", "lead", "t1", "my msg");
      const msgs = ms.leadChatRead("lead-a");
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].from, "lead-a");
    });
  });

  describe("shared artifacts", () => {
    it("shares and retrieves artifacts", () => {
      ms.shareArtifact("team1", "agent-a", "src/app.ts — new auth module");
      ms.shareArtifact("team1", "agent-b", "tests/auth.test.ts — 15 tests passing");

      const artifacts = ms.getSharedArtifacts("team1");
      assert.equal(artifacts.length, 2);
      assert.equal(artifacts[0].from, "agent-a");
      assert.ok(artifacts[0].data.includes("auth module"));
      assert.equal(artifacts[1].from, "agent-b");
    });

    it("returns empty array for team with no artifacts", () => {
      const artifacts = ms.getSharedArtifacts("nonexistent");
      assert.equal(artifacts.length, 0);
    });

    it("different teams have separate artifact lists", () => {
      ms.shareArtifact("team1", "agent-a", "team1 artifact");
      ms.shareArtifact("team2", "agent-b", "team2 artifact");

      assert.equal(ms.getSharedArtifacts("team1").length, 1);
      assert.equal(ms.getSharedArtifacts("team2").length, 1);
      assert.equal(ms.getSharedArtifacts("team1")[0].data, "team1 artifact");
    });

    it("artifacts have timestamps", () => {
      const before = new Date();
      ms.shareArtifact("team1", "agent-a", "data");
      const after = new Date();

      const artifacts = ms.getSharedArtifacts("team1");
      assert.ok(artifacts[0].timestamp >= before);
      assert.ok(artifacts[0].timestamp <= after);
    });

    it("same agent can share multiple artifacts", () => {
      ms.shareArtifact("team1", "agent-a", "artifact 1");
      ms.shareArtifact("team1", "agent-a", "artifact 2");
      ms.shareArtifact("team1", "agent-a", "artifact 3");

      assert.equal(ms.getSharedArtifacts("team1").length, 3);
    });
  });

  describe("dissolveTeam", () => {
    it("cleans up team chat", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "msg");
      ms.dissolveTeam("team1");

      const msgs = ms.groupChatRead("team1", "agent-a");
      assert.equal(msgs.length, 0);
    });

    it("cleans up shared artifacts", () => {
      ms.shareArtifact("team1", "agent-a", "data");
      ms.dissolveTeam("team1");

      assert.equal(ms.getSharedArtifacts("team1").length, 0);
    });

    it("does not affect other teams", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "t1 msg");
      ms.groupChatPost("team2", "agent-b", "dev", "t2 msg");

      ms.dissolveTeam("team1");

      assert.equal(ms.groupChatRead("team2", "agent-c").length, 1);
    });
  });

  describe("dissolveTeamWithAgents", () => {
    it("cleans up team chat, artifacts, DMs, and lead cursors", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "chat msg");
      ms.shareArtifact("team1", "agent-a", "artifact");
      ms.dmSend("agent-a", "agent-b", "dev", "dm msg");
      ms.leadChatPost("agent-a", "lead", "team1", "lead msg");

      ms.dissolveTeamWithAgents("team1", ["agent-a", "agent-b"]);

      assert.equal(ms.groupChatRead("team1", "agent-a").length, 0);
      assert.equal(ms.getSharedArtifacts("team1").length, 0);
      assert.equal(ms.dmPeek("agent-a"), 0);
      assert.equal(ms.dmPeek("agent-b"), 0);
    });

    it("cleans up DMs involving team agents with outside agents", () => {
      ms.dmSend("agent-a", "agent-x", "dev", "cross-team dm");
      ms.dissolveTeamWithAgents("team1", ["agent-a"]);

      assert.equal(ms.dmPeek("agent-x"), 0);
      assert.equal(ms.dmPeek("agent-a"), 0);
    });

    it("does not affect DMs between unrelated agents", () => {
      ms.dmSend("agent-x", "agent-y", "lead", "unrelated dm");
      ms.dissolveTeamWithAgents("team1", ["agent-a", "agent-b"]);

      assert.equal(ms.dmPeek("agent-y"), 1);
    });

    it("does not affect other team chats", () => {
      ms.groupChatPost("team1", "agent-a", "dev", "t1");
      ms.groupChatPost("team2", "agent-c", "dev", "t2");

      ms.dissolveTeamWithAgents("team1", ["agent-a", "agent-b"]);

      assert.equal(ms.groupChatRead("team2", "agent-d").length, 1);
    });
  });

  describe("cross-cutting scenarios", () => {
    it("group chat + DM + lead chat + artifacts all work together", () => {
      ms.groupChatPost("team1", "lead-1", "lead", "team standup");
      ms.groupChatPost("team1", "dev-1", "dev", "working on auth");
      ms.dmSend("lead-1", "dev-1", "lead", "prioritize login");
      ms.leadChatPost("lead-1", "lead", "team1", "auth in progress");
      ms.shareArtifact("team1", "dev-1", "src/auth.ts");

      assert.equal(ms.groupChatPeek("team1", "dev-1"), 2);
      assert.equal(ms.dmPeek("dev-1"), 1);

      const chatMsgs = ms.groupChatRead("team1", "dev-1");
      assert.equal(chatMsgs.length, 2);

      const dms = ms.dmRead("dev-1");
      assert.equal(dms.length, 1);
      assert.equal(dms[0].text, "prioritize login");

      const artifacts = ms.getSharedArtifacts("team1");
      assert.equal(artifacts.length, 1);

      const leadMsgs = ms.leadChatRead("lead-1");
      assert.equal(leadMsgs.length, 1);
    });

    it("high concurrency DMs from many agents to one", () => {
      for (let i = 0; i < 50; i++) {
        ms.dmSend(`sender-${i}`, "receiver", "worker", `message from ${i}`);
      }

      assert.equal(ms.dmPeek("receiver"), 50);

      const all = ms.dmRead("receiver");
      assert.equal(all.length, 50);
      assert.equal(ms.dmPeek("receiver"), 0);
    });

    it("multiple read calls with interleaved writes", () => {
      ms.groupChatPost("t", "a", "r", "1");
      ms.groupChatPost("t", "b", "r", "2");

      const batch1 = ms.groupChatRead("t", "reader");
      assert.equal(batch1.length, 2);

      ms.groupChatPost("t", "a", "r", "3");
      ms.groupChatPost("t", "c", "r", "4");

      const batch2 = ms.groupChatRead("t", "reader");
      assert.equal(batch2.length, 2);
      assert.equal(batch2[0].text, "3");
      assert.equal(batch2[1].text, "4");

      const batch3 = ms.groupChatRead("t", "reader");
      assert.equal(batch3.length, 0);
    });
  });
});
