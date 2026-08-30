import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "./store.js";
import type { AgentProfile, AppState } from "./types.js";

function agent(id = "agent-one"): AgentProfile {
  const timestamp = "2026-08-29T12:00:00.000Z";
  return {
    id, name: "One", title: "Builder", description: "Builds things", instructions: "Build carefully",
    avatar: "O", color: "#123456", model: "gpt-5.6-luna", effort: "medium", networkAccess: true,
    status: "idle", roomThreadIds: {}, roomLastSeenMessageIds: {}, createdAt: timestamp, updatedAt: timestamp
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gpt-bot-store-test-"));
  return { directory, filePath: path.join(directory, "state.json") };
}

test("legacy state loads with transcript and client-state migration defaults", async () => {
  const f = await fixture();
  try {
    const legacy = { agents: [agent()], rooms: [], messages: [], approvals: [], routines: [] };
    await writeFile(f.filePath, JSON.stringify(legacy), "utf8");
    const store = new Store(f.filePath);
    await store.load();

    const state = store.snapshot();
    assert.equal(state.transcriptMetadata.length, 1);
    assert.equal(state.transcriptMetadata[0].agentId, "agent-one");
    assert.equal(state.transcriptMetadata[0].updatedSeq, 0);
    assert.equal(state.transcriptMetadata[0].generation, 1);
    assert.deepEqual(state.transcriptEntries, []);
    assert.deepEqual(state.memberTurns, []);
    assert.deepEqual(state.deliveryReceipts, []);
    assert.equal(state.agentClientStates[0].notificationsEnabled, true);
    assert.equal(state.agentClientStates[0].notifyOnUpdatesEnabled, true);
    assert.equal(state.agentClientStates[0].notificationSettings, undefined);
    assert.equal(state.agentClientStates[0].unreadCount, 0);
    assert.equal(state.agentClientStates[0].hiddenFromSidebar, false);

    const persisted = JSON.parse(await readFile(f.filePath, "utf8")) as AppState;
    assert.equal(persisted.transcriptMetadata[0].generation, state.transcriptMetadata[0].generation);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("migration converts legacy generations and notification settings without settling running work", async () => {
  const f = await fixture();
  try {
    const timestamp = "2026-08-29T12:00:00.000Z";
    const persisted = {
      agents: [agent()], rooms: [], messages: [{
        id: "message-one", roomId: "room-one", senderType: "user", senderId: "user", content: "Hello",
        kind: "message", status: "complete", mentions: [], transcriptCursors: {
          "agent-one": { generation: "generation-one", updatedSeq: 41 }
        }, createdAt: timestamp, updatedAt: timestamp
      }], approvals: [], routines: [],
      transcriptMetadata: [{ agentId: "agent-one", generation: "generation-one", updatedSeq: 41, createdAt: timestamp, updatedAt: timestamp }],
      transcriptEntries: [],
      memberTurns: [{
        id: "turn-one", nonce: "nonce-one", roomId: "room-one", memberAgentId: "agent-one", requestedBy: "agent",
        requestedByAgentId: "agent-two", peerAgentIds: ["agent-two"], newMessageIds: ["message-one"], isWindingDown: true,
        state: "running", workflowId: "workflow-one", createdAt: timestamp, updatedAt: timestamp
      }],
      deliveryReceipts: [{
        id: "receipt-one", messageId: "message-one", kind: "agent-message", status: "accepted",
        delivery: "delivered-temporal", workflowId: "workflow-one", acceptedAt: timestamp, createdAt: timestamp, updatedAt: timestamp
      }],
      agentClientStates: [{
        agentId: "agent-one", unreadCount: 7, lastMessageId: "message-one", lastMessagePreview: "A durable preview",
        hiddenFromSidebar: true, notificationSettings: { enabled: false, mentionsOnly: true, soundEnabled: false }, updatedAt: timestamp
      }]
    };
    await writeFile(f.filePath, JSON.stringify(persisted), "utf8");
    const store = new Store(f.filePath);
    await store.load();
    const state = store.snapshot();

    assert.equal(state.transcriptMetadata[0].updatedSeq, 41);
    assert.equal(typeof state.transcriptMetadata[0].generation, "number");
    assert.equal(state.messages[0].transcriptCursors?.["agent-one"].generation, state.transcriptMetadata[0].generation);
    assert.equal(state.memberTurns[0].state, "running");
    assert.equal(state.memberTurns[0].recoveryRequired, true);
    assert.equal(state.memberTurns[0].workflowId, "workflow-one");
    assert.equal(state.deliveryReceipts[0].delivery, "delivered-temporal");
    assert.equal(state.agentClientStates[0].unreadCount, 7);
    assert.equal(state.agentClientStates[0].hiddenFromSidebar, true);
    assert.equal(state.agentClientStates[0].notificationsEnabled, false);
    assert.equal(state.agentClientStates[0].notifyOnUpdatesEnabled, false);
    assert.equal(state.agentClientStates[0].notificationSettings, undefined);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("transcript sequence is monotonic across persistence and generation reset", async () => {
  const f = await fixture();
  try {
    const store = new Store(f.filePath);
    await store.load();
    store.mutate((state) => { state.agents.push(agent()); });
    const first = store.nextTranscriptSequence("agent-one");
    const second = store.nextTranscriptSequence("agent-one");
    assert.equal(first.updatedSeq, 1);
    assert.equal(second.updatedSeq, 2);
    assert.equal(second.generation, first.generation);
    assert.equal(typeof first.generation, "number");
    await store.flush();

    const reloaded = new Store(f.filePath);
    await reloaded.load();
    assert.equal(reloaded.nextTranscriptSequence("agent-one").updatedSeq, 3);
    const reset = reloaded.resetTranscriptGeneration("agent-one");
    assert.equal(reset.updatedSeq, 0);
    assert.notEqual(reset.generation, first.generation);
    assert.equal(reloaded.nextTranscriptSequence("agent-one").updatedSeq, 1);
    await reloaded.flush();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("transcript entry commits are durable, sequenced, and preserve seq on update or delete", async () => {
  const f = await fixture();
  try {
    const store = new Store(f.filePath);
    await store.load();
    store.mutate((state) => { state.agents.push(agent()); });

    const first = store.commitTranscriptEntries("agent-one", [{
      entryId: "entry-one", messageId: "message-one", entryKind: "message", body: "Hello"
    }, {
      entryId: "entry-two", messageId: "message-two", entryKind: "peer-message", body: "Peer update"
    }]);
    assert.equal(first.generation, 1);
    assert.equal(first.updatedSeq, 2);
    assert.deepEqual(first.entries.map((entry) => [entry.seq, entry.updatedSeq]), [[1, 1], [2, 2]]);

    const update = store.commitTranscriptEntries("agent-one", [{
      entryId: "entry-one", messageId: "message-one", entryKind: "delete", deleted: true
    }]);
    assert.equal(update.updatedSeq, 3);
    assert.equal(update.entries[0].seq, 1);
    assert.equal(update.entries[0].updatedSeq, 3);
    assert.equal(update.entries[0].deleted, true);
    assert.ok(update.entries[0].deletedAt);
    await store.flush();

    const reloaded = new Store(f.filePath);
    await reloaded.load();
    const state = reloaded.snapshot();
    assert.equal(state.transcriptEntries.length, 2);
    assert.equal(state.transcriptEntries.find((entry) => entry.entryId === "entry-one")?.seq, 1);
    assert.equal(state.transcriptMetadata[0].updatedSeq, 3);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("runtime-created agents immediately receive durable primitives", async () => {
  const f = await fixture();
  try {
    const store = new Store(f.filePath);
    await store.load();
    store.mutate((state) => { state.agents.push(agent("runtime-agent")); });
    const state = store.snapshot();
    assert.equal(state.transcriptMetadata.some((item) => item.agentId === "runtime-agent"), true);
    assert.equal(state.agentClientStates.some((item) => item.agentId === "runtime-agent"), true);
    await store.flush();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("transcript listing is bounded, reverse-pageable, and can include tombstones", async () => {
  const f = await fixture();
  try {
    const store = new Store(f.filePath);
    await store.load();
    store.mutate((state) => { state.agents.push(agent()); });
    store.commitTranscriptEntries("agent-one", Array.from({ length: 5 }, (_, index) => ({
      entryId: `entry-${index + 1}`, entryKind: "message" as const, body: `Body ${index + 1}`
    })));
    store.commitTranscriptEntries("agent-one", [{ entryId: "entry-3", entryKind: "delete", deleted: true }]);
    const latest = store.listTranscriptEntries("agent-one", { limit: 2 });
    assert.deepEqual(latest.entries.map((entry) => entry.entryId), ["entry-4", "entry-5"]);
    assert.equal(latest.nextBeforeSeq, 4);
    const previous = store.listTranscriptEntries("agent-one", { beforeSeq: latest.nextBeforeSeq, limit: 3, includeDeleted: true });
    assert.deepEqual(previous.entries.map((entry) => entry.entryId), ["entry-1", "entry-2", "entry-3"]);
    await store.flush();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("transcript commits reject stale optimistic updates without advancing the cursor", async () => {
  const f = await fixture();
  try {
    const store = new Store(f.filePath);
    await store.load();
    store.mutate((state) => { state.agents.push(agent()); });
    const first = store.commitTranscriptEntries("agent-one", [{
      entryId: "guarded", entryKind: "message", body: "First", expectedUpdatedSeq: 0
    }]);
    const rejected = store.commitTranscriptEntries("agent-one", [{
      entryId: "guarded", entryKind: "message", body: "Stale", expectedUpdatedSeq: 0
    }]);
    assert.equal(first.committedCount, 1);
    assert.equal(rejected.committedCount, 0);
    assert.equal(rejected.updatedSeq, first.updatedSeq);
    assert.deepEqual(rejected.rejections, [{ entryId: "guarded", currentUpdatedSeq: first.updatedSeq, reason: "updated-seq-conflict" }]);
    assert.equal(store.snapshot().transcriptEntries.find((entry) => entry.entryId === "guarded")?.body, "First");
    await store.flush();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
