import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCodexExecutable } from "./codexExecutable.js";

test("uses an explicit CODEX_BIN", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oai-bot-codex-"));
  const executable = path.join(directory, "custom-codex");
  await writeFile(executable, "test");
  try {
    assert.equal(await resolveCodexExecutable({ CODEX_BIN: executable, PATH: "" }, "linux"), executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("finds codex on PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oai-bot-codex-"));
  const executable = path.join(directory, "codex");
  await writeFile(executable, "test");
  try {
    assert.equal(await resolveCodexExecutable({ PATH: directory }, "linux"), executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explains how to recover when Codex is missing", async () => {
  await assert.rejects(
    resolveCodexExecutable({ PATH: "" }, "linux"),
    /Install the Codex CLI.*sign in with ChatGPT.*CODEX_BIN/
  );
});
