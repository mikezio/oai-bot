import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerRuntimeProvider, type CommandRunner } from "./runtime.js";

function fakeRunner(results: Array<{ code: number; stdout: string; stderr: string }>) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: CommandRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const result = results.shift();
    if (!result) throw new Error("Unexpected command");
    return result;
  };
  return { runner, calls };
}

test("reports a missing Docker runtime without starting it", async () => {
  const fake = fakeRunner([{ code: 1, stdout: "", stderr: "Error: No such object: oai-bot-computer" }]);
  const provider = new DockerRuntimeProvider({ projectRoot: "/project", runner: fake.runner });
  assert.deepEqual(await provider.status(), { provider: "docker", phase: "missing", containerName: "oai-bot-computer" });
  assert.deepEqual(fake.calls[0].args, ["inspect", "--format", "{{json .State}}", "oai-bot-computer"]);
});

test("describes the loopback-only Codex execution environment", () => {
  const provider = new DockerRuntimeProvider({ projectRoot: "/project", execServerUrl: "ws://127.0.0.1:4999", runner: fakeRunner([]).runner });
  assert.deepEqual(provider.executionEnvironment(), {
    environmentId: "oai-bot-shared-computer",
    execServerUrl: "ws://127.0.0.1:4999",
    cwd: "/workspace",
    runtimeWorkspaceRoots: ["/workspace", "/agent-workspaces", "/home/bot/agent-data", "/home/bot/sand-data"]
  });
});

test("starts through Compose and reports container health", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "oai-bot-runtime-test-"));
  const fake = fakeRunner([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: JSON.stringify({ Running: true, Status: "running", Health: { Status: "healthy" } }), stderr: "" }
  ]);
  try {
    const provider = new DockerRuntimeProvider({ projectRoot, runner: fake.runner });
    assert.deepEqual(await provider.start(), { provider: "docker", phase: "running", containerName: "oai-bot-computer", health: "healthy" });
    assert.deepEqual(fake.calls[0].args, ["compose", "-f", join(projectRoot, "runtime/docker-compose.yml"), "up", "-d", "--build"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("executes argument arrays without a host shell", async () => {
  const fake = fakeRunner([{ code: 0, stdout: "ok\n", stderr: "" }]);
  const provider = new DockerRuntimeProvider({ projectRoot: "/project", runner: fake.runner });
  assert.deepEqual(await provider.exec({ argv: ["printf", "%s", "hello; rm -rf /"], cwd: "/workspace/demo" }), { code: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(fake.calls[0].args, ["exec", "--workdir", "/workspace/demo", "oai-bot-computer", "printf", "%s", "hello; rm -rf /"]);
});

test("rejects execution outside persistent runtime roots", async () => {
  const fake = fakeRunner([]);
  const provider = new DockerRuntimeProvider({ projectRoot: "/project", runner: fake.runner });
  await assert.rejects(provider.exec({ argv: ["pwd"], cwd: "/etc" }), /persistent runtime root/);
  assert.equal(fake.calls.length, 0);
});

test("allows bounded commands inside persistent VM-home agent data", async () => {
  const fake = fakeRunner([{ code: 0, stdout: "profile.json\n", stderr: "" }]);
  const provider = new DockerRuntimeProvider({ projectRoot: "/project", runner: fake.runner });
  assert.equal((await provider.exec({ argv: ["ls"], cwd: "/home/bot/agent-data/agents" })).stdout, "profile.json\n");
  assert.deepEqual(fake.calls[0].args, ["exec", "--workdir", "/home/bot/agent-data/agents", "oai-bot-computer", "ls"]);
});
