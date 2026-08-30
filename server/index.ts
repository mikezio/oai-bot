import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { CodexClient } from "./codex.js";
import { CrewOrchestrator } from "./crew.js";
import { isoNow, makeId, Store } from "./store.js";
import { sanitizeAgentName } from "./mentions.js";
import { agentStateFrame, changedAgentStateFamilies, TRANSCRIPT_HEARTBEAT_MS, TRANSCRIPT_INLINE_BODY_MAX_BYTES, TRANSCRIPT_STREAM_LIFETIME_MS, transcriptFramesForCursor } from "./transcriptProtocol.js";
import type { AgentClientPresence, AgentProfile, AppState, AttachmentRef, ChatMessage, MemberTurnMessageSnapshot, MemberTurnPeerSnapshot, MemberTurnRoomSnapshot, Room, Routine, TranscriptCursor, TranscriptEntryCommit } from "./types.js";
import { avatarShapeValues, normalizeAvatarVectorSpec } from "./avatar.js";
import { normalizeMessageSource } from "./clientSource.js";
import { removeAgentFromState } from "./agentDeletion.js";
import { removeGroupRoomFromState } from "./roomDeletion.js";
import { DockerRuntimeProvider } from "./runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workspace = path.join(root, "shared-workspace");
await mkdir(workspace, { recursive: true });
const host = process.env.HOST || "127.0.0.1";

function cleanAvatarDataUrl(value: unknown) {
  if (value === "" || value == null) return undefined;
  const dataUrl = String(value);
  const match = dataUrl.match(/^data:image\/(png|webp|jpeg);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || Buffer.byteLength(match[2], "base64") > 2_000_000) throw Object.assign(new Error("Avatar images must be PNG, WebP, or JPEG and no larger than 2 MB"), { statusCode: 400 });
  return dataUrl;
}

const store = new Store(path.join(root, "data", "state.json"));
await store.load();
await Promise.all(store.snapshot().agents.map((agent) => mkdir(path.join(root, agent.privateWorkspacePath || `agent-workspaces/${agent.id}`), { recursive: true })));
const codex = new CodexClient(workspace);
const runtime = process.env.OAI_RUNTIME_PROVIDER === "docker" ? new DockerRuntimeProvider({ projectRoot: root }) : undefined;
if (runtime) {
  await runtime.start();
  await codex.setExecutionEnvironment(runtime.executionEnvironment());
}
const clients = new Set<express.Response>();
type TranscriptStreamClient = {
  id: string;
  response: express.Response;
  cursors: Map<string, TranscriptCursor>;
  inlineBodyMaxBytes: number;
  heartbeat?: NodeJS.Timeout;
  lifetime?: NodeJS.Timeout;
  closed: boolean;
};
const transcriptClients = new Set<TranscriptStreamClient>();
const presenceByAgent = new Map<string, AgentClientPresence>();
let account = await codex.account();
let publishedState = { ...store.snapshot(), account };

function collectionDelta<T extends { id: string }>(before: T[], after: T[]) {
  const previous = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
  const currentIds = new Set(after.map((item) => item.id));
  return {
    upsert: after.filter((item) => previous.get(item.id) !== JSON.stringify(item)),
    remove: before.filter((item) => !currentIds.has(item.id)).map((item) => item.id)
  };
}

function keyedCollectionDelta<T>(before: T[], after: T[], key: (item: T) => string) {
  const previous = new Map(before.map((item) => [key(item), JSON.stringify(item)]));
  const currentIds = new Set(after.map(key));
  return {
    upsert: after.filter((item) => previous.get(key(item)) !== JSON.stringify(item)),
    remove: before.filter((item) => !currentIds.has(key(item))).map(key)
  };
}

function writeTranscriptFrame(client: TranscriptStreamClient, frame: Record<string, unknown>) {
  if (!client.closed) client.response.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function closeTranscriptClient(client: TranscriptStreamClient) {
  if (client.closed) return;
  client.closed = true;
  if (client.heartbeat) clearInterval(client.heartbeat);
  if (client.lifetime) clearTimeout(client.lifetime);
  transcriptClients.delete(client);
  client.response.end();
}

function broadcastTranscriptStreams(before: AppState, after: AppState) {
  for (const client of transcriptClients) {
    try {
      const watchedAgentIds = [...client.cursors.keys()];
      for (const agentId of watchedAgentIds) {
        const cursor = client.cursors.get(agentId)!;
        const beforeMetadata = before.transcriptMetadata.find((item) => item.agentId === agentId);
        const afterMetadata = after.transcriptMetadata.find((item) => item.agentId === agentId);
        if (JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata)) continue;
        const update = transcriptFramesForCursor(after, cursor, client.inlineBodyMaxBytes);
        for (const frame of update.frames) writeTranscriptFrame(client, frame);
        client.cursors.set(agentId, update.cursor);
      }
      const changes = changedAgentStateFamilies(before, after, watchedAgentIds);
      for (const change of changes) writeTranscriptFrame(client, { agentStateChanged: change });
      if (changes.length) writeTranscriptFrame(client, agentStateFrame(after, changes.map((change) => change.agentId), false));
    } catch {
      closeTranscriptClient(client);
    }
  }
}

function applyActivePresenceToUnread() {
  const timestamp = Date.now();
  const active = [...presenceByAgent.values()].filter((presence) => presence.viewing && Date.parse(presence.expiresAt) > timestamp);
  if (!active.length) return;
  const activeIds = new Set(active.map((presence) => presence.agentId));
  if (!store.snapshot().agentClientStates.some((client) => activeIds.has(client.agentId) && client.unreadCount > 0)) return;
  store.mutate((state) => {
    const viewedAt = isoNow();
    for (const client of state.agentClientStates) {
      if (!activeIds.has(client.agentId) || client.unreadCount === 0) continue;
      client.unreadCount = 0;
      client.lastViewedAt = viewedAt;
      client.updatedAt = viewedAt;
    }
  });
}

function broadcast() {
  applyActivePresenceToUnread();
  const next = { ...store.snapshot(), account };
  const payload = `data: ${JSON.stringify({
    type: "delta",
    agents: collectionDelta(publishedState.agents, next.agents),
    rooms: collectionDelta(publishedState.rooms, next.rooms),
    messages: collectionDelta(publishedState.messages, next.messages),
    approvals: collectionDelta(publishedState.approvals, next.approvals),
    routines: collectionDelta(publishedState.routines, next.routines),
    transcriptMetadata: keyedCollectionDelta(publishedState.transcriptMetadata, next.transcriptMetadata, (item) => item.agentId),
    transcriptEntries: keyedCollectionDelta(publishedState.transcriptEntries, next.transcriptEntries, (item) => `${item.agentId}:${item.generation}:${item.entryId}`),
    memberTurns: collectionDelta(publishedState.memberTurns, next.memberTurns),
    deliveryReceipts: collectionDelta(publishedState.deliveryReceipts, next.deliveryReceipts),
    agentClientStates: keyedCollectionDelta(publishedState.agentClientStates, next.agentClientStates, (item) => item.agentId),
    ...(JSON.stringify(publishedState.account) === JSON.stringify(next.account) ? {} : { account: next.account })
  })}\n\n`;
  for (const client of clients) client.write(payload);
  broadcastTranscriptStreams(publishedState, next);
  publishedState = next;
}

const crew = new CrewOrchestrator(store, codex, broadcast, runtime);
crew.recoverPendingMessages();
const app = express();
app.use(express.json({ limit: "12mb" }));

app.get("/api/state", (_req, res) => res.json({ ...store.snapshot(), account, workspace }));
app.get("/api/runtime/status", async (_req, res, next) => {
  try {
    res.json(runtime ? await runtime.status() : { provider: "none", phase: "missing" });
  } catch (error) { next(error); }
});
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "snapshot", state: { ...store.snapshot(), account, workspace } })}\n\n`);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post("/api/account/refresh", async (_req, res, next) => {
  try {
    account = await codex.account();
    broadcast();
    res.json(account);
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/login", async (_req, res, next) => {
  try {
    res.json(await codex.startLogin());
  } catch (error) {
    next(error);
  }
});

function roomForPromptTarget(agentId: string) {
  const state = store.snapshot();
  return state.rooms.find((room) => room.id === agentId)
    || state.rooms.find((room) => room.kind === "direct" && room.directAgentId === agentId);
}

function requiredId(value: unknown, label: string) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200) throw Object.assign(new Error(`${label} is required`), { statusCode: 400 });
  return id;
}

function nonNegativeInteger(value: unknown, label: string) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw Object.assign(new Error(`${label} must be a non-negative integer`), { statusCode: 400 });
  return number;
}

function positiveGeneration(value: unknown) {
  const generation = nonNegativeInteger(value, "generation");
  if (generation < 1 || generation > 0xffff_ffff) throw Object.assign(new Error("generation must be a positive uint32"), { statusCode: 400 });
  return generation;
}

function receiptForPrompt(agentId: string, clientNonce: string) {
  const target = roomForPromptTarget(agentId);
  if (!target || !clientNonce) return undefined;
  return store.snapshot().deliveryReceipts
    .filter((item) => item.kind === "user-message" && item.roomId === target.id && item.clientNonce === clientNonce)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function acceptanceRecord(receipt: ReturnType<typeof receiptForPrompt>) {
  if (!receipt) return undefined;
  return {
    status: receipt.status,
    echoEntryId: receipt.echoEntryId || receipt.messageId,
    acceptedAtMs: receipt.acceptedAt ? Date.parse(receipt.acceptedAt) : undefined,
    rejectionCode: receipt.status === "rejected" ? receipt.refusalCode || receipt.delivery : undefined,
    delivery: receipt.delivery,
    mode: receipt.mode,
    workflowId: receipt.workflowId
  };
}

async function attachmentsForIds(attachmentIds: string[]) {
  const attachmentDirectory = path.join(workspace, ".attachments");
  try {
    const records = JSON.parse(await readFile(path.join(attachmentDirectory, "index.json"), "utf8")) as AttachmentRef[];
    return records.filter((item) => attachmentIds.includes(item.id));
  } catch {
    return [];
  }
}

function optionalTimestamp(value: unknown, label: string) {
  if (value == null) return undefined;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw Object.assign(new Error(`${label} must be a non-negative integer timestamp`), { statusCode: 400 });
  return timestamp;
}

function normalizedRichText(value: unknown) {
  if (value == null) return undefined;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw Object.assign(new Error("richText must be JSON serializable"), { statusCode: 400 }); }
  if (typeof serialized !== "string") throw Object.assign(new Error("richText must be JSON serializable"), { statusCode: 400 });
  if (Buffer.byteLength(serialized, "utf8") > 100_000) throw Object.assign(new Error("richText is limited to 100 KB"), { statusCode: 413 });
  return structuredClone(value);
}

async function attachmentsFromEnvelope(body: Record<string, any>) {
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.slice(0, 8).filter((value: unknown) => typeof value === "string") : [];
  const attachments = await attachmentsForIds(attachmentIds);
  const paths = Array.isArray(body.attachmentPaths ?? body.attachment_paths) ? (body.attachmentPaths ?? body.attachment_paths).slice(0, 8) : [];
  const names = Array.isArray(body.attachmentNames ?? body.attachment_names) ? (body.attachmentNames ?? body.attachment_names).slice(0, 8) : [];
  for (let index = 0; index < paths.length; index += 1) {
    const supplied = typeof paths[index] === "string" ? paths[index].trim() : "";
    if (!supplied || supplied.length > 1_000) throw Object.assign(new Error("Every attachment path must be a valid string"), { statusCode: 400 });
    const absolute = path.resolve(workspace, supplied);
    if (absolute !== workspace && !absolute.startsWith(`${workspace}${path.sep}`)) throw Object.assign(new Error("Attachment paths must stay inside the shared workspace"), { statusCode: 403 });
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile()) throw Object.assign(new Error(`Attachment path was not found: ${supplied}`), { statusCode: 400 });
    if (info.size > 8_000_000) throw Object.assign(new Error("Attachments are limited to 8 MB each"), { statusCode: 413 });
    const relative = path.relative(workspace, absolute);
    if (attachments.some((attachment) => attachment.path === relative)) continue;
    const suppliedName = typeof names[index] === "string" ? names[index].trim() : "";
    attachments.push({
      id: `path:${relative}`, name: (suppliedName || path.basename(relative)).slice(0, 160), path: relative,
      size: info.size, mimeType: "application/octet-stream"
    });
  }
  return attachments.slice(0, 8);
}

async function dispatchPrompt(roomId: string, body: Record<string, any>) {
  const content = String(body.prompt ?? body.content ?? "").trim();
  const hasAttachments = Array.isArray(body.attachmentIds) && body.attachmentIds.length || Array.isArray(body.attachmentPaths ?? body.attachment_paths) && (body.attachmentPaths ?? body.attachment_paths).length;
  if (!content && !hasAttachments) throw Object.assign(new Error("Message cannot be empty"), { statusCode: 400 });
  if (!account.connected || account.authMode !== "chatgpt") {
    throw Object.assign(new Error("Sign in with ChatGPT before running the Bots. API-key fallback is intentionally disabled."), { statusCode: 409 });
  }
  const state = store.snapshot();
  const replyCandidate = typeof body.replyToId === "string" ? body.replyToId : typeof body.replyTo === "string" ? body.replyTo : undefined;
  const replyTo = replyCandidate && state.messages.some((message) => message.id === replyCandidate && message.roomId === roomId) ? replyCandidate : undefined;
  const attachments = await attachmentsFromEnvelope(body);
  if (!content && !attachments.length) throw Object.assign(new Error("Message cannot be empty"), { statusCode: 400 });
  const clientNonce = typeof body.clientNonce === "string" ? body.clientNonce.slice(0, 100) : undefined;
  const messageText = content || `Attached ${attachments.map((item) => item.name).join(", ")}`;
  const traceparent = body.traceparent == null ? undefined : String(body.traceparent).trim();
  if (traceparent && (traceparent.length > 512 || !/^[\x21-\x7e]+$/.test(traceparent))) throw Object.assign(new Error("traceparent is invalid"), { statusCode: 400 });
  const sourceValue = normalizeMessageSource(body.source);
  const envelope: Pick<ChatMessage, "richText" | "isFork" | "traceparent" | "sentAtMs" | "enterEpochMs" | "composedAtMs" | "source" | "attachmentPaths" | "attachmentNames"> = {
    richText: normalizedRichText(body.richText ?? body.rich_text),
    isFork: body.isFork === true || body.is_fork === true,
    traceparent: traceparent || undefined,
    sentAtMs: optionalTimestamp(body.sentAtMs ?? body.sent_at_ms, "sentAtMs"),
    enterEpochMs: optionalTimestamp(body.enterEpochMs ?? body.enter_epoch_ms, "enterEpochMs"),
    composedAtMs: optionalTimestamp(body.composedAtMs ?? body.composed_at_ms, "composedAtMs"),
    source: sourceValue,
    attachmentPaths: attachments.map((attachment) => attachment.path),
    attachmentNames: attachments.map((attachment) => attachment.name)
  };
  return crew.postUserMessage(roomId, messageText.slice(0, 20_000), replyTo, clientNonce, attachments, envelope);
}

app.post("/api/sendPrompt", async (req, res, next) => {
  try {
    const target = roomForPromptTarget(String(req.body.agentId || ""));
    if (!target) return res.status(404).json({ error: "Bot or group not found" });
    const receipt = await dispatchPrompt(target.id, req.body);
    res.status(receipt.delivery === "duplicate" ? 200 : 202).json({
      accepted: true,
      nonceDeduplication: true,
      dispatched: true,
      mode: "local",
      targetKind: target.kind === "group" ? "room" : "direct",
      delivery: receipt.delivery === "duplicate" ? "duplicate" : "accepted-local",
      messageId: receipt.messageId,
      receiptId: receipt.receiptId,
      acceptedAtMs: Date.parse(receipt.acceptedAt)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/promptAcceptanceStatus", (req, res) => {
  const nonce = typeof req.body.clientNonce === "string" ? req.body.clientNonce : "";
  const agentId = String(req.body.agentId || "");
  const receipt = receiptForPrompt(agentId, nonce);
  const authoritative = acceptanceRecord(receipt);
  if (authoritative) return res.json({ outcome: "found", record: authoritative });
  const target = roomForPromptTarget(agentId);
  const message = target && nonce
    ? store.snapshot().messages.find((item) => item.roomId === target.id && item.clientNonce === nonce && item.senderType === "user")
    : undefined;
  if (!message) return res.json({ outcome: "not-found" });
  const acceptanceStatus = message.dispatchStatus === "failed" || message.dispatchStatus === "superseded"
    ? "rejected"
    : message.dispatchStatus === "pending"
      ? "pending"
      : "accepted";
  res.json({
    outcome: "found",
    record: { status: acceptanceStatus, echoEntryId: message.id, acceptedAtMs: Date.parse(message.createdAt), rejectionCode: acceptanceStatus === "rejected" ? message.dispatchStatus : undefined }
  });
});

app.get("/api/delivery-status", (req, res, next) => {
  try {
    const messageId = typeof req.query.messageId === "string" ? req.query.messageId.trim() : "";
    const clientNonce = typeof req.query.clientNonce === "string" ? req.query.clientNonce.trim() : "";
    const receiptId = typeof req.query.receiptId === "string" ? req.query.receiptId.trim() : "";
    if (!messageId && !clientNonce && !receiptId) return res.status(400).json({ error: "Provide messageId, clientNonce, or receiptId" });
    const roomId = typeof req.query.roomId === "string" ? req.query.roomId : undefined;
    const receipt = store.snapshot().deliveryReceipts
      .filter((item) => (!receiptId || item.id === receiptId)
        && (!messageId || item.messageId === messageId)
        && (!clientNonce || item.clientNonce === clientNonce)
        && (!roomId || item.roomId === roomId))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!receipt) return res.json({ outcome: "not-found", record: { status: "not-found" } });
    res.json({ outcome: "found", record: receipt });
  } catch (error) {
    next(error);
  }
});

app.get("/api/messages/:messageId/delivery-status", (req, res) => {
  const receipt = store.snapshot().deliveryReceipts
    .filter((item) => item.messageId === req.params.messageId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (!receipt) return res.json({ outcome: "not-found", record: { status: "not-found" } });
  res.json({ outcome: "found", record: receipt });
});

app.post("/api/agents/:agentId/interrupt", (req, res, next) => {
  try {
    const target = roomForPromptTarget(req.params.agentId);
    if (!target) return res.status(404).json({ error: "Bot or group not found" });
    crew.stopRoom(target.id);
    res.json({ delivered: true });
  } catch (error) {
    next(error);
  }
});

function transcriptWatch(agentId: string, generation: number, afterUpdatedSeq: number) {
  const state = store.snapshot();
  if (!state.agents.some((agent) => agent.id === agentId)) throw Object.assign(new Error("Bot not found"), { statusCode: 404 });
  const metadata = state.transcriptMetadata.find((item) => item.agentId === agentId);
  if (!metadata) throw Object.assign(new Error("Bot transcript not found"), { statusCode: 404 });
  if (generation > metadata.generation || (generation === metadata.generation && afterUpdatedSeq > metadata.updatedSeq)) {
    throw Object.assign(new Error("Transcript cursor is ahead of the current transcript"), { statusCode: 409 });
  }
  const cursorTooOld = generation < metadata.generation;
  const changes = state.transcriptEntries
    .filter((entry) => entry.agentId === agentId && entry.generation === metadata.generation && (cursorTooOld || entry.updatedSeq > afterUpdatedSeq))
    .sort((left, right) => left.updatedSeq - right.updatedSeq || left.seq - right.seq);
  return {
    agentId,
    generation: metadata.generation,
    updatedSeq: metadata.updatedSeq,
    cursorTooOld,
    requestedCursor: { generation, afterUpdatedSeq },
    rows: [{
      agentId,
      generation: metadata.generation,
      entries: changes.filter((entry) => !entry.deleted),
      deletes: changes.filter((entry) => entry.deleted).map((entry) => ({ entryId: entry.entryId, updatedSeq: entry.updatedSeq, deletedAt: entry.deletedAt })),
      replay: cursorTooOld
    }]
  };
}

app.get("/api/agents/:agentId/transcript/watch", (req, res, next) => {
  try {
    const agentId = requiredId(req.params.agentId, "agentId");
    const generation = positiveGeneration(req.query.generation);
    const afterUpdatedSeq = nonNegativeInteger(req.query.afterUpdatedSeq ?? 0, "afterUpdatedSeq");
    res.json(transcriptWatch(agentId, generation, afterUpdatedSeq));
  } catch (error) {
    next(error);
  }
});

app.post("/api/transcripts/watch", (req, res, next) => {
  try {
    const requested = Array.isArray(req.body.cursors) ? req.body.cursors : [req.body];
    if (!requested.length || requested.length > 100) return res.status(400).json({ error: "Provide between 1 and 100 transcript cursors" });
    const watches = requested.map((cursor: Record<string, unknown>) => transcriptWatch(
      requiredId(cursor.agentId, "agentId"),
      positiveGeneration(cursor.generation),
      nonNegativeInteger(cursor.afterUpdatedSeq ?? 0, "afterUpdatedSeq")
    ));
    res.json({ watches });
  } catch (error) {
    next(error);
  }
});

function parseTranscriptCursor(value: Record<string, unknown>, defaultAgentId?: string): TranscriptCursor {
  const agentId = requiredId(value.agentId ?? value.agent_id ?? defaultAgentId, "agentId");
  const metadata = store.snapshot().transcriptMetadata.find((item) => item.agentId === agentId);
  const generationValue = value.generation ?? metadata?.generation;
  return {
    agentId,
    generation: positiveGeneration(generationValue),
    afterUpdatedSeq: nonNegativeInteger(value.afterUpdatedSeq ?? value.after_updated_seq ?? 0, "afterUpdatedSeq")
  };
}

function openTranscriptStream(req: express.Request, res: express.Response, requestedCursors: TranscriptCursor[], includeUnlistedAgents: boolean, inlineBodyMaxBytes: number) {
  const state = store.snapshot();
  const cursors = new Map(requestedCursors.map((cursor) => [cursor.agentId, cursor]));
  if (includeUnlistedAgents) {
    for (const metadata of state.transcriptMetadata) {
      if (!cursors.has(metadata.agentId)) cursors.set(metadata.agentId, { agentId: metadata.agentId, generation: metadata.generation, afterUpdatedSeq: 0 });
    }
  }
  if (!cursors.size || cursors.size > 100) throw Object.assign(new Error("Provide between 1 and 100 transcript cursors"), { statusCode: 400 });
  const initial = [...cursors.values()].map((cursor) => transcriptFramesForCursor(state, cursor, inlineBodyMaxBytes));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  const client: TranscriptStreamClient = {
    id: makeId(), response: res, cursors, inlineBodyMaxBytes, closed: false
  };
  transcriptClients.add(client);
  writeTranscriptFrame(client, { connected: { streamId: client.id, serverTimeMs: Date.now(), absoluteLifetimeMs: TRANSCRIPT_STREAM_LIFETIME_MS } });
  for (const update of initial) {
    for (const frame of update.frames) writeTranscriptFrame(client, frame);
    client.cursors.set(update.cursor.agentId, update.cursor);
  }
  writeTranscriptFrame(client, agentStateFrame(state, [...client.cursors.keys()], true));
  client.heartbeat = setInterval(() => writeTranscriptFrame(client, { heartbeat: { serverTimeMs: Date.now() } }), TRANSCRIPT_HEARTBEAT_MS);
  client.lifetime = setTimeout(() => closeTranscriptClient(client), TRANSCRIPT_STREAM_LIFETIME_MS);
  req.on("close", () => closeTranscriptClient(client));
}

app.get("/api/agents/:agentId/transcript/stream", (req, res, next) => {
  try {
    const cursor = parseTranscriptCursor(req.query as Record<string, unknown>, req.params.agentId);
    const inlineBodyMaxBytes = Math.min(1_000_000, nonNegativeInteger(req.query.inlineBodyMaxBytes ?? TRANSCRIPT_INLINE_BODY_MAX_BYTES, "inlineBodyMaxBytes"));
    openTranscriptStream(req, res, [cursor], false, inlineBodyMaxBytes);
  } catch (error) { next(error); }
});

app.get("/api/transcripts/stream", (req, res, next) => {
  try {
    let rawCursors: Record<string, unknown>[];
    if (typeof req.query.cursors === "string") {
      const parsed = JSON.parse(req.query.cursors);
      if (!Array.isArray(parsed)) return res.status(400).json({ error: "cursors must be a JSON array" });
      rawCursors = parsed;
    } else {
      rawCursors = [req.query as Record<string, unknown>];
    }
    const cursors = rawCursors.filter((cursor) => cursor.agentId != null || cursor.agent_id != null).map((cursor) => parseTranscriptCursor(cursor));
    const inlineBodyMaxBytes = Math.min(1_000_000, nonNegativeInteger(req.query.inlineBodyMaxBytes ?? TRANSCRIPT_INLINE_BODY_MAX_BYTES, "inlineBodyMaxBytes"));
    openTranscriptStream(req, res, cursors, req.query.includeUnlistedAgents === "true", inlineBodyMaxBytes);
  } catch (error) { next(error); }
});

app.get("/api/agents/:agentId/transcript/entries", (req, res, next) => {
  try {
    const agentId = requiredId(req.params.agentId, "agentId");
    if (!store.snapshot().agents.some((agent) => agent.id === agentId)) return res.status(404).json({ error: "Bot not found" });
    const generation = req.query.generation == null ? undefined : positiveGeneration(req.query.generation);
    const beforeSeq = req.query.beforeSeq == null ? undefined : nonNegativeInteger(req.query.beforeSeq, "beforeSeq");
    const limit = Math.min(200, Math.max(1, nonNegativeInteger(req.query.limit ?? 50, "limit")));
    res.json(store.listTranscriptEntries(agentId, { generation, beforeSeq, limit, includeDeleted: req.query.includeDeleted === "true" }));
  } catch (error) { next(error); }
});

function transcriptCommitFromBody(value: Record<string, unknown>, deleted = false): TranscriptEntryCommit {
  const entryId = requiredId(value.entryId ?? value.entry_id, "entryId");
  const entryKind = deleted ? "delete" : String(value.entryKind ?? value.entry_kind ?? "message");
  if (!["message", "peer-message", "activity", "approval", "routine", "error", "delete"].includes(entryKind)) throw Object.assign(new Error("Unsupported transcript entryKind"), { statusCode: 400 });
  const body = value.body == null ? undefined : String(value.body);
  if (body != null && Buffer.byteLength(body, "utf8") > 256_000) throw Object.assign(new Error("Transcript entry bodies are limited to 256 KB"), { statusCode: 413 });
  const expectedValue = value.expectedUpdatedSeq ?? value.expected_updated_seq;
  return {
    entryId,
    messageId: typeof value.messageId === "string" ? value.messageId : typeof value.message_id === "string" ? value.message_id : undefined,
    entryKind: entryKind as TranscriptEntryCommit["entryKind"],
    body,
    bodyOmitted: value.bodyOmitted === true || value.body_omitted === true,
    blobHash: typeof value.blobHash === "string" ? value.blobHash.slice(0, 256) : typeof value.blob_hash === "string" ? value.blob_hash.slice(0, 256) : undefined,
    deleted: deleted || value.deleted === true || entryKind === "delete",
    expectedUpdatedSeq: expectedValue == null ? undefined : nonNegativeInteger(expectedValue, "expectedUpdatedSeq")
  };
}

app.post("/api/agents/:agentId/transcript/commit", async (req, res, next) => {
  try {
    const agentId = requiredId(req.params.agentId, "agentId");
    const metadata = store.snapshot().transcriptMetadata.find((item) => item.agentId === agentId);
    if (!metadata) return res.status(404).json({ error: "Bot transcript not found" });
    const generation = req.body.generation == null ? metadata.generation : positiveGeneration(req.body.generation);
    if (generation !== metadata.generation) return res.status(409).json({ error: "Transcript generation changed", generation: metadata.generation });
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    const deletes = Array.isArray(req.body.deletes) ? req.body.deletes : [];
    if (!entries.length && !deletes.length) return res.status(400).json({ error: "Provide entries or deletes" });
    if (entries.length + deletes.length > 100) return res.status(400).json({ error: "A commit is limited to 100 transcript changes" });
    const result = store.commitTranscriptEntries(agentId, [
      ...entries.map((entry: Record<string, unknown>) => transcriptCommitFromBody(entry)),
      ...deletes.map((entry: Record<string, unknown>) => transcriptCommitFromBody(entry, true))
    ]);
    await store.flush();
    broadcast();
    res.status(result.rejections.length ? 409 : 200).json(result);
  } catch (error) { next(error); }
});

app.delete("/api/agents/:agentId/transcript/entries/:entryId", async (req, res, next) => {
  try {
    const agentId = requiredId(req.params.agentId, "agentId");
    if (!store.snapshot().transcriptMetadata.some((item) => item.agentId === agentId)) return res.status(404).json({ error: "Bot transcript not found" });
    const expectedUpdatedSeq = req.query.expectedUpdatedSeq == null ? undefined : nonNegativeInteger(req.query.expectedUpdatedSeq, "expectedUpdatedSeq");
    const result = store.commitTranscriptEntries(agentId, [{ entryId: requiredId(req.params.entryId, "entryId"), entryKind: "delete", deleted: true, expectedUpdatedSeq }]);
    await store.flush();
    broadcast();
    res.status(result.rejections.length ? 409 : 200).json(result);
  } catch (error) { next(error); }
});

app.post("/api/rooms/:roomId/member-turns", async (req, res, next) => {
  try {
    const roomId = requiredId(req.params.roomId, "roomId");
    const memberAgentId = requiredId(req.body.memberAgentId, "memberAgentId");
    const nonce = requiredId(req.body.nonce, "nonce");
    const newMessageIds = Array.isArray(req.body.newMessageIds)
      ? req.body.newMessageIds.map((value: unknown) => requiredId(value, "newMessageId")).slice(0, 100)
      : [];
    const deadlineAt = typeof req.body.deadlineAt === "string" && Number.isFinite(Date.parse(req.body.deadlineAt)) ? req.body.deadlineAt : undefined;
    if (req.body.deadlineAt != null && !deadlineAt) return res.status(400).json({ error: "deadlineAt must be an ISO date" });
    const state = store.snapshot();
    const room = state.rooms.find((item) => item.id === roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (!room.agentIds.includes(memberAgentId)) return res.status(404).json({ error: "Room member not found" });
    if (newMessageIds.some((id: string) => !state.messages.some((message) => message.id === id && message.roomId === roomId))) return res.status(400).json({ error: "Every newMessageId must belong to this room" });
    const suppliedRoom = req.body.room;
    const roomSnapshot: MemberTurnRoomSnapshot | undefined = suppliedRoom && typeof suppliedRoom === "object" ? {
      id: requiredId(suppliedRoom.id, "room.id"),
      name: String(suppliedRoom.name || "").trim().slice(0, 200),
      description: String(suppliedRoom.description || "").slice(0, 8_000),
      isSharedRoom: suppliedRoom.isSharedRoom === true || suppliedRoom.is_shared_room === true,
      sharedRoomId: typeof suppliedRoom.sharedRoomId === "string" ? suppliedRoom.sharedRoomId : typeof suppliedRoom.shared_room_id === "string" ? suppliedRoom.shared_room_id : undefined
    } : undefined;
    if (roomSnapshot && roomSnapshot.id !== roomId) return res.status(400).json({ error: "room.id must match the route roomId" });
    const peerSnapshots: MemberTurnPeerSnapshot[] | undefined = Array.isArray(req.body.peers) ? req.body.peers.slice(0, 100).map((peer: Record<string, unknown>) => ({
      id: requiredId(peer.id, "peer.id"), name: String(peer.name || "").trim().slice(0, 200), description: String(peer.description || "").slice(0, 2_000)
    })) : undefined;
    if (peerSnapshots?.some((peer) => !peer.name)) return res.status(400).json({ error: "Every peer requires a name" });
    const newMessages: MemberTurnMessageSnapshot[] | undefined = Array.isArray(req.body.newMessages) ? req.body.newMessages.slice(0, 100).map((message: Record<string, unknown>) => {
      const kind = String(message.speakerKind || message.speaker_kind || "").toLowerCase();
      if (!["human", "agent", "system"].includes(kind)) throw Object.assign(new Error("speakerKind must be human, agent, or system"), { statusCode: 400 });
      const text = String(message.text || "");
      if (!text.trim()) throw Object.assign(new Error("Every new message requires text"), { statusCode: 400 });
      return {
        messageId: typeof message.messageId === "string" ? message.messageId : typeof message.message_id === "string" ? message.message_id : undefined,
        speakerKind: kind as MemberTurnMessageSnapshot["speakerKind"],
        speakerId: typeof message.speakerId === "string" ? message.speakerId : typeof message.speaker_id === "string" ? message.speaker_id : undefined,
        speakerName: String(message.speakerName || message.speaker_name || "").trim().slice(0, 200),
        isSelf: message.isSelf === true || message.is_self === true,
        text: text.slice(0, 20_000)
      };
    }) : undefined;
    if (newMessages?.some((message) => !message.speakerName)) return res.status(400).json({ error: "Every new message requires speakerName" });
    const duplicate = state.memberTurns.find((item) => item.nonce === nonce && item.memberAgentId === memberAgentId);
    const turn = await crew.requestMemberTurn(
      roomId, memberAgentId, nonce, newMessageIds,
      req.body.isWindingDown === true || req.body.is_winding_down === true, deadlineAt,
      { room: roomSnapshot, peers: peerSnapshots, newMessages }
    );
    res.status(duplicate ? 200 : 202).json({ dispatch: duplicate ? "duplicate" : "accepted", memberAgentId, workflowId: turn.workflowId || turn.id, turn });
  } catch (error) {
    next(error);
  }
});

app.post("/api/member-turns/:id/cancel", async (req, res, next) => {
  try {
    const id = requiredId(req.params.id, "memberTurnId");
    if (!store.snapshot().memberTurns.some((turn) => turn.id === id)) return res.status(404).json({ error: "Member turn not found" });
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : "Cancelled";
    const turn = await crew.cancelMemberTurn(id, reason || "Cancelled");
    res.json({ delivered: true, turn });
  } catch (error) {
    next(error);
  }
});

app.post("/api/member-turns/cancel", async (req, res, next) => {
  try {
    const nonce = requiredId(req.body.nonce, "nonce");
    const memberAgentId = requiredId(req.body.memberAgentId ?? req.body.member_agent_id, "memberAgentId");
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : "Cancelled";
    const turn = await crew.cancelMemberTurnByNonce(nonce, memberAgentId, reason || "Cancelled");
    res.json({ delivered: true, turn });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-messages", async (req, res, next) => {
  try {
    const fromAgentId = requiredId(req.body.fromAgentId, "fromAgentId");
    const toAgentId = requiredId(req.body.toAgentId, "toAgentId");
    const messageId = requiredId(req.body.messageId, "messageId");
    const messageText = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!messageText) return res.status(400).json({ error: "text is required" });
    if (messageText.length > 8_000) return res.status(413).json({ error: "Peer messages are limited to 8,000 characters" });
    const state = store.snapshot();
    if (fromAgentId === toAgentId || !state.agents.some((agent) => agent.id === fromAgentId) || !state.agents.some((agent) => agent.id === toAgentId)) return res.status(400).json({ error: "Sender and recipient must be different existing Bots" });
    const sourceRoomId = typeof req.body.sourceRoomId === "string" ? req.body.sourceRoomId : typeof req.body.roomId === "string" ? req.body.roomId : undefined;
    if (sourceRoomId && !state.rooms.some((room) => room.id === sourceRoomId && room.agentIds.includes(fromAgentId))) return res.status(400).json({ error: "sourceRoomId must be a chat containing the sender" });
    const result = await crew.sendAgentMessage(fromAgentId, toAgentId, messageId, messageText, sourceRoomId);
    res.status(result.duplicate ? 200 : 202).json({
      delivery: result.duplicate ? "duplicate" : "delivered-local",
      mode: "local",
      targetAgentId: toAgentId,
      message: result.message,
      workflowId: result.turn?.workflowId || result.turn?.id
    });
  } catch (error) {
    next(error);
  }
});

function patchAgentClientState(agentIdValue: unknown, body: Record<string, unknown>) {
  const agentId = requiredId(agentIdValue, "agentId");
  if (!store.snapshot().agents.some((agent) => agent.id === agentId)) throw Object.assign(new Error("Bot not found"), { statusCode: 404 });
  const booleanFields = ["notificationsEnabled", "notifyOnUpdatesEnabled", "hiddenFromSidebar"] as const;
  for (const field of booleanFields) {
    if (field in body && typeof body[field] !== "boolean") throw Object.assign(new Error(`${field} must be a boolean`), { statusCode: 400 });
  }
  if ("markRead" in body && typeof body.markRead !== "boolean") throw Object.assign(new Error("markRead must be a boolean"), { statusCode: 400 });
  if ("markUnread" in body && typeof body.markUnread !== "boolean") throw Object.assign(new Error("markUnread must be a boolean"), { statusCode: 400 });
  let updated;
  store.mutate((state) => {
    const clientState = state.agentClientStates.find((item) => item.agentId === agentId);
    if (!clientState) return;
    for (const field of booleanFields) if (typeof body[field] === "boolean") clientState[field] = body[field];
    const timestamp = isoNow();
    if (body.markRead === true) { clientState.unreadCount = 0; clientState.lastViewedAt = timestamp; }
    if (body.markUnread === true) clientState.unreadCount = Math.max(1, clientState.unreadCount);
    clientState.updatedAt = timestamp;
    updated = structuredClone(clientState);
  });
  return updated;
}

app.patch("/api/agents/:agentId/client-state", async (req, res, next) => {
  try {
    const updated = patchAgentClientState(req.params.agentId, req.body);
    await store.flush();
    broadcast();
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/client-state/mark-read", async (req, res, next) => {
  try {
    const updated = patchAgentClientState(req.params.agentId, { markRead: true });
    await store.flush();
    broadcast();
    res.json(updated);
  } catch (error) { next(error); }
});

app.post("/api/agents/:agentId/client-state/mark-unread", async (req, res, next) => {
  try {
    const updated = patchAgentClientState(req.params.agentId, { markUnread: true });
    await store.flush();
    broadcast();
    res.json(updated);
  } catch (error) { next(error); }
});

const CLIENT_PRESENCE_TTL_MS = 45_000;

app.post("/api/agents/:agentId/presence", async (req, res, next) => {
  try {
    const agentId = requiredId(req.params.agentId, "agentId");
    if (!store.snapshot().agents.some((agent) => agent.id === agentId)) return res.status(404).json({ error: "Bot not found" });
    if (typeof req.body.viewing !== "boolean") return res.status(400).json({ error: "viewing must be a boolean" });
    const surface = String(req.body.surface || "unknown").trim().slice(0, 80);
    if (!surface) return res.status(400).json({ error: "surface is required" });
    const updatedAt = isoNow();
    if (req.body.viewing) {
      presenceByAgent.set(agentId, {
        agentId, viewing: true, surface, updatedAt,
        expiresAt: new Date(Date.now() + CLIENT_PRESENCE_TTL_MS).toISOString()
      });
      patchAgentClientState(agentId, { markRead: true });
      await store.flush();
      broadcast();
    } else {
      presenceByAgent.delete(agentId);
    }
    res.json({ agentId, viewing: req.body.viewing, surface, presenceTtlMs: CLIENT_PRESENCE_TTL_MS });
  } catch (error) { next(error); }
});

app.post("/api/rooms/:roomId/messages", async (req, res, next) => {
  try {
    if (!store.snapshot().rooms.some((room) => room.id === req.params.roomId)) return res.status(404).json({ error: "Room not found" });
    const receipt = await dispatchPrompt(req.params.roomId, req.body);
    res.status(receipt.delivery === "duplicate" ? 200 : 202).json(receipt);
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents", async (req, res, next) => {
  try {
    const name = sanitizeAgentName(String(req.body.name || ""));
    if (!name) return res.status(400).json({ error: "Name is required" });
    const duplicate = store.snapshot().agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase());
    if (duplicate) return res.status(409).json({ error: "Agent names must be unique" });
    if (req.body.avatarShape === "custom" && (!Array.isArray(req.body.avatarMorph) || req.body.avatarMorph.length !== 24 || req.body.avatarMorph.some((value:unknown) => !Number.isFinite(Number(value))))) return res.status(400).json({ error: "A custom avatar shape requires exactly 24 numeric morph controls" });
    if (req.body.avatarShape === "vector" && !req.body.avatarVector) return res.status(400).json({ error: "A vector avatar shape requires avatarVector" });
    const timestamp = isoNow();
    const agent: AgentProfile = {
      id: makeId(),
      name,
      title: String(req.body.title || "").slice(0, 60),
      description: String(req.body.description || "").slice(0, 2_000),
      instructions: String(req.body.instructions || "").slice(0, 12_000),
      avatar: String(req.body.avatar || name[0].toUpperCase()).slice(0, 3),
      color: String(req.body.color || "#7C5CFC").slice(0, 20),
      avatarShape: req.body.avatarVector ? "vector" : (avatarShapeValues as readonly string[]).includes(String(req.body.avatarShape)) ? req.body.avatarShape : "blob",
      avatarShapeName: String(req.body.avatarShapeName || "").slice(0, 60),
      avatarMorph: Array.isArray(req.body.avatarMorph) && req.body.avatarMorph.length === 24 ? req.body.avatarMorph.map((value:unknown) => Math.max(.45, Math.min(1.55, Number(value) || 1))) : undefined,
      avatarVector: req.body.avatarVector ? normalizeAvatarVectorSpec(req.body.avatarVector) : undefined,
      avatarColor: String(req.body.avatarColor || req.body.color || "#7C5CFC").slice(0, 20),
      avatarDataUrl: cleanAvatarDataUrl(req.body.avatarDataUrl),
      avatarAccent: String(req.body.avatarAccent || "#FFFFFF").slice(0, 20),
      avatarFace: ["dots", "visor", "spark", "none"].includes(String(req.body.avatarFace)) ? req.body.avatarFace : "dots",
      avatarTexture: ["solid", "gradient", "glass"].includes(String(req.body.avatarTexture)) ? req.body.avatarTexture : "gradient",
      avatarMotion: ["calm", "lively", "off"].includes(String(req.body.avatarMotion)) ? req.body.avatarMotion : "lively",
      avatarAccessory: ["none", "antenna", "halo", "headphones", "crown"].includes(String(req.body.avatarAccessory)) ? req.body.avatarAccessory : "none",
      model: String(req.body.model || "gpt-5.6-terra"),
      effort: String(req.body.effort || "medium"),
      networkAccess: req.body.networkAccess !== false,
      privateWorkspacePath: `agent-workspaces/pending`,
      status: "idle",
      roomThreadIds: {},
      roomLastSeenMessageIds: {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    agent.privateWorkspacePath = `agent-workspaces/${agent.id}`;
    await mkdir(path.join(root, agent.privateWorkspacePath), { recursive: true });
    const directRoom: Room = { id: makeId(), name: agent.name, description: agent.description, agentIds: [agent.id], kind: "direct", directAgentId: agent.id, createdAt: timestamp, updatedAt: timestamp };
    store.mutate((state) => { state.agents.push(agent); state.rooms.push(directRoom); });
    await crew.startAgentFirstRun(agent.id);
    broadcast();
    res.status(201).json(agent);
  } catch (error) {
    next(error);
  }
});

app.post("/api/attachments", async (req, res, next) => {
  try {
    const original = String(req.body.filename || "attachment").slice(0, 160);
    const filename = original.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "") || "attachment";
    const bytes = Buffer.from(String(req.body.bytesBase64 || ""), "base64");
    if (!bytes.length) return res.status(400).json({ error: "Attachment is empty" });
    if (bytes.length > 8_000_000) return res.status(413).json({ error: "Attachments are limited to 8 MB" });
    const directory = path.join(workspace, ".attachments");
    await mkdir(directory, { recursive: true });
    const id = makeId();
    const relative = path.join(".attachments", `${id}-${filename}`);
    await writeFile(path.join(workspace, relative), bytes);
    const attachment: AttachmentRef = { id, name: filename, path: relative, size: bytes.length, mimeType: String(req.body.mimeType || "application/octet-stream").slice(0, 100) };
    let records: AttachmentRef[] = [];
    try { records = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8")); } catch { /* first upload */ }
    records.push(attachment);
    await writeFile(path.join(directory, "index.json"), JSON.stringify(records, null, 2), "utf8");
    res.status(201).json(attachment);
  } catch (error) { next(error); }
});

app.post("/api/messages/:id/reactions", (req, res) => {
  const emoji = String(req.body.emoji || "").trim().slice(0, 16);
  if (!emoji) return res.status(400).json({ error: "Emoji is required" });
  let updated = false;
  store.mutate((state) => {
    const message = state.messages.find((item) => item.id === req.params.id);
    if (!message) return;
    message.reactions ||= {};
    const reactors = message.reactions[emoji] || [];
    message.reactions[emoji] = reactors.includes("user") ? reactors.filter((id) => id !== "user") : [...reactors, "user"];
    if (!message.reactions[emoji].length) delete message.reactions[emoji];
    message.updatedAt = isoNow();
    updated = true;
  });
  if (!updated) return res.status(404).json({ error: "Message not found" });
  broadcast();
  res.json({ ok: true });
});

function nextRoutineRun(intervalMinutes: number, from = Date.now()) {
  return new Date(from + intervalMinutes * 60_000).toISOString();
}

app.post("/api/routines", (req, res) => {
  const state = store.snapshot();
  const room = state.rooms.find((item) => item.id === req.body.roomId);
  const agent = state.agents.find((item) => item.id === req.body.agentId && room?.agentIds.includes(item.id));
  if (!room || !agent) return res.status(400).json({ error: "Choose an agent in this chat" });
  const timestamp = isoNow();
  const intervalMinutes = Math.max(5, Math.min(43_200, Number(req.body.intervalMinutes) || 1_440));
  const routine: Routine = { id: makeId(), roomId: room.id, agentId: agent.id, name: String(req.body.name || "New routine").trim().slice(0, 100), instruction: String(req.body.instruction || "").trim().slice(0, 10_000), intervalMinutes, isEnabled: req.body.isEnabled !== false, nextRunAt: nextRoutineRun(intervalMinutes), createdAt: timestamp, updatedAt: timestamp };
  if (!routine.instruction) return res.status(400).json({ error: "Instruction is required" });
  store.mutate((current) => current.routines.push(routine)); broadcast(); res.status(201).json(routine);
});

app.patch("/api/routines/:id", (req, res) => {
  let updated: Routine | undefined;
  store.mutate((state) => {
    const routine = state.routines.find((item) => item.id === req.params.id); if (!routine) return;
    if (typeof req.body.name === "string") routine.name = req.body.name.trim().slice(0, 100);
    if (typeof req.body.instruction === "string") routine.instruction = req.body.instruction.trim().slice(0, 10_000);
    if (typeof req.body.isEnabled === "boolean") routine.isEnabled = req.body.isEnabled;
    if (Number.isFinite(Number(req.body.intervalMinutes))) routine.intervalMinutes = Math.max(5, Math.min(43_200, Number(req.body.intervalMinutes)));
    routine.nextRunAt = nextRoutineRun(routine.intervalMinutes); routine.updatedAt = isoNow(); updated = structuredClone(routine);
  });
  if (!updated) return res.status(404).json({ error: "Routine not found" }); broadcast(); res.json(updated);
});

app.post("/api/routines/:id/run", (req, res) => {
  const routine = store.snapshot().routines.find((item) => item.id === req.params.id);
  if (!routine) return res.status(404).json({ error: "Routine not found" });
  crew.triggerRoutine(routine);
  const timestamp = isoNow();
  store.mutate((state) => { const item = state.routines.find((entry) => entry.id === routine.id); if (item) { item.lastRunAt = timestamp; item.nextRunAt = nextRoutineRun(item.intervalMinutes); item.updatedAt = timestamp; } });
  broadcast(); res.status(202).json({ ok: true });
});

app.delete("/api/routines/:id", (req, res) => {
  const before = store.snapshot().routines.length;
  store.mutate((state) => { state.routines = state.routines.filter((item) => item.id !== req.params.id); });
  if (store.snapshot().routines.length === before) return res.status(404).json({ error: "Routine not found" });
  broadcast(); res.json({ ok: true });
});

app.patch("/api/agents/:id", (req, res, next) => {
  try {
    if (typeof req.body.avatarShape === "string" && !(avatarShapeValues as readonly string[]).includes(req.body.avatarShape)) return res.status(400).json({ error: `Unsupported avatar shape: ${req.body.avatarShape}` });
    if (req.body.avatarShape === "custom" && !Array.isArray(req.body.avatarMorph)) return res.status(400).json({ error: "A custom avatar shape requires exactly 24 morph controls" });
    if (req.body.avatarShape === "vector" && !req.body.avatarVector) return res.status(400).json({ error: "A vector avatar shape requires avatarVector" });
    const allowed = ["name", "title", "description", "instructions", "avatar", "color", "avatarShape", "avatarColor", "avatarAccent", "avatarFace", "avatarTexture", "avatarMotion", "avatarAccessory", "model", "effort", "networkAccess"] as const;
    let updated: AgentProfile | undefined;
    store.mutate((state) => {
      const agent = state.agents.find((item) => item.id === req.params.id);
      if (!agent) return;
      for (const key of allowed) {
        if (typeof req.body[key] === "string" || (key === "networkAccess" && typeof req.body[key] === "boolean")) (agent as any)[key] = key === "name" ? sanitizeAgentName(String(req.body[key])) : req.body[key];
      }
      if (typeof req.body.avatarColor === "string") agent.color = req.body.avatarColor.slice(0, 20);
      if (typeof req.body.color === "string") agent.avatarColor = req.body.color.slice(0, 20);
      if (Array.isArray(req.body.avatarMorph)) {
        if (req.body.avatarMorph.length !== 24 || req.body.avatarMorph.some((value:unknown) => !Number.isFinite(Number(value)))) throw Object.assign(new Error("A custom avatar morph requires exactly 24 numeric control radii"), { statusCode: 400 });
        agent.avatarMorph = req.body.avatarMorph.map((value:unknown) => Math.max(.45, Math.min(1.55, Number(value))));
        agent.avatarShape = "custom";
        delete agent.avatarVector;
      }
      if (req.body.avatarVector) { agent.avatarVector = normalizeAvatarVectorSpec(req.body.avatarVector); agent.avatarShape = "vector"; delete agent.avatarMorph; }
      else if (typeof req.body.avatarShape === "string" && req.body.avatarShape !== "vector") delete agent.avatarVector;
      if (typeof req.body.avatarShapeName === "string") agent.avatarShapeName = req.body.avatarShapeName.trim().slice(0, 60);
      if ("avatarDataUrl" in req.body) agent.avatarDataUrl = cleanAvatarDataUrl(req.body.avatarDataUrl);
      agent.updatedAt = isoNow();
      const directRoom = state.rooms.find((room) => room.directAgentId === agent.id);
      if (directRoom) { directRoom.name = agent.name; directRoom.description = agent.description; directRoom.updatedAt = isoNow(); }
      updated = structuredClone(agent);
    });
    if (!updated) return res.status(404).json({ error: "Agent not found" });
    broadcast();
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/agents/:id", async (req, res, next) => {
  try {
    const snapshot = store.snapshot();
    const agent = snapshot.agents.find((item) => item.id === req.params.id);
    if (!agent) return res.status(404).json({ error: "Bot not found" });
    for (const room of snapshot.rooms.filter((item) => item.agentIds.includes(agent.id))) crew.stopRoom(room.id, `Bot ${agent.name} was deleted`);

    let archivedWorkspace: string | undefined;
    const workspaceRelative = agent.privateWorkspacePath || `agent-workspaces/${agent.id}`;
    const agentWorkspaceRoot = path.join(root, "agent-workspaces");
    const workspaceAbsolute = path.resolve(root, workspaceRelative);
    if (workspaceAbsolute.startsWith(`${agentWorkspaceRoot}${path.sep}`)) {
      const deletedRoot = path.join(agentWorkspaceRoot, ".deleted");
      await mkdir(deletedRoot, { recursive: true });
      const archivedAbsolute = path.join(deletedRoot, `${agent.id}-${Date.now()}`);
      try {
        await rename(workspaceAbsolute, archivedAbsolute);
        archivedWorkspace = path.relative(root, archivedAbsolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    store.mutate((state) => removeAgentFromState(state, agent.id));
    presenceByAgent.delete(agent.id);
    await store.flush();
    broadcast();
    res.json({ ok: true, deletedBotId: agent.id, archivedWorkspace });
  } catch (error) { next(error); }
});

app.post("/api/rooms", (req, res, next) => {
  try {
    const timestamp = isoNow();
    const validAgents = new Set(store.snapshot().agents.map((agent) => agent.id));
    const room: Room = {
      id: makeId(),
      name: String(req.body.name || "New Room").trim().slice(0, 80),
      description: String(req.body.description || "").slice(0, 8_000),
      agentIds: Array.isArray(req.body.agentIds) ? req.body.agentIds.filter((id: string) => validAgents.has(id)).slice(0, 6) : [],
      kind: "group",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (!room.agentIds.length) return res.status(400).json({ error: "Choose at least one agent" });
    store.mutate((state) => state.rooms.push(room));
    broadcast();
    res.status(201).json(room);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/rooms/:id", (req, res) => {
  let updated: Room | undefined;
  store.mutate((state) => {
    const room = state.rooms.find((item) => item.id === req.params.id);
    if (!room) return;
    if (typeof req.body.name === "string") room.name = req.body.name.trim().slice(0, 80);
    if (typeof req.body.description === "string") room.description = req.body.description.slice(0, 8_000);
    if (Array.isArray(req.body.agentIds)) room.agentIds = req.body.agentIds.filter((id: string) => state.agents.some((agent) => agent.id === id)).slice(0, 6);
    room.updatedAt = isoNow();
    updated = structuredClone(room);
  });
  if (!updated) return res.status(404).json({ error: "Room not found" });
  broadcast();
  res.json(updated);
});

app.delete("/api/rooms/:id", async (req, res, next) => {
  try {
    const room = store.snapshot().rooms.find((item) => item.id === req.params.id);
    if (!room) return res.status(404).json({ error: "Channel not found" });
    if (room.kind !== "group") return res.status(400).json({ error: "Direct chats are deleted with their Bot" });
    crew.stopRoom(room.id, `Channel ${room.name} was deleted`);
    store.mutate((state) => removeGroupRoomFromState(state, room.id));
    await store.flush();
    broadcast();
    res.json({ ok: true, deletedChannelId: room.id });
  } catch (error) { next(error); }
});

app.post("/api/approvals/:id", (req, res, next) => {
  try {
    const decision = req.body.decision;
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return res.status(400).json({ error: "Invalid decision" });
    crew.resolveApproval(req.params.id, decision);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

async function filesIn(directory: string, prefix = "", depth = 0): Promise<any[]> {
  if (depth > 4) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries.filter((item) => !item.name.startsWith(".")).slice(0, 100)) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push({ name: entry.name, path: relative, type: "directory", children: await filesIn(absolute, relative, depth + 1) });
    else if (entry.isFile()) output.push({ name: entry.name, path: relative, type: "file", size: (await stat(absolute)).size });
  }
  return output;
}

app.get("/api/workspace", async (_req, res, next) => {
  try {
    res.json({ root: workspace, files: await filesIn(workspace) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspace/file", async (req, res, next) => {
  try {
    const target = path.resolve(workspace, String(req.query.path || ""));
    if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) return res.status(403).json({ error: "Outside shared workspace" });
    const info = await stat(target);
    if (info.size > 1_000_000) return res.status(413).json({ error: "File too large to preview" });
    res.type("text/plain").send(await readFile(target, "utf8"));
  } catch (error) {
    next(error);
  }
});

if (process.env.NODE_ENV === "production" || process.argv.includes("--production")) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(root, "dist", "index.html")));
}

app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || String(error) });
});

const port = Number(process.env.PORT || 4317);
app.listen(port, host, () => console.log(`OAI Bot is running on ${host}:${port}`));

setInterval(async () => {
  account = await codex.account();
  broadcast();
}, 60_000).unref();

setInterval(() => {
  const timestamp = Date.now();
  for (const [agentId, presence] of presenceByAgent) {
    if (Date.parse(presence.expiresAt) <= timestamp) presenceByAgent.delete(agentId);
  }
}, 10_000).unref();

setInterval(() => {
  const due = store.snapshot().routines.filter((routine) => routine.isEnabled && routine.nextRunAt && Date.parse(routine.nextRunAt) <= Date.now());
  for (const routine of due) {
    const timestamp = isoNow();
    store.mutate((state) => {
      const current = state.routines.find((item) => item.id === routine.id);
      if (current) { current.lastRunAt = timestamp; current.nextRunAt = nextRoutineRun(current.intervalMinutes); current.updatedAt = timestamp; }
    });
    try { crew.triggerRoutine(routine); } catch (error) { console.error(`Routine ${routine.id} could not run`, error); }
  }
  if (due.length) broadcast();
}, 30_000).unref();
