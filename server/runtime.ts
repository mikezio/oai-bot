import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type RuntimePhase = "missing" | "created" | "running" | "paused" | "stopped" | "unhealthy";

export interface RuntimeStatus {
  provider: string;
  phase: RuntimePhase;
  containerName: string;
  health?: string;
}

export interface RuntimeExecRequest {
  argv: string[];
  cwd?: string;
}

export interface RuntimeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeExecutionEnvironment {
  environmentId: string;
  execServerUrl: string;
  cwd: string;
  runtimeWorkspaceRoots: string[];
}

export interface RuntimeProvider {
  readonly kind: string;
  status(): Promise<RuntimeStatus>;
  start(): Promise<RuntimeStatus>;
  exec(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
  doctor(): Promise<RuntimeExecResult>;
  executionEnvironment(): RuntimeExecutionEnvironment;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let terminated = false;
  const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > 1_048_576) {
      if (!terminated) {
        terminated = true;
        stderr += "\nOAI Bot stopped the runtime command after 1 MiB of output.\n";
        child.kill("SIGTERM");
      }
      return;
    }
    if (target === "stdout") stdout += String(chunk);
    else stderr += String(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  const timeout = setTimeout(() => {
    terminated = true;
    stderr += "\nOAI Bot stopped the runtime command after 5 minutes.\n";
    child.kill("SIGTERM");
  }, 5 * 60_000);
  child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  child.once("close", (code) => { clearTimeout(timeout); resolve({ code: code ?? 1, stdout, stderr }); });
});

export interface DockerRuntimeOptions {
  projectRoot: string;
  dockerBin?: string;
  containerName?: string;
  composeFile?: string;
  execServerUrl?: string;
  runner?: CommandRunner;
}

const allowedRuntimeRoots = ["/workspace", "/home/bot/.local/share", "/home/bot/agent-data", "/home/bot/sand-data"];

function assertContainerName(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error("Invalid runtime container name");
}

function assertExecRequest(request: RuntimeExecRequest) {
  if (!request.argv.length) throw new Error("Runtime command cannot be empty");
  if (request.argv.some((argument) => typeof argument !== "string" || argument.includes("\0"))) throw new Error("Runtime command contains an invalid argument");
  const cwd = path.posix.normalize(request.cwd || "/workspace");
  if (!allowedRuntimeRoots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) throw new Error("Runtime working directory must stay inside a persistent runtime root");
  return cwd;
}

function phaseFromInspect(state: Record<string, unknown>): RuntimePhase {
  if (state.Paused === true) return "paused";
  if (state.Running === true) {
    const health = (state.Health as { Status?: string } | undefined)?.Status;
    return health === "unhealthy" ? "unhealthy" : "running";
  }
  return state.Status === "created" ? "created" : "stopped";
}

export class DockerRuntimeProvider implements RuntimeProvider {
  readonly kind = "docker";
  private readonly projectRoot: string;
  private readonly dockerBin: string;
  private readonly containerName: string;
  private readonly composeFile: string;
  private readonly execServerUrl: string;
  private readonly runner: CommandRunner;

  constructor(options: DockerRuntimeOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.dockerBin = options.dockerBin || "docker";
    this.containerName = options.containerName || "oai-bot-computer";
    this.composeFile = path.resolve(this.projectRoot, options.composeFile || "runtime/docker-compose.yml");
    this.execServerUrl = options.execServerUrl || `ws://127.0.0.1:${process.env.OAI_RUNTIME_EXEC_PORT || "4096"}`;
    this.runner = options.runner || runCommand;
    assertContainerName(this.containerName);
  }

  async status(): Promise<RuntimeStatus> {
    const result = await this.runner(this.dockerBin, ["inspect", "--format", "{{json .State}}", this.containerName], this.projectRoot);
    if (result.code !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) return { provider: this.kind, phase: "missing", containerName: this.containerName };
      throw new Error(`Could not inspect shared computer: ${result.stderr.trim() || `docker exited ${result.code}`}`);
    }
    let state: Record<string, unknown>;
    try { state = JSON.parse(result.stdout.trim()) as Record<string, unknown>; }
    catch { throw new Error("Docker returned an invalid shared-computer state"); }
    return {
      provider: this.kind,
      phase: phaseFromInspect(state),
      containerName: this.containerName,
      health: (state.Health as { Status?: string } | undefined)?.Status
    };
  }

  async start() {
    await Promise.all([
      mkdir(path.join(this.projectRoot, "shared-workspace"), { recursive: true }),
      mkdir(path.join(this.projectRoot, "runtime-state"), { recursive: true }),
      mkdir(path.join(this.projectRoot, "agent-data"), { recursive: true })
    ]);
    const result = await this.runner(this.dockerBin, ["compose", "-f", this.composeFile, "up", "-d", "--build"], this.projectRoot);
    if (result.code !== 0) throw new Error(`Could not start shared computer: ${result.stderr.trim() || `docker exited ${result.code}`}`);
    return this.status();
  }

  async exec(request: RuntimeExecRequest): Promise<RuntimeExecResult> {
    const cwd = assertExecRequest(request);
    const result = await this.runner(this.dockerBin, ["exec", "--workdir", cwd, this.containerName, ...request.argv], this.projectRoot);
    return result;
  }

  doctor() {
    return this.exec({ argv: ["/usr/local/bin/oai-runtime-doctor"], cwd: "/workspace" });
  }

  executionEnvironment(): RuntimeExecutionEnvironment {
    return {
      environmentId: "oai-bot-shared-computer",
      execServerUrl: this.execServerUrl,
      cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace", "/agent-workspaces", "/home/bot/agent-data", "/home/bot/sand-data"]
    };
  }
}
