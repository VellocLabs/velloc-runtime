# Velloc Runtime

**An agent harness runtime in TypeScript.**

Velloc Runtime is the part of a coding agent that is not the model: the turn
loop, the tools the model sees, permissions, context management, memory,
sessions, subagents and teams, extension points, and the interface that
drives them. It runs many sessions at once, keeps them alive independently of
any one screen, and talks to everything outside itself through a small,
versioned capability interface.

It ships inside [Velloc](https://github.com/VellocLabs/velloc-bootstrap), a
coding agent and browser for Windows, which loads it from a URL — so you can
point an installed Velloc at your own build.

[Download Velloc](https://velloc.app/download/VellocSetup.exe) ·
[Releases](https://github.com/VellocLabs/velloc-bootstrap/releases/latest) ·
[Start here](https://github.com/VellocLabs/velloc-bootstrap#readme)

## What it gives you

- **A pure, replayable turn loop.** One turn is a state machine: the
  transition function takes the current state, an event and a set of
  policies, and returns the next state, the effects to run and the outputs to
  emit. It does no IO, reads no clock and mints no ids, so a turn can be
  replayed from a script and tested without a model or a filesystem.
- **Model-agnostic by construction.** Anthropic Messages, OpenAI Chat
  Completions, OpenAI Responses, Google Gemini and Ollama each have a driver;
  any OpenAI-compatible endpoint plugs into the same registry. The model is
  chosen per session and can change mid-session.
- **A tool contract, not a tool pile.** A tool declares its schema, its own
  input check, its permission verdict and its result shape. Built-in tools,
  host-provided tools, MCP servers and plugin tools are offered through one
  registry, and a tool-search layer keeps rarely used ones out of the prompt
  until they are needed.
- **Permissions as a first-class layer.** Allow and deny rules with command
  and path matching, protected paths, read-only shell detection, plan mode,
  accept-edits and don't-ask modes, and a permission-request hook for
  external decisions.
- **Context that manages itself.** Windowed history, automatic and manual
  compaction, project instruction files with conditional rule injection, and
  cross-session memory with background extraction, recall and consolidation.
- **Concurrency built in.** Subagents (read-only explorers, planners,
  general workers), forked runs, background shells and tasks, agent teams
  with a mailbox and a shared task board, and scheduled routines that run
  headless or deliver into a session.
- **Seams everywhere.** Skills, plugins with marketplaces, lifecycle hooks
  (command, HTTP, prompt and agent hooks), MCP servers with OAuth, and mods:
  sandboxed extensions that observe or rewrite turn events, add tools and
  commands, and contribute UI. Plugins are compatible with Claude Code
  plugins, so existing plugins and marketplaces work as they are (see
  [Plugins and mods](#plugins-and-mods)).
- **Sessions you can trust.** Append-only transcripts, per-turn file
  snapshots and diffs, rewind, worktree isolation, and import of sessions,
  skills and memory from other coding agents.
- **Many clients, one runtime.** A UI, a second window or a remote device
  connects over the same framed protocol and subscribes to the same topics.

## How it is organised

```
src/
  engine/          Turn state machine, interpreter, ledger, transcript writer
  toolkit/         Tool contract, registry, executor, built-in tools
  models/          Provider drivers, endpoint trust, usage, fast model calls
  permissions/     Rule engine, modes, plan approval, protected paths
  context/         Compaction and window management
  messages/        Row and message construction, history preparation
  memory/          Instruction files, recall, extraction, consolidation
  prompting/       System prompt assembly and templates
  agents/ team/    Subagents, forked runs, teammates, mailbox, task board
  routines/        Cron and one-shot schedules, headless runs, notifications
  sessions/        Session store, titles, file snapshots
  sessionImport/   Importing history from other agents
  skillLibrary/    Skills: discovery, install, invocation, built-ins
  pluginHost/      Plugin loading, marketplaces, install steps
  lifecycleHooks/  Hook runners and registration
  mcp/             MCP client, pools, OAuth, tool adapters
  mods/            Mod runtime, sandboxed workers, build and admission
  terminal/        Shell sessions and screen mirroring
  browser/         Process layout, protocol, transport, hub, UI
```

The dependency direction is one way: the worker layer calls `engine/`, the
engine calls `toolkit/`, and the toolkit calls leaf modules such as
`permissions/`, `context/` and `messages/`. Mods reach the engine and the
toolkit only through two interfaces they define (`TurnExtensions` and
`ToolCallExtensions`), so the core never depends on an extension.

### Process layout

The runtime keeps state in one long-lived shared worker, with a manager that
owns the session list and a worker per session that owns its engine. Heavy or
untrusted work runs elsewhere: a kernel hosts isolated workers, scripts run in
a hardened realm, and mods run in their own sandboxed workers. Clients hold no
agent state; they attach, subscribe and send commands.

### Capabilities, not privileges

The runtime has no authority of its own over the machine. File access, shell
execution, network, model transport and storage are capabilities the host
grants over a versioned interface, and a capability that is not granted does
not exist for the runtime. A change to that interface bumps its version.

### The runtime protocol

Everything that talks to the runtime speaks one framed protocol
(`src/browser/runtimeProtocol`): a handshake with capability negotiation,
request/response calls with scopes, cancellation, blob transfer, and topic
subscriptions that publish state instead of calling back. The same frames
run over a message port locally and a WebSocket remotely, which is how a
second device follows and steers a running session.

## Plugins and mods

**Plugins** are compatible with Claude Code plugins: they use the same plugin
and marketplace file format, so a Claude Code plugin installs and runs here
without changes. A plugin is a
directory with a `.claude-plugin/plugin.json` manifest, and it can carry any
mix of:

- slash **commands** (markdown files)
- **agents** (markdown subagent definitions)
- **skills**
- lifecycle **hooks**
- **MCP servers**, with per-plugin user configuration and variable
  substitution

Marketplaces are catalogs of plugins and can point at GitHub repositories,
git URLs, git subdirectories, HTTPS archives with a checksum, or local
directories. Plugins can be enabled and disabled, updated, blocked by policy
and pinned to a version; a plugin can also declare the settings it requires.

**Mods** are this runtime's own extension layer, built on top of plugins. A
plugin can ship a hooks module, and each module runs in its own sandboxed
worker. A module registers hooks on a typed event chain and can:

- observe, rewrite or veto a turn at its seams: prompt, model request, tool
  call, compaction, session append
- register tools and commands
- add model providers
- contribute interface: panes, slots, topbar items and session templates

Hooks sit in ordered tiers (managed, user, bundled, core), so a managed
policy always outranks a user-installed mod. A mod that fails, hangs or is
refused at admission is reported and left out; it never takes the engine
down.

## Develop

You need Node.js 22.

```bash
git clone https://github.com/VellocLabs/velloc-runtime.git
cd velloc-runtime
npm install
npm run dev
```

The dev server listens on `http://localhost:5173` and reloads on every
`.ts` or `.tsx` save.

```bash
npm run typecheck   # tsc over the whole project
npm test            # vitest
npm run build       # production bundle
```

### Run it in Velloc

The runtime needs a host to grant its capabilities; outside one it waits for
the handshake and never boots. Use an installed
[Velloc](https://velloc.app/download/VellocSetup.exe) as the host:

1. Settings → **About** → **Runtime source** → `http://localhost:5173`.
2. **Restart now**. The panel now loads your dev server and hot-reloads.

To go back to the hosted runtime, clear the field and restart. If a bad URL
keeps the panel from loading, its recovery screen offers **Restore default
runtime**. A runtime change never requires rebuilding the client.

Other ways to serve it:

```bash
npm run build:versioned   # a production bundle under /v<N>/
npm run preview           # serve it; point Velloc at http://localhost:4173/v2/
npm run deploy            # build and deploy your own copy to Cloudflare
```

A change to the host interface — the `*.api.json` / `*.tool.json`
declarations, the wire types under `src/browser/bridge/protocol/`, the
bootstrap message — needs a matching client and an interface-version bump;
see [velloc-core](https://github.com/VellocLabs/velloc-core#the-bridge-contract).
Everything else ships without touching the client.

## Related repositories

| Repository | What it is |
|---|---|
| [velloc-bootstrap](https://github.com/VellocLabs/velloc-bootstrap) | Start here: releases, quick start, how the pieces fit |
| [velloc-core](https://github.com/VellocLabs/velloc-core) | The client's C++ and the guide to building it |
| [plugins-marketplace](https://github.com/claude-code-mods/plugins-marketplace) | The plugins and mods every Velloc installs on its own |
| [mod-template](https://github.com/VellocLabs/mod-template) | Start a new mod |
| [Nebius-Mod](https://github.com/VellocLabs/Nebius-Mod) | A sample mod: a model provider, cloud sandboxes, a session type |

## Contributing

Issues and pull requests are welcome. The house rules:

- **Every feature and fix ships with tests.** A bug fix's test fails without
  the fix. The engine's fakes (scripted model, fake tool runner, deterministic
  scheduler) live under `src/__tests__/engine-replay/fakes/`.
- **History stays linear.** Rebase onto `main`; no merge commits.
- **No hard-coded text a user can read.** Every label, tooltip and message is
  a catalog entry under `src/browser/webview/i18n/messages/`, written in
  English first and translated in the same change. The interface ships in
  English, Chinese, Japanese, Korean, German, French and Spanish.
- **Comments state contracts**: inputs, outputs, ownership, security notes.
  Design history belongs in the pull request, not in the code.

## License

Apache License 2.0. See [LICENSE](LICENSE). Text adapted from other projects
is listed with its licence in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
A production build also emits `third-party-licenses.txt` beside `index.html`:
the licence and notice text of every npm package the bundle ships.
