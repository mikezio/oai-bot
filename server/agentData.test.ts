import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { AgentDataFilesystem } from "./agentData.js";
import { Store } from "./store.js";
import type { AgentProfile, AppState, ChatMessage, Room, Routine } from "./types.js";

const timestamp = "2026-08-30T00:00:00.000Z";

function agent(): AgentProfile {
  return {
    id: "agent-one", name: "One", title: "Builder", description: "Build the thing.",
    instructions: "Use tests first.", memories: [{ id: "memory-one", text: "The user prefers concise updates.", createdAt: timestamp, updatedAt: timestamp }],
    avatar: "O", color: "#123456", avatarColor: "#123456", avatarShape: "blob",
    model: "gpt-5.6-terra", effort: "medium", networkAccess: true,
    privateWorkspacePath: "agent-workspaces/agent-one", status: "idle",
    roomThreadIds: {}, roomLastSeenMessageIds: {}, createdAt: timestamp, updatedAt: timestamp
  };
}

function state(): AppState {
  const direct: Room = { id: "direct-one", name: "One", description: "Build the thing.", agentIds: ["agent-one"], kind: "direct", directAgentId: "agent-one", createdAt: timestamp, updatedAt: timestamp };
  const group: Room = { id: "group-one", name: "Desk", description: "Shared work.", agentIds: ["agent-one"], kind: "group", createdAt: timestamp, updatedAt: timestamp };
  const message: ChatMessage = { id: "message-one", roomId: direct.id, senderType: "agent", senderId: "agent-one", content: "Done.", kind: "message", status: "complete", mentions: [], reactions: {}, createdAt: timestamp, updatedAt: timestamp };
  const routine: Routine = { id: "routine-one", roomId: group.id, agentId: "agent-one", name: "Check build", instruction: "Run tests and stay quiet when clean.", intervalMinutes: 60, isEnabled: true, createdAt: timestamp, updatedAt: timestamp };
  return {
    agents: [agent()], rooms: [direct, group], messages: [message], approvals: [], routines: [routine],
    transcriptMetadata: [{ agentId: "agent-one", generation: 1, updatedSeq: 1, createdAt: timestamp, updatedAt: timestamp }],
    transcriptEntries: [{ agentId: "agent-one", generation: 1, seq: 1, updatedSeq: 1, entryId: "entry-one", messageId: message.id, entryKind: "message", body: "Done.", createdAt: timestamp, updatedAt: timestamp }],
    memberTurns: [], deliveryReceipts: [], agentClientStates: [{ agentId: "agent-one", unreadCount: 0, hiddenFromSidebar: false, notificationsEnabled: true, notifyOnUpdatesEnabled: true, updatedAt: timestamp }]
  };
}

test("persists authoritative Bot data in the VM-home agent-data layout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oai-agent-data-test-"));
  try {
    const data = new AgentDataFilesystem(path.join(directory, "agent-data"));
    await data.initialize();
    const store = new Store(data.statePath(), (current) => data.sync(current));
    await store.load();
    store.mutate((current) => Object.assign(current, state()));
    await store.flush();
    const profile = JSON.parse(await readFile(path.join(data.root, "agents/agent-one/profile.json"), "utf8"));
    assert.deepEqual(Object.keys(profile).sort(), ["avatarColor", "avatarShape", "description", "name", "namedBy", "title"]);
    assert.equal(profile.description, "Build the thing.\n\nUse tests first.");
    const oaiProfile = JSON.parse(await readFile(path.join(data.root, "agents/agent-one/oai-profile.json"), "utf8"));
    assert.equal(oaiProfile.instructions, "Use tests first.");
    assert.equal(oaiProfile.model, "gpt-5.6-terra");
    assert.match(await readFile(path.join(data.root, "agents/agent-one/memory/profile.md"), "utf8"), /user prefers concise updates/);
    assert.match(await readFile(path.join(data.root, "agents/agent-one/memory/log/2026-08.md"), "utf8"), /\(2026-08-30\) The user prefers concise updates/);
    assert.deepEqual(JSON.parse(await readFile(path.join(data.root, "agents/group-one/group.json"), "utf8")), { version: 1, memberIds: ["agent-one"] });
    assert.equal(JSON.parse(await readFile(path.join(data.root, "agents/agent-one/automations/check-build/automation.json"), "utf8")).prompt, "Run tests and stay quiet when clean.");
    assert.deepEqual(JSON.parse(await readFile(path.join(data.root, "agents/agent-one/automations/check-build/runs.json"), "utf8")), []);
    assert.equal(JSON.parse(await readFile(path.join(data.root, "agents/agent-one/settings.json"), "utf8")).notifyOnAgentUpdates, true);
    assert.equal(JSON.parse(await readFile(path.join(data.root, "source-map.json"), "utf8"))["agent-one"].mode, "local");
    assert.equal(JSON.parse(await readFile(path.join(data.root, "transcript-publish/agent-one.json"), "utf8")).writerSeq, 1);
    const transcript = JSON.parse((await readFile(path.join(data.root, "agent-transcripts/agent-one/agent-one.jsonl"), "utf8")).trim());
    assert.equal(transcript.role, "assistant");
    assert.equal(transcript.message.content[0].text, "Done.");
    const database = new Database(path.join(data.root, "agents/agent-one/store.db"), { readonly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row: any) => row.name);
      assert.deepEqual(tables, ["automation_completion_inbox", "blobs", "kv", "transcript_entries"]);
      assert.equal((database.prepare("SELECT count(*) AS count FROM transcript_entries").get() as any).count, 1);
      assert.equal(JSON.parse((database.prepare("SELECT entry FROM transcript_entries LIMIT 1").get() as any).entry).kind, "send-message");
      assert.equal((database.prepare("SELECT value FROM kv WHERE key = 'origin'").get() as any).value, "user");
      assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    } finally { database.close(); }
    assert.deepEqual(JSON.parse(await readFile(data.statePath(), "utf8")).agents.map((item: AgentProfile) => item.id), ["agent-one"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies legacy aggregate state into agent-data on first migration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oai-agent-data-migrate-"));
  try {
    const legacy = path.join(directory, "data/state.json");
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify(state()), "utf8");
    const data = new AgentDataFilesystem(path.join(directory, "agent-data"));
    await data.initialize(legacy);
    assert.deepEqual(JSON.parse(await readFile(data.statePath(), "utf8")).agents.map((item: AgentProfile) => item.id), ["agent-one"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes hidden host routing cues into the primary agent transcript", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oai-agent-data-hidden-"));
  try {
    const current = state();
    current.memberTurns.push({
      id: "turn-one", nonce: "routine:routine-one:run-one", roomId: "group-one", memberAgentId: "agent-one",
      requestedBy: "routine", peerAgentIds: [], newMessageIds: [], newMessages: [{
        speakerKind: "system", speakerName: "OAI Bot host", isSelf: false,
        text: "Trusted scheduled routine (hidden host instruction; not a user message)."
      }], isFirstRun: true, isWindingDown: false, state: "passed", workflowId: "workflow-one",
      rootWorkflowId: "turn-one", createdAt: timestamp, updatedAt: timestamp, finishedAt: timestamp
    });
    current.memberTurns.push({
      id: "turn-two", nonce: "routine-completion:turn-one", roomId: "group-one", memberAgentId: "agent-one",
      requestedBy: "system", peerAgentIds: [], newMessageIds: [], newMessages: [{
        speakerKind: "system", speakerName: "OAI Bot host", isSelf: false,
        text: "Hidden routine completion (not a user message). Result: clean."
      }], isWindingDown: true, state: "passed", workflowId: "workflow-two",
      rootWorkflowId: "turn-one", parentWorkflowId: "turn-one", createdAt: timestamp, updatedAt: timestamp, finishedAt: timestamp
    });
    const data = new AgentDataFilesystem(path.join(directory, "agent-data"));
    await data.initialize();
    await data.sync(current);
    const rows = (await readFile(path.join(data.root, "agent-transcripts/agent-one/agent-one.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.role === "system" && row.oai.hidden === true && /scheduled routine/.test(row.message.content[0].text)));
    assert.ok(rows.some((row) => row.role === "system" && row.oai.hidden === true && /first-run cue/.test(row.message.content[0].text)));
    const runs = JSON.parse(await readFile(path.join(data.root, "agents/agent-one/automations/check-build/runs.json"), "utf8"));
    assert.equal(runs[0].status, "success");
    const database = new Database(path.join(data.root, "agents/agent-one/store.db"), { readonly: true });
    try {
      const events = database.prepare("SELECT entry FROM transcript_entries ORDER BY seq").all().map((row: any) => JSON.parse(row.entry));
      assert.ok(events.some((entry: any) => entry.kind === "event" && entry.oai.hidden === true && /scheduled routine/.test(entry.message.content)));
      const completion = database.prepare("SELECT * FROM automation_completion_inbox").get() as any;
      assert.equal(completion.attribution, "Automation: Check build");
      assert.equal(completion.acknowledged, 1);
    } finally { database.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
