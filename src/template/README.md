# Agent templates (`src/template/`)

A **template** defines one *agent type* (e.g. `chat`, `code`, `agent`): the
session's **system-prompt skeleton** and its **tool set**. Each type is a folder
under `src/template/` whose `template.md` is the manifest.

The lightweight **launcher metadata** (each type's name + title + icon) lives in
a single **`index.md`** catalog — the only file the sidebar needs to list the
types; a type's heavy `template.md` is loaded when that type is used.

Everything is bundled by `src/prompting/templateRegistry.ts` (Vite
`import.meta.glob`) and consumed by `systemPromptLoader.ts` (prompt) +
`createBrowserRuntime.ts` (tools) + `browser/webview/threadLaunchers.tsx` (the
sidebar launcher).

> Pick a session's type via its launcher in the sidebar; the type threads
> through to `createBrowserRuntime` and `QueryEngine`. v1 ships `agent`
> (the boot default), `chat`, and `code`.

---

## Folder layout

```
src/template/
  index.md                   # LAUNCHER CATALOG — every type's name/title/icon
  index-beta.md              # the beta channel's catalog (replaces index.md there)
  shared_includes/           # holders shared across types
    system.md                # `# How this session works` — the harness block (code, agent, chat)
    system-lean.md           # `# Harness` — the same holder's lean rendering
    executing_with_care.md   # `# Acting carefully` (code + agent)
    executing_with_care-lean.md  # CC's one-paragraph action caution
    tool_call_parallelism.md # the parallel-tool-call paragraph (all four types)
    autonomy.md              # the operating-autonomously block (code + safe_code)
    delivering_work.md       # context / delivering work / corrections (code, agent, safe_code)
    pronouns.md              # the they/them paragraph (code)
  <type>/                    # one folder per agent type (= the `type:`)
    template.md              # the manifest (frontmatter + ## prompt / ## begin)
    template-beta.md         # optional: the beta channel's manifest (replaces template.md there)
    welcome.md               # optional welcome-page chips (+ welcome-<locale>.md)
    includes/                # this type's holder prose
      <type>_intro.md        # a `!<type>_intro` holder — MUST be `<type>_`-prefixed
      <type>_tone_and_style.md
```

- **`index.md`** — the launcher catalog (name + title + icon per type). See
  *Launcher catalog* below.
- **`<type>/template.md`** — the manifest (system prompt + tools). See *Manifest
  frontmatter* + *Body*.
- **`<type>/includes/*.md`** — per-type holder prose, referenced as `!name`
  from the manifest. **Names must start with `<type>_`** (see *Holders*).
- **`shared_includes/*.md`** — holders reused by more than one type. Plain names
  (no type prefix); only put a holder here when it is genuinely shared.
  **Identical prose is never duplicated across holder files**: a paragraph of
  40+ words may live in exactly one file (`templateHolderDedup.test.ts`; the
  two profile renderings of one holder are the only exemption).

---

## Launcher catalog (`index.md`)

A single file — a YAML `types:` list, one entry per agent type. This is **the
only file the sidebar reads** to render the type list; no `template.md` is
touched until a type is used.

```yaml
---
types:
  - type: code               # the type id (= the `<type>/` folder)
    title: Code              # literal label (fallback)
    title-i18n: launcher.code  # i18n key — FIRST choice for the label
    icon_lucide: code        # a lucide-react icon name
    # icon: 'data:image/svg+xml;base64,…'  # OR an inline SVG data URI → <img>
    # launcherHidden: both   # listed (creatable by type) but not offered in the launcher
---
```

Per entry (parsed into `LauncherMeta`):

| Key | Purpose |
|---|---|
| `type` | The type id; must match a `<type>/` folder. **Order in the list = launcher order.** |
| `title` | Launcher label (literal). Fallback when `title-i18n` is absent / its key has no message. |
| `title-i18n` | i18n message key — the **first choice**. Looked up in `src/browser/webview/i18n/messages/{en,zh,es,fr,de}.ts` (add the key to **every** catalog; English is the fallback). |
| `icon_lucide` | A [lucide-react](https://lucide.dev) icon name (e.g. `bot`, `code`). |
| `icon` | An inline **SVG data URI** (`data:image/svg+xml;base64,…` — quote it in YAML) → `<img>`. **Only** SVG data URIs are accepted; any other value is ignored (→ `icon_lucide`). No icon files. |
| `launcherHidden` | Scope of "not offered". `both` = hidden from the **sidebar AND the project menu**; `sidebar` = hidden from the **sidebar only** — the project menu still offers it. Nothing unhides a hidden type from the UI; it stays a full type — `openNewSession(type)` / `?templateType=` work. Absent ⇒ offered on both. |
| `launcherMenu` | `false` = **not offered in the project folder menu** (sidebar launcher unaffected). Strict `false` only; absent ⇒ offered. |

**Title resolution** (`getTemplateTitle`): `title-i18n` message → `title` → bare
`type`. **Icon resolution** (`getTemplateIcon`): `icon` (SVG data URI) →
`icon_lucide` → the launcher's hardcoded fallback.

> `icon_lucide` names must exist in `LUCIDE_BY_NAME`
> (`browser/webview/threadLaunchers.tsx`) — currently `bot`, `message-circle`,
> `code`, `folder`. Add an entry there for a new name.

---

## Beta variants (`index-beta.md`, `<type>/template-beta.md`)

The same bundle ships to both update channels, and a file with a `-beta`
suffix **replaces** its plain counterpart on the beta channel:

| On beta, this file… | …is used instead of | Scope |
|---|---|---|
| `index-beta.md` | `index.md` | The **whole** launcher catalog — order, entries, `launcherHidden`, everything. Not merged: a type it omits is not offered on beta. |
| `<type>/template-beta.md` | `<type>/template.md` | That type's **whole** manifest — frontmatter and skeleton. A type with no beta manifest uses `template.md` on both channels; a type with ONLY a beta manifest does not exist on stable. |

Holders (`includes/`, `shared_includes/`) and `welcome*.md` have no beta
variant: a beta manifest names the same holder files, and adds its own
`<type>_…` holder when its prose has to differ. To try a change on beta, put it
in the `-beta` file; to ship it, make the plain file match (or delete the
`-beta` file once the two are identical).

A `template-beta.md` is model-visible, so it has its own goldens beside the
stable ones, named with the same suffix — `expected-prompt-beta.md`,
`expected-prompt-lean-beta.md`, `expected-tools-beta.json` (see Golden files).
Promoting or retiring the variant deletes those three files and their e2e
cases along with the manifest.

**Which channel a realm is on** (`currentTemplateChannel`,
`src/branding/updateChannels.ts`):

1. The origin the bundle is served from — `beta.velloc.app` = beta,
   `app.velloc.app` = stable. Nothing overrides this.
2. Anywhere else (a dev server, a self-hosted mirror): `?channel=beta` on the
   guest URL previews beta. The page hands it to the SharedWorker through the
   worker's name (`runtimeSharedWorkerName`), so the prompt/tool code in the
   worker reads the same files as the launcher on the page.
3. Otherwise stable — so the plain files are what a dev server shows and what
   the plain goldens capture (the `-beta` goldens are captured with
   `?channel=beta`).

A remote client is the one page that does not resolve its own: it is served
from the desktop's listener, whose origin names no channel, while its sessions
run in the desktop's runtime. So it takes the channel the runtime reports
(`runtime.getBuildEntry` → `adoptRuntimeChannel`), ahead of all three rules
above — a beta desktop's remote offers Team like the desktop does.

Resolved per call, not cached, so promoting beta's bytes to production flips
every `-beta` file off without a rebuild. **Existing sessions follow the
channel** they are opened on: a session created on beta with a beta manifest
gets the stable manifest's tool set on its next turn after a switch to stable
(the variant is not pinned to the session). A `?template=local` folder may carry
its own `index-beta.md` / `template-beta.md`; whatever it provides replaces the
bundled files on **both** channels.

## Manifest frontmatter (`template.md`)

The `---`-delimited YAML at the top of a type's `template.md` — its system
prompt + tools. Parsed by `parseManifest` into `TemplateConfig`. `#` comment
lines allowed. (Name / title / icon are NOT here — they live in `index.md`.)

| Key | Type | Purpose |
|---|---|---|
| `type` | string | The agent type. Should equal the folder name (the folder name is the fallback). |
| `description` | string | One-line human description of the type (docs only). |
| `tools` | string[] | The **eager-visible** allowlist — tool GROUPS and/or individual tool names. Omitting a group excludes it. |
| `deferredTools` | string[] | Groups/skills **loaded but hidden** until `Skill()`/`ToolSearch` activates them. |
| `skills` | `all` \| string[] | Which SKILLS this type may use — `all` (default) or an exact allowlist of stable ids. See *The `skills:` allowlist*. |
| `model` | string | Optional model override for the type (rarely set). |

### `tools`, `deferredTools` — the tool set

`tools:` lists **eager** (cold-start-visible) entries; `deferredTools:` lists
entries that load but stay hidden until activated. Both accept **group names**
(expanded via `src/toolkit/builtin/toolGroups.ts`) and individual tool/skill names.

Groups (eager-or-excluded): `read` (Read/Glob/Grep), `edit`
(Write/Edit/NotebookEdit), `shell` (Bash/PowerShell), `subagent` (Agent),
`plan`, `todo`, `webfetch` (WebFetch), `ask` (AskUserQuestion), `schedule` (cron /
routines), `skills` (Skill/ToolSearch — keep eager whenever anything is
deferred), `superedit` (SuperEdit), `exec` (exec), `misc` (Sleep).

Deferrable **skills** (named in `deferredTools:`): `browser`, `a2ui`,
`agent-teams`. The `shell` *group* may also be deferred. MCP servers are always
deferred. A skill/group in `deferredTools:` is loaded (its tools registered) but
hidden from `tools[]` until `Skill('<name>')` / `ToolSearch` activates it.

```yaml
tools: [read, edit, webfetch, ask, skills, misc]   # eager
deferredTools: [shell, browser, a2ui, agent-teams]   # hidden until activated
```

### The `skills:` allowlist

Which **skills** this type may use. `all` (or absence) means every skill the
session would otherwise see — that is every type today except the one that opts
in (`safe_code`, with a deny-all). An exact list admits only what it names:

```yaml
skills: [bundled:review, bundled:security-review, project:deploy]
skills: []      # explicit deny-all (safe_code)
skills: all     # the default, written out
```

An id is `<source>:<name>` — the **stable identity**, never the display name,
with `source` one of `bundled`, `project`, `user`, `plugin`. Two sources may
ship a skill of the same name, and a renamed label must not silently widen or
narrow a capability boundary.

It is a **capability boundary, not a UI preference**, so it gates every surface
at once. The filter runs where the session's command registry is assembled
(`createAgentRuntime`), which is the one list the model-facing `$skill_listing`,
`Skill()` and the user's `/name` dispatch all read — a denied skill is *absent*,
not hidden. Both dispatch surfaces then say "not available in this session
type" rather than "unknown skill", so a denial never reads as a typo. The
`/plugins` reload re-applies it, or a reload would re-admit what the type
denies.

Two things it deliberately does **not** govern, because each already has its
own gate:

- **the Skill tool.** A type that omits the `skills` group has no `Skill` /
  `ToolSearch` at all, so it cannot invoke skills whatever the allowlist says.
  `safe_code` states both — the empty list is what makes the boundary readable,
  and what a later `tools:` edit cannot silently widen.
- **MCP server skills** (`Skill('mcp__<server>')`). Server names come from the
  user's settings, so no template could enumerate them; `noExecution` /
  `templateAllowsMcp` governs that capability.

**Validation is two-stage, and neither stage silently ignores an id** — a
dropped id would turn a capability boundary into a typo:

| Stage | When | What it checks | On failure |
|---|---|---|---|
| syntax + namespace | template load (`parseManifest`) | `<known-source>:<name>` | **throws** — fails the bundled build; a local overlay of a bundled type falls back to that type, a local-only type fails to start |
| resolution | session start (`createAgentRuntime`) | the id names a skill this session actually loaded | reported (console) — never fatal, because a `project:`/`user:` skill lives in the workspace and its absence is a property of where the session opened |

---

## Body: `## prompt` and `## begin`

After the frontmatter, two ordered sections. Each non-blank, non-`#` line is one
of three element kinds:

| Prefix | Kind | Meaning |
|---|---|---|
| `!name` | **holder** | Fixed prose resolved from a `.md` (or host-rendered). `!name @lean` / `!name @standard` emits it for that **prompt profile** only; `!name =standard` / `!name =lean` pins WHICH rendering it emits, whatever the turn's profile — see *Holders*. |
| `$name` | **dynamic** | Web-computed text inlined each turn. |
| *plain* | **literal** | Used verbatim. |

`#` comment lines and blank lines are ignored. The `## prompt` elements join
with `\n\n` into the system instruction; `## begin` defines first-turn
attachments (opening context before the user's first message).

```markdown
## prompt
# !holder | $dynamic | literal | !holder @<profile> | !holder =<profile>
!chat_intro
!system
!chat_answering_well
!chat_using_your_tools
!tool_call_parallelism @standard
$skill_catalogs
$session_guidance
!chat_tone_and_style
$environment
$memory

## begin
$skill_listing
```

---

## Holders (`!name`)

Prose resolved by `getHolderProse(name, { type, profile })`, **preferring
per-type over shared**, and sent to the host as a finished section (the host
joins sections and resolves nothing — the symbolic `{ h }` protocol and its
provider/locale override registry were removed).

- **Per-type** → `<type>/includes/<name>.md`.
  **The name MUST be `<type>_`-prefixed** (e.g. `code_intro`). Holder names
  are one global namespace (a local template may reuse a bundled holder by
  name), so two types sharing a bare name would collide. `templateRegistry.test.ts`
  enforces the prefix.
- **Shared** → `shared_includes/<name>.md` (plain name; used by 2+ types).
- **Profile variant** → `<name>-lean.md` (e.g. `code_intro-lean.md`) is the
  **lean** prompt-profile rendering; the base `<name>.md` is the **standard**
  one. `-lean` is the only suffix: holder names are snake_case, so **any
  other `-<suffix>`** (`-standard` — the base file *is* standard — or a
  retired `-anthropic` / `-openai`) is rejected loudly instead of being filed
  as an unreferenced holder. For the bundled tree that fails the vite build;
  for a `?template=local` overlay of a BUNDLED type the session logs it and
  runs on the bundled definition, and for a local-only type — which has no
  definition to fall back to — the session fails to start, loudly
  (`loadLocalTypeFilesOrFallBack`): a type with no template config would get
  every tool and the legacy monolith prompt. A holder with no `-lean` file renders its base prose
  under both profiles; a holder with ONLY a `-lean` file (a **lean-only
  section**) is emitted under the lean profile and simply absent under
  standard — no empty part. No holder is lean-only today: the profile
  **gate** below expresses the same thing on the manifest line, where it is
  visible in the skeleton.
- **Profile gate** → `!code_doing_tasks @standard` on the manifest line emits
  the holder under that profile only (`@lean` likewise), and the SAME holder
  may be listed once per profile at two positions — which is how one manifest
  gives the two profiles a different section ORDER. CC's lean prompt has no
  `# Approach to tasks` at all. Any other `@…` token is a parse error, never a
  silent "both profiles".
- **Render pin** → `!executing_with_care =standard` keeps the line under every
  profile the gate admits but always emits the **pinned** rendering — the
  base file for `=standard`, the `-lean` file for `=lean`. It is the one way
  a type can opt OUT of a shared holder's lean variant: `agent` drives the
  browser, so it keeps the full `# Acting carefully` list for
  every model rather than the one-paragraph lean caution `code` shares with
  CC. Any other `=…` token is a parse error. **Prose never varies by provider**: the
  profile is a property of the turn's *model*, resolved once per turn in
  `engine/systemPromptSources.ts` (`prompting/promptProfile.ts::resolvePromptProfile`)
  and threaded to the loader as `promptProfile`. **`lean` is opt-in**: a model
  renders the short prompt only where its catalog entry declares
  `promptProfile: 'lean'` — today the Anthropic rows for Fable 5.x and
  Opus 4.8 / Opus 5, the models trained on that prompt. Every other model,
  including every relayed, uncatalogued or future one, renders `standard`, so
  a model nobody has classified gets MORE instruction rather than less.
  `QueryEngine` builds the prompt *after* `processUserInput`
  so a skill's `model:` override is already applied. Nothing on that path caches
  by type alone — a mid-session model switch renders the other profile on its
  next turn (`queryContext.test.ts`).
- **Tool line gate** → a holder line that begins `{{IF_TOOL:<ToolName>}}` is
  emitted (marker stripped, every other byte intact) only when `<ToolName>` is
  in the turn's **visible** tool set, and dropped whole otherwise
  (`systemPromptLoader.ts::applyToolLineGates`). It is for a bullet naming one
  tool inside a section that must otherwise stay, where the tool can be absent
  for THIS turn only. Today that is `TodoWrite`: a catalog row with
  `todoTools: false` (Fable, Opus 4.8 / 5, Sonnet 5, other providers'
  flagship tiers) is sent neither the schema nor the line
  (`utils/todoTools.ts` — one decision shared by `tools[]`, this prose, the
  dispatch guard and `todo_reminder`). Put the marker at the very start of the
  line, before the bullet, so stripping it restores the ungated text. A tool
  the TYPE never has needs no gate — leave its prose out of that type's file.
- **No thinking-mode section.** There is one full prompt regardless of the
  thinking tier: thinking is an API parameter, the model knows when it is
  reasoning, and neither reference product carries such prose. (The retired
  `thinking_mode` holder was browser-flavored text that `chat` carried too.)

> **`# Tools` (formerly `# Using your tools`) is per-type prose, not host-rendered.** It used to be:
> `!using_your_tools` was intercepted by the loader and replaced with a
> `{ h: 'using-your-tools' }` holder that the C++ renderer composed from
> `tool-catalog-frame.json`, gating each sub-section on the visible tool set.
> One shared block can't be true for every type, though — it told `code` and
> `safe_code` to "use Edit/Write for file changes" and to "reserve
> Bash/PowerShell", none of which those types register. Each type now owns
> `<type>/includes/<type>_using_your_tools.md` and names only its own tools.
> A **deferred** skill's catalog must NOT live in this block: the block is
> emitted whole, so its section would be visible before activation. Those
> register on the JS skill-catalog seam instead
> (`toolkit/run/skillCatalogs.ts`, emitted at `$skill_catalogs`) — a2ui, and
> browser since the migration (`toolkit/builtin/glic/browserSkillCatalog.ts`). So no
> template inlines `## Browser tools`. The flash variants (no manifest) still
> take the host-rendered `{{TOOL_CATALOG}}` path.

**Inline placeholders** inside holder prose are substituted by the loader:
`{{AGENT_NAME}}` → the product name; `{{system-prompt-tools}}` → the
cross-cutting browser tool cheatsheet (only when a browser tool is visible).

> Only the full prompt (`system_prompt`) composes from the manifest. The
> shorter *flash* variants fall back to the monolithic
> `public/system_prompts/*.md` via `fetchPromptTemplate`.

---

## Dynamics (`$name`)

Web-computed each turn (the manifest just fixes their *position*). Known names:

| Name | Where | Content |
|---|---|---|
| `$skill_catalogs` | `## prompt` | JS skill tool-catalog sections (e.g. a2ui), deferral-gated. |
| `$session_guidance` | `## prompt` | Sub-agent / search guidance — only when the `Agent` tool is enabled. |
| `$environment` | `## prompt` | Environment block (cwd, OS, …). *Positioned here; actually appended downstream by `queryContext`/`QueryEngine`.* |
| `$memory` | `## prompt` | Memory block (when non-empty). *Appended downstream like `$environment`.* |
| `$skill_listing` | `## begin` | First-turn "available local skills" advertisement. |

An unknown `$name` is skipped (with a warning) — it produces nothing.

---

## Welcome page (`welcome.md`)

A type can ship a **welcome page** — prompt-starter suggestion chips shown on a
new (empty) session — via `<type>/welcome.md` (optional; a type without one uses
the built-in welcome).

```yaml
---
# greeting / subtitle (optional) override the i18n welcome.greeting / .subtitle.
greeting: What can I help you with?
suggestions:
  - title: Summarize this page              # the chip's main text
    description: A quick rundown of the tab  # optional subtitle
    prompt: Summarize the page I'm looking at.  # fills composer (else `title`)
  - title: …
---
```

Each `suggestions` entry → one chip (`title` + optional `description`); clicking
loads `prompt` (or `title`) into the composer to edit + send — prompts may be
intentionally incomplete (e.g. ending in `": "`). Parsed into `WelcomeContent` /
`WelcomeSuggestion`; rendered by `ThreadSuggestions` in the empty viewport.

**How many chips actually show.** The list is truncated to what fits the panel —
**6, 4, or 2** — by `visibleSuggestionCount`
(`components/assistant-ui/welcomeSuggestionLayout.ts`): two columns above a
448 px panel width, and one grid row per ~76 px of window height left over after
the greeting, composer, and browser chrome. Chips beyond the fit are not
rendered at all. So **ship six and order them by importance** — the first two
are the ones every panel size shows. A count is always even; a template shipping
an odd number just renders one fewer.

The three bundled types ship deliberately non-overlapping starters — `chat` is
"think with me", `agent` is "do work for me", `code` is repo work. A title that
appears on two welcome pages is a signal one of them is in the wrong place (the
overlap is asserted in `__tests__/templateRegistry.test.ts`).

**Locales.** `welcome.md` is the default. Add `welcome-<locale>.md` for other
languages, where `<locale>` is the **UI locale code** (`zh`, `es`, `fr`, `de` —
Chinese is `zh`, *not* `cn`). `getWelcome(type, locale)` resolves
`welcome-<locale>.md` → the default `welcome.md`.

---

## Adding a new type

1. Create `src/template/<type>/template.md` (+ `includes/<type>_*.md` holders).
2. Add an entry to **`index.md`**'s `types:` list (`type`, `title`,
   `title-i18n`, `icon_lucide`).
3. Add the `launcher.*` i18n keys to every catalog
   (`src/browser/webview/i18n/messages/*.ts`).
4. If `icon_lucide` uses a new name, add it to `LUCIDE_BY_NAME`
   (`browser/webview/threadLaunchers.tsx`).
5. Add a launcher entry to `THREAD_LAUNCHERS` (`type`, `titleKey`,
   `defaultTitleKey`, `testId`) — it sources its title + icon from `index.md`.

---

## Worked example — the `chat` type

`src/template/index.md` (the launcher catalog entry):

```yaml
- type: chat
  title: Chat
  title-i18n: launcher.chat
  icon_lucide: message-circle
```

`src/template/chat/template.md` (the config):

```markdown
---
type: chat
description: Conversation — read + edit + web; shell/browser/UI deferred.
tools: [read, edit, web, ask, skills, misc]
deferredTools: [shell, browser, a2ui, agent-teams]
---

## prompt
!chat_intro
!system
!chat_answering_well
!chat_using_your_tools
!tool_call_parallelism @standard
$skill_catalogs
$session_guidance
!chat_tone_and_style
$environment
$memory

## begin
$skill_listing
```

with `src/template/chat/includes/chat_intro.md`, `chat_answering_well.md`
and `chat_tone_and_style.md` holding the type's own prose, and `!system` /
`!tool_call_parallelism` resolving from `shared_includes/`.

---

## Local override folder (`%LOCALAPPDATA%\Velloc\.velloc\template`)

Users can override the bundled templates at runtime by dropping a folder with the
**same structure** at `<install root>/.velloc/template` (Windows:
`%LOCALAPPDATA%\Velloc\.velloc\template`). The browser host detects it and appends
`?template=local` to the guest URL; the web reads that param **synchronously** and
only then touches the local folder. **No param ⇒ zero local I/O** — the app runs
purely on the bundled templates (the common case).

When active:

- **`index.md` REPLACES the launcher catalog** — a non-empty local `types:` list
  becomes the entire left-panel list; an absent/empty one falls back to the bundled
  catalog (`applyLocalCatalog`, boot, page thread).
- **A local type's `template.md` + `includes/` OVERRIDE the bundled definition**,
  lazy-loaded when a session of that type is created (`createBrowserRuntime` →
  `loadLocalTypeFiles`, worker thread). A local type may **reuse a bundled holder**
  by its globally-unique (`<type>_`-prefixed) name — e.g. reference `!agent_intro`
  with no local file and get the bundled prose (`getHolderProse` cross-type lookup,
  gated to local types so bundled types keep the no-borrow invariant).
- **`welcome.md`** is loaded page-side during the boot overlay so the welcome chips
  render for local types.

A removed folder / a type with no local files ⇒ bundled fallback (else `'agent'`).

> Holder prose for local types is resolved in the guest like bundled prose and
> sent as finished sections, so this folder needs nothing from the binary.

---

## Golden files

Every type's fully rendered model request is frozen as a golden file outside
this repo; a change to what the model sees regenerates them (F-19).

---

## Conventions & verification

- **Per-type holders are `<type>_`-prefixed** — holder names are one global
  namespace, so a bare per-type name would collide with a shared one.
- Keep each type's goldens current (see Golden files).
- Tests: `__tests__/templateRegistry.test.ts` (parsing, holder resolution,
  title/icon, the prefix guard) and `__tests__/threadLaunchers.test.ts` (icon +
  title sourced from the template). Run `npm run typecheck && npm test`.
```
