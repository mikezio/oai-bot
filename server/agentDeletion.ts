import type { AppState } from "./types.js";

/** Remove one Bot's private state while preserving its already-posted group history. */
export function removeAgentFromState(state: AppState, agentId: string) {
  const directRoomIds = new Set(state.rooms.filter((room) => room.kind === "direct" && room.directAgentId === agentId).map((room) => room.id));
  const emptyGroupIds = new Set(state.rooms.filter((room) => room.kind === "group" && room.agentIds.length === 1 && room.agentIds[0] === agentId).map((room) => room.id));
  const removedRoomIds = new Set([...directRoomIds, ...emptyGroupIds]);

  state.agents = state.agents.filter((agent) => agent.id !== agentId);
  state.rooms = state.rooms
    .filter((room) => !removedRoomIds.has(room.id))
    .map((room) => ({ ...room, agentIds: room.agentIds.filter((id) => id !== agentId), runState: room.runState?.activeAgentId === agentId ? undefined : room.runState }));
  state.messages = state.messages
    .filter((message) => !removedRoomIds.has(message.roomId))
    .map((message) => {
      const transcriptCursors = message.transcriptCursors ? { ...message.transcriptCursors } : undefined;
      if (transcriptCursors) delete transcriptCursors[agentId];
      return { ...message, mentions: message.mentions.filter((id) => id !== agentId), toAgentIds: message.toAgentIds?.filter((id) => id !== agentId), transcriptCursors };
    });
  state.approvals = state.approvals.filter((approval) => approval.agentId !== agentId && !removedRoomIds.has(String(approval.roomId || "")));
  state.routines = state.routines.filter((routine) => routine.agentId !== agentId && !removedRoomIds.has(routine.roomId));
  state.transcriptMetadata = state.transcriptMetadata.filter((metadata) => metadata.agentId !== agentId);
  state.transcriptEntries = state.transcriptEntries.filter((entry) => entry.agentId !== agentId);
  state.memberTurns = state.memberTurns.filter((turn) => turn.memberAgentId !== agentId && turn.requestedByAgentId !== agentId && !removedRoomIds.has(turn.roomId));
  state.deliveryReceipts = state.deliveryReceipts.filter((receipt) => receipt.fromAgentId !== agentId && receipt.toAgentId !== agentId && !removedRoomIds.has(String(receipt.roomId || "")));
  state.agentClientStates = state.agentClientStates.filter((client) => client.agentId !== agentId);
  return { removedRoomIds: [...removedRoomIds] };
}
