import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CrewOrchestrator } from "./crew.js";
import { describeCodexActivity } from "./codex.js";
import { isoNow, makeId, Store } from "./store.js";
import type { AgentProfile, Room } from "./types.js";
import type { RuntimeProvider } from "./runtime.js";

class FakeCodex extends EventEmitter {
  calls: Array<{ prompt: string; instructions?: string; activeAtStart: number }> = [];
  active = 0;
  maxActive = 0;
  responses: string[];
  delayMs = 5;
  interrupts: Array<{ threadId: string; turnId: string }> = [];
  private pendingTurns = new Map<string, () => void>();
  lastThreadId?: string;

  constructor(responses: string[] = []) { super(); this.responses = responses; }
  setDynamicToolHandler(handler: (request: any) => Promise<any>) { (this as any).dynamicToolHandler = handler; }
  async startThread(options: { instructions?: string; dynamicTools?: any[] }) {
    (this as any).lastInstructions = options.instructions;
    (this as any).lastDynamicTools = options.dynamicTools;
    this.lastThreadId = `thread-${Math.random()}`;
    return this.lastThreadId;
  }
  async resumeThread() { return undefined; }
  async runTurn({ prompt, onStarted, onDelta }: { prompt: string; onStarted?: (turnId: string) => void; onDelta?: (delta: string) => void }) {
    const activeAtStart = this.active;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.calls.push({ prompt, instructions: (this as any).lastInstructions, activeAtStart });
    const index = this.calls.length - 1;
    const turnId = `turn-${index}`;
    onStarted?.(turnId);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pendingTurns.delete(turnId);
        resolve();
      };
      const timer = setTimeout(finish, this.delayMs);
      this.pendingTurns.set(turnId, finish);
    });
    this.active -= 1;
    const text = this.responses[index] ?? "[[PASS]]";
    const split = Math.max(1, Math.floor(text.length / 2));
    onDelta?.(text.slice(0, split));
    onDelta?.(text.slice(split));
    return { text, turnId };
  }
  async interruptTurn(threadId: string, turnId: string) {
    this.interrupts.push({ threadId, turnId });
    this.pendingTurns.get(turnId)?.();
    return { delivered: true };
  }
  respondToApproval() { return undefined; }
}

function makeAgent(name: string, title = ""): AgentProfile {
  const timestamp = isoNow();
  const id = makeId();
  return { id, name, title, description: `${name}'s user supplied description`, instructions: `${name}'s user supplied instructions`, avatar: name[0], color: "#7C5CFC", model: "gpt-5.6-luna", effort: "medium", networkAccess: true, privateWorkspacePath: `agent-workspaces/${id}`, status: "idle", roomThreadIds: {}, roomLastSeenMessageIds: {}, createdAt: timestamp, updatedAt: timestamp };
}

async function fixture(responses: string[] = [], runtime?: RuntimeProvider) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-bots-test-"));
  const store = new Store(path.join(directory, "state.json"));
  await store.load();
  const agents = [makeAgent("One", "Manager"), makeAgent("Two", "Builder"), makeAgent("Three", "")];
  const timestamp = isoNow();
  const group: Room = { id: makeId(), name: "User Channel", description: "Discuss first. Work only after the group has a clear direction.", agentIds: agents.map((agent) => agent.id), kind: "group", createdAt: timestamp, updatedAt: timestamp };
  const direct: Room = { id: makeId(), name: agents[0].name, description: agents[0].description, agentIds: [agents[0].id], kind: "direct", directAgentId: agents[0].id, createdAt: timestamp, updatedAt: timestamp };
  store.mutate((state) => { state.agents = agents; state.rooms = [group, direct]; });
  await store.flush();
  const codex = new FakeCodex(responses);
  const crew = new CrewOrchestrator(store, codex as any, () => undefined, runtime);
  return { directory, store, agents, group, direct, codex, crew };
}

test("a configured shared computer is exposed as explicit runtime tools", async () => {
  const calls: any[] = [];
  const runtime: RuntimeProvider = {
    kind: "test",
    executionEnvironment() { return { environmentId: "test", execServerUrl: "ws://127.0.0.1:4096", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] }; },
    async status() { return { provider: "test", phase: "running", containerName: "computer" }; },
    async start() { return { provider: "test", phase: "running", containerName: "computer" }; },
    async exec(request) { calls.push(request); return { code: 0, stdout: "/workspace\n", stderr: "" }; },
    async doctor() { return { code: 0, stdout: "healthy\n", stderr: "" }; }
  };
  const f = await fixture(["Done."], runtime);
  try {
    await f.crew.postUserMessage(f.direct.id, "Check the shared computer.");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    assert.match(f.codex.calls[0].instructions || "", /persistent shared computer/);
    const namespace = (f.codex as any).lastDynamicTools[0];
    assert.ok(namespace.tools.some((tool: any) => tool.name === "computer_exec"));
    const result = await (f.codex as any).dynamicToolHandler({
      threadId: f.codex.lastThreadId, callId: "call", namespace: "oai_bot", tool: "computer_exec",
      arguments: { argv: ["pwd"], cwd: "/workspace" }
    });
    assert.deepEqual(result, { exitCode: 0, stdout: "/workspace\n", stderr: "" });
    assert.deepEqual(calls, [{ argv: ["pwd"], cwd: "/workspace" }]);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

async function waitFor(check: () => boolean) {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  throw new Error("Timed out waiting for room turns");
}

test("an unaddressed Channel message starts with one ordinary roster member", async () => {
  const f = await fixture(["My distinct view."]);
  try {
    await f.crew.postUserMessage(f.group.id, "What do you all think?");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    assert.equal(f.codex.maxActive, 1);
    assert.equal(f.store.snapshot().messages.filter((message) => message.senderType === "agent").length, 1);
    assert.equal(f.store.snapshot().messages.find((message) => message.senderType === "agent")?.senderId, f.agents[0].id);
    assert.match(f.codex.calls[0].instructions || "", /No Bot type or role has built-in authority/);
    assert.match(f.codex.calls[0].instructions || "", /Visible @Bot handoffs are the default/);
    assert.match(f.codex.calls[0].instructions || "", /never as the routine way to wake another member/);
    assert.match(f.codex.calls[0].instructions || "", /Discuss first/);
    assert.match(f.codex.calls[0].prompt, /This message was routed to One\. Respond as One/);
    assert.match(f.codex.calls[0].prompt, /Do not answer as a generic assistant or produce a synthetic team response/);
    const transcriptBodies = (agentId: string) => f.store.snapshot().transcriptEntries.filter((entry) => entry.agentId === agentId).map((entry) => entry.body);
    assert.ok(transcriptBodies(f.agents[0].id).includes("My distinct view."));
    assert.equal(transcriptBodies(f.agents[1].id).includes("My distinct view."), true);
    assert.equal(transcriptBodies(f.agents[2].id).includes("My distinct view."), true);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a user mention addresses that Bot without invoking role based routing", async () => {
  const f = await fixture(["I was directly addressed."]);
  try {
    await f.crew.postUserMessage(f.group.id, "@Two what do you think?");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    const reply = f.store.snapshot().messages.filter((message) => message.senderType === "agent").at(-1)!;
    assert.equal(reply.senderId, f.agents[1].id);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a normal unaddressed group greeting gets one natural reply", async () => {
  const f = await fixture(["Hey."]);
  try {
    await f.crew.postUserMessage(f.group.id, "hello room");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    assert.equal(f.store.snapshot().messages.filter((message) => message.senderType === "agent").length, 1);
    assert.deepEqual(f.store.snapshot().memberTurns.map((turn) => turn.state), ["completed"]);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("the silent Channel harness can continue and deliberately wind down without visible mentions", async () => {
  const f = await fixture(["First distinct view.","Second distinct view."]);
  const originalRun=f.codex.runTurn.bind(f.codex);
  let routingStep=0;
  (f.codex as any).supportsSilentGroupRouting=true;
  (f.codex as any).runTurn=async(options:any)=>{
    if(options.prompt.startsWith("Channel:")) {
      const decisions=[
        {memberAgentId:f.agents[0].id},
        {action:"stop"},
        {action:"stop"}
      ];
      return {text:JSON.stringify(decisions[routingStep++]||{action:"stop"}),turnId:`router-${routingStep}`};
    }
    return originalRun(options);
  };
  try {
    await f.crew.postUserMessage(f.group.id,"What do you all think?");
    await waitFor(()=>f.store.snapshot().messages.filter(message=>message.roomId===f.group.id&&message.senderType==="agent").length===2&&f.codex.active===0);
    const messages=f.store.snapshot().messages.filter(message=>message.roomId===f.group.id&&message.senderType==="agent");
    assert.deepEqual(messages.map(message=>message.content),["First distinct view.","Second distinct view."]);
    assert.deepEqual(messages.map(message=>message.senderId),[f.agents[0].id,f.agents[1].id]);
    const turns=f.store.snapshot().memberTurns.filter(turn=>turn.roomId===f.group.id);
    assert.equal(turns[1].isWindingDown,true);
    assert.equal(turns[1].requestedBy,"system");
  } finally { await f.store.flush(); await rm(f.directory,{recursive:true,force:true}); }
});

test("a collective decision request gets a synthesis turn before stopping", async () => {
  const f = await fixture(["JSON is simplest.", "SQLite is safer.", "Recommendation: use JSON atomically for this prototype."]);
  const originalRun=f.codex.runTurn.bind(f.codex);
  let routingStep=0;
  (f.codex as any).supportsSilentGroupRouting=true;
  (f.codex as any).runTurn=async(options:any)=>{
    if(options.prompt.startsWith("Channel:")) {
      const decisions=[
        {memberAgentId:f.agents[0].id},
        {action:"stop"},
        {action:"stop"},
        {action:"stop"}
      ];
      return {text:JSON.stringify(decisions[routingStep++]||{action:"stop"}),turnId:`router-${routingStep}`};
    }
    return originalRun(options);
  };
  try {
    await f.crew.postUserMessage(f.group.id,"Discuss this as a group and reach a recommendation.");
    await waitFor(()=>f.store.snapshot().messages.filter(message=>message.roomId===f.group.id&&message.senderType==="agent").length===3&&f.codex.active===0);
    const messages=f.store.snapshot().messages.filter(message=>message.roomId===f.group.id&&message.senderType==="agent");
    assert.deepEqual(messages.map(message=>message.senderId),[f.agents[0].id,f.agents[1].id,f.agents[0].id]);
    assert.match(messages[2].content,/Recommendation:/);
  } finally { await f.store.flush(); await rm(f.directory,{recursive:true,force:true}); }
});

test("a natural each-of-you request requires a visible contribution from every Bot", async () => {
  const f = await fixture(["One concern.", "A different concern.", "A third concern."]);
  const originalRun=f.codex.runTurn.bind(f.codex);
  let routingStep=0;
  (f.codex as any).supportsSilentGroupRouting=true;
  (f.codex as any).runTurn=async(options:any)=>{
    if(options.prompt.startsWith("Channel:")) {
      const decisions=[{memberAgentId:f.agents[0].id},{action:"stop"},{action:"stop"},{action:"stop"}];
      return {text:JSON.stringify(decisions[routingStep++]||{action:"stop"}),turnId:`router-${routingStep}`};
    }
    return originalRun(options);
  };
  try {
    await f.crew.postUserMessage(f.group.id,"Each of you should give one distinct concern.");
    await waitFor(()=>f.store.snapshot().messages.filter(message=>message.roomId===f.group.id&&message.senderType==="agent").length===3&&f.codex.active===0);
    const messages=f.store.snapshot().messages.filter(message=>message.roomId===f.group.id&&message.senderType==="agent");
    assert.deepEqual(messages.map(message=>message.senderId),f.agents.map(agent=>agent.id));
    assert.match(f.codex.calls.at(-1)?.prompt||"",/do not paraphrase or mirror another Bot's answer/i);
    assert.match(f.codex.calls.at(-1)?.prompt||"",/each Bot, every Bot, or all Bots/i);
  } finally { await f.store.flush(); await rm(f.directory,{recursive:true,force:true}); }
});

test("an exact Bot mention in a visible Channel response creates a public handoff", async () => {
  const f = await fixture(["@Two please inspect this next.", "I inspected it independently."]);
  try {
    await f.crew.postUserMessage(f.group.id, "Discuss this together");
    await waitFor(() => f.codex.calls.length === 2 && f.codex.active === 0);
    const messages = f.store.snapshot().messages.filter((item) => item.senderType === "agent");
    assert.equal(messages[0].mentions.includes(f.agents[1].id), true);
    assert.deepEqual(messages[0].toAgentIds, [f.agents[1].id]);
    assert.equal(messages[1].senderId, f.agents[1].id);
    assert.equal(messages[1].content, "I inspected it independently.");
    assert.match(f.codex.calls[1].prompt,/Current workflow request \(authoritative scope\):\nDiscuss this together/);
    assert.match(f.codex.calls[1].prompt,/Do not import requirements, decisions, or acceptance criteria from an earlier request/);
    assert.deepEqual(f.store.snapshot().agentClientStates.map(client=>client.unreadCount),[0,0,0]);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a Bot already queued in the same workflow is not queued again by a later handoff", async () => {
  const f = await fixture(["@Two build this, then @Three verify it.", "Built. @Three please verify now.", "Verified once."]);
  try {
    await f.crew.postUserMessage(f.group.id, "@One coordinate this work");
    await waitFor(() => f.codex.calls.length === 3 && f.codex.active === 0);
    const turns=f.store.snapshot().memberTurns.filter(turn=>turn.roomId===f.group.id);
    assert.deepEqual(turns.map(turn=>turn.memberAgentId),[f.agents[0].id,f.agents[1].id,f.agents[2].id]);
    assert.equal(turns.filter(turn=>turn.memberAgentId===f.agents[2].id).length,1);
  } finally { await f.store.flush(); await rm(f.directory,{recursive:true,force:true}); }
});

test("explicit peer turn requests use transport metadata and can enter wind down", async () => {
  const f = await fixture(["Two should weigh in. [[REQUEST_TURN:@Two]]", "Here is my response."]);
  try {
    await f.crew.postUserMessage(f.group.id, "@One start the discussion");
    await waitFor(() => f.codex.calls.length === 2 && f.codex.active === 0);
    const first = f.store.snapshot().messages.find((item) => item.senderType === "agent")!;
    assert.deepEqual(first.toAgentIds, [f.agents[1].id]);
    assert.equal(first.kind, "peer-message");
    assert.match(f.codex.calls[1].prompt, /Phase: winding-down/);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("waiting marker leaves the Bot and Channel awaiting the user", async () => {
  const f = await fixture(["Which option do you prefer? [[WAIT_FOR_USER]]"]);
  try {
    await f.crew.postUserMessage(f.direct.id, "Help me choose");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0 && f.store.snapshot().rooms.find((room) => room.id === f.direct.id)?.runState?.phase === "waiting");
    assert.equal(f.store.snapshot().agents[0].awaitingUserResponse, true);
    assert.equal(f.store.snapshot().agents[0].status, "waiting");
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("reasoning events do not replace a live Bot management tool activity", async () => {
  const f = await fixture();
  try {
    const threadId = "activity-thread";
    (f.crew as any).threadContext.set(threadId, { agentId: f.agents[0].id, roomId: f.direct.id });
    f.codex.emit("dynamicTool", "started", { threadId, callId: "control-1", tool: "update_bots" });
    f.codex.emit("notification", "item/started", { threadId, item: { id: "reasoning-1", type: "reasoning" } });
    f.codex.emit("notification", "item/completed", { threadId, item: { id: "reasoning-1", type: "reasoning" } });
    let agent = f.store.snapshot().agents[0];
    assert.equal(agent.activity?.tool, "oai_bot.update_bots");
    assert.equal(agent.activity?.detail, "Updating Bot profiles");
    f.codex.emit("dynamicTool", "completed", { threadId, callId: "control-1", tool: "update_bots" });
    agent = f.store.snapshot().agents[0];
    assert.equal(agent.activity?.tool, "oai_bot.update_bots");
    await new Promise((resolve) => setTimeout(resolve, 820));
    agent = f.store.snapshot().agents[0];
    assert.equal(agent.activity, undefined);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("semantic activity labels stay stable across Codex item variants", () => {
  const cases: Array<[Record<string, any>, string, string]> = [
    [{ type: "webSearch" }, "web.search", "Searching the web"],
    [{ type: "mcpToolCall", tool: "web_fetch" }, "web.read", "Reading from the web"],
    [{ type: "fileRead" }, "file.read", "Reading files"],
    [{ type: "commandExecution" }, "shell.command", "Running a command"],
    [{ type: "fileChange" }, "file.edit", "Editing files"],
    [{ type: "imageGeneration" }, "image.generate", "Creating an image"],
    [{ type: "subagentWait" }, "subagent.wait", "Waiting for another Bot"],
    [{ type: "computerUse" }, "computer.use", "Using the computer"],
    [{ type: "requestUserInput" }, "form.wait", "Waiting for input"],
    [{ type: "mcpToolCall", tool: "SendToAgent", arguments: { target: "Two" } }, "agent.send", "Messaging Two"],
    [{ type: "mcpToolCall", tool: "UpdateAgent", arguments: JSON.stringify({ target: "Three" }) }, "agent.update", "Updating Three"]
  ];
  for (const [item, tool, detail] of cases) {
    const activity = describeCodexActivity(item);
    assert.equal(activity?.tool, tool);
    assert.equal(activity?.detail, detail);
    if (detail.endsWith("Two")) assert.equal(activity?.target, "Two");
    if (detail.endsWith("Three")) assert.equal(activity?.target, "Three");
  }
  assert.equal(describeCodexActivity({ type: "reasoning" }), undefined);
});

test("tool completion and failure settle only the correlated activity without flicker", async () => {
  const f = await fixture();
  try {
    const threadId = "settlement-thread";
    (f.crew as any).threadContext.set(threadId, { agentId: f.agents[0].id, roomId: f.direct.id });
    f.codex.emit("notification", "item/started", { threadId, item: { id: "command-1", type: "commandExecution" } });
    f.codex.emit("notification", "item/started", { threadId, item: { id: "edit-2", type: "fileChange" } });
    f.codex.emit("notification", "item/completed", { threadId, item: { id: "command-1", type: "commandExecution" } });
    assert.equal(f.store.snapshot().agents[0].activity?.tool, "file.edit");
    f.codex.emit("notification", "item/failed", { threadId, item: { id: "edit-2", type: "fileChange" } });
    assert.equal(f.store.snapshot().agents[0].activity?.detail, "Editing files");
    await new Promise((resolve) => setTimeout(resolve, 820));
    assert.equal(f.store.snapshot().agents[0].activity, undefined);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("client nonces suppress duplicate delivery", async () => {
  const f = await fixture(["Done."]);
  try {
    const accepted = await f.crew.postUserMessage(f.direct.id, "Build it", undefined, "same-send");
    const duplicate = await f.crew.postUserMessage(f.direct.id, "Build it", undefined, "same-send");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    assert.equal(f.store.snapshot().messages.filter((message) => message.roomId === f.direct.id && message.senderType === "user").length, 1);
    assert.equal(accepted.delivery, "accepted");
    assert.equal(duplicate.delivery, "duplicate");
    assert.equal(duplicate.messageId, accepted.messageId);
    const state = f.store.snapshot();
    assert.equal(state.deliveryReceipts.filter((receipt) => receipt.kind === "user-message").length, 1);
    assert.equal(state.memberTurns.filter((turn) => turn.triggerMessageId === accepted.messageId).length, 1);
    assert.equal(state.deliveryReceipts.find((receipt) => receipt.kind === "user-message")?.status, "accepted");
    assert.ok(state.transcriptMetadata.find((metadata) => metadata.agentId === f.agents[0].id)!.updatedSeq >= 2);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("user sends durably preserve the normalized client envelope", async () => {
  const f = await fixture(["Done."]);
  try {
    await f.crew.postUserMessage(f.direct.id, "Build it", undefined, "enveloped-send", [{
      id: "attachment-one", name: "plan.md", path: ".attachments/plan.md", size: 12, mimeType: "text/markdown"
    }], {
      richText: { type: "doc", text: "Build it" }, isFork: true,
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      sentAtMs: 1_788_000_000_000, enterEpochMs: 1_788_000_000_010, composedAtMs: 1_788_000_000_020,
      source: "mobile", attachmentPaths: [".attachments/plan.md"], attachmentNames: ["plan.md"]
    });
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    const message = f.store.snapshot().messages.find((item) => item.clientNonce === "enveloped-send")!;
    assert.deepEqual(message.richText, { type: "doc", text: "Build it" });
    assert.equal(message.isFork, true);
    assert.equal(message.source, "mobile");
    assert.deepEqual(message.attachmentPaths, [".attachments/plan.md"]);
    assert.deepEqual(message.attachmentNames, ["plan.md"]);
    assert.equal(message.composedAtMs, 1_788_000_000_020);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a newer user message interrupts the active turn and suppresses stale output", async () => {
  const f = await fixture(["Stale greeting from the old cycle.", "Answering the newest question."]);
  f.codex.delayMs = 100;
  try {
    await f.crew.postUserMessage(f.group.id, "hey guys", undefined, "first");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 1);
    await f.crew.postUserMessage(f.group.id, "what are you all doing?", undefined, "second");
    await waitFor(() => f.codex.calls.length === 2 && f.codex.active === 0);
    const messages = f.store.snapshot().messages.filter((message) => message.roomId === f.group.id);
    assert.equal(f.codex.interrupts.length, 1);
    assert.equal(messages.some((message) => message.content.includes("Stale greeting")), false);
    assert.equal(messages.some((message) => message.content.includes("newest question")), true);
    assert.deepEqual(messages.filter((message) => message.senderType === "user").map((message) => message.clientNonce), ["first", "second"]);
    assert.ok(f.store.snapshot().memberTurns.some((turn) => turn.state === "cancelled" && turn.cancellationReason?.includes("Superseded")));
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("accepted messages recover after a service restart", async () => {
  const f = await fixture(["Recovered after restart."]);
  try {
    const timestamp = isoNow();
    f.store.mutate((state) => state.messages.push({
      id: makeId(), roomId: f.direct.id, senderType: "user", senderId: "user", content: "Please continue",
      kind: "message", status: "complete", dispatchStatus: "processing", mentions: [], reactions: {}, createdAt: timestamp, updatedAt: timestamp
    }));
    f.crew.recoverPendingMessages();
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    const messages = f.store.snapshot().messages.filter((message) => message.roomId === f.direct.id);
    assert.equal(messages[0].dispatchStatus, "completed");
    assert.equal(messages.at(-1)?.content, "Recovered after restart.");
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a durable running member turn is requeued and completed after restart recovery", async () => {
  const f = await fixture(["Recovered durable work."]);
  try {
    const timestamp = isoNow();
    const sourceId = makeId();
    f.store.mutate((state) => {
      state.messages.push({ id: sourceId, roomId: f.direct.id, senderType: "user", senderId: "user", content: "Resume me", kind: "message", status: "complete", dispatchStatus: "processing", mentions: [], reactions: {}, createdAt: timestamp, updatedAt: timestamp });
      state.memberTurns.push({ id: makeId(), nonce: `recover-running:${sourceId}`, roomId: f.direct.id, memberAgentId: f.agents[0].id, requestedBy: "user", triggerMessageId: sourceId, peerAgentIds: [], newMessageIds: [sourceId], isWindingDown: false, state: "running", workflowId: makeId(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), startedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
    });
    f.crew.recoverPendingMessages();
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0 && f.store.snapshot().memberTurns[0]?.state === "completed");
    assert.equal(f.store.snapshot().messages.find((message) => message.id === sourceId)?.dispatchStatus, "completed");
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a fresh Store and orchestrator reclaim durable work after a real reload", async () => {
  const f = await fixture();
  try {
    const timestamp = isoNow();
    const sourceId = makeId();
    const workflowId = makeId();
    f.store.mutate((state) => {
      state.messages.push({ id: sourceId, roomId: f.direct.id, senderType: "user", senderId: "user", content: "Recover from disk", kind: "message", status: "complete", dispatchStatus: "processing", mentions: [], reactions: {}, createdAt: timestamp, updatedAt: timestamp });
      state.memberTurns.push({ id: workflowId, nonce: `disk-recovery:${sourceId}`, roomId: f.direct.id, memberAgentId: f.agents[0].id, requestedBy: "user", triggerMessageId: sourceId, peerAgentIds: [], newMessageIds: [sourceId], isWindingDown: false, state: "running", workflowId: makeId(), leaseId: "dead-process-lease", deadlineAt: new Date(Date.now() + 60_000).toISOString(), startedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
    });
    await f.store.flush();

    const restartedStore = new Store(path.join(f.directory, "state.json"));
    await restartedStore.load();
    assert.equal(restartedStore.snapshot().memberTurns.find((turn) => turn.id === workflowId)?.recoveryRequired, true);
    const restartedCodex = new FakeCodex(["Recovered through a fresh process state."]);
    const restartedCrew = new CrewOrchestrator(restartedStore, restartedCodex as any, () => undefined);
    restartedCrew.recoverPendingMessages();
    await waitFor(() => restartedCodex.calls.length === 1 && restartedCodex.active === 0 && restartedStore.snapshot().memberTurns.find((turn) => turn.id === workflowId)?.state === "completed");
    assert.equal(restartedStore.snapshot().messages.find((message) => message.id === sourceId)?.dispatchStatus, "completed");
    assert.equal(restartedStore.snapshot().messages.at(-1)?.content, "Recovered through a fresh process state.");
    await restartedStore.flush();
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("message_bot persists a peer receipt and durable targeted handoff", async () => {
  const f = await fixture(["[[PASS]]", "Target handled it."]);
  try {
    await f.crew.postUserMessage(f.group.id, "@One inspect this");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    f.codex.delayMs = 40;
    const threadId = f.store.snapshot().agents[0].roomThreadIds[f.group.id];
    const result = await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "peer-tool-turn", callId: "peer-call-1", namespace: "oai_bot", tool: "message_bot",
      arguments: { target: "Two", text: "Please take this next." }
    });
    await waitFor(() => f.codex.active === 1);
    assert.equal(f.store.snapshot().rooms.find((room) => room.id === f.group.id)?.runState?.activeAgentId, f.agents[1].id);
    await waitFor(() => f.codex.calls.length === 2 && f.codex.active === 0);
    const state = f.store.snapshot();
    const peer = state.messages.find((message) => message.clientNonce === "peer-call-1")!;
    const handoff = state.memberTurns.find((turn) => turn.workflowId === result.workflowId || turn.id === result.workflowId)!;
    assert.deepEqual(peer.toAgentIds, [f.agents[1].id]);
    assert.equal(peer.roomId, state.rooms.find((room) => room.directAgentId === f.agents[1].id)?.id);
    assert.notEqual(peer.roomId, f.group.id);
    assert.equal(handoff.memberAgentId, f.agents[1].id);
    assert.equal(handoff.state, "completed");
    assert.equal(state.deliveryReceipts.find((receipt) => receipt.kind === "agent-message" && receipt.messageId === peer.id)?.delivery, "delivered-local");
    assert.deepEqual(handoff.peerAgentIds, [f.agents[0].id]);
    assert.equal(handoff.originRoomId, f.group.id);
    assert.match(f.codex.calls[1].prompt, /Visible origin group: User Channel/);
    assert.match(f.codex.calls[1].prompt, /normal final response is returned there automatically/);
    assert.equal(handoff.newMessages?.[0]?.text, "Please take this next.");
    assert.equal(handoff.newMessages?.[0]?.speakerName, "One");
    assert.equal(state.transcriptEntries.some((entry) => entry.agentId === f.agents[1].id && entry.messageId === peer.id), true);
    assert.equal(state.transcriptEntries.some((entry) => entry.agentId === f.agents[2].id && entry.messageId === peer.id), false);
    const returned = state.messages.find((message) => message.senderId === f.agents[1].id && message.content === "Target handled it.")!;
    assert.equal(returned.roomId, f.group.id);
    assert.equal(state.transcriptEntries.some((entry) => entry.agentId === f.agents[0].id && entry.messageId === returned.id), true);
    assert.equal(state.transcriptEntries.some((entry) => entry.agentId === f.agents[2].id && entry.messageId === returned.id), true);
    assert.equal(state.agentClientStates.find((client) => client.agentId === f.agents[1].id)?.unreadCount, 1);
    assert.equal(state.agentClientStates.find((client) => client.agentId === f.agents[1].id)?.lastMessageId, state.messages.at(-1)?.id);
    assert.equal(state.rooms.find((room) => room.id === f.group.id)?.runState, undefined);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a direct private peer handoff makes the peer message the recipient's immediate task", async () => {
  const f = await fixture(["[[PASS]]", "PRIVATE_PEER_OK"]);
  try {
    await f.crew.postUserMessage(f.direct.id, "Privately ask Two to verify this.");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    f.store.mutate((state) => {
      const recipient = state.agents.find((agent) => agent.id === f.agents[1].id)!;
      recipient.awaitingUserResponse = true;
      recipient.status = "waiting";
    });
    const threadId = f.store.snapshot().agents[0].roomThreadIds[f.direct.id];
    await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "direct-peer-turn", callId: "direct-peer-call", namespace: "oai_bot", tool: "message_bot",
      arguments: { target: "Two", text: "Return PRIVATE_PEER_OK" }
    });
    await waitFor(() => f.codex.calls.length === 2 && f.codex.active === 0);
    assert.match(f.codex.calls[1].prompt, /Current workflow request \(authoritative scope\):\nReturn PRIVATE_PEER_OK/);
    assert.doesNotMatch(f.codex.calls[1].prompt, /Current workflow request \(authoritative scope\):\nPrivately ask Two/);
    assert.equal(f.store.snapshot().messages.at(-1)?.content, "PRIVATE_PEER_OK");
    assert.equal(f.store.snapshot().agents.find((agent) => agent.id === f.agents[1].id)?.awaitingUserResponse, false);
    assert.equal(f.store.snapshot().agents.find((agent) => agent.id === f.agents[1].id)?.status, "idle");
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("post_to_group creates a visible group update without waking the roster", async () => {
  const f = await fixture(["[[PASS]]"]);
  try {
    await f.crew.postUserMessage(f.direct.id, "Start here");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    const threadId = f.store.snapshot().agents[0].roomThreadIds[f.direct.id];
    const result = await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "group-post-turn", callId: "group-post-1", namespace: "oai_bot", tool: "post_to_group",
      arguments: { group: f.group.name, text: "Picked up the implementation. I will post the verified result here." }
    });
    const state = f.store.snapshot();
    const post = state.messages.find((message) => message.id === result.messageId)!;
    assert.equal(post.roomId, f.group.id);
    assert.equal(post.senderId, f.agents[0].id);
    assert.equal(post.content, "Picked up the implementation. I will post the verified result here.");
    assert.equal(state.memberTurns.length, 1);
    assert.equal(f.codex.calls.length, 1);
    assert.equal(state.deliveryReceipts.find((receipt) => receipt.messageId === post.id)?.delivery, "delivered-local");
    for (const agent of f.agents) assert.equal(state.transcriptEntries.some((entry) => entry.agentId === agent.id && entry.messageId === post.id), true);
    const duplicate = await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "group-post-turn", callId: "group-post-2", namespace: "oai_bot", tool: "post_to_group",
      arguments: { group: f.group.name, text: "Picked up the implementation. I will post the verified result here." }
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.messageId, post.id);
    assert.equal(f.store.snapshot().messages.filter((message) => message.roomId === f.group.id && message.content === post.content).length, 1);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("post_to_group wakes only exact public mentions", async () => {
  const f = await fixture(["[[PASS]]", "Public handoff received."]);
  try {
    await f.crew.postUserMessage(f.direct.id, "Start here");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    const threadId = f.store.snapshot().agents[0].roomThreadIds[f.direct.id];
    await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "public-handoff-turn", callId: "public-handoff-post", namespace: "oai_bot", tool: "post_to_group",
      arguments: { group: f.group.name, text: "@Two please review the visible update." }
    });
    await waitFor(() => f.codex.calls.length === 2 && f.codex.active === 0);
    const post = f.store.snapshot().messages.find((message) => message.clientNonce === "public-handoff-post")!;
    assert.deepEqual(post.mentions, [f.agents[1].id]);
    assert.equal(f.store.snapshot().memberTurns.at(-1)?.memberAgentId, f.agents[1].id);
    assert.equal(f.store.snapshot().messages.at(-1)?.content, "Public handoff received.");
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("global peer delivery deduplicates by sender and message id without shared room membership", async () => {
  const f = await fixture(["[[PASS]]"]);
  try {
    f.store.mutate((state) => { state.rooms.find((room) => room.id === f.group.id)!.agentIds = [f.agents[0].id, f.agents[2].id]; });
    const first = await f.crew.sendAgentMessage(f.agents[0].id, f.agents[1].id, "global-peer-id", "Private handoff", f.group.id);
    const duplicate = await f.crew.sendAgentMessage(f.agents[0].id, f.agents[1].id, "global-peer-id", "Private handoff", f.group.id);
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.message.id, duplicate.message.id);
    assert.equal(f.store.snapshot().messages.filter((message) => message.clientNonce === "global-peer-id").length, 1);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("member turns preserve immutable room peer and message snapshots", async () => {
  const f = await fixture(["[[PASS]]"]);
  try {
    const timestamp = isoNow();
    const messageId = makeId();
    f.store.mutate((state) => state.messages.push({
      id: messageId, roomId: f.group.id, senderType: "user", senderId: "user", content: "Original payload",
      kind: "message", status: "complete", mentions: [], reactions: {}, createdAt: timestamp, updatedAt: timestamp
    }));
    const turn = await f.crew.requestMemberTurn(f.group.id, f.agents[0].id, "snapshot-nonce", [messageId]);
    f.store.mutate((state) => {
      state.rooms.find((room) => room.id === f.group.id)!.name = "Changed later";
      state.agents.find((agent) => agent.id === f.agents[1].id)!.name = "Changed peer";
      state.messages.find((message) => message.id === messageId)!.content = "Changed payload";
    });
    const saved = f.store.snapshot().memberTurns.find((item) => item.id === turn.id)!;
    assert.equal(saved.roomSnapshot?.name, "User Channel");
    assert.equal(saved.peerSnapshots?.find((peer) => peer.id === f.agents[1].id)?.name, "Two");
    assert.equal(saved.newMessages?.[0]?.text, "Original payload");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("member turns can be cancelled by nonce and member id", async () => {
  const f = await fixture(["Should be interrupted."]);
  f.codex.delayMs = 100;
  try {
    const timestamp = isoNow();
    const messageId = makeId();
    f.store.mutate((state) => state.messages.push({
      id: messageId, roomId: f.direct.id, senderType: "user", senderId: "user", content: "Cancel this",
      kind: "message", status: "complete", mentions: [], reactions: {}, createdAt: timestamp, updatedAt: timestamp
    }));
    await f.crew.requestMemberTurn(f.direct.id, f.agents[0].id, "cancel-nonce", [messageId]);
    await waitFor(() => f.codex.active === 1);
    const cancelled = await f.crew.cancelMemberTurnByNonce("cancel-nonce", f.agents[0].id, "No longer needed");
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.cancellationReason, "No longer needed");
    assert.equal(f.codex.interrupts.length, 1);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("everyone explicitly offers every member a turn", async () => {
  const f = await fixture(["One", "Two", "Three"]);
  try {
    await f.crew.postUserMessage(f.group.id, "@everyone give your name");
    await waitFor(() => f.codex.calls.length === 3 && f.codex.active === 0);
    assert.deepEqual(f.store.snapshot().messages.filter((message) => message.senderType === "agent").map((message) => message.content), ["One", "Two", "Three"]);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("a Bot can atomically update persistent roster profiles through its control tool", async () => {
  const f = await fixture(["[[PASS]]"]);
  try {
    await f.crew.postUserMessage(f.direct.id, "Inspect the roster");
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    const threadId = f.store.snapshot().agents[0].roomThreadIds[f.direct.id];
    const result = await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "turn-tool", callId: "call-tool", namespace: "oai_bot", tool: "update_bots",
      arguments: { updates: [{ id: "One", name: "Nova", title: "Lead", color: "#123456", avatarShape: "custom", avatarShapeName: "Comet pup", avatarMorph: Array.from({length:24},(_,index)=>1+Math.sin(index/24*Math.PI*4)*.12) }, { id: "Two", name: "Sage" }] }
    });
    const state = f.store.snapshot();
    assert.deepEqual(result.updated.map((item: any) => item.name), ["Nova", "Sage"]);
    assert.equal(state.agents[0].title, "Lead");
    assert.equal(state.agents[0].color, "#123456");
    assert.equal(state.agents[0].avatarShape, "custom");
    assert.equal(state.agents[0].avatarShapeName, "Comet pup");
    assert.equal(state.agents[0].avatarMorph?.length, 24);
    assert.equal(result.updated[0].avatar.shape, "custom");
    assert.equal(result.updated[0].avatar.semanticVerified, false);
    assert.match(result.updated[0].avatar.capability, /display-only/);
    assert.equal(result.updated[0].avatar.morph.length, 24);
    assert.equal(state.rooms.find((room) => room.directAgentId === state.agents[0].id)?.name, "Nova");

    const catResult = await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "turn-cat", callId: "call-cat", namespace: "oai_bot", tool: "update_bots",
      arguments: { updates: [{ id: "Nova", avatarShape: "cat" }] }
    });
    assert.equal(catResult.updated[0].avatar.shape, "cat");
    assert.equal(catResult.updated[0].avatar.semanticVerified, true);
    assert.equal(f.store.snapshot().agents[0].avatarMorph, undefined);

    const vectorResult = await (f.codex as any).dynamicToolHandler({
      threadId, turnId: "turn-vector", callId: "call-vector", namespace: "oai_bot", tool: "update_bots",
      arguments: { updates: [{ id: "Nova", avatarVector: { version:1, name:"Rocket", layers:[
        {id:"body",kind:"path",role:"body",d:"M20 80Q50 10 80 80Z",fill:"primary",motion:"breathe"},
        {id:"window",kind:"circle",role:"feature",cx:50,cy:48,r:8,fill:"accent",motion:"float"}
      ] } }] }
    });
    assert.equal(vectorResult.updated[0].avatar.shape, "vector");
    assert.equal(vectorResult.updated[0].avatar.vector.layers.length, 2);
    assert.equal(vectorResult.updated[0].avatar.semanticVerified, false);
    assert.equal(vectorResult.updated[0].avatar.renderableVector, true);
    assert.match(vectorResult.updated[0].avatar.capability, /subjective resemblance is not automatically vision-verified/);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("avatar tool schema states the semantic boundary explicitly", async () => {
  const f = await fixture(["[[PASS]]"]);
  try {
    const namespace = (f.crew as any).controlTools()[0];
    const update = namespace.tools.find((tool:any) => tool.name === "update_bots");
    const properties = update.inputSchema.properties.updates.items.properties;
    assert.ok(properties.avatarShape.enum.includes("cat"));
    assert.ok(properties.avatarShape.enum.includes("vector"));
    assert.match(properties.avatarMorph.description, /abstract/);
    assert.match(properties.avatarShapeName.description, /display-only/i);
    assert.equal(properties.avatarVector.properties.version.enum[0], 1);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});

test("routines dispatch only their configured ordinary Bot", async () => {
  const f = await fixture(["Routine complete."]);
  try {
    f.crew.triggerRoutine({ id: "routine", roomId: f.group.id, agentId: f.agents[1].id, name: "Check build", instruction: "Run the tests", intervalMinutes: 60, isEnabled: true, createdAt: "", updatedAt: "" });
    await waitFor(() => f.codex.calls.length === 1 && f.codex.active === 0);
    assert.match(f.codex.calls[0].prompt, /Scheduled routine "Check build"/);
    assert.equal(f.store.snapshot().messages.filter((message) => message.senderType === "agent").at(-1)?.senderId, f.agents[1].id);
  } finally { await f.store.flush(); await rm(f.directory, { recursive: true, force: true }); }
});
