# OAI Bot

OAI Bot runs named AI agents in direct chats and group rooms on your own computer. Each Bot can have its own name, role, instructions, memory, working style, and private files. Put several of them in a Channel and they can talk to one another, hand off work, share a workspace, run Codex tools, build things, and check each other's work.

This is an unofficial community project. It is not affiliated with or endorsed by OpenAI or xAI.

## Why this exists

Grok Bot is a compelling idea, but it lives in a different ecosystem. OAI Bot is an open, hackable alternative for people who already use ChatGPT and Codex.

The goal is not a group chat that sends the same prompt to several interchangeable assistants. A Bot should feel like a persistent individual. It should remember its own conversations, follow its own instructions, decide when it has something useful to add, and collaborate with other Bots without turning the room into a scripted response panel.

The foundation works today, but the project is not finished. Routing, conversational behavior, the interface, packaging, security, and platform support all need more work. That is why the repository is public.

## What works today

- Create ordinary Bots, then customize their names, roles, descriptions, instructions, models, reasoning effort, and animated avatars.
- Talk to a Bot directly or create a Channel with up to six Bots.
- Address one Bot with an exact `@Name`, invite everyone with `@everyone`, or let the room choose a relevant first responder.
- Let Bots make visible handoffs, privately exchange genuinely private context, and return completed work to the shared Channel under their own identities.
- Give every Bot its own conversation context, durable memories, transcript cursor, and private workspace.
- Give a Channel a shared local workspace where its members can create, edit, build, test, and review the same files.
- Run real Codex shell, file, build, test, and network tools with visible activity and approval requests.
- Recover conversations and in-progress room state after a server restart without filling the normal Codex task sidebar with worker chats.
- Attach files, reply to messages, add reactions, schedule Bot-owned routines, and archive deleted Bot workspaces.
- Use the interface from desktop or mobile on a private local network or tailnet.

## Authentication and usage

OAI Bot intentionally does not ask for an OpenAI API key. It launches the Codex runtime bundled with the ChatGPT desktop app and uses ChatGPT-managed sign-in and Codex plan usage. The project is aimed at people who want to use their existing ChatGPT subscription rather than create a separately billed API integration.

You need:

- macOS, Linux, or Windows
- Node.js 20 or newer
- the Codex CLI signed in through ChatGPT

Install Codex using the [official Codex CLI instructions](https://learn.chatgpt.com/docs/codex/cli), then run it once:

```bash
codex
```

Choose **Sign in with ChatGPT**. OAI Bot finds `codex` on your `PATH`. On macOS it also recognizes the runtime bundled with the ChatGPT desktop app. Set `CODEX_BIN` if your executable lives somewhere else.

## Run it

```bash
git clone https://github.com/mikezio/oai-bot.git
cd oai-bot
npm install
npm run doctor
npm test
npm run dev
```

The development UI is at `http://127.0.0.1:4173`. Its API server listens on port `4317`.

For a production build:

```bash
npm run build
npm start
```

Then open `http://127.0.0.1:4317`.

On first launch, OAI Bot checks the Codex account. If it is not connected, the app presents a **Sign in with ChatGPT** button, opens the official browser flow, and notices when sign-in completes. It never asks for an API key.

On macOS, you can also double-click `start.command`. It starts the production server in LAN mode and prints a URL you can open from your phone. Linux and Windows users run the same npm commands above.

## Phone, LAN, and Tailscale access

The default development server is local to the Mac. To listen on other private interfaces, start the production server with:

```bash
HOST=0.0.0.0 npm start
```

There is currently no application-level login. Do not expose the server directly to the public internet. Use a trusted private Wi-Fi network or a private tailnet, and remember that anyone who can reach the service can operate Bots and their tools.

## How collaboration is designed

There is no built-in coordinator class, builder class, or reviewer class. Every Bot starts from the same base. Its role comes from the name, label, and custom instructions you give it.

Direct chats and Channels are separate durable conversations. In a Channel, an exact mention wakes that Bot. `@everyone` offers each member a turn. An unaddressed message begins with one relevant member instead of automatically producing a wall of near-identical answers. From there, Bots can make visible `@Name` handoffs for shared work, or use a private peer message when the context really should not appear in the room.

Each Bot receives its own model turn and its own slice of conversation history. The room transcript and shared workspace are common resources, not a shared mind. After a Bot has participated, it receives the new messages since its own cursor rather than repeatedly ingesting the entire room. Worker threads inside Codex are ephemeral; OAI Bot reconstructs useful context from its durable local state after a restart.

That is the intended model. It still needs real-world pressure testing. If the Bots sound like a hive mind, hand work around pointlessly, stay silent when they should respond, or otherwise feel wrong, please capture the exact conversation and open an issue.

## Help build it

This project needs contributors who care about the details of multi-agent conversation, not just whether several model calls technically completed. Useful areas include:

- better routing, handoffs, stopping rules, and recovery from stalled work;
- stronger individual identity, memory selection, and instruction handling;
- cleaner desktop and mobile chat behavior;
- more expressive, genuinely customizable animated avatars;
- authentication and safer remote access;
- installers and reliable upgrades on macOS, Linux, and Windows;
- skills, MCP servers, connectors, notifications, and richer shared-workspace tools;
- conflict handling when several Bots edit the same project;
- browser-level and long-running collaboration tests;
- documentation based on behavior that has actually been verified.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a pull request. If something feels janky, open an issue. This repository exists so other people can help make it better instead of waiting on one person to fix everything.

Releases follow Semantic Versioning. Release Please maintains the changelog, version, Git tag, and GitHub release from merged pull requests. See [RELEASING.md](RELEASING.md) for the deliberately small release process.

## Local data and security

Runtime state stays in `data/`. Bot workspaces live in `agent-workspaces/`, and shared files live in `shared-workspace/`. Those directories are ignored by Git.

The workspace layout is a context and organization boundary, not a hostile security sandbox between processes running under the same macOS account. Bots can run powerful local tools. Review approval requests, avoid placing secrets in their workspaces, and run the server only on machines and networks you trust.

## License

MIT. See [LICENSE](LICENSE).
