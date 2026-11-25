/**
 * Worker-side handlers for the `plugins` bridge namespace (SharedWorker, NOT
 * routed to C++): bridge envelopes to install-pipeline ops. The registry's
 * per-id arrays are flattened on read, `name` / `marketplace` from the key.
 */

import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  PluginAvailableUiEntry,
  PluginInstalledUiEntry,
  PluginMarketplaceUiEntry,
  PluginsBridgeActionMap,
} from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import {
  applyEnabledPluginsPatch,
  getEnabledPluginsMap,
  setPluginEnabled,
} from '../../../pluginHost/enabledPlugins'
import { PluginNotListedError, setupPlugin, teardownPlugin } from '../../../pluginHost/installSteps'
import {
  removeLocalPlugin,
  setLocalPluginEnabled,
} from '../../../pluginHost/localPluginRemove'
import { listLocalPlugins, localCopiesShadowing } from '../../../pluginHost/localPluginList'
import { forgetModBuilds } from '../../../mods/modBuildStore'
import { forgetPluginWebProfiles } from '../../../mods/provider/webProfilesRuntime'
import { pluginNamed } from '../../../pluginHost/pluginNamed'
import { RUNTIME_DIR_NAME } from '../../../branding/runtimeDir'
import { joinRuntimePath } from '../../../utils/runtimePaths'
import { sanitizeWorkspaceState } from '../../../utils/workspaceState'
import { WORKSPACE_STATE_FILE } from '../../runtimeHub/workspaceCapability'
import { loadInstalledPlugins } from '../../../pluginHost/installedRegistry'
import { describeInstalledPlugin } from '../../../pluginHost/loadPlugins'
import {
  fetchCatalogListing,
  listingsVisibleOn,
  loadKnownMarketplaces,
  parseMarketplaceManifest,
  removeMarketplace,
  withMarketplaceContent,
} from '../../../pluginHost/marketplaces'
import { githubRepoOf, parseMarketplaceSource, registerMarketplaceSource } from '../../../pluginHost/marketplaceRegister'
import { directoryFallbackName, installFromDirectory } from '../../../pluginHost/directoryInstall'
import { DIRECTORY_CATALOG_KEY } from '../../../pluginHost/directoryListings'
import { builtinMarketplaceOriginDir, isBuiltinMarketplace } from '../../../pluginHost/builtinMarketplace'
import { listingInstalls, resolveListingTheme } from '../../../pluginHost/themeListing'
import type { CatalogListing } from '../../../pluginHost/registryFormats'
import { currentTemplateChannel, type UpdateChannel } from '../../../branding/updateChannels'
import { pluginBlockReason } from '../../../pluginHost/blocklist'
import { getPluginConfigsMap, mergePluginOptions, readPluginManifests } from '../../../pluginHost/pluginConfigs'
import { declaredSettings, missingRequiredSettings, settingValueProblems } from '../../../pluginHost/requiredSettings'
import {
  isCuratedCatalog,
  joinPluginRef,
  readStrictPluginRef,
  splitPluginRef,
} from '../../../pluginHost/pluginRef'
import {
  getMarketplaceManifestPath,
  type PluginInstallPathContext,
} from '../../../pluginHost/pluginDirs'
import type {
  InstalledPluginsFile,
  PluginSetupRecord,
} from '../../../pluginHost/registryFormats'
import { createBridgeBackedFetch } from '../../../pluginHost/bridgeBackedFetch'
import { keepOneThemePlugin, themePluginName } from '../../../mods/themePlugins'
import { enableSwitchKey, type ThemeSwitchBoard, type ThemeSwitchRun } from '../../../mods/themeSwitch'
import type { BrowserBridgeTransport } from '../protocol/core'

export type PluginsAdapterContext = {
  /** Same `{ homeDir }` the install pipeline + settings module use. */
  homeDir: string
  /** Worker-side `RuntimeFs`. Bridge-backed in production. */
  fs: RuntimeFs
  /** Injected for tests; defaults to `new Date().toISOString()` at call time. */
  now?: () => string
  /** The channel listings are filtered for (`betaOnly`); defaults to the realm's. */
  channel?: () => UpdateChannel
  /** Injected for tests. In production, leave undefined and pass
   *  `directBridge` instead — the adapter derives a CSP-bypassing
   *  fetch via `network.httpGet`. */
  fetchImpl?: typeof fetch
  /** Direct-bridge transport to C++. When set AND `fetchImpl` is not
   *  provided, the adapter routes plugin/marketplace downloads through
   *  `network.httpGet` instead of the SharedWorker's blocked
   *  `globalThis.fetch`. This is the production path — without it,
   *  every install request fails CSP with "Failed to fetch". */
  directBridge?: BrowserBridgeTransport | null
  /** Hot-reload every active session after an install, uninstall or
   *  enable/disable write. Wired by `initBuiltinHandlers` to
   *  `WebUiBridgeContext.reloadPluginsOnAllSessions`. Plugin
   *  enable/disable hot-reloads (never a session restart) — and an installed
   *  mod loads, an uninstalled one unloads, in the sessions already open.
   *  Optional — unit tests omit it; the enabled map is still persisted, so a
   *  fresh session picks the change up at boot. */
  reloadPluginsOnAllSessions?: () => void
  /** Where switching a theme plugin on or off shows its steps (F-25). */
  themeSwitches?: ThemeSwitchBoard
}

export type PluginsAction = keyof PluginsBridgeActionMap

// ---------------------------------------------------------------------------
// Individual handlers — typed; tested directly
// ---------------------------------------------------------------------------

/**
 * `plugins/listInstalled` — flatten the V2 array-per-id registry, merge
 * with the user's `enabledPlugins` map from settings.json. UI gets every
 * field it needs to render the installed-plugins list without a second
 * round-trip, including the enabled local copies that replace a row.
 */
async function handleListInstalled(
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['listInstalled']['result']> {
  const pathCtx = pathContextOf(ctx)
  const { registry } = await loadInstalledPlugins(pathCtx, ctx.fs)
  const enabledMap = await getEnabledPluginsMap(
    { homeDir: ctx.homeDir }, ctx.fs,
  )
  const flat = flattenRegistryForUi(registry, enabledMap)
  const localRoots = await listLocalPlugins({ homeDir: ctx.homeDir, projects: await sidebarProjects(ctx), fs: ctx.fs })
  return {
    plugins: await Promise.all(flat.map(async entry => {
      const shadows = localCopiesShadowing(localRoots, entry.name)
      const withFacts = await withPluginFacts(entry, ctx.fs)
      return shadows.length > 0 ? { ...withFacts, shadowedBy: shadows } : withFacts
    })),
  }
}

/** The sidebar's project folders (`~/.velloc/workspace-state.json`): the
 *  host's own list, never paths a client names. Empty when there is none. */
async function sidebarProjects(ctx: PluginsAdapterContext): Promise<string[]> {
  try {
    const text = await ctx.fs.readFile(
      joinRuntimePath(ctx.homeDir, RUNTIME_DIR_NAME, WORKSPACE_STATE_FILE),
      { encoding: 'utf-8' },
    )
    return sanitizeWorkspaceState(JSON.parse(text)).projects.map(project => project.path)
  } catch {
    return []
  }
}

/** An installed row with what its files say — description, and whether it
 *  is a mod — so the list need not wait for a session to load it. */
async function withPluginFacts(
  entry: PluginInstalledUiEntry,
  fs: RuntimeFs,
): Promise<PluginInstalledUiEntry> {
  if (!entry.installPath) return entry
  const facts = await describeInstalledPlugin(fs, entry.installPath)
  return {
    ...entry,
    ...(facts.description !== undefined ? { description: facts.description } : {}),
    ...(facts.hasModules ? { isMod: true } : {}),
  }
}

const channelOf = (ctx: PluginsAdapterContext): UpdateChannel => (ctx.channel ?? currentTemplateChannel)()

/**
 * `plugins/listMarketplaces` — every entry in `known_marketplaces.json`
 * (a bare top-level record) with the `isOfficial` flag derived
 * from the hardcoded official-names set.
 */
async function handleListMarketplaces(
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['listMarketplaces']['result']> {
  const pathCtx = pathContextOf(ctx)
  const nowIso = nowOf(ctx)
  const { registry } = await loadKnownMarketplaces(pathCtx, ctx.fs, nowIso)
  const marketplaces: PluginMarketplaceUiEntry[] = Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      ...entry,
      name,
      isOfficial: isCuratedCatalog(name),
      isBuiltin: isBuiltinMarketplace(name),
    }))
  return { marketplaces }
}

/**
 * `plugins/listMarketplacePlugins` — a marketplace's local `marketplace.json`
 * entries (`manifest: null` when absent). Served at `observe`: never fetches or writes.
 */
async function handleListMarketplacePlugins(
  payload: PluginsBridgeActionMap['listMarketplacePlugins']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['listMarketplacePlugins']['result']> {
  const pathCtx = pathContextOf(ctx)
  const manifestPath = getMarketplaceManifestPath(
    pathCtx, payload.marketplace,
  )
  let raw: string
  try {
    raw = await ctx.fs.readFile(manifestPath, { encoding: 'utf-8' })
  } catch {
    return { marketplace: payload.marketplace, manifest: null }
  }
  const manifest = parseMarketplaceManifest(raw, payload.marketplace)
  const enriched = await listedEntries(
    ctx, payload.marketplace, listingsVisibleOn(manifest.plugins, channelOf(ctx)), payload.kind === 'themes' ? 'themes' : 'plugins',
  )
  return {
    marketplace: payload.marketplace,
    manifest: {
      name: manifest.name,
      description: manifest.description,
      owner: manifest.owner,
      plugins: enriched,
    },
  }
}

/**
 * The entries one listing kind shows, with `installed` merged in. Only the
 * built-in marketplace has theme listings: `plugins` leaves them out and
 * `themes` is them alone, each preview an absolute address; a theme also
 * counts as installed when the same code is installed from elsewhere.
 * Anywhere else a `theme` block is not honoured and the listing is an
 * ordinary plugin.
 */
async function listedEntries(
  ctx: PluginsAdapterContext,
  marketplace: string,
  visible: readonly CatalogListing[],
  kind: 'plugins' | 'themes',
): Promise<PluginAvailableUiEntry[]> {
  const pathCtx = pathContextOf(ctx)
  const builtin = isBuiltinMarketplace(marketplace)
  if (kind === 'themes' && !builtin) return []
  const { registry: installed } = await loadInstalledPlugins(pathCtx, ctx.fs)
  const entryOf = (
    listing: CatalogListing,
    refs: readonly string[] = [joinPluginRef(listing.name, marketplace)],
  ): PluginAvailableUiEntry => ({
    ...listing,
    installed: refs.some(ref => Object.hasOwn(installed.plugins, ref)),
  })
  if (!builtin) return visible.map(({ theme: _notHonoured, ...listing }) => entryOf(listing))
  if (kind === 'plugins') return visible.filter(listing => !listing.theme).map(listing => entryOf(listing))
  const { registry } = await loadKnownMarketplaces(pathCtx, ctx.fs, nowOf(ctx))
  const record = Object.entries(registry).find(([name]) => isBuiltinMarketplace(name))?.[1]
  const originDir = record ? builtinMarketplaceOriginDir(record.source) : null
  return visible.flatMap(listing =>
    listing.theme
      ? [
          entryOf(
            { ...listing, theme: resolveListingTheme(listing.theme, originDir) },
            listingInstalls(installed.plugins, listing, marketplace),
          ),
        ]
      : [],
  )
}

async function handleInstall(
  payload: PluginsBridgeActionMap['install']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['install']['result']> {
  const pathCtx = pathContextOf(ctx)
  const parsed = parseIdentifierOrThrow(payload.identifier)
  // Security gate: refuse known-malicious plugins before fetching/installing.
  // Both slash-command install paths run the same check
  // (pluginBlockReason); without it the React settings UI — the primary install
  // surface — is a blocklist bypass.
  const blockReason = pluginBlockReason(
    joinPluginRef(parsed.name, parsed.marketplace),
  )
  if (blockReason) {
    throw new Error(blockReason)
  }
  let result: Awaited<ReturnType<typeof setupPlugin>>
  try {
    result = await setupPlugin(
      pathCtx, ctx.fs,
      parsed.marketplace, parsed.name,
      {
        nowIso: nowOf(ctx),
        fetchImpl: pickFetch(ctx),
        freshListing: true,
      },
    )
  } catch (error) {
    if (error instanceof PluginNotListedError) return { ok: false, reason: 'notListed' }
    throw error
  }
  const run = await startThemeSwitch(ctx, true, { plugin: parsed.name })
  run?.record({ kind: 'turnOn', plugin: parsed.name })
  await keepOneTheme(ctx, { plugin: parsed.name }, run)
  if (run && ctx.themeSwitches) run.finishUnlessJoined(ctx.themeSwitches.joinMs)
  const enabledMap = await getEnabledPluginsMap(
    { homeDir: ctx.homeDir }, ctx.fs,
  )
  // The sessions already open load it now — a mod's hooks run without a new
  // session, as `/plugin install` followed by `/reload-plugins` would.
  ctx.reloadPluginsOnAllSessions?.()
  return {
    ok: true,
    entry: await withPluginFacts(
      mergeEnabledForUi(payload.identifier, result.entry, enabledMap),
      ctx.fs,
    ),
    fileCount: result.fileCount,
  }
}

/**
 * `plugins/installFromDirectory` — the record's reviewed commit, straight
 * from its repository. The blocklist is asked for the name the record's
 * fallback installs under before anything is fetched, and for the name the
 * manifest gives before anything is written.
 */
async function handleInstallFromDirectory(
  payload: PluginsBridgeActionMap['installFromDirectory']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['installFromDirectory']['result']> {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const spec = {
    manifestName: text(payload?.manifestName),
    apiOrigin: text(payload?.apiOrigin),
    repositoryUrl: text(payload?.repositoryUrl),
    ...(text(payload?.path) ? { path: text(payload?.path) } : {}),
    commit: text(payload?.commit),
    fallbackName: text(payload?.fallbackName),
  }
  const early = pluginBlockReason(joinPluginRef(directoryFallbackName(spec.fallbackName), DIRECTORY_CATALOG_KEY))
  if (early) throw new Error(early)
  const pathCtx = pathContextOf(ctx)
  const result = await installFromDirectory(pathCtx, ctx.fs, spec, {
    fetchImpl: pickFetch(ctx),
    nowIso: nowOf(ctx),
    refuse: pluginBlockReason,
  })
  const enabledMap = await getEnabledPluginsMap({ homeDir: ctx.homeDir }, ctx.fs)
  ctx.reloadPluginsOnAllSessions?.()
  return {
    ok: true,
    identifier: result.identifier,
    entry: await withPluginFacts(mergeEnabledForUi(result.identifier, result.entry, enabledMap), ctx.fs),
    fileCount: result.fileCount,
  }
}

/** A plugin switched on or off, or removed: its generated module builds
 *  (`~/.velloc/mods/.builds/`, `modBuildStore.ts`) go, so its next load builds
 *  afresh — and nothing else of it (configuration, `$.store`, settings). A
 *  running session drops them itself too; this covers a switch made while
 *  none runs. */
function forgetBuilds(ctx: PluginsAdapterContext, which: { plugin?: string; root?: string }): Promise<void> {
  return forgetModBuilds(ctx.fs, joinRuntimePath(ctx.homeDir, RUNTIME_DIR_NAME, 'mods'), which).catch(() => undefined)
}

/** A theme plugin just switched on: with *Only one at a time* on, the others
 *  go off. The caller's own reload loads the result. */
function keepOneTheme(
  ctx: PluginsAdapterContext,
  which: { plugin: string } | { root: string },
  run?: ThemeSwitchRun,
): Promise<number> {
  return keepOneThemePlugin(
    {
      homeDir: ctx.homeDir,
      fs: ctx.fs,
      reload: () => {},
      ...(run ? { onOff: (plugins: string[]) => run.record({ kind: 'turnOff', plugins }) } : {}),
    },
    which,
  )
}

/**
 * A switch on the board when `which` is a theme plugin: an enable is left
 * open for the plugin's own command to carry on (`theme.onEnable`).
 */
async function startThemeSwitch(
  ctx: PluginsAdapterContext,
  enabling: boolean,
  which: { plugin: string } | { root: string },
): Promise<ThemeSwitchRun | undefined> {
  if (!ctx.themeSwitches) return undefined
  const plugin = await themePluginName(ctx.homeDir, ctx.fs, which)
  if (plugin === null) return undefined
  return enabling
    ? ctx.themeSwitches.start({ kind: 'enable', plugin }, enableSwitchKey(plugin))
    : ctx.themeSwitches.start({ kind: 'disable', plugin })
}

/** Ends `run` once its plugin is switched: an enable waits a moment for its command to join it. */
function settleThemeSwitch(ctx: PluginsAdapterContext, run: ThemeSwitchRun | undefined, enabling: boolean): void {
  if (!run || !ctx.themeSwitches) return
  if (enabling) run.finishUnlessJoined(ctx.themeSwitches.joinMs)
  else run.finish({ ok: true })
}

/** `<name>@<marketplace>` → `<name>`. */
const pluginNameOf = (identifier: string) => identifier.slice(0, Math.max(0, identifier.lastIndexOf('@'))) || identifier

async function handleUninstall(
  payload: PluginsBridgeActionMap['uninstall']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['uninstall']['result']> {
  const pathCtx = pathContextOf(ctx)
  const result = await teardownPlugin(
    pathCtx, { homeDir: ctx.homeDir }, ctx.fs,
    payload.identifier,
    {
      clearEnabledOverride: payload.clearEnabledOverride !== false,
    },
  )
  await forgetBuilds(ctx, { plugin: pluginNameOf(payload.identifier) })
  if (result.registryHadEntry) {
    await forgetPluginWebProfiles({ ...ctx, stillInstalled: name => pluginNamed(ctx, name) }, pluginNameOf(payload.identifier))
  }
  // The sessions already open drop it now — an uninstalled mod's hooks stop.
  ctx.reloadPluginsOnAllSessions?.()
  return { ok: true, registryHadEntry: result.registryHadEntry }
}

/** `plugins/removeLocal` — a directory plugin's folder goes (the guard is
 *  `removeLocalPlugin`'s), then every session reloads its plugins so its
 *  hooks module unloads at once. */
async function handleRemoveLocal(
  payload: PluginsBridgeActionMap['removeLocal']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['removeLocal']['result']> {
  const { name } = await removeLocalPlugin(payload.path, ctx.fs)
  await forgetBuilds(ctx, { root: payload.path })
  await forgetPluginWebProfiles({ ...ctx, stillInstalled: plugin => pluginNamed(ctx, plugin) }, name)
  ctx.reloadPluginsOnAllSessions?.()
  return { ok: true, name }
}

/** `plugins/listLocal` — the directory plugins of the user root and of every
 *  project in the sidebar (`~/.velloc/workspace-state.json`). The projects are
 *  the host's own list, never paths a client names. */
async function handleListLocal(
  payload: PluginsBridgeActionMap['listLocal']['payload'] | undefined,
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['listLocal']['result']> {
  const locale = typeof payload?.locale === 'string' ? payload.locale : undefined
  const projects = await sidebarProjects(ctx)
  return { roots: await listLocalPlugins({ homeDir: ctx.homeDir, projects, fs: ctx.fs, ...(locale ? { locale } : {}) }) }
}

/** `plugins/listBuiltin` — the product's built-in mods, each with whether it
 *  loads: settings.json `enabledPlugins["<name>@builtin"]` when set, its
 *  default otherwise. Listed whether loaded or not, so one that is off can be
 *  turned on (`setEnabled` on its identifier). */
async function handleListBuiltin(
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['listBuiltin']['result']> {
  const [{ registerBundledBuiltinMods }, { listBuiltinMods, builtinModId, isBuiltinModEnabled }] = await Promise.all([
    import('../../../mods/bundledBuiltinMods'),
    import('../../../mods/builtinMods'),
  ])
  registerBundledBuiltinMods()
  const enabledMap = await getEnabledPluginsMap({ homeDir: ctx.homeDir }, ctx.fs)
  return {
    mods: listBuiltinMods().map(definition => {
      const identifier = builtinModId(definition.name)
      return {
        name: definition.name,
        identifier,
        ...(definition.version !== undefined ? { version: definition.version } : {}),
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        enabled: isBuiltinModEnabled(definition, enabledMap),
        enabledSource: typeof enabledMap[identifier] === 'boolean' ? 'explicit' as const : 'default' as const,
        onByDefault: definition.onByDefault !== false,
      }
    }),
  }
}

/** `plugins/setLocalEnabled` — a directory plugin's folder in or out of its
 *  root's allowlist, then every session reloads its plugins (re-reading that
 *  allowlist), so its hooks module loads or unloads at once. */
async function handleSetLocalEnabled(
  payload: PluginsBridgeActionMap['setLocalEnabled']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['setLocalEnabled']['result']> {
  const enabling = payload.enabled === true
  const run = await startThemeSwitch(ctx, enabling, { root: payload.path })
  try {
    const { name } = await setLocalPluginEnabled(payload.path, enabling, ctx.fs)
    run?.record(enabling ? { kind: 'turnOn', plugin: name } : { kind: 'turnOff', plugins: [name] })
    await forgetBuilds(ctx, { root: payload.path })
    if (enabling) await keepOneTheme(ctx, { root: payload.path }, run)
    ctx.reloadPluginsOnAllSessions?.()
    settleThemeSwitch(ctx, run, enabling)
    return { ok: true, name }
  } catch (error) {
    run?.finish({ ok: false, reason: 'request' })
    throw error
  }
}

async function handleSetEnabled(
  payload: PluginsBridgeActionMap['setEnabled']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['setEnabled']['result']> {
  // Security gate: enabling re-activates a plugin's hooks/MCP/commands, so a
  // blocklisted (already-installed) plugin must not be re-enabled through the
  // UI. Disabling is always allowed.
  if (payload.enabled !== false) {
    const blockReason = pluginBlockReason(payload.identifier)
    if (blockReason) {
      throw new Error(blockReason)
    }
  }
  const plugin = pluginNameOf(payload.identifier)
  const enabling = payload.enabled !== false
  const run = await startThemeSwitch(ctx, enabling, { plugin })
  try {
    await setPluginEnabled(
      { homeDir: ctx.homeDir }, ctx.fs,
      payload.identifier, payload.enabled,
    )
    run?.record(enabling ? { kind: 'turnOn', plugin } : { kind: 'turnOff', plugins: [plugin] })
    await forgetBuilds(ctx, { plugin })
    if (enabling) await keepOneTheme(ctx, { plugin }, run)
    // Hot-reload every active session so the enable/disable applies live —
    // the same reload `/reload-plugins` runs, never a session restart. The reload re-reads this enabled map from disk, so the
    // change we just wrote takes effect on the next turn. MCP server changes
    // still defer to the next session.
    ctx.reloadPluginsOnAllSessions?.()
    settleThemeSwitch(ctx, run, enabling)
  } catch (error) {
    run?.finish({ ok: false, reason: 'request' })
    throw error
  }
  return { ok: true, effectiveEnabled: enabling }
}

async function handleRefreshMarketplace(
  payload: PluginsBridgeActionMap['refreshMarketplace']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['refreshMarketplace']['result']> {
  const pathCtx = pathContextOf(ctx)
  // A GitHub marketplace refreshes its manifest alone; installs download the repo.
  const result = await withMarketplaceContent(pathCtx, payload.name, () => fetchCatalogListing(
    pathCtx, ctx.fs, payload.name, nowOf(ctx),
    pickFetch(ctx),
  ))
  const enriched = await listedEntries(
    ctx, payload.name, listingsVisibleOn(result.marketplace.plugins, channelOf(ctx)), 'plugins',
  )
  return {
    ok: true,
    pluginCount: enriched.length,
    ...(result.sha ? { sha: result.sha } : {}),
    manifest: {
      name: result.marketplace.name,
      description: result.marketplace.description,
      owner: result.marketplace.owner,
      plugins: enriched,
    },
  }
}

/** A plugin's id as `pluginConfigs` is keyed; a folder, when given, absolute text. */
function checkSettingsTarget(payload: { plugin?: unknown; path?: unknown } | undefined): { plugin: string; paths: string[] } {
  const plugin = payload?.plugin
  if (typeof plugin !== 'string' || plugin.length === 0 || plugin.length > 200 || plugin.lastIndexOf('@') < 1) {
    throw new Error('`plugin` must be a plugin id such as `name@marketplace`')
  }
  const path = payload?.path
  if (path !== undefined && (typeof path !== 'string' || path.length === 0)) throw new Error('`path` must be a folder path')
  return { plugin, paths: path === undefined ? [] : [path] }
}

async function missingSettingsOf(
  ctx: PluginsAdapterContext,
  plugin: string,
  paths: readonly string[],
  locale?: string,
): Promise<{ fields: ReturnType<typeof declaredSettings>; missing: ReturnType<typeof missingRequiredSettings> }> {
  const pathCtx = { homeDir: ctx.homeDir }
  const manifests = await readPluginManifests(pathCtx, ctx.fs, plugin, await sidebarProjects(ctx), paths)
  const fields = declaredSettings(manifests, locale)
  const stored = (await getPluginConfigsMap(pathCtx, ctx.fs))[plugin]?.options
  return { fields, missing: missingRequiredSettings(fields, stored) }
}

/** `plugins/requiredSettings` — the required settings a plugin still lacks. */
async function handleRequiredSettings(
  payload: PluginsBridgeActionMap['requiredSettings']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['requiredSettings']['result']> {
  const { plugin, paths } = checkSettingsTarget(payload)
  const locale = typeof payload.locale === 'string' ? payload.locale : undefined
  return { ok: true, missing: (await missingSettingsOf(ctx, plugin, paths, locale)).missing }
}

/** `plugins/setSettings` — store declared settings, checked against the
 *  manifest on disk, then reload every session's plugins. */
async function handleSetSettings(
  payload: PluginsBridgeActionMap['setSettings']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['setSettings']['result']> {
  const { plugin, paths } = checkSettingsTarget(payload)
  const values = payload.values
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('`values` must be an object')
  const { fields } = await missingSettingsOf(ctx, plugin, paths)
  const problems = settingValueProblems(fields, values)
  if (problems.length > 0) throw new Error(problems.join('; '))
  await mergePluginOptions({ homeDir: ctx.homeDir }, ctx.fs, plugin, values)
  ctx.reloadPluginsOnAllSessions?.()
  return { ok: true, missing: (await missingSettingsOf(ctx, plugin, paths)).missing }
}

/**
 * `plugins/addMarketplace` — registers a typed source. A repository that is
 * already registered is reported under its name and not fetched again.
 */
async function handleAddMarketplace(
  payload: PluginsBridgeActionMap['addMarketplace']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['addMarketplace']['result']> {
  const source = typeof payload?.source === 'string' ? parseMarketplaceSource(payload.source) : null
  if (!source) return { ok: true, status: 'invalidSource' }
  const pathCtx = pathContextOf(ctx)
  const nowIso = nowOf(ctx)
  const repo = githubRepoOf(source)
  const { registry } = await loadKnownMarketplaces(pathCtx, ctx.fs, nowIso)
  for (const [name, entry] of Object.entries(registry)) {
    const known = entry.source
    if (known.source !== 'github' && known.source !== 'url') continue
    if (repo !== null && githubRepoOf(known) === repo) return { ok: true, status: 'alreadyAdded', name }
  }
  const outcome = await registerMarketplaceSource(pathCtx, ctx.fs, source, nowIso, pickFetch(ctx))
  if (outcome.ok) return { ok: true, status: 'added', name: outcome.name, pluginCount: outcome.pluginCount }
  const error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  return { ok: true, status: 'failed', stage: outcome.stage, name: outcome.name, error }
}

/** `plugins/removeMarketplace` — official and built-in names throw. */
async function handleRemoveMarketplace(
  payload: PluginsBridgeActionMap['removeMarketplace']['payload'],
  ctx: PluginsAdapterContext,
): Promise<PluginsBridgeActionMap['removeMarketplace']['result']> {
  const name = typeof payload?.name === 'string' ? payload.name : ''
  const pathCtx = pathContextOf(ctx)
  const nowIso = nowOf(ctx)
  const { registry } = await loadKnownMarketplaces(pathCtx, ctx.fs, nowIso)
  const present = name.trim() in registry
  await removeMarketplace(pathCtx, ctx.fs, name, nowIso)
  return { ok: true, removed: present }
}

/** Exported map so tests can call individual handlers directly without
 *  constructing a bridge envelope. */
export const pluginsHandlers = {
  listInstalled: handleListInstalled,
  listMarketplaces: handleListMarketplaces,
  listMarketplacePlugins: handleListMarketplacePlugins,
  install: handleInstall,
  installFromDirectory: handleInstallFromDirectory,
  uninstall: handleUninstall,
  removeLocal: handleRemoveLocal,
  listLocal: handleListLocal,
  listBuiltin: handleListBuiltin,
  setLocalEnabled: handleSetLocalEnabled,
  setEnabled: handleSetEnabled,
  refreshMarketplace: handleRefreshMarketplace,
  addMarketplace: handleAddMarketplace,
  removeMarketplace: handleRemoveMarketplace,
  requiredSettings: handleRequiredSettings,
  setSettings: handleSetSettings,
}

// ---------------------------------------------------------------------------
// Dispatcher — wrapped in the standard ok/error envelope
// ---------------------------------------------------------------------------

/**
 * Route a `plugins/*` request to its handler. Caught throws surface as
 * `{ ok: false, error: { code: 'plugins_handler_error' }}` envelopes.
 */
export async function handlePluginsBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: PluginsAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as PluginsAction
  try {
    let result: unknown
    switch (action) {
      case 'listInstalled':
        result = await handleListInstalled(ctx)
        break
      case 'listMarketplaces':
        result = await handleListMarketplaces(ctx)
        break
      case 'listMarketplacePlugins':
        result = await handleListMarketplacePlugins(
          request.payload as PluginsBridgeActionMap['listMarketplacePlugins']['payload'],
          ctx,
        )
        break
      case 'install':
        result = await handleInstall(
          request.payload as PluginsBridgeActionMap['install']['payload'],
          ctx,
        )
        break
      case 'installFromDirectory':
        result = await handleInstallFromDirectory(
          request.payload as PluginsBridgeActionMap['installFromDirectory']['payload'],
          ctx,
        )
        break
      case 'uninstall':
        result = await handleUninstall(
          request.payload as PluginsBridgeActionMap['uninstall']['payload'],
          ctx,
        )
        break
      case 'removeLocal':
        result = await handleRemoveLocal(
          request.payload as PluginsBridgeActionMap['removeLocal']['payload'],
          ctx,
        )
        break
      case 'listLocal':
        result = await handleListLocal(
          request.payload as PluginsBridgeActionMap['listLocal']['payload'] | undefined,
          ctx,
        )
        break
      case 'listBuiltin':
        result = await handleListBuiltin(ctx)
        break
      case 'setLocalEnabled':
        result = await handleSetLocalEnabled(
          request.payload as PluginsBridgeActionMap['setLocalEnabled']['payload'],
          ctx,
        )
        break
      case 'setEnabled':
        result = await handleSetEnabled(
          request.payload as PluginsBridgeActionMap['setEnabled']['payload'],
          ctx,
        )
        break
      case 'refreshMarketplace':
        result = await handleRefreshMarketplace(
          request.payload as PluginsBridgeActionMap['refreshMarketplace']['payload'],
          ctx,
        )
        break
      case 'addMarketplace':
        result = await handleAddMarketplace(
          request.payload as PluginsBridgeActionMap['addMarketplace']['payload'],
          ctx,
        )
        break
      case 'removeMarketplace':
        result = await handleRemoveMarketplace(
          request.payload as PluginsBridgeActionMap['removeMarketplace']['payload'],
          ctx,
        )
        break
      case 'requiredSettings':
        result = await handleRequiredSettings(
          request.payload as PluginsBridgeActionMap['requiredSettings']['payload'],
          ctx,
        )
        break
      case 'setSettings':
        result = await handleSetSettings(
          request.payload as PluginsBridgeActionMap['setSettings']['payload'],
          ctx,
        )
        break
      default: {
        const _exhaustive: never = action
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'unknown_action',
            message: `Unknown plugins action: ${String(_exhaustive)}`,
          },
        }
      }
    }
    return {
      id: request.id,
      route: request.route,
      ok: true,
      result,
    } as BrowserBridgeResponse
  } catch (e) {
    return {
      id: request.id,
      route: request.route,
      ok: false,
      error: {
        code: 'plugins_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathContextOf(ctx: PluginsAdapterContext): PluginInstallPathContext {
  return { homeDir: ctx.homeDir }
}

function nowOf(ctx: PluginsAdapterContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString()
}

/**
 * Pick the fetch implementation for an install/refresh op:
 *   - test injection wins (explicit `fetchImpl`)
 *   - else the bridge-backed fetch via `network.httpGet` when a direct
 *     bridge is available
 *   - else fall through to `globalThis.fetch`
 */
function pickFetch(ctx: PluginsAdapterContext): typeof fetch {
  if (ctx.fetchImpl) return ctx.fetchImpl
  if (ctx.directBridge) {
    return createBridgeBackedFetch({
      transport: ctx.directBridge,
      createRequestId: () =>
        `plugin-fetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    })
  }
  return globalThis.fetch.bind(globalThis)
}

/**
 * Flatten the V2 array-per-id registry into a UI-ready list. For each
 * `<name>@<marketplace>` key, pick the first scope's entry (v1 nexus
 * only writes user scope) and synthesize the `name` / `marketplace`
 * fields the UI needs by re-parsing the identifier.
 */
function flattenRegistryForUi(
  registry: InstalledPluginsFile,
  enabledMap: Record<string, boolean>,
): PluginInstalledUiEntry[] {
  const out: PluginInstalledUiEntry[] = []
  for (const [id, entries] of Object.entries(registry.plugins)) {
    if (!entries || entries.length === 0) continue
    const entry = entries[0]!
    out.push(mergeEnabledForUi(id, entry, enabledMap))
  }
  return out.sort((a, b) => {
    if (a.marketplace !== b.marketplace) {
      return a.marketplace.localeCompare(b.marketplace)
    }
    return a.name.localeCompare(b.name)
  })
}

function mergeEnabledForUi(
  identifier: string,
  entry: PluginSetupRecord,
  enabledMap: Record<string, boolean>,
): PluginInstalledUiEntry {
  // Lenient split: name is always present (may be empty for malformed
  // input), marketplace may be undefined.
  const parsed = splitPluginRef(identifier)
  const name = parsed.name || identifier
  const marketplace = parsed.marketplace ?? ''
  const override = enabledMap[identifier]
  return {
    ...entry,
    name,
    marketplace,
    enabled: override !== false,
    enabledSource: override === undefined ? 'default' : 'explicit',
  }
}

function parseIdentifierOrThrow(
  identifier: string,
): { name: string; marketplace: string } {
  // Slash-command / install paths need strict validation.
  const parsed = readStrictPluginRef(identifier)
  if (!parsed.ok) {
    throw new Error(`[plugins] invalid identifier '${identifier}': ${parsed.error.message}`)
  }
  return parsed.value
}

/** Test-only: bulk-clear enabled overrides. */
export async function __clearAllEnabledOverridesForTests(
  ctx: PluginsAdapterContext,
): Promise<void> {
  const map = await getEnabledPluginsMap({ homeDir: ctx.homeDir }, ctx.fs)
  const patch: Record<string, null> = {}
  for (const id of Object.keys(map)) patch[id] = null
  if (Object.keys(patch).length > 0) {
    await applyEnabledPluginsPatch({ homeDir: ctx.homeDir }, ctx.fs, patch)
  }
}
