import assert from "node:assert/strict";
import test from "node:test";
import { removeAgentFromState } from "./agentDeletion.js";
import type { AppState } from "./types.js";

test("removes private Bot state, memberships, and work while preserving group history", () => {
  const state = {
    agents: [{ id: "gone" }, { id: "keep" }],
    rooms: [
      { id: "direct", kind: "direct", directAgentId: "gone", agentIds: ["gone"] },
      { id: "group", kind: "group", agentIds: ["gone", "keep"] }
    ],
    messages: [
      { id: "private", roomId: "direct", mentions: [], senderId: "gone" },
      { id: "history", roomId: "group", mentions: ["gone"], toAgentIds: ["gone"], senderId: "gone", transcriptCursors: { gone: { generation: 1, updatedSeq: 1 } } }
    ],
    approvals: [{ id: "approval", agentId: "gone" }], routines: [{ id: "routine", agentId: "gone", roomId: "group" }],
    transcriptMetadata: [{ agentId: "gone" }], transcriptEntries: [{ agentId: "gone" }],
    memberTurns: [{ id: "turn", memberAgentId: "gone", roomId: "group" }], deliveryReceipts: [{ id: "receipt", toAgentId: "gone" }], agentClientStates: [{ agentId: "gone" }]
  } as unknown as AppState;
  removeAgentFromState(state, "gone");
  assert.deepEqual(state.agents.map((agent) => agent.id), ["keep"]);
  assert.deepEqual(state.rooms[0].agentIds, ["keep"]);
  assert.deepEqual(state.messages.map((message) => message.id), ["history"]);
  assert.deepEqual(state.messages[0].mentions, []);
  assert.equal(state.routines.length, 0);
  assert.equal(state.transcriptEntries.length, 0);
  assert.equal(state.memberTurns.length, 0);
});
