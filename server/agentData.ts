import { access, appendFile, copyFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentProfile, AppState, ChatMessage, Room } from "./types.js";
import { syncAgentSqlite } from "./agentSqlite.js";

async function exists(filePath: string) {
  try { await access(filePath); return true; } catch { return false; }
}

async function atomicWrite(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function automationSlug(name: string, fallback: string) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

function profile(agent: AgentProfile) {
  return {
    name: agent.name,
    title: agent.title,
    description: [agent.description, agent.instructions].filter(Boolean).join("\n\n"),
    avatarShape: agent.avatarShape || "",
    avatarColor: agent.avatarColor || agent.color || "",
    namedBy: "user"
  };
}

function oaiProfile(agent: AgentProfile) {
  return {
    version: 1,
    id: agent.id,
    description: agent.description,
    instructions: agent.instructions,
    model: agent.model,
    effort: agent.effort,
    networkAccess: agent.networkAccess,
    avatar: agent.avatar,
    avatarColor: agent.avatarColor || agent.color,
    avatarShape: agent.avatarShape || "blob",
    avatarShapeName: agent.avatarShapeName,
    avatarMorph: agent.avatarMorph,
    avatarVector: agent.avatarVector,
    avatarAccent: agent.avatarAccent,
    avatarFace: agent.avatarFace,
    avatarTexture: agent.avatarTexture,
    avatarMotion: agent.avatarMotion,
    avatarAccessory: agent.avatarAccessory,
    privateWorkspacePath: agent.privateWorkspacePath,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

function groupProfile(room: Room) {
  return {
    name: room.name,
    title: "",
    description: room.description,
    avatarShape: "",
    avatarColor: "",
    namedBy: "user"
  };
}

function transcriptRole(agentId: string, message?: ChatMessage) {
  if (message?.senderType === "agent" && message.senderId === agentId) return "assistant";
  if (message?.senderType === "system") return "system";
  return "user";
}

function memoryMarkdown(agent: AgentProfile) {
  const lines = [
    `# ${agent.name}`,
    "",
    "## Profile",
    "",
    agent.description || "No description saved.",
    "",
    "## Instructions",
    "",
    agent.instructions || "No custom instructions saved.",
    "",
    "## Durable memories",
    ""
  ];
  if (agent.memories?.length) {
    for (const memory of agent.memories) lines.push(`- [${memory.id}] ${memory.text}`);
  } else lines.push("No durable memories saved.");
  return `${lines.join("\n")}\n`;
}

/**
 * Persistent, inspectable VM-home representation of OAI Bot state. The host
 * writes this bind-mounted directory and Bots read the same files at
 * /home/bot/agent-data inside the shared computer.
 */
export class AgentDataFilesystem {
  private fingerprints = new Map<string, string>();
  private sqliteFingerprints = new Map<string, string>();

  constructor(readonly root: string) {}

  statePath() { return path.join(this.root, "state.json"); }

  async initialize(legacyStatePath?: string) {
    await mkdir(this.root, { recursive: true });
    await Promise.all([
      mkdir(path.join(this.root, "agents"), { recursive: true }),
      mkdir(path.join(this.root, "agent-transcripts"), { recursive: true }),
      mkdir(path.join(this.root, "transcript-publish"), { recursive: true }),
      mkdir(path.join(this.root, "workflows"), { recursive: true }),
      mkdir(path.join(this.root, ".deleted"), { recursive: true })
    ]);
    if (legacyStatePath && !(await exists(this.statePath())) && await exists(legacyStatePath)) {
      await copyFile(legacyStatePath, this.statePath());
    }
  }

  private async writeChanged(relativePath: string, content: string) {
    if (this.fingerprints.get(relativePath) === content) return;
    await atomicWrite(path.join(this.root, relativePath), content);
    this.fingerprints.set(relativePath, content);
  }

  async sync(state: AppState) {
    const liveIds = new Set<string>();
    for (const agent of state.agents) {
      liveIds.add(agent.id);
      const base = path.join("agents", agent.id);
      await this.writeChanged(path.join(base, "profile.json"), json(profile(agent)));
      await this.writeChanged(path.join(base, "oai-profile.json"), json(oaiProfile(agent)));
      await this.writeChanged(path.join(base, "settings.json"), json({ notifyOnAgentUpdates: state.agentClientStates.find((item) => item.agentId === agent.id)?.notifyOnUpdatesEnabled ?? true }));
      await this.writeChanged(path.join(base, "memory", "profile.md"), memoryMarkdown(agent));
      await mkdir(path.join(this.root, base, "memory", "log"), { recursive: true });
      const memoryMonths = new Map<string, string[]>();
      for (const memory of agent.memories || []) {
        const month = /^\d{4}-\d{2}/.exec(memory.createdAt)?.[0] || "undated";
        const date = /^\d{4}-\d{2}-\d{2}/.exec(memory.createdAt)?.[0] || "undated";
        const lines = memoryMonths.get(month) || [];
        lines.push(`- (${date}) ${memory.text}`);
        memoryMonths.set(month, lines);
      }
      for (const [month, lines] of memoryMonths) {
        await this.writeChanged(path.join(base, "memory", "log", `${month}.md`), `# Memory log\n\n<!-- Dated facts, one per line as "- (YYYY-MM-DD) <fact>". Safe to read, grep, and edit. -->\n${lines.join("\n")}\n`);
      }
      await this.archiveRemovedMemoryLogs(agent.id, new Set(memoryMonths.keys()));
      const routines = state.routines.filter((routine) => routine.agentId === agent.id);
      const baseSlugs = routines.map((routine) => automationSlug(routine.name, routine.id));
      const duplicateSlugs = new Set(baseSlugs.filter((slug, index) => baseSlugs.indexOf(slug) !== index));
      const routineDirectories = new Map(routines.map((routine, index) => [routine.id, duplicateSlugs.has(baseSlugs[index]) ? `${baseSlugs[index]}-${routine.id.slice(0, 8)}` : baseSlugs[index]]));
      for (const routine of routines) {
        const routineDirectory = routineDirectories.get(routine.id)!;
        await this.writeChanged(path.join(base, "automations", routineDirectory, "automation.json"), json({
          name: routine.name,
          prompt: routine.instruction,
          schedule: `every ${routine.intervalMinutes} minutes`,
          triggerPresentation: { version: 1, trigger: { type: "interval", intervalMinutes: routine.intervalMinutes } },
          enabled: routine.isEnabled,
          provenance: "user",
          createdAt: Date.parse(routine.createdAt) || routine.createdAt,
          lastRunAt: routine.lastRunAt ? Date.parse(routine.lastRunAt) || routine.lastRunAt : undefined,
          oai: { id: routine.id, roomId: routine.roomId, nextRunAt: routine.nextRunAt, updatedAt: routine.updatedAt }
        }));
        const runs = state.memberTurns
          .filter((turn) => turn.memberAgentId === agent.id && turn.nonce.startsWith(`routine:${routine.id}:`))
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
          .slice(0, 100)
          .map((turn) => ({
            id: turn.id,
            requestId: turn.workflowId,
            trigger: "schedule",
            startedAt: turn.startedAt ? Date.parse(turn.startedAt) : Date.parse(turn.createdAt),
            finishedAt: turn.finishedAt ? Date.parse(turn.finishedAt) : null,
            status: turn.state === "completed" || turn.state === "passed" ? "success" : turn.state,
            detail: turn.error || turn.cancellationReason
          }));
        await this.writeChanged(path.join(base, "automations", routineDirectory, "runs.json"), json(runs));
      }
      await this.archiveRemovedAutomations(agent.id, new Set(routineDirectories.values()));
      const metadata = state.transcriptMetadata.find((item) => item.agentId === agent.id);
      const entries = state.transcriptEntries
        .filter((entry) => entry.agentId === agent.id && entry.generation === metadata?.generation && !entry.deleted)
        .sort((left, right) => left.seq - right.seq);
      const transcriptRows: Array<{ at: number; order: number; value: unknown }> = entries.map((entry) => {
        const message = entry.messageId ? state.messages.find((item) => item.id === entry.messageId) : undefined;
        return {
          at: Date.parse(entry.createdAt) || 0,
          order: entry.seq,
          value: {
            role: transcriptRole(agent.id, message),
            message: { content: [{ type: "text", text: entry.body || "" }] },
            oai: {
              entryId: entry.entryId, messageId: entry.messageId, entryKind: entry.entryKind,
              seq: entry.seq, updatedSeq: entry.updatedSeq, generation: entry.generation,
              roomId: message?.roomId, senderId: message?.senderId, createdAt: entry.createdAt, updatedAt: entry.updatedAt
            }
          }
        };
      });
      for (const turn of state.memberTurns.filter((item) => item.memberAgentId === agent.id)) {
        const hiddenMessages = (turn.newMessages || []).filter((message) => message.speakerKind === "system");
        if (turn.isFirstRun) hiddenMessages.unshift({
          speakerKind: "system", speakerName: "OAI Bot host", isSelf: false,
          text: "Hidden first-run cue (not a user message). Open the newly created Bot conversation proactively without mentioning this cue."
        });
        hiddenMessages.forEach((message, index) => transcriptRows.push({
          at: Date.parse(turn.createdAt) || 0,
          order: 1_000_000 + index,
          value: {
            role: "system",
            message: { content: [{ type: "text", text: message.text }] },
            oai: {
              hidden: true, speakerName: message.speakerName, workflowId: turn.workflowId,
              memberTurnId: turn.id, requestedBy: turn.requestedBy, roomId: turn.roomId,
              createdAt: turn.createdAt
            }
          }
        }));
      }
      const transcript = transcriptRows
        .sort((left, right) => left.at - right.at || left.order - right.order)
        .map((row) => JSON.stringify(row.value)).join("\n");
      await this.writeChanged(path.join("agent-transcripts", agent.id, `${agent.id}.jsonl`), transcript ? `${transcript}\n` : "");
      await this.writeChanged(path.join("transcript-publish", `${agent.id}.json`), json({
        version: 2,
        generation: metadata?.generation || 1,
        writerSeq: metadata?.updatedSeq || 0,
        publishedThroughSeq: metadata?.updatedSeq || 0,
        anchorSeq: entries[0]?.seq || 0,
        anchorId: entries[0]?.entryId
      }));
      const audit = [
        ...state.memberTurns.filter((turn) => turn.memberAgentId === agent.id).map((turn) => ({ type: "member_turn", ...turn })),
        ...state.deliveryReceipts.filter((receipt) => receipt.fromAgentId === agent.id || receipt.toAgentId === agent.id).map((receipt) => ({ type: "delivery_receipt", ...receipt }))
      ].map((entry) => JSON.stringify(entry)).join("\n");
      await this.writeChanged(path.join(base, "audit.jsonl"), audit ? `${audit}\n` : "");
      await this.writeChanged(path.join(base, "store.json"), json({
        version: 1,
        transcriptMetadata: metadata,
        transcriptEntries: entries,
        clientState: state.agentClientStates.find((item) => item.agentId === agent.id),
        memberTurns: state.memberTurns.filter((turn) => turn.memberAgentId === agent.id),
        deliveryReceipts: state.deliveryReceipts.filter((receipt) => receipt.fromAgentId === agent.id || receipt.toAgentId === agent.id)
      }));
      const sqliteRelevantState = {
        agent,
        clientState: state.agentClientStates.find((item) => item.agentId === agent.id),
        routines: state.routines.filter((routine) => routine.agentId === agent.id),
        memberTurns: state.memberTurns.filter((turn) => turn.memberAgentId === agent.id),
        transcriptEntries: entries,
        messages: entries.flatMap((entry) => {
          const message = entry.messageId ? state.messages.find((item) => item.id === entry.messageId) : undefined;
          return message ? [message] : [];
        })
      };
      const sqliteFingerprint = createHash("sha256").update(JSON.stringify(sqliteRelevantState)).digest("hex");
      if (this.sqliteFingerprints.get(agent.id) !== sqliteFingerprint) {
        syncAgentSqlite(path.join(this.root, base, "store.db"), agent, state);
        this.sqliteFingerprints.set(agent.id, sqliteFingerprint);
      }
    }
    for (const room of state.rooms.filter((item) => item.kind === "group")) {
      liveIds.add(room.id);
      const base = path.join("agents", room.id);
      await this.writeChanged(path.join(base, "profile.json"), json(groupProfile(room)));
      await this.writeChanged(path.join(base, "group.json"), json({ version: 1, memberIds: room.agentIds }));
    }
    await this.writeChanged("source-map.json", json(Object.fromEntries([
      ...state.agents.map((agent) => [agent.id, { sourceId: agent.id, mode: "local" }]),
      ...state.rooms.filter((room) => room.kind === "group").map((room) => [room.id, { sourceId: room.id, mode: "local" }])
    ])));
    await this.writeChanged("send-acceptance.json", json({
      version: 1,
      historyGaps: [],
      records: state.deliveryReceipts
    }));
    await this.archiveRemoved(liveIds);
  }

  async appendRuntimeEvent(agentId: string, event: unknown) {
    const directory = path.join(this.root, "agent-transcripts", agentId);
    await mkdir(directory, { recursive: true });
    const serialized = JSON.stringify(event);
    const bounded = Buffer.byteLength(serialized) <= 262_144
      ? serialized
      : JSON.stringify({ role: "event", truncated: true, preview: serialized.slice(0, 64_000), recordedAt: new Date().toISOString() });
    await appendFile(path.join(directory, `${agentId}.events.jsonl`), `${bounded}\n`, "utf8");
  }

  private async archiveRemoved(liveIds: Set<string>) {
    const agentsRoot = path.join(this.root, "agents");
    for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || liveIds.has(entry.name)) continue;
      const destination = path.join(this.root, ".deleted", `${entry.name}-${Date.now()}`);
      await rename(path.join(agentsRoot, entry.name), destination);
      this.sqliteFingerprints.delete(entry.name);
      for (const key of [...this.fingerprints.keys()]) if (key.startsWith(`agents/${entry.name}/`)) this.fingerprints.delete(key);
    }
    const transcriptsRoot = path.join(this.root, "agent-transcripts");
    for (const entry of await readdir(transcriptsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || liveIds.has(entry.name)) continue;
      await rename(path.join(transcriptsRoot, entry.name), path.join(this.root, ".deleted", `transcript-${entry.name}-${Date.now()}`));
      for (const key of [...this.fingerprints.keys()]) if (key.startsWith(`agent-transcripts/${entry.name}/`)) this.fingerprints.delete(key);
    }
  }

  private async archiveRemovedAutomations(agentId: string, liveIds: Set<string>) {
    const automationsRoot = path.join(this.root, "agents", agentId, "automations");
    if (!(await exists(automationsRoot))) return;
    for (const entry of await readdir(automationsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || liveIds.has(entry.name)) continue;
      await rename(path.join(automationsRoot, entry.name), path.join(this.root, ".deleted", `automation-${agentId}-${entry.name}-${Date.now()}`));
      for (const key of [...this.fingerprints.keys()]) if (key.startsWith(`agents/${agentId}/automations/${entry.name}/`)) this.fingerprints.delete(key);
    }
  }

  private async archiveRemovedMemoryLogs(agentId: string, liveMonths: Set<string>) {
    const logRoot = path.join(this.root, "agents", agentId, "memory", "log");
    if (!(await exists(logRoot))) return;
    for (const entry of await readdir(logRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || liveMonths.has(entry.name.slice(0, -3))) continue;
      await rename(path.join(logRoot, entry.name), path.join(this.root, ".deleted", `memory-${agentId}-${entry.name.slice(0, -3)}-${Date.now()}.md`));
      this.fingerprints.delete(path.join("agents", agentId, "memory", "log", entry.name));
    }
  }
}
