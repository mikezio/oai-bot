import assert from "node:assert/strict";
import test from "node:test";
import { SendJournal, type StorageLike } from "./sendJournal";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("journals before dispatch and restores an interrupted dispatch as queued", () => {
  const storage = new MemoryStorage();
  const first = new SendJournal({ storage, now: () => 100 });
  first.prepare({ clientNonce: "nonce-1", payload: { prompt: "hello", agentId: "room-1" }, draft: "hello" });
  first.queue("nonce-1");
  first.beginDispatch("nonce-1");

  const restored = new SendJournal({ storage, now: () => 200 });
  assert.equal(restored.restorePending()[0]?.phase, "queued");
  assert.equal(restored.get("nonce-1")?.attempts, 1);
});

test("keeps the nonce stable and rejects a conflicting payload", () => {
  const journal = new SendJournal({ storage: new MemoryStorage() });
  const first = journal.prepare({ clientNonce: "stable", payload: { prompt: "one" } });
  const duplicate = journal.prepare({ clientNonce: "stable", payload: { prompt: "one" } });
  assert.equal(first.clientNonce, duplicate.clientNonce);
  assert.throws(() => journal.prepare({ clientNonce: "stable", payload: { prompt: "two" } }));
});

test("acceptance waits for a transcript echo before removing the send", () => {
  const journal = new SendJournal({ storage: new MemoryStorage(), now: () => 500 });
  journal.prepare({ clientNonce: "echo-me", payload: { prompt: "hello" } });
  journal.queue("echo-me");
  journal.beginDispatch("echo-me");
  journal.markAccepted("echo-me");
  assert.equal(journal.get("echo-me")?.phase, "accepted-awaiting-echo");
  assert.deepEqual(journal.reconcileTranscript([{ clientNonce: "other" }, { clientNonce: "echo-me" }]), ["echo-me"]);
  assert.equal(journal.get("echo-me"), undefined);
});

test("validates transitions and allows an explicit retry after failure", () => {
  const journal = new SendJournal({ storage: new MemoryStorage() });
  journal.prepare({ clientNonce: "retry", payload: { prompt: "hello" } });
  assert.throws(() => journal.beginDispatch("retry"), /Invalid send transition/);
  journal.markFailed("retry", new Error("offline"));
  journal.queue("retry");
  journal.beginDispatch("retry");
  assert.equal(journal.get("retry")?.attempts, 1);
});

test("retention is bounded and prefers evicting terminal entries", () => {
  let time = 0;
  const journal = new SendJournal({ storage: new MemoryStorage(), maxEntries: 2, now: () => ++time });
  journal.prepare({ clientNonce: "failed", payload: { prompt: "old" } });
  journal.markFailed("failed", "nope");
  journal.prepare({ clientNonce: "active", payload: { prompt: "keep" } });
  journal.prepare({ clientNonce: "new", payload: { prompt: "new" } });
  assert.equal(journal.get("failed"), undefined);
  assert.deepEqual(journal.list().map((entry) => entry.clientNonce), ["active", "new"]);
});
