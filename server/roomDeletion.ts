import type { AppState } from "./types.js";

export function removeGroupRoomFromState(state: AppState, roomId: string) {
  state.rooms = state.rooms.filter((room) => room.id !== roomId);
  state.messages = state.messages.filter((message) => message.roomId !== roomId);
  state.approvals = state.approvals.filter((approval) => approval.roomId !== roomId);
  state.routines = state.routines.filter((routine) => routine.roomId !== roomId);
  state.memberTurns = state.memberTurns.filter((turn) => turn.roomId !== roomId);
  state.deliveryReceipts = state.deliveryReceipts.filter((receipt) => receipt.roomId !== roomId);
}
