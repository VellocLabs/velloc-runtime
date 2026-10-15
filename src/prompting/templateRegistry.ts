// Per-session agent templates: the LIVE registry and getters, over data
// parsed at build time (`virtual:bundled-template-registry`); the `yaml`
// parsers load only for `?template=local`. Files: `shared_includes/<name>.md`
// (global holders), `<type>/template.md` (manifest), `<type>/includes/` (type
// holders); `-lean` marks the LEAN rendering. Manifest bodies list
// `!name` holders, `$name` dynamics and literal text.

import { createBundledRegistry } from 'virtual:bundled-template-registry'
import { expandGroups, isToolGroup, TOOL_GROUPS } from '../toolkit/builtin/toolGroups'
import type {
  HolderFile,
  RegistryData,
} from './templateParsing'

// Re-export the public shapes so existing `import { … } from
// './templateRegistry'` call sites keep working unchanged.
export type {
  PromptElement,
  TemplateConfig,
  LauncherMeta,
  WelcomeSuggestion,
  WelcomeContent,
  ParsedTemplate,
} from './templateParsing'
import type {
  ParsedTemplate,
  TemplateConfig,
} from './templateParsing'
import type { PromptProfile } from './promptProfile'
import type { UpdateChannel } from '../branding/updateChannels'
import {
  replaceLauncherCatalog,
  resetTemplateCatalogForTest,
  setLocalWelcome,
  setTemplateChannelForTest,
  templateChannel,
} from './templateCatalog'

// The launcher catalog and welcome pages live in `templateCatalog.ts` so the
// page can render them without this module's template bodies; re-exported for
// the runtime's callers.
export {
  getLauncherCatalog,
  getLauncherMeta,
  getTemplateIcon,
  getTemplateTitle,
  getWelcome,
  isTypeListedInBundledCatalog,
  type TemplateIcon,
} from './templateCatalog'

// The LIVE registry. Starts as a fresh clone of the build-time bundled set.
// The maps are mutated in place by `registerLocalType`
// (only when the host signalled `template=local`). The getters below close
// over these bindings.
let {
  sharedHolders,
  typeHolders,
  templates,
  betaTemplates,
} = createBundledRegistry()
// Types loaded from the LOCAL folder (`registerLocalType`). A local type may
// reuse a bundled holder by its globally-unique (type-prefixed) name; bundled
// types keep the no-cross-type-borrow invariant (this gate).
const localTypes = new Set<string>()

/**
 * A type's manifest for the current channel: on beta its `template-beta.md`
 * when it has one, else its `template.md` (on either channel). A type with
 * ONLY a beta manifest is a beta-only type — `undefined` on stable, where the
 * runtime falls back to the default type like any unknown one.
 */
export function getTemplate(type: string): ParsedTemplate | undefined {
  if (templateChannel() === 'beta') {
    const beta = betaTemplates.get(type)
    if (beta) return beta
  }
  return templates.get(type)
}

export function hasTemplate(type: string): boolean {
  return getTemplate(type) !== undefined
}

/**
 * A `!holder`'s trimmed prose: per-type over shared; `-lean.md` when `profile`
 * is `'lean'` and it exists, else the base. Undefined when none. No cache: the
 * profile can change on the next turn.
 */
export function getHolderProse(
  name: string,
  opts: { type?: string; profile?: PromptProfile } = {},
): string | undefined {
  const wantLean = opts.profile === 'lean'
  const pick = (files: HolderFile[] | undefined): string | undefined => {
    if (!files) return undefined
    const variant = wantLean
      ? files.find(f => f.name === name && f.profile === 'lean')
      : undefined
    const base = files.find(f => f.name === name && f.profile === '')
    return (variant ?? base)?.content.trim()
  }
  const own =
    pick(opts.type ? typeHolders.get(opts.type) : undefined) ?? pick(sharedHolders)
  if (own !== undefined) return own
  // A LOCAL type may reuse a bundled holder by its globally-unique (type-
  // prefixed) name — e.g. a local template that references `!agent_intro`.
  // Bundled types keep the no-cross-type-borrow invariant (the localTypes gate).
  if (opts.type && localTypes.has(opts.type)) {
    for (const files of typeHolders.values()) {
      const hit = pick(files)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/**
 * Overlay a local catalog (REPLACE): a non-empty `types:` list becomes the
 * catalog on both channels; empty or unparsable is a no-op. Called only when
 * the host signalled `template=local`.
 */
export async function applyLocalCatalog(indexMd: string): Promise<void> {
  const { parseLauncherCatalog } = await import('./templateParsing')
  const local = parseLauncherCatalog(indexMd)
  if (local.length === 0) return
  replaceLauncherCatalog(local)
}

/**
 * Register a LOCAL type's files, overriding a bundled type of that name on
 * both channels (no local `template-beta.md` drops the bundled one), and mark
 * it local. Idempotent; local `shared_includes` are not supported.
 */
export async function registerLocalType(
  type: string,
  files: Iterable<readonly [string, string]>,
): Promise<void> {
  const { buildRegistry } = await import('./templateParsing')
  const built = buildRegistry(files)
  const tmpl = built.templates.get(type)
  const betaTmpl = built.betaTemplates.get(type)
  if (tmpl) templates.set(type, tmpl)
  if (betaTmpl) betaTemplates.set(type, betaTmpl)
  else if (tmpl) betaTemplates.delete(type)
  const holders = built.typeHolders.get(type)
  if (holders) typeHolders.set(type, holders)
  localTypes.add(type)
}

/** Register/override a local type's welcome page (from a `welcome[-locale].md`).
 *  `locale` is '' for the default `welcome.md`. `async`: see `applyLocalCatalog`. */
export async function applyLocalWelcome(
  type: string,
  locale: string,
  raw: string,
): Promise<void> {
  const { parseWelcome } = await import('./templateParsing')
  setLocalWelcome(type, locale, parseWelcome(raw))
}

/** Test-only: undo all local overlays (catalog, types, holders, welcome),
 *  restoring the bundled registry so overlay tests don't leak. */
export function __resetLocalOverlayForTest(): void {
  ;({
    sharedHolders,
    typeHolders,
    templates,
    betaTemplates,
  } = createBundledRegistry())
  resetTemplateCatalogForTest()
  localTypes.clear()
}

/** Test-only: pin the channel the registry serves (`null` = read the realm). */
export function __setTemplateChannelForTest(channel: UpdateChannel | null): void {
  setTemplateChannelForTest(channel)
}

/**
 * Security: may this type use the MCP pool (tools, resource tools,
 * `Skill('mcp__<server>')`)? Not for `noExecution`: MCP tools join after
 * the allowlist, and stdio servers spawn processes.
 */
export function templateAllowsMcp(config: TemplateConfig | undefined): boolean {
  return config?.noExecution !== true
}

/**
 * The STABLE id of a skill — `<source>:<name>` — the identity a template's
 * `skills:` allowlist names. Never the display name: two sources may ship a
 * skill of the same name, and a rename of the display string must not silently
 * widen or narrow a capability boundary.
 */
export function skillId(skill: { name: string; source: string }): string {
  return `${skill.source}:${skill.name}`
}

/**
 * Security: an MCP server skill (bypasses the `skills:` allowlist): an `mcp__`
 * name AND the `bundled` source, so a workspace skill named `mcp__x` cannot
 * pass a deny-all.
 */
export function isMcpServerSkillCommand(skill: {
  name: string
  source: string
}): boolean {
  return skill.source === 'bundled' && skill.name.startsWith('mcp__')
}

/**
 * Does the `skills:` allowlist admit this skill? `'all'` / absent ⇒ every
 * skill; a list ⇒ exact stable id; empty ⇒ none. MCP server skills bypass it.
 */
export function templateAllowsSkill(
  config: TemplateConfig | undefined,
  skill: { name: string; source: string },
): boolean {
  const allowlist = config?.skills
  if (allowlist === undefined || allowlist === 'all') return true
  if (isMcpServerSkillCommand(skill)) return true
  return allowlist.includes(skillId(skill))
}

/**
 * `skills:` validation stage two: allowlisted ids matching no loaded skill,
 * returned for the caller to report, not thrown.
 */
export function unresolvedSkillIds(
  config: TemplateConfig | undefined,
  loaded: readonly { name: string; source: string }[],
): string[] {
  const allowlist = config?.skills
  if (allowlist === undefined || allowlist === 'all') return []
  const present = new Set(loaded.map(skillId))
  return allowlist.filter(id => !present.has(id))
}

/**
 * Does this session record file snapshots? When it registers `superedit` and
 * not `edit` (the recorder captures only SuperEdit, and the Diff panel uses
 * the recorder wholly once it exists), or `fileSnapshots: true`. Absent
 * `tools` ⇒ off.
 */
export function templateWantsFileSnapshots(
  config: TemplateConfig | undefined,
): boolean {
  if (config?.fileSnapshots === true) return true
  const tools = config?.tools
  if (!tools) return false
  return tools.includes('superedit') && !tools.includes('edit')
}

/**
 * Does a snapshot-backed session also get `WorkspaceDiff` (the git-diff
 * substitute)? Only with no shell: `supershell` counts as one, a sealed
 * `shell` alone does not. Appended at runtime, not in the base tool set.
 */
export function templateWantsWorkspaceDiffTool(
  config: TemplateConfig | undefined,
): boolean {
  if (!templateWantsFileSnapshots(config)) return false
  const tools = config?.tools
  // Absent `tools` ⇒ the full set ⇒ has a shell ⇒ no WorkspaceDiff.
  if (!tools) return false
  return !tools.includes('shell') && !tools.includes('supershell')
}

/**
 * The file-writing tool this type registers, for prompt text that names one
 * (`buildMemoryLines`); `undefined` when it can write nothing.
 */
export function templateWriteToolName(
  config: TemplateConfig | undefined,
): string | undefined {
  const tools = config?.tools
  // Absent `tools` ⇒ the full default set ⇒ `Write` is in it.
  if (!tools) return 'Write'
  const names = expandGroups(tools)
  if (names.has('Write')) return 'Write'
  if (names.has('SuperEdit')) return 'SuperEdit'
  return undefined
}

export function resolveDeferrableSkills(
  serverIds: ReadonlyArray<string>,
  config: TemplateConfig | undefined,
): Array<{
  name: string
  defaultDeferred: boolean
  toolNames?: readonly string[]
  sealed?: boolean
}> {
  const out: Array<{
    name: string
    defaultDeferred: boolean
    toolNames?: readonly string[]
    sealed?: boolean
  }> = []
  const seen = new Set<string>()
  // `sealedTools` first so a unit listed in BOTH resolves to sealed (the
  // stronger tier — a conflicting template should fail closed, not open).
  for (const name of config?.sealedTools ?? []) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(
      isToolGroup(name)
        ? { name, defaultDeferred: true, toolNames: TOOL_GROUPS[name], sealed: true }
        : { name, defaultDeferred: true, sealed: true },
    )
  }
  for (const name of config?.deferredTools ?? []) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(
      isToolGroup(name)
        ? { name, defaultDeferred: true, toolNames: TOOL_GROUPS[name] }
        : { name, defaultDeferred: true },
    )
  }
  for (const name of serverIds) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, defaultDeferred: true })
  }
  return out
}

/**
 * Narrow named items (tools) by a template's `tools` allowlist. Each `tools:`
 * entry is a GROUP name (expanded to its tools via `expandGroups` — see
 * `toolkit/builtin/toolGroups.ts`) or an individual tool name. No allowlist ⇒ the full
 * set unchanged. `alwaysKeep` items bypass the allowlist — used for a DEFERRED
 * skill's tools, which load (registered) even though `tools:` omits them, so
 * the deferral gate can surface them on activation.
 */
export function applyTemplateToolAllowlist<T extends { name: string }>(
  items: readonly T[],
  config: TemplateConfig | undefined,
  alwaysKeep?: (item: T) => boolean,
): T[] {
  const allow = config?.tools
  if (!allow || allow.length === 0) return [...items]
  const set = expandGroups(allow)
  return items.filter(item => set.has(item.name) || (alwaysKeep?.(item) ?? false))
}

/** Test-only: snapshot of what the bundle parsed (for unit assertions). */
export function __templateBundleForTest(): {
  templateTypes: string[]
  sharedHolderNames: string[]
  typeHolderNames: Record<string, string[]>
} {
  return {
    templateTypes: [...templates.keys()],
    sharedHolderNames: sharedHolders.map(f => (f.profile ? `${f.name}-${f.profile}` : f.name)),
    typeHolderNames: Object.fromEntries(
      [...typeHolders.entries()].map(([type, files]) => [
        type,
        files.map(f => (f.profile ? `${f.name}-${f.profile}` : f.name)),
      ]),
    ),
  }
}

// Keep `RegistryData` importable from here for existing type-only consumers.
export type { RegistryData }
