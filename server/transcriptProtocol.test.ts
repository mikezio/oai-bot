import assert from "node:assert/strict";
import test from "node:test";
import { agentStateFrame, changedAgentStateFamilies, transcriptFramesForCursor } from "./transcriptProtocol.js";
import type { AgentProfile, AppState } from "./types.js";

const timestamp = "2026-08-29T12:00:00.000Z";

function agent(): AgentProfile {
  return {
    id: "agent-one", name: "One", title: "", description: "Independent", instructions: "",
    avatar: "O", color: "#000", model: "gpt-5.6-luna", effort: "medium", networkAccess: true,
    status: "working", isComposingMessage: true, activity: { kind: "tool", tool: "WebSearch", detail: "Searching the web", callId: "call-one", updatedAt: timestamp },
    roomThreadIds: {}, roomLastSeenMessageIds: {}, createdAt: timestamp, updatedAt: timestamp
  };
}

function state(): AppState {
  return {
    agents: [agent()], rooms: [], messages: [], approvals: [], routines: [], memberTurns: [], deliveryReceipts: [],
    transcriptMetadata: [{ agentId: "agent-one", generation: 2, updatedSeq: 3, createdAt: timestamp, updatedAt: timestamp }],
    transcriptEntries: [{
      agentId: "agent-one", generation: 2, seq: 1, updatedSeq: 1, entryId: "entry-one", entryKind: "message",
      body: "x".repeat(100), createdAt: timestamp, updatedAt: timestamp
    }, {
      agentId: "agent-one", generation: 2, seq: 2, updatedSeq: 3, entryId: "entry-two", entryKind: "delete",
      deleted: true, createdAt: timestamp, updatedAt: timestamp, deletedAt: timestamp
    }],
    agentClientStates: [{
      agentId: "agent-one", unreadCount: 2, hiddenFromSidebar: false, notificationsEnabled: true,
      notifyOnUpdatesEnabled: true, updatedAt: timestamp
    }]
  };
}

test("transcript stream frames replay a new generation with bounded inline bodies", () => {
  const result = transcriptFramesForCursor(state(), { agentId: "agent-one", generation: 1, afterUpdatedSeq: 50 }, 10);
  assert.deepEqual(Object.keys(result.frames[0]), ["cursorTooOld"]);
  assert.deepEqual(Object.keys(result.frames[1]), ["cleared"]);
  const rows = (result.frames[2] as any).rows;
  assert.equal(rows.replay, true);
  assert.equal(rows.entries[0].body, undefined);
  assert.equal(rows.entries[0].bodyOmitted, true);
  assert.deepEqual(rows.deletes[0], { seq: 2, updatedSeq: 3, entryId: "entry-two" });
  assert.deepEqual(result.cursor, { agentId: "agent-one", generation: 2, afterUpdatedSeq: 3 });
});

test("transcript stream frames resume strictly after updated sequence", () => {
  const result = transcriptFramesForCursor(state(), { agentId: "agent-one", generation: 2, afterUpdatedSeq: 1 });
  assert.equal(result.frames.length, 1);
  const rows = (result.frames[0] as any).rows;
  assert.equal(rows.entries.length, 0);
  assert.equal(rows.deletes[0].entryId, "entry-two");
  assert.equal(rows.replay, false);
});

test("agent state frames separate live and presentation state families", () => {
  const before = state();
  const after = structuredClone(before);
  after.agentClientStates[0].unreadCount = 0;
  const changes = changedAgentStateFamilies(before, after, ["agent-one"]);
  assert.deepEqual(changes[0].families, ["client"]);
  const frame = agentStateFrame(after, ["agent-one"], true) as any;
  assert.equal(frame.agentState.live[0].activity.callId, "call-one");
  assert.equal(frame.agentState.client[0].unreadCount, 0);
  assert.equal(frame.agentState.snapshot, true);
});
