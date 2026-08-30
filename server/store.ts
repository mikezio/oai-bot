import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentClientState, AgentTranscriptMetadata, AppState, TranscriptCommitRejection, TranscriptEntry, TranscriptEntryCommit } from "./types.js";

const MAX_UINT32 = 0xffff_ffff;

function now() {
  return new Date().toISOString();
}

function initialState(): AppState {
  return {
    agents: [], rooms: [], messages: [], approvals: [], routines: [],
    transcriptMetadata: [], transcriptEntries: [], memberTurns: [], deliveryReceipts: [], agentClientStates: []
  };
}

function newTranscriptMetadata(agentId: string, timestamp = now()): AgentTranscriptMetadata {
  return { agentId, generation: 1, updatedSeq: 0, createdAt: timestamp, updatedAt: timestamp };
}

function newClientState(agentId: string, timestamp = now()): AgentClientState {
  return {
    agentId,
    unreadCount: 0,
    hiddenFromSidebar: false,
    notificationsEnabled: true,
    notifyOnUpdatesEnabled: true,
    updatedAt: timestamp
  };
}

/** Convert legacy UUID/string generations into a stable non-zero uint32. */
function normalizeGeneration(value: unknown, fallback = 1) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_UINT32) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric > 0 && numeric <= MAX_UINT32) return numeric;
    if (value) {
      let hash = 0x811c9dc5;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0) || fallback;
    }
  }
  return fallback;
}

/**
 * Normalizes newly introduced persistent collections without changing existing
 * public records. This also runs after mutations so agents created at runtime
 * immediately receive their transcript and client-state primitives.
 */
function ensurePersistentPrimitives(state: AppState, recoveringFromRestart = false) {
  state.transcriptMetadata ||= [];
  state.transcriptEntries ||= [];
  state.memberTurns ||= [];
  state.deliveryReceipts ||= [];
  state.agentClientStates ||= [];

  const timestamp = now();
  const knownTranscriptAgents = new Set<string>();
  state.transcriptMetadata = state.transcriptMetadata.filter((metadata) => {
    if (!metadata?.agentId || knownTranscriptAgents.has(metadata.agentId)) return false;
    knownTranscriptAgents.add(metadata.agentId);
    metadata.generation = normalizeGeneration(metadata.generation);
    metadata.updatedSeq = Number.isSafeInteger(metadata.updatedSeq) && metadata.updatedSeq >= 0 ? metadata.updatedSeq : 0;
    metadata.createdAt ||= timestamp;
    metadata.updatedAt ||= metadata.createdAt;
    return true;
  });

  const metadataByAgent = new Map(state.transcriptMetadata.map((metadata) => [metadata.agentId, metadata]));
  const knownTranscriptEntries = new Map<string, TranscriptEntry>();
  state.transcriptEntries = state.transcriptEntries.filter((entry) => {
    if (!entry?.agentId || !entry.entryId) return false;
    const metadata = metadataByAgent.get(entry.agentId);
    entry.generation = normalizeGeneration(entry.generation, metadata?.generation || 1);
    entry.seq = Number.isSafeInteger(entry.seq) && entry.seq > 0 ? entry.seq : 0;
    entry.updatedSeq = Number.isSafeInteger(entry.updatedSeq) && entry.updatedSeq > 0 ? entry.updatedSeq : entry.seq;
    entry.createdAt ||= timestamp;
    entry.updatedAt ||= entry.createdAt;
    if (entry.deleted && !entry.deletedAt) entry.deletedAt = entry.updatedAt;
    const key = `${entry.agentId}:${entry.generation}:${entry.entryId}`;
    const previous = knownTranscriptEntries.get(key);
    if (previous && previous.updatedSeq >= entry.updatedSeq) return false;
    knownTranscriptEntries.set(key, entry);
    return true;
  });
  state.transcriptEntries = state.transcriptEntries.filter((entry) => (
    knownTranscriptEntries.get(`${entry.agentId}:${entry.generation}:${entry.entryId}`) === entry
  ));

  for (const metadata of state.transcriptMetadata) {
    const generationEntries = state.transcriptEntries.filter((entry) => entry.agentId === metadata.agentId && entry.generation === metadata.generation);
    let nextSeq = 0;
    for (const entry of generationEntries.sort((left, right) => left.seq - right.seq || left.updatedSeq - right.updatedSeq)) {
      if (entry.seq <= 0 || entry.seq <= nextSeq) entry.seq = nextSeq + 1;
      nextSeq = entry.seq;
      if (entry.updatedSeq <= 0) entry.updatedSeq = entry.seq;
      metadata.updatedSeq = Math.max(metadata.updatedSeq, entry.updatedSeq);
    }
  }

  for (const message of state.messages || []) {
    if (!message.transcriptCursors) continue;
    for (const [agentId, cursor] of Object.entries(message.transcriptCursors)) {
      cursor.generation = metadataByAgent.get(agentId)?.generation || normalizeGeneration(cursor.generation);
      cursor.updatedSeq = Number.isSafeInteger(cursor.updatedSeq) && cursor.updatedSeq >= 0 ? cursor.updatedSeq : 0;
    }
  }

  const knownClientAgents = new Set<string>();
  state.agentClientStates = state.agentClientStates.filter((clientState) => {
    if (!clientState?.agentId || knownClientAgents.has(clientState.agentId)) return false;
    knownClientAgents.add(clientState.agentId);
    clientState.unreadCount = Number.isSafeInteger(clientState.unreadCount) && clientState.unreadCount >= 0 ? clientState.unreadCount : 0;
    clientState.hiddenFromSidebar ??= false;
    const legacy = clientState.notificationSettings;
    clientState.notificationsEnabled ??= legacy?.enabled ?? true;
    clientState.notifyOnUpdatesEnabled ??= legacy ? legacy.enabled && !legacy.mentionsOnly : true;
    delete clientState.notificationSettings;
    clientState.updatedAt ||= timestamp;
    return true;
  });

  for (const turn of state.memberTurns) {
    turn.peerAgentIds ||= [];
    turn.newMessageIds ||= [];
    turn.isWindingDown ??= false;
    if (recoveringFromRestart && turn.state === "running") {
      // A process-local lease cannot survive restart. Leave the durable state
      // unsettled so the orchestrator explicitly decides whether to retry,
      // expire, or cancel it during recovery.
      turn.recoveryRequired = true;
      delete turn.leaseId;
    }
  }

  for (const agent of state.agents) {
    agent.memories ||= [];
    if (!knownTranscriptAgents.has(agent.id)) {
      state.transcriptMetadata.push(newTranscriptMetadata(agent.id, timestamp));
      knownTranscriptAgents.add(agent.id);
    }
    if (!knownClientAgents.has(agent.id)) {
      state.agentClientStates.push(newClientState(agent.id, timestamp));
      knownClientAgents.add(agent.id);
    }
  }
}

export class Store {
  private state: AppState = initialState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.filePath, "utf8")) as AppState;
      ensurePersistentPrimitives(this.state, true);
      // Approval RPC ids belong to one app-server process and cannot survive a restart.
      this.state.approvals = [];
      this.state.agents.forEach((agent) => {
        agent.status = "idle";
        delete agent.activity;
        agent.networkAccess ??= true;
        // Runtime worker threads are ephemeral so they never fill the native Codex sidebar.
        // The room transcript is the durable context and is supplied to a fresh thread on launch.
        agent.roomThreadIds = {};
        agent.roomLastSeenMessageIds ||= {};
        agent.privateWorkspacePath ||= `agent-workspaces/${agent.id}`;
        agent.avatarColor ||= agent.color;
        agent.avatarFace ||= "dots";
        agent.avatarTexture ||= "gradient";
        agent.avatarMotion ||= "lively";
        agent.avatarAccessory ||= "none";
        if (!this.state.rooms.some((room) => room.directAgentId === agent.id)) {
          const timestamp = now();
          this.state.rooms.push({ id: randomUUID(), name: agent.name, description: agent.description, agentIds: [agent.id], kind: "direct", directAgentId: agent.id, createdAt: timestamp, updatedAt: timestamp });
        }
      });
      this.state.rooms.forEach((room) => { delete room.routerThreadId; });
      this.state.rooms.forEach((room) => { room.kind ||= room.directAgentId ? "direct" : "group"; delete room.runState; });
      this.state.routines ||= [];
      this.state.messages.forEach((message) => { message.reactions ||= {}; message.attachments ||= []; });
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  mutate<T>(fn: (state: AppState) => T): T {
    const result = fn(this.state);
    ensurePersistentPrimitives(this.state);
    this.writeChain = this.writeChain.then(() => this.persist());
    return result;
  }

  /** Allocate the next durable transcript sequence for one Bot. */
  nextTranscriptSequence(agentId: string): { generation: number; updatedSeq: number } {
    let cursor: { generation: number; updatedSeq: number } | undefined;
    this.mutate((state) => {
      const metadata = state.transcriptMetadata.find((item) => item.agentId === agentId);
      if (!metadata) throw new Error(`Unknown agent transcript: ${agentId}`);
      metadata.updatedSeq += 1;
      metadata.updatedAt = now();
      cursor = { generation: metadata.generation, updatedSeq: metadata.updatedSeq };
    });
    return cursor!;
  }

  /**
   * Atomically insert, update, or tombstone durable transcript rows and return
   * the watch cursor after the commit. Entry seq remains stable on updates;
   * updatedSeq advances for every changed row.
   */
  commitTranscriptEntries(agentId: string, commits: TranscriptEntryCommit[]): {
    generation: number; updatedSeq: number; entries: TranscriptEntry[];
    committedCount: number; deletedCount: number; rejections: TranscriptCommitRejection[];
  } {
    let result: {
      generation: number; updatedSeq: number; entries: TranscriptEntry[];
      committedCount: number; deletedCount: number; rejections: TranscriptCommitRejection[];
    } | undefined;
    this.mutate((state) => {
      const metadata = state.transcriptMetadata.find((item) => item.agentId === agentId);
      if (!metadata) throw new Error(`Unknown agent transcript: ${agentId}`);
      const current = state.transcriptEntries.filter((entry) => entry.agentId === agentId && entry.generation === metadata.generation);
      let nextSeq = current.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0);
      const committed: TranscriptEntry[] = [];
      const rejections: TranscriptCommitRejection[] = [];
      for (const commit of commits) {
        if (!commit.entryId) throw new Error("Transcript entryId is required");
        const timestamp = commit.updatedAt || now();
        let entry = current.find((item) => item.entryId === commit.entryId);
        const currentUpdatedSeq = entry?.updatedSeq || 0;
        if (commit.expectedUpdatedSeq != null && commit.expectedUpdatedSeq !== currentUpdatedSeq) {
          rejections.push({ entryId: commit.entryId, currentUpdatedSeq, reason: "updated-seq-conflict" });
          continue;
        }
        metadata.updatedSeq += 1;
        if (!entry) {
          entry = {
            agentId, generation: metadata.generation, seq: ++nextSeq, updatedSeq: metadata.updatedSeq,
            entryId: commit.entryId, messageId: commit.messageId, entryKind: commit.entryKind,
            body: commit.body, bodyOmitted: commit.bodyOmitted, blobHash: commit.blobHash,
            deleted: commit.deleted, createdAt: commit.createdAt || timestamp, updatedAt: timestamp,
            deletedAt: commit.deleted ? timestamp : undefined
          };
          state.transcriptEntries.push(entry);
          current.push(entry);
        } else {
          entry.messageId = commit.messageId ?? entry.messageId;
          entry.entryKind = commit.entryKind;
          entry.body = commit.body;
          entry.bodyOmitted = commit.bodyOmitted;
          entry.blobHash = commit.blobHash;
          entry.deleted = commit.deleted;
          entry.deletedAt = commit.deleted ? entry.deletedAt || timestamp : undefined;
          entry.updatedSeq = metadata.updatedSeq;
          entry.updatedAt = timestamp;
        }
        committed.push(structuredClone(entry));
      }
      metadata.updatedAt = committed.length ? committed.at(-1)!.updatedAt : metadata.updatedAt;
      result = {
        generation: metadata.generation, updatedSeq: metadata.updatedSeq, entries: committed,
        committedCount: committed.filter((entry) => !entry.deleted).length,
        deletedCount: committed.filter((entry) => entry.deleted).length,
        rejections
      };
    });
    return result!;
  }

  /** Bounded reverse-page listing for transcript replay and history views. */
  listTranscriptEntries(agentId: string, options: {
    generation?: number; beforeSeq?: number; limit?: number; includeDeleted?: boolean;
  } = {}): { agentId: string; generation: number; entries: TranscriptEntry[]; nextBeforeSeq?: number } {
    const state = this.snapshot();
    const metadata = state.transcriptMetadata.find((item) => item.agentId === agentId);
    if (!metadata) throw new Error(`Unknown agent transcript: ${agentId}`);
    const generation = options.generation ?? metadata.generation;
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 50)));
    const beforeSeq = options.beforeSeq;
    const entries = state.transcriptEntries
      .filter((entry) => entry.agentId === agentId && entry.generation === generation
        && (options.includeDeleted === true || !entry.deleted)
        && (beforeSeq == null || entry.seq < beforeSeq))
      .sort((left, right) => right.seq - left.seq)
      .slice(0, limit)
      .reverse();
    return {
      agentId, generation, entries,
      nextBeforeSeq: entries.length === limit ? entries[0]?.seq : undefined
    };
  }

  /** Start a fresh transcript generation while preserving the Bot identity. */
  resetTranscriptGeneration(agentId: string): { generation: number; updatedSeq: number } {
    let cursor: { generation: number; updatedSeq: number } | undefined;
    this.mutate((state) => {
      const metadata = state.transcriptMetadata.find((item) => item.agentId === agentId);
      if (!metadata) throw new Error(`Unknown agent transcript: ${agentId}`);
      metadata.generation = metadata.generation >= MAX_UINT32 ? 1 : metadata.generation + 1;
      metadata.updatedSeq = 0;
      metadata.updatedAt = now();
      cursor = { generation: metadata.generation, updatedSeq: metadata.updatedSeq };
    });
    return cursor!;
  }

  async flush() {
    await this.writeChain;
  }

  private async persist() {
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}

export function makeId() {
  return randomUUID();
}

export function isoNow() {
  return now();
}
