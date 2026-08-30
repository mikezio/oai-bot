# Contributing

OAI Bot is public because it needs more eyes, more environments, and more real conversations than one person can provide. Bug reports, rough prototypes, careful refactors, UI work, tests, documentation, and uncomfortable questions about the product model are all useful.

## Start here

You need Node.js 20 or newer on macOS, Linux, or Windows. Live Bot turns also require the Codex CLI signed in with ChatGPT; most unit tests do not.

```bash
git clone https://github.com/mikezio/oai-bot.git
cd oai-bot
npm install
npm run doctor
npm run dev
```

The web client runs at `http://127.0.0.1:4173` and proxies API requests to port `4317`.

If `npm run doctor` cannot find Codex, follow the [official installation instructions](https://learn.chatgpt.com/docs/codex/cli), run `codex`, and choose **Sign in with ChatGPT**. You can also set `CODEX_BIN` to an explicit executable path.

## Pick work that can be verified

Search the issues before starting. For a larger change, open an issue or short discussion first so two people do not unknowingly rebuild the same subsystem.

Good pull requests usually do one coherent thing. They explain the behavior before and after, include regression coverage where practical, and avoid rewriting unrelated code. A draft pull request is welcome when early feedback would save time.

For group-conversation changes, include the exact test scenario: Bot roles and instructions, the user's messages, relevant replies, and why the result is better. "All model calls returned 200" does not establish that the collaboration felt natural.

## Checks

Run the same checks as CI:

```bash
npm run check
```

CI runs the test suite and production build on macOS, Linux, and Windows. If a check cannot run in your environment, say so in the pull request.

## Project boundaries

- Preserve each Bot's independent identity and context. Shared transcript does not mean shared mind.
- Prefer visible Channel handoffs for shared work. Private peer messages should carry genuinely private or off-channel context.
- Keep local-first behavior and user control intact.
- Do not add API-key billing as a silent fallback.
- Do not claim a feature works until it has a meaningful test or a clearly described live verification.
- Do not commit transcripts, account data, generated builds, Bot workspaces, shared-workspace files, logs, or secrets.

## Pull requests and releases

Use a descriptive title. Release Please derives changelog entries and version bumps from conventional prefixes:

- `feat:` for a backward-compatible feature;
- `fix:` for a backward-compatible bug fix;
- `feat!:` or a `BREAKING CHANGE:` footer for an incompatible change;
- `docs:`, `test:`, `refactor:`, `build:`, or `chore:` for work that normally does not change the public version.

Maintainers may edit a title before squash-merging so the release note says what actually changed. See [RELEASING.md](RELEASING.md).

## Be decent

Challenge decisions and code directly. Do not attack or belittle the people doing the work. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
