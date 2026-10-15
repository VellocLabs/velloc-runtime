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
  LauncherMeta,
  ParsedTemplate,
  TemplateConfig,
  WelcomeContent,
} from './templateParsing'
import type { PromptProfile } from './promptProfile'
import {
  currentTemplateChannel,
  type UpdateChannel,
} from '../branding/updateChannels'

// The LIVE registry. Starts as a fresh clone of the build-time bundled set.
// `launcherCatalog`/`launcherByType`/`betaLauncherCatalog` are mutable so a
// local `index.md` overlay can REPLACE them at boot (only when the host
// signalled `template=local`); the other maps are mutated in place by
// `registerLocalType` / `applyLocalWelcome`. The getters below close over these
// bindings.
let {
  launcherCatalog,
  launcherByType,
  betaLauncherCatalog,
  sharedHolders,
  typeHolders,
  templates,
  betaTemplates,
  welcomeByType,
} = createBundledRegistry()
// The BUNDLED launcher catalogs, kept when a local `index.md` replaces the live
// ones (`applyLocalCatalog` reassigns the bindings above; these stay). Read by
// `isTypeListedInBundledCatalog`.
const bundledLaunchers = { launcherByType, betaLauncherCatalog }
// Types loaded from the LOCAL folder (`registerLocalType`). A local type may
// reuse a bundled holder by its globally-unique (type-prefixed) name; bundled
// types keep the no-cross-type-borrow invariant (this gate).
const localTypes = new Set<string>()

// Test-only pin for the channel (`__setTemplateChannelForTest`); `null` reads
// the realm (`currentTemplateChannel`).
let channelForTest: UpdateChannel | null = null

/**
 * The channel whose files this registry serves. Read per call, never cached at
 * module load: it is a property of the realm (its origin, or an off-channel
 * preview), so there is nothing to invalidate and no boot-order to get wrong.
 * The one exception is a remote client, which takes its runtime's channel off
 * the connection (`adoptRuntimeChannel`) — once, before its shell renders.
 */
function templateChannel(): UpdateChannel {
  return channelForTest ?? currentTemplateChannel()
}

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
 * A launcher's display title: `title-i18n` via `translate` (which must
 * return undefined for a missing key), else `title`, else `type`.
 */
export function getTemplateTitle(
  type: string,
  translate?: (key: string) => string | undefined,
): string {
  const meta = activeLauncherByType().get(type)
  if (meta?.titleI18n && translate) {
    const localized = translate(meta.titleI18n)
    if (localized) return localized
  }
  return meta?.title ?? type
}

/** A resolved launcher icon: an SVG data URI (or image URL) for an `<img>`, or a
 *  lucide-react component name. */
export type TemplateIcon =
  | { kind: 'url'; src: string }
  | { kind: 'lucide'; name: string }

/**
 * The launcher icon for a type, from the `index.md` catalog. Resolution order:
 *   1. `icon` — an inline SVG **data URI** (`data:image/svg+xml;…`) → `<img src>`.
 *   2. `icon_lucide` — a lucide-react icon name → a component.
 * undefined when none is set (the caller keeps its own fallback icon). There are
 * NO icon files; the icon is inlined in `index.md`.
 */
export function getTemplateIcon(type: string): TemplateIcon | undefined {
  const meta = activeLauncherByType().get(type)
  if (meta?.icon) return { kind: 'url', src: meta.icon }
  if (meta?.iconLucide) return { kind: 'lucide', name: meta.iconLucide }
  return undefined
}

/**
 * The launcher catalog for the channel without loading any `template.md`:
 * beta uses `index-beta.md` when bundled, else `index.md`. The array is stable
 * per channel (`getThreadLaunchers` memoizes on it).
 */
export function getLauncherCatalog(): readonly LauncherMeta[] {
  return templateChannel() === 'beta' && betaLauncherCatalog
    ? betaLauncherCatalog
    : launcherCatalog
}

/** The launcher metadata for one type in the current channel's catalog. */
export function getLauncherMeta(type: string): LauncherMeta | undefined {
  return activeLauncherByType().get(type)
}

/**
 * Whether the current channel's BUNDLED catalog lists `type` — whatever a
 * local `index.md` overlay did to the live one. A local catalog REPLACES the
 * launcher list (`applyLocalCatalog`), but the bundled types it leaves out are
 * still registered and their existing sessions still run.
 */
export function isTypeListedInBundledCatalog(type: string): boolean {
  const beta =
    templateChannel() === 'beta' ? bundledLaunchers.betaLauncherCatalog : null
  return beta
    ? beta.some(meta => meta.type === type)
    : bundledLaunchers.launcherByType.has(type)
}

// `launcherByType` for the beta catalog, built on first use and rebuilt only
// when the beta catalog array is replaced.
let betaByTypeFor: readonly LauncherMeta[] | null = null
let betaByType = new Map<string, LauncherMeta>()

function activeLauncherByType(): ReadonlyMap<string, LauncherMeta> {
  const catalog = getLauncherCatalog()
  if (catalog === launcherCatalog) return launcherByType
  if (betaByTypeFor !== catalog) {
    betaByTypeFor = catalog
    betaByType = new Map(catalog.map(m => [m.type, m]))
  }
  return betaByType
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
  launcherCatalog = local
  launcherByType = new Map(local.map(m => [m.type, m]))
  betaLauncherCatalog = null
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
  const byLocale = welcomeByType.get(type) ?? new Map<string, WelcomeContent>()
  byLocale.set(locale, parseWelcome(raw))
  welcomeByType.set(type, byLocale)
}

/** Test-only: undo all local overlays (catalog, types, holders, welcome),
 *  restoring the bundled registry so overlay tests don't leak. */
export function __resetLocalOverlayForTest(): void {
  ;({
    launcherCatalog,
    launcherByType,
    betaLauncherCatalog,
    sharedHolders,
    typeHolders,
    templates,
    betaTemplates,
    welcomeByType,
  } = createBundledRegistry())
  localTypes.clear()
}

/** Test-only: pin the channel the registry serves (`null` = read the realm). */
export function __setTemplateChannelForTest(channel: UpdateChannel | null): void {
  channelForTest = channel
}

/**
 * A type's welcome page for the active UI `locale` (e.g. 'zh'), from
 * `<type>/welcome-<locale>.md`, falling back to the default `<type>/welcome.md`.
 * undefined when the type ships no welcome.md.
 */
export function getWelcome(
  type: string,
  locale = '',
): WelcomeContent | undefined {
  const byLocale = welcomeByType.get(type)
  if (!byLocale) return undefined
  return byLocale.get(locale) ?? byLocale.get('')
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
