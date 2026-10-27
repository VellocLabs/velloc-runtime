import type { HookTableByEvent } from '../lifecycleHooks/hookTypes'

export type ChromiumCommandLoadedFrom = 'skills' | 'bundled' | 'plugin'

export type ChromiumSkillSource = 'project' | 'user' | 'bundled' | 'plugin'

export type ChromiumPromptCommand = {
  type: 'prompt'
  name: string
  description: string
  /** True when `description` came from author-supplied frontmatter rather than
   *  being auto-derived from the body's first line. A plugin/MCP skill needs an author-specified
   *  description (or `useWhen`) to appear in the model-facing skill listing.
   *  Bundled/user/project dir skills bypass this gate via `loadedFrom`. */
  describedByAuthor?: boolean
  content: string
  path: string
  useWhen?: string
  /** RESOLVED for the loading session: `loadLocalPromptCommands` evaluates
   *  `modelInvocation` against the session's `templateType` and stamps the
   *  answer here. Downstream (`SkillRunTool`, `getModelInvocableCommands`) reads
   *  only this boolean and never re-derives it. */
  hiddenFromModel?: boolean
  /** RESOLVED for the loading session, from `userInvocation` — see above. */
  userCallable?: boolean
  /** AUTHORED model-invocation gate, pre-resolution. `undefined` = every
   *  session type; `[]` = disabled outright; a list = those types only
   *  (`'*'` normalizes to `undefined`). Set from the bundled definition's
   *  `modelInvocation` or the frontmatter `disable-model-invocation` /
   *  `session-types` keys. The loader consumes it and stamps
   *  `hiddenFromModel`; nothing downstream should read it. */
  modelInvocation?: readonly string[]
  /** AUTHORED user-invocation (`/name`) gate, pre-resolution. Same tri-state
   *  as `modelInvocation`; the loader stamps `userCallable` from it. */
  userInvocation?: readonly string[]
  /** Hide this user-invocable skill from the slash picker while `/<name>` still
   *  dispatches; an exact full-name query and `/skills` still show it. Unlike
   *  `userCallable: false`, which removes slash dispatch. */
  hiddenFromPicker?: boolean
  loadedFrom: ChromiumCommandLoadedFrom
  source: ChromiumSkillSource
  /** Directory the skill's body should resolve relative paths against.
   *  For directory-format skills (skill-name/SKILL.md) this is the skill
   *  directory; for flat .md skills it is the parent directory. Surfaced
   *  to the model as a "Base directory" header and substituted into the
   *  body for `${CLAUDE_SKILL_DIR}`. */
  baseDir?: string
  /** True for a flat `.md` file from a plugin's `commands/` folder: a command,
   *  not a skill, so its `baseDir` is not a skill root. */
  fromCommandFolder?: boolean
  /** Named positional argument labels parsed from the frontmatter
   *  `arguments` field. Maps positional `$name` placeholders in the body
   *  onto the same index in the parsed argv. */
  argNames?: string[]
  /** Human-readable hint for the shape of `args`, surfaced in tool-call UI. */
  argumentHint?: string
  /** Skill-scoped tool allowlist parsed from `allowed-tools` / `allowedTools`.
   *  The parsed list is stored; permission enforcement is deferred until
   *  Nexus grows a real permission-rule system. The model still
   *  benefits because the listing surfaces it as guidance. */
  permittedTools?: string[]
  /** Frontmatter `model` override. When set, `SkillRunTool` swaps
   *  `mainLoopModel` on the per-turn `ToolUseContext` so downstream tool
   *  calls and the next assistant response use the requested model. */
  model?: string
  /** Free-form `version` string surfaced for diagnostics; not used by the
   *  runtime today. */
  version?: string
  /** Gitignore-style path patterns from frontmatter `paths`. When non-empty
   *  the skill is "conditional" — `loadLocalPromptCommands` excludes it
   *  from the model-visible listing until file-touch activation lands.
   *  Empty/undefined means the skill is always exposed. */
  paths?: string[]
  /** Name of the plugin that contributed this command, when `source` is
   *  `'plugin'`. Used for diagnostics and namespacing; undefined for
   *  bundled/user/project skills. */
  pluginName?: string
  /** Per-skill hooks parsed from frontmatter `hooks:` (validated by
   *  `parseHooksSettings`). Now that frontmatter is real YAML the nested
   *  block is representable; this carries the parsed hooks for a follow-on
   *  `armSkillHooks`-style wiring that pushes them into the session hook
   *  store on invoke. Undefined when no valid `hooks:` block is present. */
  hooks?: HookTableByEvent
  /** Execution mode parsed from frontmatter `context`: `'fork'` runs the skill as a forked sub-agent (its
   *  intermediate tool output stays out of the main conversation; only the
   *  final summary returns), `'inline'` (the default) expands the body into
   *  the main conversation. Undefined is treated as `'inline'`. */
  context?: 'fork' | 'inline'
  /** Named agent to fork as when `context === 'fork'`. Resolved against the
   *  agent registry (`agentDefinitions.activeAgents`); when unset or unknown
   *  the fork inherits the parent's system prompt and tools. Ignored for inline skills. */
  agent?: string
  /** Reasoning-effort hint forwarded to a forked skill's model, from
   *  frontmatter `effort`. Free-form today (e.g. `'low'`/`'high'`); surfaced for
   *  future model-config wiring. Ignored for inline skills. */
  effort?: string
}

export type ChromiumCommandMetadata = ChromiumPromptCommand

export type ChromiumSkillSummary = {
  name: string
  description: string
  path?: string
  shortId?: string
}

