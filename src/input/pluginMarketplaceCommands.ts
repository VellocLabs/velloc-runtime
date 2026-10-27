/**
 * Handlers for `/plugin` (installed plugins: list / install / uninstall /
 * enable / disable `<name>@<marketplace>`, and `marketplace …`) and
 * `/marketplace` (list / add / remove / update / info). User-scope, alongside
 * the project-scoped `/plugins`. Prose is catalog keys; names, ids, shas and
 * command syntax stay literal.
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import {
  applyEnabledPluginsPatch as _applyEnabledPluginsPatch,
  getEnabledPluginsMap,
  setPluginEnabled,
} from '../pluginHost/enabledPlugins'
import {
  setupPlugin,
  teardownPlugin,
} from '../pluginHost/installSteps'
import {
  loadInstalledPlugins,
} from '../pluginHost/installedRegistry'
import {
  findCatalogPlugin as resolvePluginInMarketplace,
  fetchCatalog as refreshMarketplace,
  listingsVisibleOn,
  loadKnownMarketplaces,
  removeMarketplace,
} from '../pluginHost/marketplaces'
import { isBuiltinMarketplace } from '../pluginHost/builtinMarketplace'
import { currentTemplateChannel } from '../branding/updateChannels'
import type {
  CatalogRecord as KnownMarketplaceEntry,
  PluginSetupRecord as InstalledPluginEntry,
} from '../pluginHost/registryFormats'
import { githubRepoOf, parseMarketplaceSource, registerMarketplaceSource } from '../pluginHost/marketplaceRegister'
import type { PluginInstallPathContext } from '../pluginHost/pluginDirs'
import { resolveSettingsHomeDir } from '../settings/settingsStore'
import {
  isCuratedCatalog,
  joinPluginRef,
  readStrictPluginRef,
} from '../pluginHost/pluginRef'
import { pluginBlockReason } from '../pluginHost/blocklist'
import type { MessageKey } from '../browser/webview/i18n/messages/en'
import {
  BLOCK,
  bullet,
  bulletBlock,
  key,
  paragraph,
  renderPartsEnglish,
  text,
  title,
} from './systemMessageParts'

// Silence unused-import warning — applyEnabledPluginsPatch may be needed
// by future commands but isn't called directly in this file.
void _applyEnabledPluginsPatch

export { parseMarketplaceSource }

/** Translatable-parts payload a slash handler returns. The caller wraps it
 *  in a localized system message and a `ProcessUserInputResult`. */
export type SlashCommandText = SystemMessagePart[]

/** Context the marketplace/plugin handlers need to do their work.
 *  The slash dispatcher in `processUserInput.ts` builds this from
 *  whatever it has in scope (runtimeConfig + fs implementation). */
export type PluginCommandContext = {
  runtimeConfig: RuntimeConfig
  fs: RuntimeFs
  /** Bridge-resolved user home (`~`) for `~/.velloc/...` path resolution.
   *  REQUIRED in production: the SharedWorker env (`HOME`/`USERPROFILE`) is
   *  empty there, so the env-based `resolveSettingsHomeDir` fallback throws
   *  ("HOME / USERPROFILE not set"). The runtime resolves the real home via the
   *  `fs.userHome` bridge and threads it here. When omitted (tests that set
   *  env HOME on `runtimeConfig`), `buildPathContext` falls back to the env. */
  homeDir?: string
  /** Injected for tests; defaults to `Date.now()` at call time. */
  /** Injected for tests. Returns either an epoch-ms `number` (legacy
   *  call shape — converted to ISO internally) or an ISO 8601 `string`.
   *  Tests can use either form. */
  now?: () => number | string
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------------------
// Top-level dispatchers — called from `processUserInput.ts`'s switch
// ---------------------------------------------------------------------------

/**
 * `/plugin <subcommand> [args]` dispatcher. Returns the parts the caller
 * renders as a localized system message. Falls back to usage text when
 * the subcommand is missing or unknown — never throws.
 */
export async function handlePluginSlashCommand(
  rawArgs: string,
  ctx: PluginCommandContext,
): Promise<SlashCommandText> {
  const { sub, rest } = splitSubcommand(rawArgs)
  if (!sub) return PLUGIN_USAGE
  // `/plugin marketplace <action>` (alias `market`) takes the same
  // subcommands `/marketplace` does.
  if (sub === 'marketplace' || sub === 'market') {
    return handleMarketplaceSlashCommand(rest, ctx)
  }
  try {
    switch (sub) {
      case 'list':
        return await renderPluginList(buildPathContext(ctx), ctx.fs)
      case 'install':
      case 'i':
        return await runPluginInstall(ctx, rest)
      case 'uninstall':
        return await runPluginUninstall(ctx, rest)
      case 'enable':
        return await runPluginEnable(ctx, rest, true)
      case 'disable':
        return await runPluginEnable(ctx, rest, false)
      default:
        return [
          key('slash.out.plugin.unknownSubcommand', { sub }),
          text('\n\n'),
          ...PLUGIN_USAGE,
        ]
    }
  } catch (e) {
    return [key('slash.out.plugin.error', { sub, error: formatError(e) })]
  }
}

/**
 * `/marketplace <subcommand> [args]` dispatcher. Same shape as
 * `handlePluginSlashCommand`.
 */
export async function handleMarketplaceSlashCommand(
  rawArgs: string,
  ctx: PluginCommandContext,
): Promise<SlashCommandText> {
  const { sub, rest } = splitSubcommand(rawArgs)
  // No subcommand → default to `list` (matches `/plugins` no-arg behavior).
  const effectiveSub = sub || 'list'
  try {
    switch (effectiveSub) {
      case 'list':
        return await renderMarketplaceList(buildPathContext(ctx), ctx.fs, nowIsoOf(ctx))
      case 'add':
        return await runMarketplaceAdd(ctx, rest)
      case 'remove':
      case 'rm':
        return await runMarketplaceRemove(ctx, rest)
      case 'update':
        return await runMarketplaceUpdate(ctx, rest)
      case 'info':
        return await runMarketplaceInfo(ctx, rest)
      default:
        return [
          key('slash.out.marketplace.unknownSubcommand', { sub: effectiveSub }),
          text('\n\n'),
          ...MARKETPLACE_USAGE,
        ]
    }
  } catch (e) {
    return [
      key('slash.out.marketplace.error', { sub: effectiveSub, error: formatError(e) }),
    ]
  }
}

// ---------------------------------------------------------------------------
// /plugin subcommands
// ---------------------------------------------------------------------------

const PLUGIN_USAGE: SystemMessagePart[] = [
  text('### /plugin <subcommand> [args]'),
  text(`${BLOCK}- `),
  key('slash.out.plugin.usage.list'),
  text('\n- '),
  key('slash.out.plugin.usage.install'),
  text('\n- '),
  key('slash.out.plugin.usage.installFrom'),
  text('\n- '),
  key('slash.out.plugin.usage.uninstall'),
  text('\n- '),
  key('slash.out.plugin.usage.enable'),
  text('\n- '),
  key('slash.out.plugin.usage.disable'),
  ...paragraph(key('slash.out.plugin.usage.identifierFormat')),
  ...paragraph(key('slash.out.plugin.usage.example')),
  ...paragraph(key('slash.out.plugin.usage.seeAvailable')),
  text(`${BLOCK}- /marketplace info <marketplace>`),
  ...paragraph(key('slash.out.plugin.usage.legacyNote')),
]

async function runPluginInstall(
  ctx: PluginCommandContext,
  rest: string,
): Promise<SlashCommandText> {
  const flag = splitMarketplaceFlag(rest)
  if (flag === 'missing-value') return [key('slash.out.plugin.install.usage')]
  let id = rest.trim()
  const registered: SystemMessagePart[] = []
  if (flag) {
    const resolved = await resolveMarketplaceArg(ctx, flag.marketplace)
    if (!resolved.ok) return resolved.parts
    id = joinPluginRef(flag.name, resolved.name)
    registered.push(...resolved.parts)
  }
  if (!id) return [key('slash.out.plugin.install.usage')]
  const parsed = readStrictPluginRef(id)
  if (!parsed.ok) {
    return [key('slash.out.plugin.invalidIdentifier', { message: parsed.error.message })]
  }
  // Security gate: refuse known-malicious plugins before fetching/installing.
  const blockReason = pluginBlockReason(
    joinPluginRef(parsed.value.name, parsed.value.marketplace),
  )
  if (blockReason) return [...registered, text(blockReason)]
  const pathCtx = buildPathContext(ctx)
  const result = await setupPlugin(
    pathCtx,
    ctx.fs,
    parsed.value.marketplace,
    parsed.value.name,
    {
      nowIso: nowIsoOf(ctx),
      fetchImpl: ctx.fetchImpl,
    },
  )
  return [
    ...registered,
    key('slash.out.plugin.install.success', {
      identifier: result.identifier,
      // `?` fallback matches `formatInstalledEntryLine`'s handling of the
      // same optional field, below.
      version: result.entry.version ?? '?',
    }),
    // Wrap the path in a code span: the message renders as markdown, and a raw
    // Windows path has its separators eaten as escapes (`\.velloc` → `.velloc`).
    text('\n  '),
    key('slash.out.plugin.install.fileCount', {
      count: result.fileCount,
      path: result.entry.installPath,
    }),
    text('\n\n'),
    key('slash.out.plugin.install.liveNote'),
  ]
}

async function runPluginUninstall(
  ctx: PluginCommandContext,
  rest: string,
): Promise<SlashCommandText> {
  const id = rest.trim()
  if (!id) return [key('slash.out.plugin.uninstall.usage')]
  const parsed = readStrictPluginRef(id)
  if (!parsed.ok) {
    return [key('slash.out.plugin.invalidIdentifier', { message: parsed.error.message })]
  }
  const pathCtx = buildPathContext(ctx)
  const result = await teardownPlugin(
    pathCtx,
    { homeDir: pathCtx.homeDir },
    ctx.fs,
    id,
  )
  if (!result.registryHadEntry) {
    return [key('slash.out.plugin.uninstall.notInstalled', { id })]
  }
  const parts: SystemMessagePart[] = [key('slash.out.plugin.uninstall.success', { id })]
  if (result.formerInstallPath) {
    parts.push(
      text('\n'),
      key('slash.out.plugin.uninstall.cacheNote', { path: result.formerInstallPath }),
    )
  }
  return parts
}

async function runPluginEnable(
  ctx: PluginCommandContext,
  rest: string,
  enabled: boolean,
): Promise<SlashCommandText> {
  const verb = enabled ? 'enable' : 'disable'
  const id = rest.trim()
  if (!id) return [key('slash.out.plugin.enableDisable.usage', { verb })]
  const parsed = readStrictPluginRef(id)
  if (!parsed.ok) {
    return [key('slash.out.plugin.invalidIdentifier', { message: parsed.error.message })]
  }
  const pathCtx = buildPathContext(ctx)
  await setPluginEnabled(
    { homeDir: pathCtx.homeDir },
    ctx.fs,
    id,
    enabled,
  )
  return [
    key(enabled ? 'slash.out.plugin.enabledConfirm' : 'slash.out.plugin.disabledConfirm', { id }),
    text('\n'),
    key('slash.out.plugin.effectNow'),
  ]
}

async function renderPluginList(
  pathCtx: PluginInstallPathContext,
  fs: RuntimeFs,
): Promise<SlashCommandText> {
  const { registry } = await loadInstalledPlugins(pathCtx, fs)
  const enabledMap = await getEnabledPluginsMap({ homeDir: pathCtx.homeDir }, fs)
  // V2 registry shape: `plugins[id]` is an array of per-scope entries.
  // Flatten to (id, entry) pairs for rendering. v1 nexus user-scope only,
  // so every array is length 1 in practice.
  const flat: Array<{ id: string; entry: InstalledPluginEntry }> = []
  for (const [id, entries] of Object.entries(registry.plugins)) {
    if (!entries || entries.length === 0) continue
    flat.push({ id, entry: entries[0]! })
  }
  if (flat.length === 0) {
    return [
      key('slash.out.plugin.list.empty'),
      text(`${BLOCK}- `),
      key('slash.out.plugin.list.installHint'),
      text('\n- '),
      key('slash.out.plugin.list.marketplacesHint'),
      ...paragraph(key('slash.out.plugin.list.scopeNote')),
    ]
  }
  flat.sort(compareFlatEntries)
  return [
    ...title(key('slash.out.plugin.list.header', { count: flat.length })),
    ...bulletBlock(
      flat.map(({ id, entry }) => formatInstalledEntryLine(id, entry, enabledMap)),
    ),
  ]
}

function compareFlatEntries(
  a: { id: string; entry: InstalledPluginEntry },
  b: { id: string; entry: InstalledPluginEntry },
): number {
  return a.id.localeCompare(b.id)
}

function formatInstalledEntryLine(
  id: string,
  entry: InstalledPluginEntry,
  enabledMap: Record<string, boolean>,
): string {
  const override = enabledMap[id]
  let stateLabelKey: MessageKey
  if (override === false) stateLabelKey = 'slash.out.plugin.state.disabled'
  else if (override === true) stateLabelKey = 'slash.out.plugin.state.enabledExplicit'
  else stateLabelKey = 'slash.out.plugin.state.enabledDefault'
  const stateLabel = englishOf(stateLabelKey)
  const shaPart = entry.gitCommitSha
    ? `, sha ${entry.gitCommitSha.slice(0, 8)}`
    : ''
  return bullet(`**${id}** v${entry.version ?? '?'} [${stateLabel}${shaPart}]`)
}

// ---------------------------------------------------------------------------
// /marketplace subcommands
// ---------------------------------------------------------------------------

const MARKETPLACE_USAGE: SystemMessagePart[] = [
  text('### /marketplace <subcommand> [args]'),
  text(`${BLOCK}- `),
  key('slash.out.marketplace.usage.list'),
  text('\n- '),
  key('slash.out.marketplace.usage.add'),
  text('\n- '),
  key('slash.out.marketplace.usage.remove'),
  text('\n- '),
  key('slash.out.marketplace.usage.update'),
  text('\n- '),
  key('slash.out.marketplace.usage.info'),
  text(`${BLOCK}**`),
  key('slash.out.marketplace.usage.defaultsHeading'),
  text(`**${BLOCK}- `),
  key('slash.out.marketplace.usage.officialLine'),
  text('\n- '),
  key('slash.out.marketplace.usage.communityLine'),
  text(`${BLOCK}**`),
  key('slash.out.marketplace.usage.exampleHeading'),
  text(`**${BLOCK}- /marketplace add https://github.com/obra/superpowers\n- /plugin install superpowers@superpowers-dev`),
]

async function renderMarketplaceList(
  pathCtx: PluginInstallPathContext,
  fs: RuntimeFs,
  nowIso: string,
): Promise<SlashCommandText> {
  const { registry } = await loadKnownMarketplaces(pathCtx, fs, nowIso)
  // V2 shape: registry is a bare top-level record keyed by marketplace
  // name (no `marketplaces:` wrapper).
  const entries = Object.entries(registry).sort(
    ([a], [b]) => a.localeCompare(b),
  )
  if (entries.length === 0) {
    return [key('slash.out.marketplace.list.emptyUnexpected')]
  }
  return [
    ...title(key('slash.out.marketplace.list.header', { count: entries.length })),
    ...bulletBlock(
      entries.map(([name, entry]) => formatMarketplaceLine(name, entry)),
    ),
    ...paragraph(key('slash.out.marketplace.list.footer')),
  ]
}

function formatMarketplaceLine(
  name: string,
  entry: KnownMarketplaceEntry,
): string {
  const official = isCuratedCatalog(name)
    ? ` ${englishOf('slash.out.marketplace.officialTag')}`
    : isBuiltinMarketplace(name)
      ? ` ${englishOf('slash.out.marketplace.builtinTag')}`
      : ''
  const source = describeSource(entry)
  // `lastUpdated` is an ISO 8601 string. Epoch-zero sentinel
  // (year 1970) renders as "not yet fetched" so a freshly-seeded entry
  // that's never been refreshed doesn't show a misleading timestamp.
  const isEpochZero = entry.lastUpdated.startsWith('1970-')
  const fetched = isEpochZero
    ? englishOf('slash.out.marketplace.notYetFetched')
    : englishOf('slash.out.marketplace.lastUpdated', { time: formatIsoTime(entry.lastUpdated) })
  return bullet(`**${name}**${official} ${source}${fetched}`)
}

function describeSource(entry: KnownMarketplaceEntry): string {
  const s = entry.source
  switch (s.source) {
    case 'github':
      return `github:${s.repo}`
    case 'url':
      return `url:${s.url}`
    case 'https':
      return `https:${s.url}`
    case 'git-subdir':
      return `git-subdir:${s.url}/${s.path}`
    case 'local':
      return `local:./${s.path}`
    case 'directory':
      return `directory:${s.path}`
    case 'inline':
      return 'inline:<embedded>'
  }
}

async function runMarketplaceAdd(
  ctx: PluginCommandContext,
  rest: string,
): Promise<SlashCommandText> {
  const raw = rest.trim()
  if (!raw) {
    return [key('slash.out.marketplace.add.usage')]
  }
  const source = parseMarketplaceSource(raw)
  if (!source) {
    return [key('slash.out.marketplace.add.parseError', { value: raw })]
  }
  const added = await registerMarketplace(ctx, source)
  if (!added.ok) return added.parts
  return [
    ...addedLines(added.name, source, added.pluginCount),
    text('\n\n'),
    key('slash.out.marketplace.add.browseHint', { name: added.name }),
    text('\n'),
    key('slash.out.marketplace.add.installHint', { name: added.name }),
  ]
}

type ParsedMarketplaceOrigin = NonNullable<ReturnType<typeof parseMarketplaceSource>>

type RegisterOutcome =
  | { ok: true; name: string; pluginCount: number }
  | { ok: false; parts: SystemMessagePart[] }

/** Registers `source`, fetches it, and files it under the name its
 *  marketplace.json declares. A failed fetch leaves nothing registered. */
async function registerMarketplace(
  ctx: PluginCommandContext,
  source: ParsedMarketplaceOrigin,
): Promise<RegisterOutcome> {
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const outcome = await registerMarketplaceSource(buildPathContext(ctx), ctx.fs, source, nowIsoOf(ctx), fetchImpl)
  if (outcome.ok) return outcome
  const error = formatError(outcome.error)
  switch (outcome.stage) {
    case 'register':
      return { ok: false, parts: [key('slash.out.marketplace.add.registerFailed', { error })] }
    case 'fetch':
      return {
        ok: false,
        parts: [
          key('slash.out.marketplace.add.fetchFailed', {
            source: describeSource({ source } as KnownMarketplaceEntry),
            error,
          }),
        ],
      }
    case 'rename':
      return {
        ok: false,
        parts: [key('slash.out.marketplace.add.renameCleanupFailed', { name: outcome.name, error })],
      }
    case 'nameTaken':
      return { ok: false, parts: [key('slash.out.marketplace.add.nameTaken', { name: outcome.name })] }
    case 'nameRefused':
      return { ok: false, parts: [key('slash.out.marketplace.add.nameRefused', { name: outcome.name, error })] }
  }
}

function addedLines(name: string, source: ParsedMarketplaceOrigin, pluginCount: number): SystemMessagePart[] {
  return [
    key('slash.out.marketplace.add.success', { name }),
    text('\n  '),
    key('slash.out.marketplace.add.sourceLine', {
      source: describeSource({ source } as KnownMarketplaceEntry),
    }),
    text('\n  '),
    key('slash.out.marketplace.add.pluginsAvailable', { count: pluginCount }),
  ]
}

/** `<name> --marketplace <value>` (or `--marketplace=<value>`, either order)
 *  → its two parts; `null` when the flag is absent, `'missing-value'` when
 *  the value or the plugin name is missing. */
export function splitMarketplaceFlag(
  rest: string,
): { name: string; marketplace: string } | 'missing-value' | null {
  const words = rest.trim().split(/\s+/).filter(Boolean)
  const at = words.findIndex(w => w === '--marketplace' || w.startsWith('--marketplace='))
  if (at === -1) return null
  const word = words[at]!
  const inline = word.startsWith('--marketplace=')
  const marketplace = inline ? word.slice('--marketplace='.length) : (words[at + 1] ?? '')
  const others = words.filter((_, i) => i !== at && (inline || i !== at + 1))
  if (!marketplace || others.length !== 1) return 'missing-value'
  return { name: others[0]!, marketplace }
}

type ResolvedMarketplace =
  | { ok: true; name: string; parts: SystemMessagePart[] }
  | { ok: false; parts: SystemMessagePart[] }

/** A `--marketplace` value: a registered name as it is, or a GitHub source —
 *  the marketplace already registered from that repository, else a new
 *  registration, which `parts` reports. */
async function resolveMarketplaceArg(
  ctx: PluginCommandContext,
  value: string,
): Promise<ResolvedMarketplace> {
  const source = parseMarketplaceSource(value)
  if (!source) {
    if (value.includes('/') || value.includes(':')) {
      return { ok: false, parts: [key('slash.out.marketplace.add.parseError', { value })] }
    }
    return { ok: true, name: value, parts: [] }
  }
  const repo = githubRepoOf(source)
  const { registry } = await loadKnownMarketplaces(buildPathContext(ctx), ctx.fs, nowIsoOf(ctx))
  for (const [name, entry] of Object.entries(registry)) {
    const known = entry.source
    if (known.source !== 'github' && known.source !== 'url') continue
    if (repo !== null && githubRepoOf(known) === repo) return { ok: true, name, parts: [] }
  }
  const added = await registerMarketplace(ctx, source)
  if (!added.ok) return added
  return {
    ok: true,
    name: added.name,
    parts: [...addedLines(added.name, source, added.pluginCount), text('\n\n')],
  }
}

async function runMarketplaceRemove(
  ctx: PluginCommandContext,
  rest: string,
): Promise<SlashCommandText> {
  const name = rest.trim()
  if (!name) return [key('slash.out.marketplace.remove.usage')]
  if (isCuratedCatalog(name)) {
    return [key('slash.out.marketplace.remove.official', { name })]
  }
  if (isBuiltinMarketplace(name)) {
    return [key('slash.out.marketplace.remove.builtin', { name })]
  }
  await removeMarketplace(buildPathContext(ctx), ctx.fs, name, nowIsoOf(ctx))
  return [key('slash.out.marketplace.remove.success', { name })]
}

async function runMarketplaceUpdate(
  ctx: PluginCommandContext,
  rest: string,
): Promise<SlashCommandText> {
  const name = rest.trim()
  if (!name) return [key('slash.out.marketplace.update.usage')]
  const result = await refreshMarketplace(
    buildPathContext(ctx),
    ctx.fs,
    name,
    nowIsoOf(ctx),
    ctx.fetchImpl ?? globalThis.fetch.bind(globalThis),
  )
  const sha = result.sha ? `, sha ${result.sha.slice(0, 8)}` : ''
  return [
    key('slash.out.marketplace.update.success', { name, sha }),
    text('\n  '),
    key('slash.out.marketplace.add.pluginsAvailable', {
      count: result.marketplace.plugins.length,
    }),
  ]
}

async function runMarketplaceInfo(
  ctx: PluginCommandContext,
  rest: string,
): Promise<SlashCommandText> {
  const name = rest.trim()
  if (!name) return [key('slash.out.marketplace.info.usage')]
  const pathCtx = buildPathContext(ctx)
  // Pick a plugin name that's guaranteed not to match anything in the
  // marketplace, just to trigger the manifest load. The resolve helper
  // already loads + parses the full manifest.
  const sentinel = await resolvePluginInMarketplace(
    pathCtx, ctx.fs, name, '__manifest_probe__',
  )
  // The helper returns the matched entry or null. Reading the full
  // listing through a separate helper would be cleaner — for v1 we
  // re-read the manifest directly via the same path. Tradeoff: one
  // extra fs.read but no new export needed.
  const { parseMarketplaceManifest } = await import(
    '../pluginHost/marketplaces'
  )
  const { getMarketplaceManifestPath } = await import(
    '../pluginHost/pluginDirs'
  )
  let raw: string
  try {
    raw = await ctx.fs.readFile(
      getMarketplaceManifestPath(pathCtx, name),
      { encoding: 'utf-8' },
    )
  } catch {
    return [
      key('slash.out.marketplace.info.notFetched', { name }),
      text('\n'),
      key('slash.out.marketplace.info.runUpdateHint', { name }),
    ]
  }
  const manifest = parseMarketplaceManifest(raw, name)
  void sentinel
  // Off the beta channel a beta-only listing is not shown.
  manifest.plugins = listingsVisibleOn(manifest.plugins, currentTemplateChannel())
  if (manifest.plugins.length === 0) {
    return [key('slash.out.marketplace.info.zeroPlugins', { name })]
  }
  const noDescription = englishOf('slash.out.marketplace.info.noDescription')
  const parts: SystemMessagePart[] = [
    key('slash.out.marketplace.info.header', {
      name,
      description: manifest.description ?? noDescription,
    }),
    text('\n'),
    key('slash.out.marketplace.info.countLine', { count: manifest.plugins.length }),
    text('\n\n'),
  ]
  // Cap to keep the output reasonable; user can grep the manifest
  // directly if they need the full list.
  const cap = 50
  const rows = manifest.plugins.slice(0, cap).map(p => {
    const cat = p.category ? ` [${p.category}]` : ''
    const desc = p.description ?? noDescription
    return `  ${p.name}${cat}  ${desc}`
  })
  parts.push(text(rows.join('\n')))
  if (manifest.plugins.length > cap) {
    parts.push(
      text('\n\n'),
      key('slash.out.marketplace.info.moreCount', { count: manifest.plugins.length - cap }),
    )
  }
  parts.push(
    text('\n\n'),
    key('slash.out.marketplace.add.installHint', { name }),
  )
  return parts
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitSubcommand(rawArgs: string): {
  sub: string
  rest: string
} {
  const trimmed = rawArgs.trim()
  if (!trimmed) return { sub: '', rest: '' }
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return { sub: trimmed.toLowerCase(), rest: '' }
  return {
    sub: trimmed.slice(0, spaceIdx).toLowerCase(),
    rest: trimmed.slice(spaceIdx + 1).trim(),
  }
}

function buildPathContext(ctx: PluginCommandContext): PluginInstallPathContext {
  // Prefer the bridge-resolved home threaded from the runtime; only fall back to
  // the env-based resolver (which THROWS when HOME/USERPROFILE are unset — always
  // the case in the production SharedWorker) for tests that set env HOME on the
  // runtimeConfig and don't thread a homeDir.
  return { homeDir: ctx.homeDir ?? resolveSettingsHomeDir(ctx.runtimeConfig) }
}

/** Resolve an ISO 8601 timestamp for the current op. Accepts both legacy
 *  number (epoch ms) and string (ISO) test injections; production calls
 *  use `new Date().toISOString()`. Install pipeline timestamps are ISO
 *  strings end-to-end. */
function nowIsoOf(ctx: PluginCommandContext): string {
  if (!ctx.now) return new Date().toISOString()
  const value = ctx.now()
  if (typeof value === 'string') return value
  return new Date(value).toISOString()
}

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Render a single catalog key to English, for embedding as a value inside a
 * data-heavy row (a plugin/marketplace listing line) that is itself composed
 * as literal `text()` — same tradeoff `dispatchCommandInput.ts`'s `/tabs`
 * case makes for its `(untitled)`/`(no url)` placeholders: the row is a
 * machine-ish record, so the fragment is fixed at construction time rather
 * than re-translated per viewer locale.
 */
function englishOf(k: MessageKey, params?: Record<string, string | number>): string {
  return renderPartsEnglish([key(k, params)])
}

function formatIsoTime(iso: string): string {
  // Pure formatter — no `Date.now()` call (tests can't predict the
  // current time otherwise). Returns the ISO date compact form ("YYYY-MM-DD HH:MM:SS");
  // a future pass can swap in "5 minutes ago" prose.
  try {
    return iso.slice(0, 19).replace('T', ' ')
  } catch {
    return iso
  }
}
