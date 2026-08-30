import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { AccountState } from "./types.js";
import { resolveCodexExecutable } from "./codexExecutable.js";

type JsonObject = Record<string, any>;

export interface CodexActivityDescriptor {
  tool: string;
  detail: string;
  target?: string;
}

function objectArguments(item: JsonObject) {
  const value = item.arguments ?? item.args ?? item.input;
  if (value && typeof value === "object") return value as JsonObject;
  if (typeof value === "string") {
    try { return JSON.parse(value) as JsonObject; } catch { return {}; }
  }
  return {};
}

/** Convert version-specific app-server item shapes into stable user-facing activity. */
export function describeCodexActivity(item: JsonObject): CodexActivityDescriptor | undefined {
  const args = objectArguments(item);
  const raw = [item.type, item.name, item.tool, item.method, item.server, item.namespace].filter(Boolean).join(" ");
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const targetValue = item.target ?? args.target ?? args.agent ?? args.agentName ?? args.agent_name ?? args.name;
  const target = typeof targetValue === "string" && targetValue.trim() ? targetValue.trim().slice(0, 80) : undefined;

  if (!key || /\b(reasoning|agent message|user message|plan)\b/.test(key)) return undefined;
  if (/send\s*to\s*agent|message\s*bot|agent\s*message/.test(key)) return { tool: "agent.send", detail: target ? `Messaging ${target}` : "Messaging another Bot", target };
  if (/update\s*agent|update\s*bots?/.test(key)) return { tool: "agent.update", detail: target ? `Updating ${target}` : "Updating a Bot", target };
  if (/web\s*(search|query)|search\s*web/.test(key)) return { tool: "web.search", detail: "Searching the web", target };
  if (/web\s*(read|fetch|open|browse)|url\s*(read|fetch)|http\s*(get|fetch)/.test(key)) return { tool: "web.read", detail: "Reading from the web", target };
  if (/file\s*(read|open)|read\s*file/.test(key)) return { tool: "file.read", detail: "Reading files", target };
  if (/command|shell|terminal|exec/.test(key)) return { tool: "shell.command", detail: "Running a command", target };
  if (/file\s*(change|edit|write|patch)|apply\s*patch|draft/.test(key)) return { tool: "file.edit", detail: /draft/.test(key) ? "Drafting changes" : "Editing files", target };
  if (/image\s*(generation|generate|create)|imagegen/.test(key)) return { tool: "image.generate", detail: "Creating an image", target };
  if (/(sub)?agent\s*(wait|join)|wait\s*(agent|thread)/.test(key)) return { tool: "subagent.wait", detail: "Waiting for another Bot", target };
  if (/computer\s*(use|control)|desktop\s*(use|control)|browser\s*control/.test(key)) return { tool: "computer.use", detail: "Using the computer", target };
  if (/form|request\s*(input|user)|ask\s*user|wait\s*(user|input)/.test(key)) return { tool: "form.wait", detail: "Waiting for input", target };
  if (/mcp\s*tool\s*call/.test(key)) return { tool: `mcp.${String(item.tool || item.name || "tool")}`, detail: "Using a connected tool", target };
  return { tool: String(item.type || item.tool || item.name || "tool"), detail: raw.replace(/ToolCall$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (value) => value.toUpperCase()), target };
}

export class CodexClient extends EventEmitter {
  readonly supportsSilentGroupRouting = true;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private approvalRequests = new Map<string, string | number>();
  private activeThreads = new Set<string>();
  private inFlightTurns = new Map<string, { reject: (error: Error) => void; cleanup: () => void }>();
  private ready?: Promise<void>;
  private dynamicToolHandler?: (request: { threadId: string; turnId: string; callId: string; namespace: string | null; tool: string; arguments: any }) => Promise<any>;

  constructor(private readonly workspace: string) {
    super();
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.launch().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async launch() {
    const executable = await resolveCodexExecutable();
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: this.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.child = child;
    child.stderr.on("data", (data) => this.emit("log", String(data)));
    child.on("exit", (code, signal) => {
      const error = new Error(`Codex App Server stopped (${code ?? signal ?? "unknown"})`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      for (const turn of this.inFlightTurns.values()) { turn.cleanup(); turn.reject(error); }
      this.inFlightTurns.clear();
      this.activeThreads.clear();
      this.approvalRequests.clear();
      if (this.child === child) this.child = undefined;
      this.ready = undefined;
      this.emit("offline", error);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.handle(JSON.parse(line));
      } catch (error) {
        this.emit("log", `Could not parse App Server output: ${String(error)}`);
      }
    });
    await this.request("initialize", {
      clientInfo: { name: "oai-bot", title: "OAI Bot", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  private handle(message: JsonObject) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const id = Number(message.id);
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else request.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      if (message.method === "item/tool/call") {
        const params = message.params || {};
        this.emit("dynamicTool", "started", params);
        void Promise.resolve(this.dynamicToolHandler?.(params))
          .then((result) => {
            this.send({ id: message.id, result: { contentItems: [{ type: "inputText", text: JSON.stringify(result ?? { ok: true }) }], success: true } });
            this.emit("dynamicTool", "completed", params);
          })
          .catch((error) => {
            this.send({ id: message.id, result: { contentItems: [{ type: "inputText", text: String(error instanceof Error ? error.message : error) }], success: false } });
            this.emit("dynamicTool", "failed", { ...params, error: String(error) });
          });
        return;
      }
      const approvalId = String(message.id);
      this.approvalRequests.set(approvalId, message.id);
      this.emit("approval", { approvalId, method: message.method, params: message.params || {} });
      return;
    }
    if (message.method) this.emit("notification", message.method, message.params || {});
  }

  setDynamicToolHandler(handler: (request: { threadId: string; turnId: string; callId: string; namespace: string | null; tool: string; arguments: any }) => Promise<any>) {
    this.dynamicToolHandler = handler;
  }

  private send(payload: JsonObject) {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server is not running");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method: string, params: JsonObject = {}) {
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: JsonObject = {}) {
    this.send({ method, params });
  }

  respondToApproval(approvalId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") {
    const rpcId = this.approvalRequests.get(approvalId);
    if (rpcId === undefined) throw new Error("Approval is no longer pending");
    this.approvalRequests.delete(approvalId);
    this.send({ id: rpcId, result: { decision } });
  }

  async account(): Promise<AccountState> {
    try {
      await this.start();
      const result = await this.request("account/read", { refreshToken: false });
      const account = result.account;
      const state: AccountState = {
        connected: Boolean(account),
        authMode: account?.type ?? "none",
        runtimeAvailable: true,
        email: account?.email ?? undefined,
        planType: account?.planType ?? undefined,
        requiresOpenaiAuth: result.requiresOpenaiAuth
      };
      try {
        const usage = await this.request("account/rateLimits/read", {});
        const window = usage.rateLimits?.primary;
        state.primaryUsedPercent = window?.usedPercent;
        state.primaryWindowMinutes = window?.windowDurationMins;
        state.primaryResetsAt = window?.resetsAt;
      } catch {
        // Rate-limit details are optional and vary by Codex build.
      }
      return state;
    } catch (error) {
      return { connected: false, authMode: "unknown", runtimeAvailable: Boolean(this.child), error: error instanceof Error ? error.message : String(error) };
    }
  }

  async startLogin() {
    await this.start();
    return this.request("account/login/start", {
      type: "chatgpt",
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
      appBrand: "codex"
    });
  }

  async startThread(options: {
    name: string;
    model: string;
    effort: string;
    instructions: string;
    privateWorkspacePath?: string;
    dynamicTools?: JsonObject[];
  }) {
    await this.start();
    const result = await this.request("thread/start", {
      model: options.model,
      cwd: this.workspace,
      runtimeWorkspaceRoots: this.workspaceRoots(options.privateWorkspacePath),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      baseInstructions: options.instructions,
      developerInstructions: null,
      modelProvider: null,
      serviceTier: null,
      personality: null,
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: true
      ,dynamicTools: options.dynamicTools || []
    });
    const threadId = result.thread.id as string;
    this.activeThreads.add(threadId);
    return threadId;
  }

  async resumeThread(threadId: string, options: { model: string; instructions: string; privateWorkspacePath?: string; dynamicTools?: JsonObject[] }) {
    if (this.activeThreads.has(threadId)) return;
    await this.start();
    await this.request("thread/resume", {
      threadId,
      model: options.model,
      cwd: this.workspace,
      runtimeWorkspaceRoots: this.workspaceRoots(options.privateWorkspacePath),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      baseInstructions: options.instructions,
      personality: null,
      excludeTurns: true
      ,dynamicTools: options.dynamicTools || []
    });
    this.activeThreads.add(threadId);
  }

  async runTurn(options: {
    threadId: string;
    prompt: string;
    model: string;
    effort: string;
    networkAccess?: boolean;
    privateWorkspacePath?: string;
    onDelta?: (delta: string) => void;
    onStarted?: (turnId: string) => void;
  }) {
    await this.start();
    const started = await this.request("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      cwd: this.workspace,
      runtimeWorkspaceRoots: this.workspaceRoots(options.privateWorkspacePath),
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: this.workspaceRoots(options.privateWorkspacePath), networkAccess: options.networkAccess === true },
      model: options.model,
      effort: options.effort,
      serviceTier: null,
      personality: null,
      collaborationMode: null,
      outputSchema: null
    });
    const turnId = started.turn.id as string;
    options.onStarted?.(turnId);
    return new Promise<{ text: string; turnId: string }>((resolve, reject) => {
      let streamed = "";
      const key = `${options.threadId}:${turnId}`;
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("notification", listener);
        this.inFlightTurns.delete(key);
      };
      const listener = (method: string, params: JsonObject) => {
        if (params.threadId !== options.threadId) return;
        if (method === "item/agentMessage/delta" && params.turnId === turnId) {
          streamed += params.delta || "";
          options.onDelta?.(params.delta || "");
        }
        if (method === "turn/completed" && params.turn?.id === turnId) {
          cleanup();
          const finalMessages = (params.turn.items || []).filter((item: JsonObject) => item.type === "agentMessage");
          const text = finalMessages.at(-1)?.text || streamed;
          if (params.turn.status === "failed") reject(new Error(params.turn.error?.message || "Codex turn failed"));
          else resolve({ text, turnId });
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        void this.interruptTurn(options.threadId, turnId).catch(() => undefined);
        reject(new Error("Codex turn exceeded the 5 minute deadline"));
      }, 5 * 60_000);
      this.on("notification", listener);
      this.inFlightTurns.set(key, { reject, cleanup });
    });
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.start();
    return this.request("turn/interrupt", { threadId, turnId });
  }

  private workspaceRoots(privateWorkspacePath?: string) {
    if (!privateWorkspacePath) return [this.workspace];
    return [this.workspace, path.resolve(path.dirname(this.workspace), privateWorkspacePath)];
  }
}
