import { spawnSync } from "node:child_process";
import { resolveCodexExecutable } from "../server/codexExecutable.js";

console.log(`Node: ${process.version} (${process.platform}/${process.arch})`);

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error("Node.js 20 or newer is required.");
  process.exitCode = 1;
} else {
  console.log("Node version: OK");
}

try {
  const executable = await resolveCodexExecutable();
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)
  });
  if (result.error) throw result.error;
  console.log(`Codex: ${executable}`);
  console.log(`Codex version: ${(result.stdout || result.stderr || "available").trim()}`);
  console.log("Open OAI Bot after starting it. If Codex is not signed in, the app will offer Sign in with ChatGPT.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Install instructions: https://learn.chatgpt.com/docs/codex/cli");
  process.exitCode = 1;
}
