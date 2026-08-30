export type SendPhase =
  | "prepared"
  | "queued"
  | "dispatching"
  | "accepted-awaiting-echo"
  | "failed";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type SendPayload = Record<string, JsonValue | undefined>;

export interface SendAttachmentMetadata {
  id: string;
  name: string;
  size?: number;
  mimeType?: string;
  path?: string;
}

export interface SendJournalEntry {
  version: 1;
  clientNonce: string;
  phase: SendPhase;
  payload: SendPayload;
  draft: string;
  attachments: SendAttachmentMetadata[];
  createdAtMs: number;
  updatedAtMs: number;
  attempts: number;
  acceptedAtMs?: number;
  lastError?: string;
}

export interface PrepareSendInput {
  clientNonce?: string;
  payload: SendPayload;
  draft?: string;
  attachments?: SendAttachmentMetadata[];
}

export interface TranscriptNonceItem {
  clientNonce?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredJournal {
  version: 1;
  entries: SendJournalEntry[];
}

export interface SendJournalOptions {
  storage?: StorageLike | null;
  storageKey?: string;
  maxEntries?: number;
  retentionMs?: number;
  now?: () => number;
}

const DEFAULT_STORAGE_KEY = "gpt-bot.send-journal.v1";
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const transitions: Record<SendPhase, ReadonlySet<SendPhase>> = {
  prepared: new Set(["queued", "failed"]),
  queued: new Set(["dispatching", "failed"]),
  dispatching: new Set(["queued", "accepted-awaiting-echo", "failed"]),
  "accepted-awaiting-echo": new Set(["failed"]),
  failed: new Set(["queued"]),
};

export function isValidSendTransition(from: SendPhase, to: SendPhase) {
  return from === to || transitions[from].has(to);
}

export function createClientNonce() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const random = () => Math.floor(Math.random() * 0x1_0000).toString(16).padStart(4, "0");
  return `${Date.now().toString(36)}-${random()}-${random()}-${random()}-${random()}${random()}${random()}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isPhase(value: unknown): value is SendPhase {
  return value === "prepared" || value === "queued" || value === "dispatching" || value === "accepted-awaiting-echo" || value === "failed";
}

function sanitizeEntry(value: unknown): SendJournalEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<SendJournalEntry>;
  if (
    entry.version !== 1 ||
    typeof entry.clientNonce !== "string" ||
    !entry.clientNonce ||
    !isPhase(entry.phase) ||
    !entry.payload ||
    typeof entry.payload !== "object" ||
    Array.isArray(entry.payload) ||
    typeof entry.draft !== "string" ||
    !Array.isArray(entry.attachments) ||
    typeof entry.createdAtMs !== "number" ||
    typeof entry.updatedAtMs !== "number" ||
    typeof entry.attempts !== "number"
  ) return null;
  return entry as SendJournalEntry;
}

function cloneEntry(entry: SendJournalEntry): SendJournalEntry {
  return JSON.parse(JSON.stringify(entry)) as SendJournalEntry;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Durable, synchronous journal for the browser's send path. A caller records a
 * message before clearing the composer, then advances it as the network request
 * progresses. Server transcript echoes remove matching entries by clientNonce.
 */
export class SendJournal {
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private entries = new Map<string, SendJournalEntry>();
  private persistenceError?: Error;

  constructor(options: SendJournalOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.retentionMs = Math.max(60_000, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.now = options.now ?? Date.now;
    this.load();
  }

  prepare(input: PrepareSendInput): SendJournalEntry {
    const clientNonce = input.clientNonce || createClientNonce();
    const existing = this.entries.get(clientNonce);
    if (existing) {
      if (canonicalJson(existing.payload) !== canonicalJson({ ...input.payload, clientNonce })) {
        throw new Error(`Send nonce ${clientNonce} is already journaled with a different payload`);
      }
      return cloneEntry(existing);
    }
    const timestamp = this.now();
    const entry: SendJournalEntry = {
      version: 1,
      clientNonce,
      phase: "prepared",
      payload: { ...input.payload, clientNonce },
      draft: input.draft ?? "",
      attachments: (input.attachments ?? []).map((attachment) => ({ ...attachment })),
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      attempts: 0,
    };
    this.entries.set(clientNonce, entry);
    this.persist();
    return cloneEntry(entry);
  }

  queue(clientNonce: string) {
    return this.transition(clientNonce, "queued", { lastError: undefined });
  }

  beginDispatch(clientNonce: string) {
    const current = this.require(clientNonce);
    return this.transition(clientNonce, "dispatching", { attempts: current.attempts + 1, lastError: undefined });
  }

  markAccepted(clientNonce: string, acceptedAtMs = this.now()) {
    return this.transition(clientNonce, "accepted-awaiting-echo", { acceptedAtMs, lastError: undefined });
  }

  markFailed(clientNonce: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "Send failed");
    return this.transition(clientNonce, "failed", { lastError: message });
  }

  get(clientNonce: string) {
    const entry = this.entries.get(clientNonce);
    return entry ? cloneEntry(entry) : undefined;
  }

  list() {
    return [...this.entries.values()]
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map(cloneEntry);
  }

  /** Lets the composer keep the draft visible if browser storage rejects writes. */
  persistenceStatus() {
    return { durable: Boolean(this.storage) && !this.persistenceError, error: this.persistenceError?.message };
  }

  /** Entries safe to resume after reload. A crashed dispatch is re-queued. */
  restorePending() {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.phase === "dispatching") {
        entry.phase = "queued";
        entry.updatedAtMs = this.now();
        changed = true;
      }
    }
    if (changed) this.persist();
    return this.list();
  }

  /** Removes sends already represented in the authoritative transcript. */
  reconcileTranscript(items: readonly TranscriptNonceItem[]) {
    const echoed = new Set(items.map((item) => item.clientNonce).filter((nonce): nonce is string => Boolean(nonce)));
    const reconciled: string[] = [];
    for (const nonce of echoed) {
      if (!this.entries.has(nonce)) continue;
      this.entries.delete(nonce);
      reconciled.push(nonce);
    }
    if (reconciled.length) this.persist();
    return reconciled;
  }

  discard(clientNonce: string) {
    const removed = this.entries.delete(clientNonce);
    if (removed) this.persist();
    return removed;
  }

  clear() {
    this.entries.clear();
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      // Storage can become unavailable at runtime; the in-memory journal remains usable.
    }
  }

  private transition(clientNonce: string, phase: SendPhase, patch: Partial<SendJournalEntry>) {
    const entry = this.require(clientNonce);
    if (!isValidSendTransition(entry.phase, phase)) {
      throw new Error(`Invalid send transition: ${entry.phase} -> ${phase}`);
    }
    Object.assign(entry, patch, { phase, updatedAtMs: this.now() });
    this.persist();
    return cloneEntry(entry);
  }

  private require(clientNonce: string) {
    const entry = this.entries.get(clientNonce);
    if (!entry) throw new Error(`Unknown send nonce: ${clientNonce}`);
    return entry;
  }

  private load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as Partial<StoredJournal>;
      if (stored.version !== 1 || !Array.isArray(stored.entries)) return;
      for (const value of stored.entries) {
        const entry = sanitizeEntry(value);
        if (entry) this.entries.set(entry.clientNonce, entry);
      }
      this.prune();
    } catch {
      // Corrupt or inaccessible browser state should never prevent composing.
      this.entries.clear();
    }
  }

  private prune() {
    const expiry = this.now() - this.retentionMs;
    for (const [nonce, entry] of this.entries) {
      if (entry.updatedAtMs < expiry && (entry.phase === "failed" || entry.phase === "accepted-awaiting-echo")) {
        this.entries.delete(nonce);
      }
    }
    const overflow = this.entries.size - this.maxEntries;
    if (overflow <= 0) return;
    const evictionOrder = [...this.entries.values()].sort((left, right) => {
      const leftTerminal = left.phase === "failed" || left.phase === "accepted-awaiting-echo" ? 0 : 1;
      const rightTerminal = right.phase === "failed" || right.phase === "accepted-awaiting-echo" ? 0 : 1;
      return leftTerminal - rightTerminal || left.updatedAtMs - right.updatedAtMs;
    });
    evictionOrder.slice(0, overflow).forEach((entry) => this.entries.delete(entry.clientNonce));
  }

  private persist() {
    this.prune();
    if (!this.storage) return;
    const state: StoredJournal = { version: 1, entries: [...this.entries.values()] };
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(state));
      this.persistenceError = undefined;
    } catch (error) {
      // The current page still retains the journal if localStorage rejects a write.
      this.persistenceError = error instanceof Error ? error : new Error(String(error));
    }
  }
}

export const sendJournal = new SendJournal();
