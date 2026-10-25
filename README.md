# Velloc Code

**A coding agent that is also a browser, built for Windows.**

Velloc Code reads and edits your project, runs your shells, and drives real
browser tabs, all inside one desktop application. This repository is its
**runtime**: the agent loop, the tools as the model sees them, sessions,
memory and the whole user interface, written in TypeScript and React.

[Download for Windows](https://velloc.app/download/VellocSetup.exe) ·
[Releases](https://github.com/VellocLabs/velloc-bootstrap/releases/latest) ·
[Platform and architecture](https://github.com/VellocLabs/velloc-bootstrap#readme)

## Why Velloc

- **The browser is built in.** The agent opens pages, clicks, types, reads and
  takes screenshots in tabs of the same application. Checking a frontend
  change, filling in a form or reading a signed-in dashboard needs no
  extension and no separate driver.
- **Windows is a first-class platform.** Bash and PowerShell are two separate
  tools, and the model uses the one the task needs. Commands run in a
  sandboxed process that the application owns, not inside the terminal you
  launched it from, and no WSL is required.
- **Any model.** Anthropic, OpenAI (Chat Completions and Responses), Google
  Gemini, Ollama, or any OpenAI-compatible endpoint, chosen per session.
- **Bring your history.** Import sessions, skills and memory from other coding
  agents.
- **Work from another device.** Remote access lets a phone or a second
  computer follow and steer a running session.

## What is in the runtime

| Area | What it does |
|---|---|
| Agent engine | Turn loop, tool batching, subagents and agent teams |
| Tools | Files, search, shells, background tasks, the browser, web fetch, notebooks |
| Permissions | Allow and deny rules, plan mode, a review step before risky actions |
| Context | Memory across sessions, project instruction files, automatic compaction |
| Extensibility | Skills, plugins, lifecycle hooks, MCP servers, mods that add UI to a session |
| Sessions | History, file snapshots and diffs, worktree isolation, scheduled routines |
| Interface | Seven languages: English, Chinese, Japanese, Korean, German, French, Spanish |

## How it fits together

```
velloc-runtime  (this repository: TypeScript / React)
      ▲
      │  capability bridge: files · shell · browser · model · ui · session
      ▼
Velloc client   (Chromium-based desktop application, C++)
```

The client loads the runtime into an isolated surface and grants it
capabilities over a versioned bridge. The runtime holds no privilege of its
own, so a capability the client does not grant does not exist for it. One
installed client can load any runtime built for its interface version: the
hosted one, your own deploy, or a local dev server.

The runtime cannot run on its own. Outside a client it waits for the bridge
handshake and never boots.

## Develop

You need an installed client (see Download above) and Node.js 22.

```bash
git clone https://github.com/VellocLabs/velloc-runtime.git
cd velloc-runtime
npm install
npm run dev
```

The dev server listens on `http://localhost:5173`. In the client, open
**Settings → About → Runtime source**, enter that URL and choose
**Restart now**. From then on, saving a `.ts` or `.tsx` file reloads the
panel. A runtime change never requires rebuilding the client.

```bash
npm run typecheck
npm test
```

To go back to the hosted runtime, clear the Runtime source field and restart.

## Contributing

Issues and pull requests are welcome. The house rules:

- **Every feature and fix ships with tests.** A bug fix's test fails without
  the fix.
- **History stays linear.** Rebase onto `main`; no merge commits.
- **No hard-coded text a user can read.** Every label, tooltip and message is
  a catalog entry under `src/browser/webview/i18n/messages/`, written in
  English first and translated in the same change.
- **Comments state contracts**: inputs, outputs, ownership, security notes.
  Design history belongs in the pull request, not in the code.

## License

Apache License 2.0. See [LICENSE](LICENSE). Text adapted from other projects
is listed with its licence in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
