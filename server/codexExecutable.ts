import { access } from "node:fs/promises";
import path from "node:path";

export const MACOS_BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

async function exists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
) {
  const configured = environment.CODEX_BIN?.trim();
  if (configured) {
    if (await exists(configured)) return configured;
    throw new Error(`CODEX_BIN points to a file that does not exist: ${configured}`);
  }

  if (platform === "darwin" && await exists(MACOS_BUNDLED_CODEX)) return MACOS_BUNDLED_CODEX;

  const pathSeparator = platform === "win32" ? ";" : ":";
  const directories = (environment.PATH || "").split(pathSeparator).filter(Boolean);
  const executableNames = platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
    : ["codex"];

  for (const directory of directories) {
    for (const name of executableNames) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) return candidate;
    }
  }

  throw new Error("Codex was not found. Install the Codex CLI, run `codex` once to sign in with ChatGPT, or set CODEX_BIN to the executable path.");
}
