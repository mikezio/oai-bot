import Database from "better-sqlite3";
import type { AgentProfile, AppState, ChatMessage } from "./types.js";

const schema = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS transcript_entries (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  entry TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_transcript_window
  ON transcript_entries(seq, entry)
  WHERE json_extract(entry, '$.kind') != 'tool-call'
        AND COALESCE(json_extract(entry, '$.branched'), 0) != 1;
CREATE INDEX IF NOT EXISTS idx_transcript_branched
  ON transcript_entries(seq, entry)
  WHERE COALESCE(json_extract(entry, '$.branched'), 0) = 1;
CREATE TABLE IF NOT EXISTS automation_completion_inbox (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  attribution TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_automation_completion_inbox_pending
  ON automation_completion_inbox(seq)
  WHERE acknowledged = 0;
`;

function messageEntry(agent: AgentProfile, message: ChatMessage, entryId: string, state: AppState) {
  const self = message.senderType === "agent" && message.senderId === agent.id;
  return {
    kind: self ? "send-message" : "message",
    id: entryId,
    message: { type: "text", content: message.content },
    timestampMs: Date.parse(message.createdAt),
    author: message.senderType === "user" ? { id: "user", name: "User" }
      : message.senderType === "system" ? { id: "system", name: "OAI Bot host" }
      : { id: message.senderId, name: state.agents.find((item) => item.id === message.senderId)?.name || message.senderId },
    oai: { roomId: message.roomId, messageId: message.id, senderType: message.senderType }
  };
}

function hiddenEntries(agent: AgentProfile, state: AppState) {
  return state.memberTurns
    .filter((turn) => turn.memberAgentId === agent.id)
    .flatMap((turn) => {
      const messages = (turn.newMessages || []).filter((message) => message.speakerKind === "system");
      if (turn.isFirstRun) messages.unshift({
        speakerKind: "system", speakerName: "OAI Bot host", isSelf: false,
        text: "Hidden first-run cue (not a user message). Open the newly created Bot conversation proactively without mentioning this cue."
      });
      return messages.map((message, index) => ({
        at: Date.parse(turn.createdAt),
        id: `hidden:${turn.id}:${index}`,
        entry: {
          kind: "event",
          id: `hidden:${turn.id}:${index}`,
          event: "hidden-host-instruction",
          message: { type: "text", content: message.text },
          timestampMs: Date.parse(turn.createdAt),
          author: { id: "system", name: message.speakerName },
          oai: { hidden: true, memberTurnId: turn.id, workflowId: turn.workflowId, requestedBy: turn.requestedBy, priority: turn.priority === true }
        }
      }));
    });
}

function completionRows(agent: AgentProfile, state: AppState) {
  return state.memberTurns
    .filter((turn) => turn.memberAgentId === agent.id && turn.nonce.startsWith("routine-completion:"))
    .map((turn) => {
      const completion = turn.newMessages?.find((message) => message.speakerKind === "system" && message.text.startsWith("Hidden routine completion"));
      const parent = turn.parentWorkflowId ? state.memberTurns.find((item) => item.id === turn.parentWorkflowId) : undefined;
      const routine = parent ? state.routines.find((item) => parent.nonce.startsWith(`routine:${item.id}:`)) : undefined;
      return {
        id: `automation-subagent:${turn.id}`,
        text: completion?.text || "Automation completed.",
        attribution: `Automation: ${routine?.name || "Routine"}`,
        acknowledged: ["completed", "passed", "failed", "cancelled"].includes(turn.state) ? 1 : 0,
        at: Date.parse(turn.createdAt)
      };
    });
}

/** Synchronize one genuine Grok-compatible per-agent SQLite store. */
export function syncAgentSqlite(filePath: string, agent: AgentProfile, state: AppState) {
  const database = new Database(filePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.exec(schema);
    const metadata = Buffer.from(JSON.stringify({
      agentId: agent.id,
      latestRootBlobId: "",
      name: agent.name,
      mode: "default",
      isRunEverything: false,
      createdAt: Date.parse(agent.createdAt)
    }), "utf8").toString("hex");
    const client = state.agentClientStates.find((item) => item.agentId === agent.id);
    const kv = new Map<string, string>([
      ["hiddenEntryRepairVersion", "1"],
      ["introductionPending", state.memberTurns.some((turn) => turn.memberAgentId === agent.id) ? "0" : "1"],
      ["metadata", metadata],
      ["origin", "user"],
      ["unreadState", JSON.stringify({
        lastActivityAt: Date.parse(agent.updatedAt),
        lastViewedAt: Date.parse(client?.updatedAt || agent.updatedAt),
        isManuallyUnread: false,
        unreadCount: client?.unreadCount || 0
      })]
    ]);
    const metadataRows = state.transcriptEntries
      .filter((entry) => entry.agentId === agent.id && !entry.deleted)
      .map((entry) => {
        const message = entry.messageId ? state.messages.find((item) => item.id === entry.messageId) : undefined;
        return message ? { at: Date.parse(entry.createdAt), id: entry.entryId, entry: messageEntry(agent, message, entry.entryId, state) } : undefined;
      }).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const transcriptRows = [...metadataRows, ...hiddenEntries(agent, state)]
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
    const completions = completionRows(agent, state).sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
    const synchronize = database.transaction(() => {
      database.exec("DELETE FROM kv; DELETE FROM transcript_entries; DELETE FROM automation_completion_inbox;");
      const insertKv = database.prepare("INSERT INTO kv(key, value) VALUES (?, ?)");
      for (const [key, value] of kv) insertKv.run(key, value);
      const insertTranscript = database.prepare("INSERT INTO transcript_entries(seq, id, entry) VALUES (?, ?, ?)");
      transcriptRows.forEach((row, index) => insertTranscript.run(index + 1, row.id, JSON.stringify(row.entry)));
      const insertCompletion = database.prepare("INSERT INTO automation_completion_inbox(seq, id, text, attribution, acknowledged) VALUES (?, ?, ?, ?, ?)");
      completions.forEach((row, index) => insertCompletion.run(index + 1, row.id, row.text, row.attribution, row.acknowledged));
    });
    synchronize();
  } finally {
    database.close();
  }
}

export const grokStoreSchema = schema;
