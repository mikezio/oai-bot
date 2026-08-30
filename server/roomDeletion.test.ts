import assert from "node:assert/strict";
import test from "node:test";
import { removeGroupRoomFromState } from "./roomDeletion.js";
import type { AppState } from "./types.js";

test("deletes one group and its room-scoped history without deleting Bots or direct chats", () => {
  const state = {
    agents: [{ id: "one" }],
    rooms: [{ id: "group" }, { id: "direct" }],
    messages: [{ id: "group-message", roomId: "group" }, { id: "direct-message", roomId: "direct" }],
    approvals: [{ id: "approval", roomId: "group" }], routines: [{ id: "routine", roomId: "group" }],
    memberTurns: [{ id: "turn", roomId: "group" }], deliveryReceipts: [{ id: "receipt", roomId: "group" }],
    transcriptMetadata: [], transcriptEntries: [], agentClientStates: []
  } as unknown as AppState;
  removeGroupRoomFromState(state, "group");
  assert.deepEqual(state.agents.map((agent) => agent.id), ["one"]);
  assert.deepEqual(state.rooms.map((room) => room.id), ["direct"]);
  assert.deepEqual(state.messages.map((message) => message.id), ["direct-message"]);
  assert.equal(state.routines.length, 0);
  assert.equal(state.memberTurns.length, 0);
});
