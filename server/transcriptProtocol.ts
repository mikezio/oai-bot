import type { AppState, TranscriptCursor, TranscriptEntry } from "./types.js";

export const TRANSCRIPT_STREAM_LIFETIME_MS = 5 * 60_000;
export const TRANSCRIPT_HEARTBEAT_MS = 15_000;
export const TRANSCRIPT_INLINE_BODY_MAX_BYTES = 64 * 1024;

export type TranscriptStreamFrame = Record<string, unknown>;

function inlineEntry(entry: TranscriptEntry, inlineBodyMaxBytes: number) {
  const copy = structuredClone(entry);
  if (copy.body != null && Buffer.byteLength(copy.body, "utf8") > inlineBodyMaxBytes) {
    delete copy.body;
    copy.bodyOmitted = true;
  }
  return copy;
}

export function transcriptFramesForCursor(
  state: AppState,
  cursor: TranscriptCursor,
  inlineBodyMaxBytes = TRANSCRIPT_INLINE_BODY_MAX_BYTES
): { frames: TranscriptStreamFrame[]; cursor: TranscriptCursor } {
  if (!state.agents.some((agent) => agent.id === cursor.agentId)) throw Object.assign(new Error("Bot not found"), { statusCode: 404 });
  const metadata = state.transcriptMetadata.find((item) => item.agentId === cursor.agentId);
  if (!metadata) throw Object.assign(new Error("Bot transcript not found"), { statusCode: 404 });
  if (cursor.generation > metadata.generation || (cursor.generation === metadata.generation && cursor.afterUpdatedSeq > metadata.updatedSeq)) {
    throw Object.assign(new Error("Transcript cursor is ahead of the current transcript"), { statusCode: 409 });
  }

  const frames: TranscriptStreamFrame[] = [];
  const replay = cursor.generation < metadata.generation;
  if (replay) {
    frames.push({ cursorTooOld: { agentId: cursor.agentId, generation: cursor.generation } });
    frames.push({ cleared: { agentId: cursor.agentId, newGeneration: metadata.generation } });
  }
  const changes = state.transcriptEntries
    .filter((entry) => entry.agentId === cursor.agentId && entry.generation === metadata.generation
      && (replay || entry.updatedSeq > cursor.afterUpdatedSeq))
    .sort((left, right) => left.updatedSeq - right.updatedSeq || left.seq - right.seq);
  if (changes.length || replay) {
    frames.push({
      rows: {
        agentId: cursor.agentId,
        generation: metadata.generation,
        entries: changes.filter((entry) => !entry.deleted).map((entry) => inlineEntry(entry, inlineBodyMaxBytes)),
        deletes: changes.filter((entry) => entry.deleted).map((entry) => ({
          seq: entry.seq, updatedSeq: entry.updatedSeq, entryId: entry.entryId
        })),
        replay
      }
    });
  }
  return {
    frames,
    cursor: { agentId: cursor.agentId, generation: metadata.generation, afterUpdatedSeq: metadata.updatedSeq }
  };
}

export function agentStateFrame(state: AppState, agentIds: string[], snapshot: boolean): TranscriptStreamFrame {
  const ids = new Set(agentIds);
  return {
    agentState: {
      live: state.agents.filter((agent) => ids.has(agent.id)).map((agent) => ({
        agentId: agent.id,
        isRunning: agent.status === "working",
        isComposingMessage: agent.isComposingMessage === true,
        isRetrying: agent.isRetrying === true,
        activity: agent.activity ? {
          kind: agent.activity.kind,
          tool: agent.activity.tool,
          detail: agent.activity.detail,
          target: agent.activity.target,
          callId: agent.activity.callId
        } : undefined,
        awaiting: agent.awaitingUserResponse ? { reason: "waiting-for-user", sinceMs: Date.parse(agent.updatedAt) } : undefined,
        updatedAtMs: Date.parse(agent.activity?.updatedAt || agent.updatedAt),
        staleAfterMs: 30_000
      })),
      snapshot,
      client: state.agentClientStates.filter((client) => ids.has(client.agentId))
    }
  };
}

export function changedAgentStateFamilies(before: AppState, after: AppState, agentIds: string[]) {
  const changes: Array<{ agentId: string; families: string[]; changedAtMs: number }> = [];
  for (const agentId of agentIds) {
    const families: string[] = [];
    if (JSON.stringify(before.agents.find((agent) => agent.id === agentId)) !== JSON.stringify(after.agents.find((agent) => agent.id === agentId))) families.push("live");
    if (JSON.stringify(before.agentClientStates.find((client) => client.agentId === agentId)) !== JSON.stringify(after.agentClientStates.find((client) => client.agentId === agentId))) families.push("client");
    if (families.length) changes.push({ agentId, families, changedAtMs: Date.now() });
  }
  return changes;
}
