# Shared computer runtime

OAI Bot gives its Bots one shared computer while keeping each Bot's identity,
conversation, memory, and audit history independent. The computer is a durable
collaboration surface, not the owner of Bot identity.

## Runtime model

The first provider is one Docker container per OAI Bot installation. It offers:

- a Debian 13 userspace running as an unprivileged `bot` user;
- a persistent `/workspace` shared by every Bot;
- a persistent `/home/bot/.local/share` for user-installed application state;
- Node.js, Python, Git, Bash, Chromium, and common command-line tools;
- an Xvfb desktop with a window manager, VNC, and browser-delivered noVNC;
- an official Codex WebSocket exec-server used by every Bot's native shell;
- explicit lifecycle and health operations owned by the OAI Bot host process.

This deliberately is not one container per Bot. Private Bot state remains in
OAI Bot's own stores and private workspace boundary. The shared computer holds
only files and application state that participants intentionally share.

## Persistence and recovery

The container is replaceable. Explicit host directories back the two durable
paths, so the existing OAI Bot workspace UI and the container see the same
files, and rebuilding or updating the image does not erase shared files or
application state. Production can point those paths at `/srv/data`; portable
development defaults keep them beside the checkout. System packages installed
into the container layer are replaceable and must be restored by a project
bootstrap script when needed.

For bind mounts, set `OAI_RUNTIME_UID` and `OAI_RUNTIME_GID` to the numeric IDs
of the host service account (`id -u` and `id -g`) before building. The image's
unprivileged `bot` user will then share file ownership with the host process.

An update means rebuilding/recreating the container while retaining volumes. A
reset is a separate, explicitly destructive operation that must never be folded
into update. Reset is intentionally outside the first provider slice.

## Provider boundary

`RuntimeProvider` is the host-side contract. Callers pass argument arrays, not
shell command strings. Its initial operations are:

- inspect runtime status;
- explicitly build/start the runtime;
- execute an argument vector inside an allowed persistent working directory;
- run the runtime health check.

Status inspection and explicit command execution never start the provider as a
side effect. When `OAI_RUNTIME_PROVIDER=docker` is selected, application startup
is atomic: OAI Bot builds/starts the computer, registers its loopback-only Codex
exec-server through `environment/add`, and only then accepts agent work. All
thread and turn requests select that environment with `/workspace` as their
runtime working directory. If startup or registration fails, OAI Bot fails
closed instead of silently running Bot commands on the host.

The App Server's remote-environment policy requires `danger-full-access` and
`never` approval settings at the Codex layer. Those settings apply only after a
remote environment is registered. The external computer remains the actual
sandbox boundary: non-root user, read-only root filesystem, dropped Linux
capabilities, `no-new-privileges`, bounded mounts, and resource limits.

## Desktop contract

The image starts display `:1` at 1280×800, a D-Bus session, Xfwm, Picom, x11vnc,
and websockify/noVNC. The noVNC port binds to loopback by default in Compose;
remote access belongs behind OAI Bot's authenticated/private-network surface.
Chromium is installed but is not opened automatically.

On hosts that block Chromium's nested user-namespace sandbox, the supplied
launcher uses Chromium's `--no-sandbox` mode. That exception is contained by
the runtime boundary: the browser runs as the non-root `bot` user inside a
capability-free, `no-new-privileges`, read-only container with tmpfs-backed
ephemeral paths. Callers must use `oai-runtime-browser`, not raw `chromium`.

The runtime doctor verifies machine identity, browser and Codex binaries, the
exec-server socket, system clock, D-Bus, X11, the persistent directories, and
optional DNS/egress. Egress checks are opt-in so offline development remains
diagnosable.

## Security boundaries

- Run as a non-root user and do not use privileged containers.
- Drop Linux capabilities and enable `no-new-privileges` by default.
- Do not mount the Docker socket, host home directory, Codex state, or secrets.
- Bind the desktop bridge only to loopback unless a trusted proxy is configured.
- Treat `/workspace` as shared collaboration state, not an adversarial sandbox.
- Keep credentials, cookies, transcripts, and captured reference-service data
  out of the image and public repository.

## Evidence and originality

The behavior is based on observation of a user-authorized runtime export: a
shared Debian Docker computer, non-root processes, persistent work, multiple
Xvfb/VNC/websockify desktop sessions, and replaceable compute. This design is an
original implementation. It does not reuse proprietary host bundles, workers,
private endpoints, credentials, or reference-service source code.

## Implementation sequence

1. Add authenticated screenshot and browser-computer surfaces to OAI Bot.
2. Add update/recovery flows that preserve volumes, then a separate reset flow.
3. Add explicit runtime version compatibility checks during upgrades.
