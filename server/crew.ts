import type { AgentProfile, AppState, AttachmentRef, ChatMessage, DeliveryReceipt, MemberTurnMessageSnapshot, MemberTurnPeerSnapshot, MemberTurnRoomSnapshot, MemberTurnWorkflow, PendingApproval, Room, Routine } from "./types.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CodexClient, describeCodexActivity } from "./codex.js";
import { agentRoster, extractMentionedAgentIds } from "./mentions.js";
import { isoNow, makeId, Store } from "./store.js";
import { avatarShapeValues, normalizeAvatarVectorSpec, normalizedAvatarState } from "./avatar.js";

type TurnPhase = "active" | "winding-down";
type MemberTurnResult = { requestedAgentIds: string[]; awaitingUserResponse: boolean; passed: boolean; error?: string };
type ActiveCycle = { id: string; workflowId: string; sourceMessageId: string; cancelled: boolean; activeThreadId?: string; activeTurnId?: string };

export class CrewOrchestrator {
  private threadContext = new Map<string, { agentId: string; roomId: string }>();
  private roomQueues = new Map<string, Promise<void>>();
  private agentLeases = new Map<string, Promise<void>>();
  private activeCycles = new Map<string, ActiveCycle>();
  private activityClearTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly store: Store, private readonly codex: CodexClient, private readonly broadcast: () => void) {
    codex.on("approval", (request) => this.onApproval(request));
    codex.on("notification", (method, params) => this.onNotification(method, params));
    codex.on("dynamicTool", (phase, params) => this.onDynamicToolActivity(phase, params));
    codex.on("offline", () => {
      for (const timer of this.activityClearTimers.values()) clearTimeout(timer);
      this.activityClearTimers.clear();
      this.store.mutate((state) => {
        state.approvals = [];
        state.rooms.forEach((room) => delete room.runState);
        state.agents.forEach((agent) => {
          agent.status = "idle";
          agent.isComposingMessage = false;
          agent.isRetrying = false;
          delete agent.activity;
        });
      });
      this.broadcast();
    });
    codex.setDynamicToolHandler((request) => this.handleDynamicTool(request));
  }

  private controlTools() {
    const botProperties = {
      id: { type: "string", description: "Bot ID or current exact Bot name" },
      name: { type: "string" }, title: { type: "string", description: "Optional role label" },
      description: { type: "string" }, instructions: { type: "string", description: "Custom instructions" },
      color: { type: "string", description: "CSS color, preferably a hex color" },
      avatarShape: { type: "string", enum: [...avatarShapeValues], description: "Use cat or dog for a recognizable deterministic character. custom is only an abstract radial silhouette. vector requires avatarVector." },
      avatarShapeName: { type: "string", description: "Display-only label. It never makes a custom radial silhouette semantically recognizable." },
      avatarMorph: { type: "array", minItems: 24, maxItems: 24, items: { type: "number", minimum: .45, maximum: 1.55 }, description: "Exactly 24 radial controls for an abstract custom silhouette. Do not claim these values produce a recognizable animal or object." },
      avatarVector: { type: "object", description: "Safe versioned layered vector character. Applying it sets avatarShape to vector.", properties: {
        version: { type: "number", enum: [1] }, name: { type: "string", maxLength: 60 },
        layers: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", properties: {
          id: { type: "string", maxLength: 32 }, kind: { type: "string", enum: ["path", "ellipse", "circle"] }, role: { type: "string", enum: ["body", "feature", "face", "accessory"] },
          d: { type: "string", maxLength: 1200 }, cx: { type: "number" }, cy: { type: "number" }, rx: { type: "number" }, ry: { type: "number" }, r: { type: "number" },
          fill: { type: "string", enum: ["primary", "accent", "ink", "white", "none"] }, stroke: { type: "string", enum: ["primary", "accent", "ink", "white", "none"] },
          strokeWidth: { type: "number", minimum: 0, maximum: 8 }, opacity: { type: "number", minimum: 0, maximum: 1 }, motion: { type: "string", enum: ["none", "breathe", "float", "sway", "blink"] }
        }, required: ["id", "kind", "role", "fill"], additionalProperties: false } }
      }, required: ["version", "name", "layers"], additionalProperties: false },
      avatarColor: { type: "string", description: "Avatar primary color, preferably a hex color" },
      avatarAccent: { type: "string", description: "Avatar secondary or highlight color" },
      avatarFace: { type: "string", enum: ["dots", "visor", "spark", "none"] },
      avatarTexture: { type: "string", enum: ["solid", "gradient", "glass"] },
      avatarMotion: { type: "string", enum: ["calm", "lively", "off"] },
      avatarAccessory: { type: "string", enum: ["none", "antenna", "halo", "headphones", "crown"] },
      clearAvatarImage: { type: "boolean", description: "Remove a custom image and return to the procedural character" }
    };
    return [{
      type: "namespace", name: "oai_bot", description: "Manage the persistent OAI Bot roster and Channels. Use these tools when the user asks you to actually change Bots or Channels. Do not merely claim a change.", tools: [
        { type: "function", name: "list_bots", description: "List current Bots and groups with their persistent IDs and editable profiles.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        { type: "function", name: "remember", description: "Save one durable memory for your own Bot across direct chats and Channels. Use only for a stable user preference, standing instruction, responsibility, or lasting fact, not transient task chatter.", inputSchema: { type: "object", properties: { text: { type: "string", description: "Concise durable memory stated as a fact or instruction" } }, required: ["text"], additionalProperties: false } },
        { type: "function", name: "forget_memory", description: "Delete one of your own durable memories by its exact memory ID.", inputSchema: { type: "object", properties: { memoryId: { type: "string" } }, required: ["memoryId"], additionalProperties: false } },
        { type: "function", name: "update_bots", description: "Atomically update existing Bots. The result returns the exact normalized saved avatar config and whether its semantics are supported. Report only that result.", inputSchema: { type: "object", properties: { updates: { type: "array", minItems: 1, items: { type: "object", properties: botProperties, required: ["id"], additionalProperties: false } } }, required: ["updates"], additionalProperties: false } },
        { type: "function", name: "create_bot", description: "Create a persistent customizable Bot and its direct chat.", inputSchema: { type: "object", properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, instructions: { type: "string" }, color: { type: "string" }, avatarShape: botProperties.avatarShape, avatarVector: botProperties.avatarVector, avatarColor: botProperties.avatarColor, avatarAccent: botProperties.avatarAccent, avatarFace: botProperties.avatarFace, avatarTexture: botProperties.avatarTexture, avatarMotion: botProperties.avatarMotion, avatarAccessory: botProperties.avatarAccessory }, required: ["name"], additionalProperties: false } },
        { type: "function", name: "message_bot", description: "Send a first-class direct message to another Bot and request an independent turn from that Bot. Use it for assignments, questions, review requests, and handoffs.", inputSchema: { type: "object", properties: { target: { type: "string", description: "Target Bot ID or exact current name" }, text: { type: "string", description: "The direct peer message, question, feedback request, or handoff" } }, required: ["target", "text"], additionalProperties: false } },
        { type: "function", name: "post_to_group", description: "Post a visible update as yourself into a group you belong to. An exact @Bot mention is a public handoff and wakes that Bot; a post without an exact mention is shared context only. Use message_bot for a private handoff.", inputSchema: { type: "object", properties: { group: { type: "string", description: "Group ID or exact current group name" }, text: { type: "string", description: "Visible status, finding, question, decision, or public @Bot handoff" } }, required: ["group", "text"], additionalProperties: false } },
        { type: "function", name: "update_group", description: "Update a group name, description, or membership. Members may be Bot IDs or exact current Bot names.", inputSchema: { type: "object", properties: { id: { type: "string", description: "Group ID or exact group name" }, name: { type: "string" }, description: { type: "string" }, memberIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 } }, required: ["id"], additionalProperties: false } },
        { type: "function", name: "create_group", description: "Create a persistent group containing ordinary existing Bots.", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, memberIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 } }, required: ["name", "memberIds"], additionalProperties: false } }
      ]
    }];
  }

  private findAgent(idOrName: string, state = this.store.snapshot()) {
    const needle = String(idOrName || "").trim().toLowerCase();
    return state.agents.find((agent) => agent.id === idOrName || agent.name.toLowerCase() === needle);
  }

  private async handleDynamicTool(request: { threadId: string; callId: string; namespace: string | null; tool: string; arguments: any }) {
    if (request.namespace !== "oai_bot") throw new Error(`Unknown tool namespace: ${request.namespace || "none"}`);
    if (!this.threadContext.has(request.threadId)) throw new Error("The calling Bot is not attached to an OAI Bot chat");
    const args = request.arguments && typeof request.arguments === "object" ? request.arguments : {};
    if(request.tool==="remember") {
      const context=this.threadContext.get(request.threadId)!;
      const text=String(args.text||"").replace(/\s+/g," ").trim().slice(0,1_000);
      if(!text)throw new Error("Memory text is required");
      const timestamp=isoNow();
      let saved:any;
      this.store.mutate(state=>{
        const agent=state.agents.find(item=>item.id===context.agentId);
        if(!agent)throw new Error("Bot not found");
        agent.memories ||= [];
        const existing=agent.memories.find(memory=>memory.text.toLowerCase()===text.toLowerCase());
        if(existing){existing.updatedAt=timestamp;saved=existing;return;}
        saved={id:makeId(),text,createdAt:timestamp,updatedAt:timestamp};
        agent.memories.push(saved);
        if(agent.memories.length>100)agent.memories.splice(0,agent.memories.length-100);
        agent.updatedAt=timestamp;
      });
      this.broadcast();
      return {saved:true,memory:saved};
    }
    if(request.tool==="forget_memory") {
      const context=this.threadContext.get(request.threadId)!;
      const memoryId=String(args.memoryId||"");
      let removed=false;
      this.store.mutate(state=>{
        const agent=state.agents.find(item=>item.id===context.agentId);
        if(!agent)return;
        const before=agent.memories?.length||0;
        agent.memories=(agent.memories||[]).filter(memory=>memory.id!==memoryId);
        removed=agent.memories.length<before;
        if(removed)agent.updatedAt=isoNow();
      });
      if(!removed)throw new Error("Memory not found");
      this.broadcast();
      return {removed:true,memoryId};
    }
    if (request.tool === "message_bot") {
      const context = this.threadContext.get(request.threadId)!;
      const state = this.store.snapshot();
      const room = state.rooms.find((item) => item.id === context.roomId);
      const sender = state.agents.find((item) => item.id === context.agentId);
      const target = this.findAgent(String(args.target || ""), state);
      if (!room || !sender || !target || target.id === sender.id) throw new Error("Choose another Bot");
      const text = String(args.text || "").trim().slice(0, 8_000);
      if (!text) throw new Error("Peer message text is required");
      const result = await this.sendAgentMessage(sender.id, target.id, request.callId, text, room.id);
      return {
        delivered: true, duplicate: result.duplicate,
        from: { id: sender.id, name: sender.name }, to: { id: target.id, name: target.name },
        workflowId: result.turn?.workflowId || result.turn?.id
      };
    }
    if (request.tool === "post_to_group") {
      const context = this.threadContext.get(request.threadId)!;
      const state = this.store.snapshot();
      const sender = state.agents.find((item) => item.id === context.agentId);
      const needle = String(args.group || "").trim().toLowerCase();
      const group = state.rooms.find((item) => item.kind === "group" && (item.id === args.group || item.name.toLowerCase() === needle));
      if (!sender || !group) throw new Error("Group not found");
      if (!group.agentIds.includes(sender.id)) throw new Error(`${sender.name} is not a member of ${group.name}`);
      const text = String(args.text || "").trim().slice(0, 8_000);
      if (!text) throw new Error("Group post text is required");
      const result = await this.postAgentMessageToGroup(sender.id, group.id, request.callId, text);
      return {
        delivered: true, duplicate: result.duplicate,
        from: { id: sender.id, name: sender.name }, group: { id: group.id, name: group.name },
        messageId: result.message.id
      };
    }
    if (request.tool === "list_bots") {
      const state = this.store.snapshot();
      return {
        bots: state.agents.map(({ id, name, title, description, instructions, memories, avatar, color, avatarShape, avatarShapeName, avatarMorph, avatarVector, avatarColor, avatarAccent, avatarFace, avatarTexture, avatarMotion, avatarAccessory, avatarDataUrl }) => ({ id, name, title, description, instructions, memories:memories||[], avatar, color, avatarShape, avatarShapeName, avatarMorph, avatarVector, avatarColor, avatarAccent, avatarFace, avatarTexture, avatarMotion, avatarAccessory, hasCustomImage: Boolean(avatarDataUrl) })),
        groups: state.rooms.filter((room) => room.kind === "group").map(({ id, name, description, agentIds }) => ({ id, name, description, memberIds: agentIds }))
      };
    }
    if (request.tool === "update_bots") {
      const updates: any[] = Array.isArray(args.updates) ? args.updates : [];
      if (!updates.length) throw new Error("At least one Bot update is required");
      for (const update of updates) {
        if (typeof update.avatarShape === "string" && !(avatarShapeValues as readonly string[]).includes(update.avatarShape)) throw new Error(`Unsupported avatar shape: ${update.avatarShape}`);
        if (update.avatarShape === "custom" && !Array.isArray(update.avatarMorph)) throw new Error("A custom avatar shape requires exactly 24 avatarMorph values");
        if (Array.isArray(update.avatarMorph) && (update.avatarMorph.length !== 24 || update.avatarMorph.some((value:any) => !Number.isFinite(Number(value))))) throw new Error("A custom avatar morph requires exactly 24 numeric control radii");
        if (update.avatarShape === "vector" && !update.avatarVector) throw new Error("A vector avatar shape requires avatarVector");
        if (update.avatarVector) update.avatarVector = normalizeAvatarVectorSpec(update.avatarVector);
      }
      const before = this.store.snapshot();
      const targets: Array<{ update: any; target: AgentProfile | undefined }> = updates.map((update: any) => ({ update, target: this.findAgent(String(update.id || ""), before) }));
      if (targets.some(({ target }) => !target)) throw new Error("One or more Bots were not found");
      const proposedNames = targets.map(({ update, target }) => String(update.name ?? target!.name).trim().toLowerCase());
      if (new Set(proposedNames).size !== proposedNames.length) throw new Error("Bot names must be unique");
      for (const agent of before.agents) {
        if (!targets.some(({ target }) => target!.id === agent.id) && proposedNames.includes(agent.name.toLowerCase())) throw new Error(`A Bot named ${agent.name} already exists`);
      }
      const changedIds: string[] = [];
      this.store.mutate((state) => {
        for (const { update, target } of targets) {
          const agent = state.agents.find((item) => item.id === target!.id)!;
          if (typeof update.name === "string" && update.name.trim()) agent.name = update.name.trim().slice(0, 80);
          if (typeof update.title === "string") agent.title = update.title.slice(0, 60);
          if (typeof update.description === "string") agent.description = update.description.slice(0, 2_000);
          if (typeof update.instructions === "string") agent.instructions = update.instructions.slice(0, 12_000);
          if (typeof update.avatar === "string") agent.avatar = update.avatar.slice(0, 3);
          if (typeof update.color === "string") agent.color = update.color.slice(0, 30);
          if (typeof update.avatarShape === "string") {
            agent.avatarShape = update.avatarShape;
            if (update.avatarShape !== "vector") delete agent.avatarVector;
            if (update.avatarShape !== "custom") delete agent.avatarMorph;
          }
          if (Array.isArray(update.avatarMorph)) {
            agent.avatarMorph = update.avatarMorph.map((value:any) => Math.max(.45, Math.min(1.55, Number(value))));
            agent.avatarShape = "custom";
            delete agent.avatarVector;
          }
          if (update.avatarVector) { agent.avatarVector = update.avatarVector; agent.avatarShape = "vector"; delete agent.avatarMorph; }
          if (typeof update.avatarShapeName === "string") agent.avatarShapeName = update.avatarShapeName.trim().slice(0, 60);
          if (typeof update.avatarColor === "string") { const avatarColor = update.avatarColor.slice(0, 30); agent.avatarColor = avatarColor; agent.color = avatarColor; }
          if (typeof update.avatarAccent === "string") agent.avatarAccent = update.avatarAccent.slice(0, 30);
          if (["dots", "visor", "spark", "none"].includes(update.avatarFace)) agent.avatarFace = update.avatarFace;
          if (["solid", "gradient", "glass"].includes(update.avatarTexture)) agent.avatarTexture = update.avatarTexture;
          if (["calm", "lively", "off"].includes(update.avatarMotion)) agent.avatarMotion = update.avatarMotion;
          if (["none", "antenna", "halo", "headphones", "crown"].includes(update.avatarAccessory)) agent.avatarAccessory = update.avatarAccessory;
          if (update.clearAvatarImage === true) delete agent.avatarDataUrl;
          agent.updatedAt = isoNow();
          const direct = state.rooms.find((room) => room.directAgentId === agent.id);
          if (direct) { direct.name = agent.name; direct.description = agent.description; direct.updatedAt = isoNow(); }
          changedIds.push(agent.id);
        }
      });
      this.broadcast();
      const saved = this.store.snapshot();
      return { updated: changedIds.map((id) => { const agent = saved.agents.find((item) => item.id === id)!; return { id: agent.id, name: agent.name, avatar: normalizedAvatarState(agent) }; }) };
    }
    if (request.tool === "create_bot") {
      const name = String(args.name || "").trim().slice(0, 80);
      if (!name) throw new Error("Bot name is required");
      if (this.store.snapshot().agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) throw new Error("Bot names must be unique");
      const timestamp = isoNow();
      const id = makeId();
      const privateWorkspacePath = `agent-workspaces/${id}`;
      const baseColor = String(args.avatarColor || args.color || "#7C5CFC").slice(0, 30);
      const avatarVector = args.avatarVector ? normalizeAvatarVectorSpec(args.avatarVector) : undefined;
      const requestedShape = String(args.avatarShape || "blob");
      if (requestedShape === "vector" && !avatarVector) throw new Error("A vector avatar shape requires avatarVector");
      const agent: AgentProfile = { id, name, title: String(args.title || "").slice(0, 60), description: String(args.description || "").slice(0, 2_000), instructions: String(args.instructions || "").slice(0, 12_000), avatar: name[0], color: baseColor, avatarColor: baseColor, avatarAccent: String(args.avatarAccent || "#FFFFFF").slice(0, 30), avatarShape: avatarVector ? "vector" : (["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop", "cat", "dog"].includes(requestedShape) ? requestedShape as AgentProfile["avatarShape"] : "blob"), avatarVector, avatarFace: ["dots", "visor", "spark", "none"].includes(args.avatarFace) ? args.avatarFace : "dots", avatarTexture: ["solid", "gradient", "glass"].includes(args.avatarTexture) ? args.avatarTexture : "gradient", avatarMotion: ["calm", "lively", "off"].includes(args.avatarMotion) ? args.avatarMotion : "lively", avatarAccessory: ["none", "antenna", "halo", "headphones", "crown"].includes(args.avatarAccessory) ? args.avatarAccessory : "none", model: "gpt-5.6-terra", effort: "medium", networkAccess: true, privateWorkspacePath, status: "idle", roomThreadIds: {}, roomLastSeenMessageIds: {}, createdAt: timestamp, updatedAt: timestamp };
      await mkdir(path.resolve(process.cwd(), privateWorkspacePath), { recursive: true });
      const direct: Room = { id: makeId(), name, description: agent.description, agentIds: [id], kind: "direct", directAgentId: id, createdAt: timestamp, updatedAt: timestamp };
      this.store.mutate((state) => { state.agents.push(agent); state.rooms.push(direct); });
      this.broadcast();
      return { bot: { id, name }, directChatId: direct.id };
    }
    if (request.tool === "update_group" || request.tool === "create_group") {
      const state = this.store.snapshot();
      const memberInputs = Array.isArray(args.memberIds) ? args.memberIds : undefined;
      const memberIds = memberInputs?.map((value: any) => this.findAgent(String(value), state)?.id);
      if (memberIds?.some((id: string | undefined) => !id)) throw new Error("One or more group members were not found");
      if (request.tool === "create_group") {
        const name = String(args.name || "").trim().slice(0, 80);
        if (!name || !memberIds?.length) throw new Error("Group name and members are required");
        const timestamp = isoNow();
        const room: Room = { id: makeId(), name, description: String(args.description || "").slice(0, 8_000), agentIds: memberIds as string[], kind: "group", createdAt: timestamp, updatedAt: timestamp };
        this.store.mutate((current) => current.rooms.push(room));
        this.broadcast();
        return { group: { id: room.id, name: room.name, memberIds: room.agentIds } };
      }
      const needle = String(args.id || "").trim().toLowerCase();
      const room = state.rooms.find((item) => item.kind === "group" && (item.id === args.id || item.name.toLowerCase() === needle));
      if (!room) throw new Error("Group not found");
      this.store.mutate((current) => {
        const target = current.rooms.find((item) => item.id === room.id)!;
        if (typeof args.name === "string" && args.name.trim()) target.name = args.name.trim().slice(0, 80);
        if (typeof args.description === "string") target.description = args.description.slice(0, 8_000);
        if (memberIds?.length) target.agentIds = memberIds as string[];
        target.updatedAt = isoNow();
      });
      this.broadcast();
      return { group: this.store.snapshot().rooms.find((item) => item.id === room.id) };
    }
    throw new Error(`Unknown OAI Bot tool: ${request.tool}`);
  }

  private addMessage(message: Omit<ChatMessage, "id" | "createdAt" | "updatedAt">) {
    const timestamp = isoNow();
    const complete = { ...message, id: makeId(), createdAt: timestamp, updatedAt: timestamp };
    this.store.mutate((state) => {
      state.messages.push(complete);
      const room = state.rooms.find((item) => item.id === message.roomId);
      if (room) room.updatedAt = timestamp;
    });
    this.broadcast();
    return complete;
  }

  private commitMessageToAgent(message: ChatMessage, agentId: string) {
    const snapshot = this.store.snapshot();
    if (!snapshot.agents.some((agent) => agent.id === agentId)) return;
    const existingCursor = message.transcriptCursors?.[agentId];
    const existingEntry = snapshot.transcriptEntries.find((entry) => entry.agentId === agentId && entry.entryId === message.id && !entry.deleted);
    if (existingCursor && existingEntry && existingEntry.body === message.content && existingEntry.entryKind === message.kind) return;
    const committed = this.store.commitTranscriptEntries(agentId, [{
      entryId: message.id, messageId: message.id, entryKind: message.kind, body: message.content,
      createdAt: message.createdAt, updatedAt: message.updatedAt
    }]);
    this.store.mutate((state) => {
      const stored = state.messages.find((item) => item.id === message.id);
      if (stored) stored.transcriptCursors = {
        ...(stored.transcriptCursors || {}),
        [agentId]: { generation: committed.generation, updatedSeq: committed.updatedSeq }
      };
      this.updateClientState(state, agentId, message);
    });
  }

  private commitMessageToRoomMembers(message: ChatMessage, room: Room) {
    const agentIds = room.kind === "group" ? room.agentIds : [message.senderId];
    for (const agentId of [...new Set(agentIds)]) this.commitMessageToAgent(message, agentId);
  }

  private updateClientState(state: AppState, agentId: string, message: ChatMessage) {
    const client = state.agentClientStates.find((item) => item.agentId === agentId);
    if (!client) return;
    client.lastActivityAt = message.updatedAt;
    client.lastEntryId = message.id;
    client.lastEntryKind = message.kind;
    client.lastMessageId = message.id;
    client.lastMessagePreview = message.content.slice(0, 240);
    // The sidebar badge belongs to this Bot's direct chat. Group transcript
    // fan-out keeps every Bot informed, but must not create phantom unread
    // badges on otherwise empty direct chats.
    const directRoom = state.rooms.find((room) => room.id === message.roomId && room.kind === "direct" && room.directAgentId === agentId);
    if (message.senderType === "agent" && directRoom && message.senderId !== agentId) client.unreadCount += 1;
    client.updatedAt = message.updatedAt;
  }

  private messageSnapshot(message: ChatMessage, memberAgentId: string, state = this.store.snapshot()): MemberTurnMessageSnapshot {
    const speaker = message.senderType === "user" ? undefined : state.agents.find((agent) => agent.id === message.senderId);
    const reply = message.replyTo ? state.messages.find((item) => item.id === message.replyTo) : undefined;
    const replySpeaker = reply?.senderType === "user" ? undefined : state.agents.find((agent) => agent.id === reply?.senderId);
    return {
      messageId: message.id,
      speakerKind: message.senderType === "user" ? "human" : message.senderType,
      speakerId: message.senderType === "user" ? undefined : message.senderId,
      speakerName: message.senderType === "user" ? "User" : speaker?.name || "System",
      isSelf: message.senderType === "agent" && message.senderId === memberAgentId,
      text: message.content,
      replyTo: reply ? {
        speakerKind: reply.senderType === "user" ? "human" : reply.senderType,
        speakerName: reply.senderType === "user" ? "User" : replySpeaker?.name || "System",
        isSelf: reply.senderType === "agent" && reply.senderId === memberAgentId,
        quote: reply.content.slice(0, 500)
      } : undefined
    };
  }

  private addDeliveryReceipt(receipt: Omit<DeliveryReceipt, "id" | "createdAt" | "updatedAt">) {
    const timestamp = isoNow();
    const complete: DeliveryReceipt = { ...receipt, id: makeId(), createdAt: timestamp, updatedAt: timestamp };
    this.store.mutate((state) => state.deliveryReceipts.push(complete));
    return complete;
  }

  private async selectInitialGroupMember(room: Room, members: AgentProfile[], incoming: ChatMessage) {
    const fallback=members[0]?.id;
    if(!fallback||members.length<2||!(this.codex as any).supportsSilentGroupRouting) return fallback;
    const instructions=`You are the silent message router for a multi-Bot Channel. You never answer the user's message and never invent work. Select exactly one ordinary member to receive the first turn. Roles and labels are arbitrary user-authored text. Use the member profiles and current message. Prefer the member whose configured scope best matches. For greetings or ties, choose the first listed member. Return only JSON in this form: {"memberAgentId":"exact-id"}.`;
    try {
      let threadId=room.routerThreadId;
      if(threadId) {
        try { await this.codex.resumeThread(threadId,{model:"gpt-5.6-luna",instructions}); }
        catch { threadId=undefined; }
      }
      if(!threadId) {
        threadId=await this.codex.startThread({name:`${room.name} · Channel routing`,model:"gpt-5.6-luna",effort:"low",instructions});
        this.store.mutate(state=>{const target=state.rooms.find(item=>item.id===room.id);if(target)target.routerThreadId=threadId;});
      }
      const recent=this.store.snapshot().messages.filter(message=>message.roomId===room.id&&message.id!==incoming.id&&message.kind!=="activity").slice(-8).map(message=>{
        const speaker=message.senderType==="user"?"User":members.find(agent=>agent.id===message.senderId)?.name||"System";
        return `${speaker}: ${message.content.slice(0,600)}`;
      }).join("\n");
      const profiles=members.map((member,index)=>`${index+1}. id=${member.id}\nname=${member.name}\nrole=${member.title||"None"}\ndescription=${member.description||"None"}\ncustomInstructions=${member.instructions||"None"}`).join("\n\n");
      const result=await this.codex.runTurn({threadId,prompt:`Channel: ${room.name}\nChannel context: ${room.description||"None"}\n\nMembers:\n${profiles}\n\nRecent visible context:\n${recent||"None"}\n\nNew user message:\n${incoming.content}\n\nSelect the one best first recipient.`,model:"gpt-5.6-luna",effort:"low",networkAccess:false});
      const match=result.text.match(/\{[\s\S]*?\}/);
      const selected=match?JSON.parse(match[0])?.memberAgentId:undefined;
      return members.some(member=>member.id===selected)?selected:fallback;
    } catch {
      return fallback;
    }
  }

  private async selectGroupFollowup(room: Room, workflow: MemberTurnWorkflow, latest: ChatMessage) {
    if(room.kind!=="group"||!(this.codex as any).supportsSilentGroupRouting)return undefined;
    const state=this.store.snapshot();
    const members=state.agents.filter(agent=>room.agentIds.includes(agent.id));
    const rootId=workflow.rootWorkflowId||workflow.id;
    const chain=state.memberTurns.filter(turn=>(turn.rootWorkflowId||turn.id)===rootId&&["completed","passed","running","queued"].includes(turn.state));
    if(chain.length>=Math.max(3,members.length*2))return undefined;
    const eligible=members.filter(member=>member.id!==workflow.memberAgentId);
    if(!eligible.length)return undefined;
    const rootTurn=state.memberTurns.find(turn=>turn.id===rootId)||workflow;
    const rootMessage=rootTurn.triggerMessageId?state.messages.find(message=>message.id===rootTurn.triggerMessageId):undefined;
    const collectiveRequest=/\b(?:discuss|debate|challenge each other|what do you all|everyone|each of you|together|as a group)\b/i.test(rootMessage?.content||"");
    const allMembersRequest=/\b(?:each of you|everyone|all of you|every bot|all bots)\b/i.test(rootMessage?.content||"");
    const resolutionRequest=/\b(?:reach|agree(?: on)?|decide|choose|settle on|consensus|final)\b[\s\S]{0,48}\b(?:recommendation|decision|approach|option|choice|answer|plan)\b|\b(?:reach a recommendation|reach consensus|make a decision)\b/i.test(rootMessage?.content||"");
    const participatedIds=new Set(chain.flatMap(turn=>state.messages.some(message=>message.cycleId===turn.id&&message.senderType==="agent"&&message.status==="complete"&&message.content.trim())?[turn.memberAgentId]:[]));
    const requiredParticipants=allMembersRequest?members.length:collectiveRequest?Math.min(2,members.length):1;
    const firstParticipant=chain[0]?.memberAgentId;
    const firstParticipantTurns=chain.filter(turn=>turn.memberAgentId===firstParticipant).length;
    const instructions=`You are the silent lifecycle router for a multi-Bot Channel. You never write a chat response. Decide whether the completed member turn should naturally be followed by one other member turn. Continue only when another Bot has a distinct useful contribution, unresolved responsibility, direct reason to react, or the user's group-oriented request clearly calls for more than one perspective. Stop when the latest response is sufficient, work is complete, the room needs the user, or another turn would be repetition or ceremony. Prefer a member who has not participated in this cycle. Return only {"action":"stop"} or {"action":"continue","memberAgentId":"exact-id"}.`;
    try {
      let threadId=room.routerThreadId;
      if(threadId){try{await this.codex.resumeThread(threadId,{model:"gpt-5.6-luna",instructions});}catch{threadId=undefined;}}
      if(!threadId){threadId=await this.codex.startThread({name:`${room.name} · Channel routing`,model:"gpt-5.6-luna",effort:"low",instructions});this.store.mutate(current=>{const target=current.rooms.find(item=>item.id===room.id);if(target)target.routerThreadId=threadId;});}
      const participants=chain.map(turn=>state.agents.find(agent=>agent.id===turn.memberAgentId)?.name||turn.memberAgentId);
      const profiles=eligible.map(member=>`id=${member.id}; name=${member.name}; role=${member.title||"None"}; description=${member.description||"None"}; memories=${member.memories?.map(memory=>memory.text).join(" | ")||"None"}`).join("\n");
      const result=await this.codex.runTurn({threadId,prompt:`Channel: ${room.name}\nOriginal user message: ${rootMessage?.content||"Unknown"}\nMembers who already took turns: ${participants.join(", ")||"None"}\nLatest speaker: ${state.agents.find(agent=>agent.id===workflow.memberAgentId)?.name||workflow.memberAgentId}\nLatest response: ${latest.content}\n\nEligible next members:\n${profiles}\n\nDecide whether the room naturally needs exactly one follow-up turn.`,model:"gpt-5.6-luna",effort:"low",networkAccess:false});
      const match=result.text.match(/\{[\s\S]*?\}/);const decision=match?JSON.parse(match[0]):undefined;
      if(decision?.action==="continue"&&eligible.some(member=>member.id===decision.memberAgentId))return String(decision.memberAgentId);
      if(collectiveRequest&&participatedIds.size<requiredParticipants)return eligible.find(member=>!participatedIds.has(member.id))?.id;
      // A shared-decision request needs one synthesis turn after distinct views.
      // The first recipient owns that synthesis once, which avoids open-ended loops.
      if(collectiveRequest&&resolutionRequest&&participatedIds.size>=Math.min(2,members.length)&&firstParticipant&&firstParticipant!==workflow.memberAgentId&&firstParticipantTurns===1)return firstParticipant;
      return undefined;
    }catch{return undefined;}
  }

  private queueMemberTurn(input: {
    room: Room; memberAgentId: string; requestedBy: MemberTurnWorkflow["requestedBy"];
    requestedByAgentId?: string; triggerMessageId?: string; newMessageIds: string[];
    nonce: string; isWindingDown: boolean; deadlineAt?: string; rootWorkflowId?: string; parentWorkflowId?: string; originRoomId?: string;
    roomSnapshot?: MemberTurnRoomSnapshot; peerSnapshots?: MemberTurnPeerSnapshot[];
    newMessages?: MemberTurnMessageSnapshot[]; additionalPeerAgentIds?: string[];
  }) {
    const duplicate = this.store.snapshot().memberTurns.find((turn) => turn.nonce === input.nonce && turn.memberAgentId === input.memberAgentId);
    if (duplicate) return duplicate;
    const timestamp = isoNow();
    const id = makeId();
    const rootWorkflowId = input.rootWorkflowId || id;
    if (input.requestedBy === "agent") {
      const chainCount = this.store.snapshot().memberTurns.filter((turn) => turn.rootWorkflowId === rootWorkflowId).length;
      if (chainCount >= Math.max(4, input.room.agentIds.length * 4)) throw new Error("Peer handoff limit reached for this workflow");
    }
    const state = this.store.snapshot();
    const peerAgentIds = [...new Set([
      ...input.room.agentIds.filter((agentId) => agentId !== input.memberAgentId),
      ...(input.additionalPeerAgentIds || []).filter((agentId) => agentId !== input.memberAgentId)
    ])];
    const roomSnapshot: MemberTurnRoomSnapshot = structuredClone(input.roomSnapshot || {
      id: input.room.id, name: input.room.name, description: input.room.description,
      isSharedRoom: input.room.kind === "group", sharedRoomId: input.room.kind === "group" ? input.room.id : undefined
    });
    const peerSnapshots = structuredClone(input.peerSnapshots || peerAgentIds.map((agentId) => {
      const peer = state.agents.find((agent) => agent.id === agentId);
      return { id: agentId, name: peer?.name || agentId, description: peer?.description || "" };
    }));
    const newMessages = structuredClone(input.newMessages || input.newMessageIds.flatMap((messageId) => {
      const message = state.messages.find((item) => item.id === messageId);
      return message ? [this.messageSnapshot(message, input.memberAgentId, state)] : [];
    }));
    const turn: MemberTurnWorkflow = {
      id, nonce: input.nonce, roomId: input.room.id, memberAgentId: input.memberAgentId,
      requestedBy: input.requestedBy, requestedByAgentId: input.requestedByAgentId,
      triggerMessageId: input.triggerMessageId, peerAgentIds,
      newMessageIds: input.newMessageIds, roomSnapshot, peerSnapshots, newMessages,
      isWindingDown: input.isWindingDown, state: "queued",
      workflowId: makeId(), rootWorkflowId, parentWorkflowId: input.parentWorkflowId, originRoomId: input.originRoomId,
      deadlineAt: input.deadlineAt || new Date(Date.now() + 10 * 60_000).toISOString(),
      createdAt: timestamp, updatedAt: timestamp
    };
    this.store.mutate((state) => state.memberTurns.push(turn));
    for (const messageId of input.newMessageIds) {
      const message = this.store.snapshot().messages.find((item) => item.id === messageId);
      if (message) this.commitMessageToAgent(message, input.memberAgentId);
    }
    this.addDeliveryReceipt({
      messageId: input.triggerMessageId || turn.id, kind: "member-turn", status: "accepted", mode: "local",
      delivery: "accepted-local", roomId: input.room.id, fromAgentId: input.requestedByAgentId,
      toAgentId: input.memberAgentId, memberTurnId: turn.id, workflowId: turn.workflowId, acceptedAt: timestamp
    });
    return turn;
  }

  async postUserMessage(
    roomId: string, content: string, replyTo?: string, clientNonce?: string, attachments: AttachmentRef[] = [],
    envelope: Pick<ChatMessage, "richText" | "isFork" | "traceparent" | "sentAtMs" | "enterEpochMs" | "composedAtMs" | "source" | "attachmentPaths" | "attachmentNames"> = {}
  ) {
    const state = this.store.snapshot();
    const room = state.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error("Room not found");
    const members = state.agents.filter((agent) => room.agentIds.includes(agent.id));
    if (!members.length) throw new Error("This chat has no bots");
    const duplicate = clientNonce ? state.messages.find((message) => message.clientNonce === clientNonce && message.roomId === roomId) : undefined;
    if (duplicate) {
      const existingReceipt = state.deliveryReceipts.find((receipt) => receipt.kind === "user-message" && receipt.messageId === duplicate.id);
      return { messageId: duplicate.id, delivery: "duplicate" as const, acceptedAt: duplicate.createdAt, receiptId: existingReceipt?.id };
    }

    const mentioned = extractMentionedAgentIds(content, members);
    this.cancelRoomWork(room.id, "Superseded by a newer user message");
    const userMessage = this.addMessage({
      roomId, senderType: "user", senderId: "user", content, kind: "message", status: "complete",
      mentions: mentioned, replyTo, clientNonce, dispatchStatus: "pending", attachments, reactions: {}, ...envelope
    });
    const receipt = this.addDeliveryReceipt({
      messageId: userMessage.id, kind: "user-message", status: "accepted", mode: "local", delivery: "accepted-local",
      roomId: room.id, clientNonce, acceptedAt: userMessage.createdAt
    });
    this.store.mutate((current) => {
      for (const member of current.agents.filter((agent) => room.agentIds.includes(agent.id))) member.awaitingUserResponse = false;
    });
    const everyone = /@everyone\b/i.test(content);
    const replied = replyTo ? state.messages.find((message) => message.id === replyTo && message.roomId === room.id && message.senderType === "agent") : undefined;
    let targets = room.kind === "direct" ? members.slice(0, 1).map((agent) => agent.id)
      : mentioned.length && !everyone ? mentioned
      : everyone ? members.map((agent) => agent.id)
      : replied && room.agentIds.includes(replied.senderId) ? [replied.senderId]
      : [];
    if(room.kind==="group"&&!targets.length) {
      const selected=await this.selectInitialGroupMember(room,members,userMessage);
      if(selected)targets=[selected];
    }
    for (const agentId of [...new Set(targets)]) this.queueMemberTurn({
      room, memberAgentId: agentId, requestedBy: "user", triggerMessageId: userMessage.id,
      newMessageIds: [userMessage.id], nonce: `user-message:${userMessage.id}:${agentId}`, isWindingDown: false
    });
    await this.store.flush();
    this.enqueueRoom(room.id, () => this.drainRoom(room.id));
    return { messageId: userMessage.id, delivery: "accepted" as const, acceptedAt: userMessage.createdAt, receiptId: receipt.id };
  }

  recoverPendingMessages() {
    const timestamp = isoNow();
    this.store.mutate((state) => {
      for (const turn of state.memberTurns) {
        if (turn.state !== "queued" && turn.state !== "running") continue;
        if (turn.deadlineAt && Date.parse(turn.deadlineAt) <= Date.now()) {
          turn.state = "failed"; turn.error = "Member turn deadline expired"; turn.finishedAt = timestamp;
        } else if (turn.state === "running") {
          turn.state = "queued"; delete turn.startedAt; delete turn.turnId; delete turn.leaseId; delete turn.recoveryRequired;
        }
        turn.updatedAt = timestamp;
      }
    });
    const state = this.store.snapshot();
    for (const room of state.rooms) {
      let hasQueued = state.memberTurns.some((turn) => turn.roomId === room.id && turn.state === "queued");
      if (!hasQueued) {
        const latest = state.messages.filter((message) => message.roomId === room.id && message.senderType === "user" && (message.dispatchStatus === "pending" || message.dispatchStatus === "processing")).at(-1);
        if (latest) {
          const members = state.agents.filter((agent) => room.agentIds.includes(agent.id));
          const mentioned = extractMentionedAgentIds(latest.content, members);
          const everyone = /@everyone\b/i.test(latest.content);
          const replied = latest.replyTo ? state.messages.find((message) => message.id === latest.replyTo && message.roomId === room.id && message.senderType === "agent") : undefined;
          const targets = room.kind === "direct" ? members.slice(0, 1)
            : mentioned.length && !everyone ? members.filter((agent) => mentioned.includes(agent.id))
            : everyone ? members
            : replied && room.agentIds.includes(replied.senderId) ? members.filter((agent) => agent.id === replied.senderId)
            : members.filter((agent) => agent.id === room.agentIds[0]);
          for (const agent of targets) this.queueMemberTurn({ room, memberAgentId: agent.id, requestedBy: "system", triggerMessageId: latest.id, newMessageIds: [latest.id], nonce: `recovery:${latest.id}:${agent.id}`, isWindingDown: false });
          hasQueued = targets.length > 0;
        }
      }
      if (hasQueued) this.enqueueRoom(room.id, () => this.drainRoom(room.id));
    }
  }

  triggerRoutine(routine: Routine) {
    const state = this.store.snapshot();
    const room = state.rooms.find((item) => item.id === routine.roomId);
    const agent = state.agents.find((item) => item.id === routine.agentId && room?.agentIds.includes(item.id));
    if (!room || !agent) throw new Error("Routine target is unavailable");
    const event = this.addMessage({
      roomId: room.id, senderType: "system", senderId: agent.id,
      content: `Scheduled routine "${routine.name}":\n${routine.instruction}`, kind: "routine", status: "complete",
      mentions: [agent.id], reactions: {}
    });
    this.queueMemberTurn({ room, memberAgentId: agent.id, requestedBy: "routine", triggerMessageId: event.id, newMessageIds: [event.id], nonce: `routine:${routine.id}:${event.id}`, isWindingDown: false });
    this.enqueueRoom(room.id, () => this.drainRoom(room.id));
  }

  private enqueueRoom(roomId: string, task: () => Promise<void>) {
    const previous = this.roomQueues.get(roomId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task).finally(() => {
      if (this.roomQueues.get(roomId) === next) this.roomQueues.delete(roomId);
    });
    this.roomQueues.set(roomId, next);
  }

  private async withAgentLease<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.agentLeases.get(agentId) || Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const lease = previous.catch(() => undefined).then(() => hold);
    this.agentLeases.set(agentId, lease);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      void lease.finally(() => { if (this.agentLeases.get(agentId) === lease) this.agentLeases.delete(agentId); });
    }
  }

  private cancelRoomWork(roomId: string, reason: string) {
    const active = this.activeCycles.get(roomId);
    if (active) active.cancelled = true;
    if (active?.activeThreadId && active.activeTurnId) {
      void this.codex.interruptTurn(active.activeThreadId, active.activeTurnId).catch(() => undefined);
    }
    this.store.mutate((state) => {
      const room = state.rooms.find((item) => item.id === roomId);
      if (room) room.runState = undefined;
      const timestamp = isoNow();
      for (const turn of state.memberTurns) {
        if (turn.roomId !== roomId || (turn.state !== "queued" && turn.state !== "running")) continue;
        turn.state = "cancelled"; turn.cancellationReason = reason; turn.finishedAt = timestamp; turn.updatedAt = timestamp; delete turn.leaseId; delete turn.recoveryRequired;
        const receipt = state.deliveryReceipts.find((item) => item.memberTurnId === turn.id && item.kind === "member-turn");
        if (receipt) { receipt.status = "rejected"; receipt.refusalCode = reason; receipt.updatedAt = timestamp; }
      }
      for (const source of state.messages) {
        if (source.roomId === roomId && (source.dispatchStatus === "processing" || source.dispatchStatus === "pending")) { source.dispatchStatus = "superseded"; source.updatedAt = timestamp; }
      }
    });
    this.broadcast();
  }

  stopRoom(roomId: string, reason = "Stopped by the user") {
    if (!this.store.snapshot().rooms.some((room) => room.id === roomId)) throw new Error("Room not found");
    this.cancelRoomWork(roomId, reason);
  }

  async cancelMemberTurn(id: string, reason = "Cancelled") {
    const existing = this.store.snapshot().memberTurns.find((turn) => turn.id === id);
    if (!existing) throw new Error("Member turn not found");
    if (!["queued", "running"].includes(existing.state)) return existing;
    const active = this.activeCycles.get(existing.roomId);
    if (active?.workflowId === id) {
      active.cancelled = true;
      if (active.activeThreadId && active.activeTurnId) void this.codex.interruptTurn(active.activeThreadId, active.activeTurnId).catch(() => undefined);
    }
    const timestamp = isoNow();
    this.store.mutate((state) => {
      const turn = state.memberTurns.find((item) => item.id === id);
      if (turn) { turn.state = "cancelled"; turn.cancellationReason = reason; turn.finishedAt = timestamp; turn.updatedAt = timestamp; delete turn.leaseId; delete turn.recoveryRequired; }
      const receipt = state.deliveryReceipts.find((item) => item.memberTurnId === id && item.kind === "member-turn");
      if (receipt) { receipt.status = "rejected"; receipt.refusalCode = reason; receipt.updatedAt = timestamp; }
    });
    await this.store.flush();
    this.broadcast();
    return this.store.snapshot().memberTurns.find((turn) => turn.id === id)!;
  }

  async cancelMemberTurnByNonce(nonce: string, memberAgentId: string, reason = "Cancelled") {
    const existing = this.store.snapshot().memberTurns.find((turn) => turn.nonce === nonce && turn.memberAgentId === memberAgentId);
    if (!existing) throw new Error("Member turn not found");
    return this.cancelMemberTurn(existing.id, reason);
  }

  async requestMemberTurn(roomId: string, memberAgentId: string, nonce: string, newMessageIds: string[] = [], isWindingDown = false, deadlineAt?: string, snapshots?: {
    room?: MemberTurnRoomSnapshot; peers?: MemberTurnPeerSnapshot[]; newMessages?: MemberTurnMessageSnapshot[];
  }) {
    const state = this.store.snapshot();
    const room = state.rooms.find((item) => item.id === roomId);
    if (!room || !room.agentIds.includes(memberAgentId)) throw new Error("Room member not found");
    const turn = this.queueMemberTurn({
      room, memberAgentId, requestedBy: "system", newMessageIds, nonce, isWindingDown, deadlineAt,
      roomSnapshot: snapshots?.room, peerSnapshots: snapshots?.peers, newMessages: snapshots?.newMessages
    });
    await this.store.flush();
    this.enqueueRoom(room.id, () => this.drainRoom(room.id));
    return turn;
  }

  async sendAgentMessage(fromAgentId: string, toAgentId: string, messageId: string, text: string, sourceRoomId?: string) {
    let state = this.store.snapshot();
    const sender = state.agents.find((agent) => agent.id === fromAgentId);
    const target = state.agents.find((agent) => agent.id === toAgentId);
    if (!sender || !target || fromAgentId === toAgentId) throw new Error("Invalid peer message target");
    let room = state.rooms.find((item) => item.kind === "direct" && item.directAgentId === toAgentId);
    if (!room) {
      const timestamp = isoNow();
      room = { id: makeId(), name: target.name, description: target.description, agentIds: [target.id], kind: "direct", directAgentId: target.id, createdAt: timestamp, updatedAt: timestamp };
      this.store.mutate((current) => current.rooms.push(room!));
      state = this.store.snapshot();
    }
    const existing = state.messages.find((message) => message.clientNonce === messageId && message.fromAgentId === fromAgentId);
    if (existing) return { message: existing, duplicate: true };
    const content = text.trim().slice(0, 8_000);
    if (!content) throw new Error("Peer message text is required");
    const message = this.addMessage({ roomId: room.id, senderType: "agent", senderId: fromAgentId, fromAgentId, toAgentIds: [toAgentId], content, kind: "peer-message", status: "complete", mentions: [toAgentId], clientNonce: messageId, reactions: {} });
    const sourceActive = sourceRoomId ? this.activeCycles.get(sourceRoomId) : undefined;
    const sourceWorkflow = sourceActive ? state.memberTurns.find((turn) => turn.id === sourceActive.workflowId) : undefined;
    const sourceRoom = sourceRoomId ? state.rooms.find((item) => item.id === sourceRoomId) : undefined;
    const originRoomId = sourceWorkflow?.originRoomId || (sourceRoom?.kind === "group" ? sourceRoom.id : undefined);
    const turn = this.queueMemberTurn({
      room, memberAgentId: toAgentId, requestedBy: "agent", requestedByAgentId: fromAgentId,
      triggerMessageId: message.id, newMessageIds: [message.id], nonce: `agent-message:${messageId}:${toAgentId}`,
      isWindingDown: true, rootWorkflowId: sourceWorkflow?.rootWorkflowId, parentWorkflowId: sourceWorkflow?.id,
      additionalPeerAgentIds: [fromAgentId], originRoomId
    });
    this.addDeliveryReceipt({
      messageId: message.id, kind: "agent-message", status: "accepted", mode: "local", delivery: "delivered-local",
      roomId: room.id, fromAgentId, toAgentId, memberTurnId: turn.id, workflowId: turn.workflowId, acceptedAt: isoNow()
    });
    await this.store.flush();
    this.enqueueRoom(room.id, () => this.drainRoom(room.id));
    return { message, turn, duplicate: false };
  }

  async postAgentMessageToGroup(fromAgentId: string, groupId: string, messageId: string, text: string) {
    const state = this.store.snapshot();
    const sender = state.agents.find((agent) => agent.id === fromAgentId);
    const room = state.rooms.find((item) => item.id === groupId && item.kind === "group");
    if (!sender || !room || !room.agentIds.includes(fromAgentId)) throw new Error("Invalid group post target");
    const existing = state.messages.find((message) => message.clientNonce === messageId && message.fromAgentId === fromAgentId && message.roomId === groupId);
    if (existing) return { message: existing, duplicate: true };
    const content = text.trim().slice(0, 8_000);
    if (!content) throw new Error("Group post text is required");
    const recentDuplicate = state.messages.find((message) => message.roomId === groupId && message.fromAgentId === fromAgentId && message.senderType === "agent" && message.content.trim() === content && Date.now() - Date.parse(message.createdAt) < 30_000);
    if (recentDuplicate) return { message: recentDuplicate, duplicate: true };
    const members = state.agents.filter((agent) => room.agentIds.includes(agent.id));
    const mentions = extractMentionedAgentIds(content, members).filter((id) => id !== fromAgentId);
    const message = this.addMessage({
      roomId: room.id, senderType: "agent", senderId: fromAgentId, fromAgentId,
      toAgentIds: [], content, kind: "message", status: "complete", mentions,
      clientNonce: messageId, reactions: {}
    });
    this.commitMessageToRoomMembers(message, room);
    this.addDeliveryReceipt({
      messageId: message.id, kind: "agent-message", status: "accepted", mode: "local",
      delivery: "delivered-local", roomId: room.id, fromAgentId, acceptedAt: isoNow()
    });
    for (const targetId of mentions) this.queueMemberTurn({
      room, memberAgentId: targetId, requestedBy: "agent", requestedByAgentId: fromAgentId,
      triggerMessageId: message.id, newMessageIds: [message.id], nonce: `group-mention:${message.id}:${targetId}`,
      isWindingDown: true
    });
    await this.store.flush();
    if (mentions.length) this.enqueueRoom(room.id, () => this.drainRoom(room.id));
    return { message, duplicate: false };
  }

  private async drainRoom(roomId: string) {
    while (true) {
      const snapshot = this.store.snapshot();
      const workflow = snapshot.memberTurns.find((turn) => turn.roomId === roomId && turn.state === "queued");
      if (!workflow) break;
      const room = snapshot.rooms.find((item) => item.id === roomId);
      if (!room) break;
      if (workflow.deadlineAt && Date.parse(workflow.deadlineAt) <= Date.now()) {
        this.finishWorkflow(workflow.id, "failed", "Member turn deadline expired");
        continue;
      }
      const source = workflow.triggerMessageId ? snapshot.messages.find((message) => message.id === workflow.triggerMessageId) : undefined;
      const incoming = workflow.newMessages?.map((message) => `${message.speakerName}: ${message.text}`).join("\n\n")
        || source?.content || "Continue the queued room work.";
      const active: ActiveCycle = { id: workflow.nonce, workflowId: workflow.id, sourceMessageId: workflow.triggerMessageId || workflow.id, cancelled: false };
      this.activeCycles.set(roomId, active);
      const startedAt = isoNow();
      const leaseId = makeId();
      this.store.mutate((state) => {
        const turn = state.memberTurns.find((item) => item.id === workflow.id);
        if (turn) { turn.state = "running"; turn.leaseId = leaseId; turn.attempts = (turn.attempts || 0) + 1; turn.startedAt = startedAt; turn.updatedAt = startedAt; delete turn.recoveryRequired; }
        const trigger = state.messages.find((message) => message.id === workflow.triggerMessageId);
        if (trigger && trigger.dispatchStatus !== "superseded") { trigger.dispatchStatus = "processing"; trigger.updatedAt = startedAt; }
      });
      this.setRoomRunState(roomId, { nonce: workflow.nonce, phase: workflow.isWindingDown ? "winding-down" : "active", activeAgentId: workflow.memberAgentId, startedAt });
      if (workflow.originRoomId) this.setRoomRunState(workflow.originRoomId, { nonce: workflow.nonce, phase: workflow.isWindingDown ? "winding-down" : "active", activeAgentId: workflow.memberAgentId, startedAt });
      const result = await this.withAgentLease(workflow.memberAgentId, () => this.runMemberTurn(workflow, incoming, workflow.triggerMessageId || workflow.id, workflow.isWindingDown ? "winding-down" : "active", active));
      if (this.activeCycles.get(roomId) === active) this.activeCycles.delete(roomId);
      const persisted = this.store.snapshot().memberTurns.find((turn) => turn.id === workflow.id);
      if (active.cancelled || persisted?.state === "cancelled") continue;
      this.finishWorkflow(workflow.id, result.error ? "failed" : result.passed ? "passed" : "completed", result.error);
      for (const requested of result.requestedAgentIds) {
        const handoffState = this.store.snapshot();
        const currentRoom = handoffState.rooms.find((item) => item.id === roomId);
        const originRoom = workflow.originRoomId ? handoffState.rooms.find((item) => item.id === workflow.originRoomId && item.kind === "group") : undefined;
        const handoffRoom = originRoom || currentRoom;
        if (!handoffRoom || !handoffRoom.agentIds.includes(requested)) continue;
        const root = workflow.triggerMessageId || workflow.id;
        const handoffRootId = workflow.rootWorkflowId || workflow.id;
        const alreadyPending = handoffState.memberTurns.some((turn) =>
          (turn.rootWorkflowId || turn.id) === handoffRootId
          && turn.memberAgentId === requested
          && (turn.state === "queued" || turn.state === "running")
        );
        if (alreadyPending) continue;
        const chainCount = handoffState.memberTurns.filter((turn) => turn.rootWorkflowId === workflow.rootWorkflowId).length;
        if (chainCount >= Math.max(4, handoffRoom.agentIds.length * 4)) continue;
        const handoffMessage = handoffState.messages.find((message) => message.cycleId === workflow.id && message.senderId === workflow.memberAgentId && message.status === "complete");
        this.queueMemberTurn({ room: handoffRoom, memberAgentId: requested, requestedBy: "agent", requestedByAgentId: workflow.memberAgentId, triggerMessageId: root, newMessageIds: handoffMessage ? [handoffMessage.id] : [], nonce: `public-handoff:${workflow.id}:${requested}`, isWindingDown: true, rootWorkflowId: workflow.rootWorkflowId, parentWorkflowId: workflow.id });
      }
      if(!result.error&&!result.passed&&!result.awaitingUserResponse&&!result.requestedAgentIds.length&&room.kind==="group") {
        const completedMessage=this.store.snapshot().messages.find(message=>message.cycleId===workflow.id&&message.senderId===workflow.memberAgentId&&message.status==="complete");
        const nextMember=completedMessage?await this.selectGroupFollowup(room,workflow,completedMessage):undefined;
        if(nextMember) this.queueMemberTurn({room,memberAgentId:nextMember,requestedBy:"system",triggerMessageId:workflow.triggerMessageId,newMessageIds:[completedMessage!.id],nonce:`channel-followup:${workflow.id}:${nextMember}`,isWindingDown:true,rootWorkflowId:workflow.rootWorkflowId||workflow.id,parentWorkflowId:workflow.id});
      }
      this.completeTriggerIfSettled(roomId, workflow.triggerMessageId);
      this.refreshOriginRunState(workflow.originRoomId);
    }
    const finalState = this.store.snapshot();
    const room = finalState.rooms.find((item) => item.id === roomId);
    const waiting = room && finalState.agents.some((agent) => room.agentIds.includes(agent.id) && agent.awaitingUserResponse);
    this.store.mutate((state) => {
      const current = state.rooms.find((item) => item.id === roomId);
      if (current) current.runState = waiting ? { nonce: makeId(), phase: "waiting", startedAt: isoNow() } : undefined;
    });
    this.broadcast();
  }

  private finishWorkflow(id: string, stateValue: "completed" | "passed" | "failed", error?: string) {
    const timestamp = isoNow();
    this.store.mutate((state) => {
      const turn = state.memberTurns.find((item) => item.id === id);
      if (turn && turn.state !== "cancelled") { turn.state = stateValue; turn.error = error; turn.finishedAt = timestamp; turn.updatedAt = timestamp; delete turn.leaseId; delete turn.recoveryRequired; }
      const receipt = state.deliveryReceipts.find((item) => item.memberTurnId === id && item.kind === "member-turn");
      if (receipt) { receipt.status = stateValue === "failed" ? "rejected" : "accepted"; receipt.refusalCode = error; receipt.updatedAt = timestamp; }
    });
  }

  private completeTriggerIfSettled(roomId: string, triggerMessageId?: string) {
    if (!triggerMessageId) return;
    this.store.mutate((state) => {
      const unsettled = state.memberTurns.some((turn) => turn.roomId === roomId && turn.triggerMessageId === triggerMessageId && (turn.state === "queued" || turn.state === "running"));
      const source = state.messages.find((message) => message.id === triggerMessageId);
      if (!unsettled && source && source.dispatchStatus !== "superseded") { source.dispatchStatus = "completed"; source.updatedAt = isoNow(); }
    });
  }

  private setRoomRunState(roomId: string, runState: NonNullable<Room["runState"]>) {
    this.store.mutate((state) => { const room = state.rooms.find((item) => item.id === roomId); if (room) room.runState = runState; });
    this.broadcast();
  }

  private refreshOriginRunState(originRoomId?: string) {
    if (!originRoomId) return;
    const snapshot = this.store.snapshot();
    const pending = snapshot.memberTurns.find((turn) => turn.originRoomId === originRoomId && turn.state === "running")
      || snapshot.memberTurns.find((turn) => turn.originRoomId === originRoomId && turn.state === "queued");
    this.store.mutate((state) => {
      const room = state.rooms.find((item) => item.id === originRoomId && item.kind === "group");
      if (!room) return;
      if (pending) {
        room.runState = {
          nonce: pending.nonce,
          phase: pending.isWindingDown ? "winding-down" : "active",
          activeAgentId: pending.memberAgentId,
          startedAt: pending.startedAt || pending.createdAt
        };
        return;
      }
      const waiting = state.agents.some((agent) => room.agentIds.includes(agent.id) && agent.awaitingUserResponse);
      room.runState = waiting ? { nonce: makeId(), phase: "waiting", startedAt: isoNow() } : undefined;
    });
    this.broadcast();
  }

  private instructions(agent: AgentProfile, room: Room, peers: AgentProfile[]) {
    return `You are ${agent.name}. You are a persistent individual Bot, not a narrator, coordinator, or voice for the room. No Bot type or role has built-in authority over another Bot.

Your user-configured profile is authoritative.
Name: ${agent.name}
Optional role or label: ${agent.title || "None"}
Your description:
${agent.description || "No description supplied."}

Your custom instructions:
${agent.instructions || "No custom instructions supplied."}

Your durable memories from prior conversations:
${agent.memories?.length ? agent.memories.map(memory=>`- [${memory.id}] ${memory.text}`).join("\n") : "No durable memories saved."}

Current conversation: ${room.name}
Channel description or working context:
${room.description || "No additional group instructions supplied."}

Other Bots available in this conversation:
${agentRoster(peers)}

Stay recognizably ${agent.name} across conversations. Follow the profile and custom instructions above for judgment, voice, priorities, boundaries, and working habits. Do not flatten your voice into generic team language. Do not announce your role, narrate the orchestration, manufacture consensus, or speak for another Bot. If the profile does not prescribe a special voice, be natural, concise, and specific.

Talk to the actual people and Bots in the conversation. In a user-facing response, address the person as "you" when needed. In a Bot-to-Bot message, address the other Bot directly and state the work or question. Do not relay routine context as "the user said," "the user wants," or "the user asked." Speaker labels such as User are transport metadata and must never leak into conversational prose.

You have your own model turn, conversation memory, tools, and private Bot workspace. The room transcript and shared workspace are common resources, not a shared identity. Preserve other members' changes. In a Channel, an exact @Bot mention is a visible message to that Bot and wakes it. Plain names do not. Visible @Bot handoffs are the default for shared discussion, implementation, review, and verification. Use oai_bot.message_bot only for context that genuinely belongs in a private Bot-to-Bot exchange, never as the routine way to wake another member of the current Channel. ${room.kind === "group" ? `Your normal answer is already posted in ${room.name}; do not post it again with a tool.` : "When a private Bot handoff originated in a Channel, your normal answer is returned to that Channel under your own name."}

Use oai_bot tools when a request actually changes Bots, Channels, memory, or another Bot's work. Save a memory only when the user clearly establishes something lasting across conversations. Report only confirmed changes. Never pretend prose changed persistent state. For avatars, do not claim a custom abstract silhouette is a recognizable object or animal unless the tool confirms semanticVerified. The character itself is the avatar, never an icon placed inside a generic shape.

If you have nothing relevant to add, output exactly [[PASS]]. If you need the user before continuing, end with [[WAIT_FOR_USER]]. Do not use em dashes. Do not perform destructive, public, account, billing, or external side effects without approval.`;
  }

  private transcript(agent: AgentProfile, workflow: MemberTurnWorkflow, fullContext: boolean) {
    const state = this.store.snapshot();
    const metadata = state.transcriptMetadata.find((item) => item.agentId === agent.id);
    const rows = state.transcriptEntries
      .filter((entry) => entry.agentId === agent.id && entry.generation === metadata?.generation && !entry.deleted && entry.entryKind !== "activity")
      .sort((left, right) => left.seq - right.seq);
    const cursor = agent.roomLastSeenMessageIds[workflow.roomId];
    const cursorIndex = cursor ? rows.findIndex((entry) => entry.messageId === cursor || entry.entryId === cursor) : -1;
    const selected = fullContext || cursorIndex < 0 ? rows.slice(-24) : rows.slice(cursorIndex + 1);
    return selected.map((entry) => {
      const message = entry.messageId ? state.messages.find((item) => item.id === entry.messageId) : undefined;
      const snapshot = workflow.newMessages?.find((item) => item.messageId === entry.messageId);
      const speaker = snapshot?.speakerName || (message?.senderType === "user" ? "User" : state.agents.find((item) => item.id === message?.senderId)?.name || "System");
      const isSelf = snapshot?.isSelf ?? (message?.senderType === "agent" && message.senderId === agent.id);
      const targets = (message?.toAgentIds || []).map((id) => state.agents.find((item) => item.id === id)?.name || id);
      const routing = message?.kind === "peer-message" ? ` peerMessage=true from=${speaker} to=${targets.join(",") || agent.name} addressedToSelf=${message.toAgentIds?.includes(agent.id) === true}` : "";
      const files = message?.attachments?.length ? `\nAttachments: ${message.attachments.map((item) => item.path).join(", ")}` : "";
      return `[message id=${entry.messageId || entry.entryId} speaker=${speaker} isSelf=${isSelf}${routing}]\n${entry.body || ""}${files}`;
    }).join("\n\n");
  }

  private async ensureThread(agent: AgentProfile, room: Room, members: AgentProfile[]) {
    const instructions = this.instructions(agent, room, members.filter((item) => item.id !== agent.id));
    const existing = agent.roomThreadIds[room.id];
    if (existing) {
      try {
        await this.codex.resumeThread(existing, { model: agent.model, instructions, privateWorkspacePath: agent.privateWorkspacePath, dynamicTools: this.controlTools() });
        this.threadContext.set(existing, { agentId: agent.id, roomId: room.id });
        return { threadId: existing, fresh: false };
      } catch {
        this.store.mutate((state) => { const target = state.agents.find((item) => item.id === agent.id); if (target) delete target.roomThreadIds[room.id]; });
      }
    }
    const threadId = await this.codex.startThread({ name: `${room.name} · ${agent.name}`, model: agent.model, effort: agent.effort, instructions, privateWorkspacePath: agent.privateWorkspacePath, dynamicTools: this.controlTools() });
    this.store.mutate((state) => { const target = state.agents.find((item) => item.id === agent.id); if (target) target.roomThreadIds[room.id] = threadId; });
    this.threadContext.set(threadId, { agentId: agent.id, roomId: room.id });
    return { threadId, fresh: true };
  }

  private async runMemberTurn(workflow: MemberTurnWorkflow, incoming: string, sourceMessageId: string, phase: TurnPhase, active: ActiveCycle): Promise<MemberTurnResult> {
    const roomId = workflow.roomId;
    const agentId = workflow.memberAgentId;
    const cycleId = workflow.id;
    const state = this.store.snapshot();
    const room = state.rooms.find((item) => item.id === roomId);
    const agent = state.agents.find((item) => item.id === agentId);
    if (!room || !agent) return { requestedAgentIds: [], awaitingUserResponse: false, passed: true };
    const peerIds = new Set(workflow.peerAgentIds || room.agentIds.filter((id) => id !== agent.id));
    const snapshotPeers = new Map((workflow.peerSnapshots || []).map((peer) => [peer.id, peer]));
    const members = [agent, ...state.agents.filter((item) => peerIds.has(item.id) && item.id !== agent.id).map((item) => {
      const peer = snapshotPeers.get(item.id);
      return peer ? { ...item, name: peer.name, description: peer.description } : item;
    })];
    const executionRoom: Room = workflow.roomSnapshot ? {
      ...room,
      id: workflow.roomSnapshot.id,
      name: workflow.roomSnapshot.name,
      description: workflow.roomSnapshot.description
    } : room;
    const originRoom = workflow.originRoomId ? state.rooms.find((item) => item.id === workflow.originRoomId && item.kind === "group") : undefined;
    const responseRoom = originRoom || room;
    const rootWorkflow = state.memberTurns.find((item) => item.id === (workflow.rootWorkflowId || workflow.id)) || workflow;
    const rootMessage = rootWorkflow.triggerMessageId ? state.messages.find((item) => item.id === rootWorkflow.triggerMessageId) : undefined;
    let streamingMessageId: string | undefined;
    let streamedText = "";
    let deadlineTimer: NodeJS.Timeout | undefined;
    let deadlineExpired = false;
    this.store.mutate((current) => {
      const target = current.agents.find((item) => item.id === agentId);
      if (target) { target.status = "working"; target.activity = { kind: "thinking", detail: phase === "winding-down" ? "Finishing their turn" : "Considering new messages", updatedAt: isoNow() }; }
    });
    this.broadcast();
    try {
      const { threadId, fresh } = await this.ensureThread(agent, executionRoom, members);
      const deadlineAt = this.store.snapshot().memberTurns.find((turn) => turn.id === active.workflowId)?.deadlineAt;
      if (deadlineAt) {
        deadlineTimer = setTimeout(() => {
          deadlineExpired = true;
          if (active.activeTurnId) void this.codex.interruptTurn(threadId, active.activeTurnId).catch(() => undefined);
        }, Math.max(0, Date.parse(deadlineAt) - Date.now()));
      }
      const newMessages = this.transcript(agent, workflow, fresh);
      const prompt = `Room member turn request
Cycle: ${cycleId}
Phase: ${phase}
Trigger message: ${sourceMessageId}
Newest incoming text: ${incoming}

Current workflow request (authoritative scope):
${rootMessage?.content || incoming}

Treat older transcript entries as conversational background only. Do not import requirements, decisions, or acceptance criteria from an earlier request unless the current workflow request or a handoff in this workflow explicitly carries them forward.

Immutable room snapshot: ${workflow.roomSnapshot?.name || executionRoom.name}
Immutable peer snapshot: ${(workflow.peerSnapshots || []).map((peer) => `${peer.name}: ${peer.description || "No description"}`).join("; ") || "No peers"}
${originRoom ? `Visible origin group: ${originRoom.name} (${originRoom.id}). This direct peer request came from work coordinated in that group. Your normal final response is returned there automatically under ${agent.name}'s identity. Do not call oai_bot.post_to_group merely to duplicate that result.` : ""}

${fresh ? "Recent room transcript" : "New room messages since your last turn"}:
${newMessages || "No additional messages."}

This message was routed to ${agent.name}. Respond as ${agent.name}, using the profile and custom instructions above. Bot roles are arbitrary user-authored text, not a fixed vocabulary. Do not answer as a generic assistant or produce a synthetic team response.

Answer, act, disagree, ask, or stay quiet according to ${agent.name}'s own judgment. If another Bot should contribute to visible Channel work, address it with an exact @Name in the Channel. Reserve oai_bot.message_bot for genuinely private or off-channel context. Say what you actually want from that Bot. Do not impersonate it or write its expected answer. Handoffs are available, not mandatory.

In a Channel, do not paraphrase or mirror another Bot's answer. Apply ${agent.name}'s configured perspective and add concrete information, reasoning, or action that is distinct from what is already visible. If nothing distinct remains, use [[PASS]]. However, when the current workflow explicitly asks each Bot, every Bot, or all Bots to contribute and ${agent.name} has not yet visibly contributed, provide ${agent.name}'s distinct perspective instead of passing.

Keep the visible response conversational. Do not announce readiness, restate the role, describe routing, or pad the answer with project-management language. A greeting can get a normal human reply. Use [[PASS]] only when silence is genuinely more natural. An exact @Name in a visible Channel response wakes that Bot; a plain name does not.`;
      active.activeThreadId = threadId;
      let composingSeen = false;
      const result = await this.codex.runTurn({
        threadId, prompt, model: agent.model, effort: agent.effort, networkAccess: agent.networkAccess,
        privateWorkspacePath: agent.privateWorkspacePath,
        onDelta: (delta) => {
          if (active.cancelled) return;
          if (!composingSeen) {
            composingSeen = true;
            this.store.mutate((current) => {
              const target = current.agents.find((item) => item.id === agentId);
              if (target) target.isComposingMessage = true;
            });
          }
          streamedText += delta;
          const trimmedStream = streamedText.trimStart().toUpperCase();
          const controlPrefixes = ["[[PASS]]", "[[WAIT_FOR_USER]]", "[[REQUEST_TURN:"];
          if (controlPrefixes.some((marker) => marker.startsWith(trimmedStream) || trimmedStream.startsWith(marker))) return;
          const visibleText = streamedText
            .replace(/\s*\[\[(?:PASS|WAIT_FOR_USER|REQUEST_TURN:@[^\]]+)\]\]\s*$/gi, "")
            .trimEnd();
          if (!visibleText) return;
          if (!streamingMessageId) {
            const streaming = this.addMessage({ roomId: responseRoom.id, senderType: "agent", senderId: agent.id, fromAgentId: agent.id, toAgentIds: [], content: visibleText, kind: "message", status: "streaming", mentions: [], cycleId, reactions: {} });
            streamingMessageId = streaming.id;
          } else {
            this.store.mutate((current) => {
              const message = current.messages.find((item) => item.id === streamingMessageId);
              if (message) { message.content = visibleText; message.updatedAt = isoNow(); }
            });
            this.broadcast();
          }
        },
        onStarted: (turnId) => {
          active.activeTurnId = turnId;
          this.store.mutate((current) => {
            const workflow = current.memberTurns.find((item) => item.id === active.workflowId);
            if (workflow) { workflow.turnId = turnId; workflow.updatedAt = isoNow(); }
          });
          if (active.cancelled) void this.codex.interruptTurn(threadId, turnId).catch(() => undefined);
        }
      });
      active.activeThreadId = undefined;
      active.activeTurnId = undefined;
      if (deadlineExpired) throw new Error("Member turn deadline expired");
      if (active.cancelled) {
        if (streamingMessageId) {
          this.store.mutate((current) => { current.messages = current.messages.filter((message) => message.id !== streamingMessageId); });
          this.broadcast();
        }
        return { requestedAgentIds: [], awaitingUserResponse: false, passed: true };
      }
      const raw = result.text.trim();
      const awaitingUserResponse = /\[\[WAIT_FOR_USER\]\]/i.test(raw);
      const requestedNames = [...raw.matchAll(/\[\[REQUEST_TURN:@([^\]]+)\]\]/gi)].map((match) => match[1].trim().toLowerCase());
      const markerRequests = members.filter((member) => requestedNames.includes(member.name.toLowerCase()) && member.id !== agent.id).map((member) => member.id);
      const requestedAgentIds = [...new Set(markerRequests)];
      const text = raw.replace(/\s*\[\[(?:WAIT_FOR_USER|REQUEST_TURN:@[^\]]+)\]\]\s*/gi, "\n").trim();
      const latest = this.store.snapshot().messages.filter((message) => message.roomId === room.id).at(-1)?.id;
      if (awaitingUserResponse) this.store.mutate((current) => { const target = current.agents.find((item) => item.id === agent.id); if (target) target.awaitingUserResponse = true; });
      if (!text || /^\[\[PASS\]\][.!]?$/i.test(text)) {
        if (streamingMessageId) this.store.mutate((current) => { current.messages = current.messages.filter((message) => message.id !== streamingMessageId); });
        if (latest) this.setAgentCursor(agent.id, room.id, latest);
        return { requestedAgentIds, awaitingUserResponse, passed: true };
      }
      const conversationalMentions = extractMentionedAgentIds(text, members).filter((id) => id !== agent.id);
      if (responseRoom.kind === "group") {
        for (const mentionedId of conversationalMentions) {
          if (responseRoom.agentIds.includes(mentionedId) && !requestedAgentIds.includes(mentionedId)) requestedAgentIds.push(mentionedId);
        }
      }
      let response: ChatMessage;
      if (streamingMessageId) {
        this.store.mutate((current) => {
          const message = current.messages.find((item) => item.id === streamingMessageId)!;
          message.content = text;
          message.status = "complete";
          message.kind = requestedAgentIds.length ? "peer-message" : "message";
          message.toAgentIds = requestedAgentIds;
          message.mentions = conversationalMentions;
          message.turnId = result.turnId;
          message.updatedAt = isoNow();
        });
        this.commitMessageToRoomMembers(this.store.snapshot().messages.find((message) => message.id === streamingMessageId)!, responseRoom);
        if (!responseRoom.agentIds.includes(agent.id)) this.commitMessageToAgent(this.store.snapshot().messages.find((message) => message.id === streamingMessageId)!, agent.id);
        this.broadcast();
        response = this.store.snapshot().messages.find((message) => message.id === streamingMessageId)!;
      } else {
        response = this.addMessage({
          roomId: responseRoom.id, senderType: "agent", senderId: agent.id, fromAgentId: agent.id,
          toAgentIds: requestedAgentIds, content: text, kind: requestedAgentIds.length ? "peer-message" : "message",
          status: "complete", mentions: conversationalMentions, turnId: result.turnId, cycleId, reactions: {}
        });
        this.commitMessageToRoomMembers(response, responseRoom);
        if (!responseRoom.agentIds.includes(agent.id)) this.commitMessageToAgent(response, agent.id);
      }
      this.setAgentCursor(agent.id, room.id, response.id);
      return { requestedAgentIds, awaitingUserResponse, passed: false };
    } catch (error) {
      if (streamingMessageId) this.store.mutate((current) => { current.messages = current.messages.filter((message) => message.id !== streamingMessageId); });
      if (active.cancelled) return { requestedAgentIds: [], awaitingUserResponse: false, passed: true };
      const failure = this.addMessage({ roomId: room.id, senderType: "system", senderId: agent.id, content: String(error), kind: "error", status: "failed", mentions: [], cycleId });
      this.commitMessageToAgent(failure, agent.id);
      return { requestedAgentIds: [], awaitingUserResponse: false, passed: false, error: String(error) };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const activityTimer = this.activityClearTimers.get(agentId);
      if (activityTimer) { clearTimeout(activityTimer); this.activityClearTimers.delete(agentId); }
      this.store.mutate((current) => {
        const target = current.agents.find((item) => item.id === agentId);
        if (target) {
          target.status = target.awaitingUserResponse ? "waiting" : "idle";
          target.isComposingMessage = false;
          target.isRetrying = false;
          delete target.activity;
        }
      });
      this.broadcast();
    }
  }

  private setAgentCursor(agentId: string, roomId: string, messageId: string) {
    this.store.mutate((state) => { const agent = state.agents.find((item) => item.id === agentId); if (agent) agent.roomLastSeenMessageIds[roomId] = messageId; });
  }

  private onApproval(request: { approvalId: string; method: string; params: Record<string, unknown> }) {
    const context = this.threadContext.get(String(request.params.threadId || ""));
    const command = String(request.params.command || request.params.reason || "Codex requested permission");
    const approval: PendingApproval = {
      id: makeId(), rpcId: request.approvalId, method: request.method, threadId: String(request.params.threadId || ""),
      agentId: context?.agentId, roomId: context?.roomId,
      title: request.method.includes("fileChange") ? "Approve file changes" : "Approve command",
      detail: command, params: request.params, createdAt: isoNow()
    };
    this.store.mutate((state) => state.approvals.push(approval));
    if (context?.agentId) this.store.mutate((state) => { const agent = state.agents.find((item) => item.id === context.agentId); if (agent) { agent.status = "waiting"; agent.activity = { kind: "waiting", detail: approval.title, updatedAt: isoNow() }; } });
    if (context) {
      const message = this.addMessage({ roomId: context.roomId, senderType: "system", senderId: context.agentId, content: `${approval.title}: ${approval.detail}`, kind: "approval", status: "complete", mentions: [] });
      this.commitMessageToAgent(message, context.agentId);
    }
    this.broadcast();
  }

  private onNotification(method: string, params: Record<string, any>) {
    const context = this.threadContext.get(String(params.threadId || ""));
    if (!context) return;
    if (method === "item/started") {
      const item = params.item || {};
      const descriptor = describeCodexActivity(item);
      if (!descriptor) return;
      const existing = this.store.snapshot().agents.find((entry) => entry.id === context.agentId)?.activity;
      if (existing?.tool?.startsWith("oai_bot.")) return;
      this.startStableActivity(context.agentId, {
        kind: descriptor.tool === "form.wait" ? "waiting" : "tool",
        tool: descriptor.tool, detail: descriptor.detail, target: descriptor.target,
        callId: String(item.id || item.callId || params.callId || "")
      });
    } else if (["item/completed", "item/failed", "item/cancelled"].includes(method)) {
      const item = params.item || {};
      if (!describeCodexActivity(item)) return;
      this.settleStableActivity(context.agentId, String(item.id || item.callId || params.callId || ""));
    }
  }

  private startStableActivity(agentId: string, activity: { kind: "tool" | "waiting"; tool: string; detail: string; target?: string; callId: string }) {
    const existingTimer = this.activityClearTimers.get(agentId);
    if (existingTimer) clearTimeout(existingTimer);
    const timestamp = isoNow();
    this.store.mutate((state) => {
      const agent = state.agents.find((entry) => entry.id === agentId);
      if (!agent) return;
      agent.status = activity.kind === "waiting" ? "waiting" : "working";
      agent.activity = { ...activity, updatedAt: timestamp };
    });
    const timer = setTimeout(() => this.clearStableActivity(agentId, activity.callId), 2 * 60_000);
    this.activityClearTimers.set(agentId, timer);
    this.broadcast();
  }

  private settleStableActivity(agentId: string, callId: string, minimumVisibleMs = 800) {
    const activity = this.store.snapshot().agents.find((entry) => entry.id === agentId)?.activity;
    if (!activity || activity.callId !== callId) return;
    const existingTimer = this.activityClearTimers.get(agentId);
    if (existingTimer) clearTimeout(existingTimer);
    const remaining = Math.max(0, minimumVisibleMs - (Date.now() - Date.parse(activity.updatedAt)));
    const timer = setTimeout(() => this.clearStableActivity(agentId, callId), remaining);
    this.activityClearTimers.set(agentId, timer);
  }

  private clearStableActivity(agentId: string, callId: string) {
    this.store.mutate((state) => {
      const agent = state.agents.find((entry) => entry.id === agentId);
      if (agent?.activity?.callId === callId) {
        const activeTurn = state.memberTurns.some((turn) => turn.memberAgentId === agentId && turn.state === "running");
        if (activeTurn) {
          agent.status = "working";
          agent.activity = { kind: "thinking", detail: "Working", updatedAt: isoNow() };
        } else {
          delete agent.activity;
          if (agent.status === "working") agent.status = "idle";
        }
      }
    });
    this.activityClearTimers.delete(agentId);
    this.broadcast();
  }

  private onDynamicToolActivity(phase: "started" | "completed" | "failed", params: Record<string, any>) {
    const context = this.threadContext.get(String(params.threadId || ""));
    if (!context) return;
    const labels: Record<string, string> = {
      list_bots: "Checking Bots and groups",
      remember: "Saving a memory",
      forget_memory: "Forgetting a memory",
      message_bot: "Messaging another Bot",
      post_to_group: "Posting to a group",
      update_bots: "Updating Bot profiles",
      create_bot: "Creating a Bot",
      update_group: "Updating the group",
      create_group: "Creating a group"
    };
    const callId = String(params.callId || "");
    if (phase === "started") {
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const target = typeof args.target === "string" ? args.target : typeof args.group === "string" ? args.group : undefined;
      const base = labels[String(params.tool)] || "Updating OAI Bot";
      const detail = params.tool === "message_bot" && target ? `Messaging ${target}`
        : params.tool === "post_to_group" && target ? `Posting to ${target}`
        : params.tool === "update_bots" && target ? `Updating ${target}` : base;
      this.startStableActivity(context.agentId, { kind: "tool", tool: `oai_bot.${String(params.tool || "tool")}`, detail, target, callId });
    } else this.settleStableActivity(context.agentId, callId);
  }

  resolveApproval(id: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") {
    const approval = this.store.snapshot().approvals.find((item) => item.id === id);
    if (!approval) throw new Error("Approval not found");
    this.codex.respondToApproval(String(approval.rpcId), decision);
    this.store.mutate((state) => {
      state.approvals = state.approvals.filter((item) => item.id !== id);
      const agent = approval.agentId ? state.agents.find((item) => item.id === approval.agentId) : undefined;
      if (agent) { agent.status = "working"; agent.activity = { kind: "thinking", detail: "Resuming", updatedAt: isoNow() }; }
    });
    this.broadcast();
  }
}
