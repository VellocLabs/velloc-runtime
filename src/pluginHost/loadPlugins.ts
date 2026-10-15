/**
 * Local plugin loader over `processFs()` and `runtimePaths`. `assemblePluginAt`
 * resolves `.mcp.json` and manifest `mcpServers` eagerly onto
 * `plugin.mcpServers`.
 */

import {
  isStdioMCPServerConfig,
  parseMCPServerConfig,
  parseNativeMCPServerConfig,
} from '../mcp/config'
import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { MCPServerConfig } from '../mcp/types'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import type { HookTableByEvent } from '../lifecycleHooks/hookTypes'
import { parseHooksSettings } from '../lifecycleHooks/hookTypes'
import { basenameRuntimePath, joinRuntimePath, normalizeRuntimePath } from '../utils/runtimePaths'
import { resolveHookModulePaths } from './hookModules'
import { resolveProviders } from '../mods/provider/providerManifest'
import {
  getProjectPluginsRoot,
  getPluginManifestPath,
  getUserPluginsRoot,
} from './pluginPaths'
import { checkPluginDescriptor } from './manifestValidator'
import type {
  ActivePlugin,
  ComponentKind,
  PluginLoadIssue,
  PluginScan,
  PluginDescriptor,
} from './pluginModel'
import { readStrictPluginRef } from './pluginRef'
import { loadInstalledPlugins } from './installedRegistry'
import type { PluginInstallPathContext } from './pluginDirs'
import type {
  InstalledPluginsFile,
  PluginSetupRecord,
} from './registryFormats'

/**
 * Directories under the USER plugins root owned by the marketplace pipeline
 * (`cache`, `known_marketplaces`), skipped by the directory walk.
 */
const RESERVED_USER_ROOT_DIRS: ReadonlySet<string> = new Set([
  'cache',
  'known_marketplaces',
  'marketplaces',
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(fs: RuntimeFs, path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function readJsonOrNull(fs: RuntimeFs, path: string): Promise<unknown> {
  const content = await fs.readFile(path, { encoding: 'utf-8' })
  return JSON.parse(content)
}

/** Concatenate per-event matcher arrays from two HookTableByEvent. */
function concatHookTables(
  base: HookTableByEvent | undefined,
  additional: HookTableByEvent,
): HookTableByEvent {
  if (!base) {
    return additional
  }
  const merged: HookTableByEvent = { ...base }
  for (const [event, matchers] of Object.entries(additional) as [
    keyof HookTableByEvent,
    HookTableByEvent[keyof HookTableByEvent],
  ][]) {
    if (!matchers) continue
    const existing = merged[event]
    merged[event] = existing ? [...existing, ...matchers] : matchers
  }
  return merged
}

/**
 * `{ description?, hooks: {...} }` and a bare `HookTableByEvent` object.
 */
async function loadHooksFile(
  fs: RuntimeFs,
  path: string,
): Promise<HookTableByEvent> {
  const parsed = await readJsonOrNull(fs, path)
  const candidate =
    parsed && typeof parsed === 'object' && 'hooks' in (parsed as object)
      ? (parsed as { hooks: unknown }).hooks
      : parsed
  const settings = parseHooksSettings(candidate)
  if (!settings) {
    throw new Error('no valid hook entries')
  }
  return settings
}

/**
 * Read the plugin's STANDARD `hooks/hooks.json`, which may carry two
 * independent things: classic settings hooks (as `loadHooksFile` reads them)
 * (see hookModules.ts). A file with only `modules` is valid; a file with
 * neither is the same error it always was. The two are independent: a bad
 * `modules` is reported (`modulesError`) without discarding the classic
 * hooks beside it — a safety guard among them.
 */
async function loadStandardHooksFile(
  fs: RuntimeFs,
  path: string,
  pluginPath: string,
): Promise<{ hooks?: HookTableByEvent; modules: string[]; modulesError?: string }> {
  const parsed = await readJsonOrNull(fs, path)
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  let modules: string[] = []
  let modulesError: string | undefined
  try {
    modules = resolveHookModulePaths(record.modules, path, pluginPath)
  } catch (error) {
    modulesError = errorMessage(error)
  }
  const candidate = 'hooks' in record ? record.hooks : parsed
  const hooks = parseHooksSettings(candidate) ?? undefined
  if (!hooks && modulesError !== undefined) throw new Error(modulesError)
  if (!hooks && modules.length === 0) {
    throw new Error('no valid hook entries')
  }
  return { ...(hooks ? { hooks } : {}), modules, ...(modulesError !== undefined ? { modulesError } : {}) }
}

/**
 * Read an MCP servers JSON file. Accepts both `{ mcpServers: {...} }` and a
 * bare `{ name: config }` record, validating each entry with the shared
 * browser-transport rules.
 */
async function loadMcpFile(fs: RuntimeFs, path: string): Promise<{
  browser: Record<string, MCPServerConfig>
  native: Record<string, NexusMcpServerLaunchConfig>
}> {
  const parsed = await readJsonOrNull(fs, path)
  const servers =
    parsed && typeof parsed === 'object' && 'mcpServers' in (parsed as object)
      ? (parsed as { mcpServers: unknown }).mcpServers
      : parsed
  const browser: Record<string, MCPServerConfig> = {}
  const native: Record<string, NexusMcpServerLaunchConfig> = {}
  if (servers && typeof servers === 'object') {
    for (const [name, value] of Object.entries(servers)) {
      if (isStdioMCPServerConfig(value)) {
        const config = parseNativeMCPServerConfig(name, value)
        if (config) native[name] = config
        continue
      }
      const config = parseMCPServerConfig(name, value)
      if (config) {
        browser[name] = config
        continue
      }
      const nativeConfig = parseNativeMCPServerConfig(name, value)
      if (nativeConfig) native[name] = nativeConfig
    }
  }
  return { browser, native }
}

/**
 * Resolve a `string | string[]` component path field to absolute paths that
 * exist on disk. Missing paths are recorded as `path-not-found` errors.
 */
async function resolveExtraPaths(
  fs: RuntimeFs,
  field: string | string[] | undefined,
  pluginPath: string,
  pluginName: string,
  source: string,
  component: ComponentKind,
  errors: PluginLoadIssue[],
): Promise<string[]> {
  if (!field) {
    return []
  }
  const relPaths = Array.isArray(field) ? field : [field]
  const checks = await Promise.all(
    relPaths.map(async relPath => {
      const fullPath = joinRuntimePath(pluginPath, relPath)
      return { fullPath, exists: await pathExists(fs, fullPath) }
    }),
  )
  const valid: string[] = []
  for (const { fullPath, exists } of checks) {
    if (exists) {
      valid.push(fullPath)
    } else {
      errors.push({
        type: 'path-not-found',
        source,
        plugin: pluginName,
        path: fullPath,
        component,
      })
    }
  }
  return valid
}

/**
 * Load and validate a plugin's manifest. Returns a manifest plus an optional
 * error. A missing manifest yields a minimal default (so a bare plugin
 * directory still functions via auto-detected dirs); a corrupt or invalid one
 * yields a fallback-named manifest and a recorded error.
 */
export async function readPluginDescriptor(
  descriptorFile: string,
  nameIfMissing: string,
  source: string,
  fs: RuntimeFs = processFs(),
): Promise<{ manifest: PluginDescriptor; error?: PluginLoadIssue }> {
  if (!(await pathExists(fs, descriptorFile))) {
    return {
      manifest: { name: nameIfMissing, description: `Plugin from ${source}` },
    }
  }

  let parsed: unknown
  try {
    parsed = await readJsonOrNull(fs, descriptorFile)
  } catch (error) {
    return {
      manifest: { name: nameIfMissing },
      error: {
        type: 'manifest-parse-error',
        source,
        plugin: nameIfMissing,
        manifestPath: descriptorFile,
        parseError: errorMessage(error),
      },
    }
  }

  const { manifest, errors } = checkPluginDescriptor(parsed)
  if (!manifest) {
    return {
      manifest: { name: nameIfMissing },
      error: {
        type: 'manifest-validation-error',
        source,
        plugin: nameIfMissing,
        manifestPath: descriptorFile,
        validationErrors: errors,
      },
    }
  }

  // Component-level validation problems are non-fatal: keep the manifest but
  // surface the messages so authors can fix them.
  return {
    manifest,
    error:
      errors.length > 0
        ? {
            type: 'manifest-validation-error',
            source,
            plugin: manifest.name,
            manifestPath: descriptorFile,
            validationErrors: errors,
          }
        : undefined,
  }
}

/**
 * What an installed plugin's list row says before any session has loaded it:
 * its manifest's own description, and whether its `hooks/hooks.json` names
 * hooks modules — whether it is a MOD. Read off the files, so a plugin just
 * installed reads as a mod at once. Never throws: an unreadable file leaves
 * its half out.
 */
export async function describeInstalledPlugin(
  fs: RuntimeFs,
  pluginPath: string,
): Promise<{ description?: string; hasModules: boolean }> {
  let description: string | undefined
  try {
    const manifest = await readJsonOrNull(fs, getPluginManifestPath(pluginPath))
    const value = (manifest as { description?: unknown } | null)?.description
    if (typeof value === 'string' && value.trim() !== '') description = value
  } catch {
    // no manifest, or not JSON: no description
  }
  let hasModules = false
  const hooksPath = joinRuntimePath(pluginPath, 'hooks', 'hooks.json')
  try {
    hasModules = (await loadStandardHooksFile(fs, hooksPath, pluginPath)).modules.length > 0
  } catch {
    // no hooks.json, or not a valid one: not a mod
  }
  return { ...(description !== undefined ? { description } : {}), hasModules }
}

/**
 * Resolve a single plugin directory into a `ActivePlugin`. Auto-detects the
 * standard `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, and
 * `.mcp.json` locations and merges any manifest-declared extra paths / inline
 * definitions.
 */
export async function assemblePluginAt(
  pluginPath: string,
  source: string,
  enabled: boolean,
  nameIfMissing: string,
  fs: RuntimeFs = processFs(),
): Promise<{ plugin: ActivePlugin; errors: PluginLoadIssue[] }> {
  const errors: PluginLoadIssue[] = []

  const manifestPath = getPluginManifestPath(pluginPath)
  const { manifest, error } = await readPluginDescriptor(
    manifestPath,
    nameIfMissing,
    source,
    fs,
  )
  if (error) errors.push(error)

  const plugin: ActivePlugin = {
    name: manifest.name,
    manifest,
    path: pluginPath,
    source,
    enabled,
  }

  // Auto-detect standard component directories (only when the manifest does
  // not declare the field explicitly).
  const [commandsDirExists, agentsDirExists, skillsDirExists] =
    await Promise.all([
      manifest.commands
        ? Promise.resolve(false)
        : pathExists(fs, joinRuntimePath(pluginPath, 'commands')),
      manifest.agents
        ? Promise.resolve(false)
        : pathExists(fs, joinRuntimePath(pluginPath, 'agents')),
      manifest.skills
        ? Promise.resolve(false)
        : pathExists(fs, joinRuntimePath(pluginPath, 'skills')),
    ])
  if (commandsDirExists) {
    plugin.commandFolder = joinRuntimePath(pluginPath, 'commands')
  }
  if (agentsDirExists) {
    plugin.agentsPath = joinRuntimePath(pluginPath, 'agents')
  }
  if (skillsDirExists) {
    plugin.skillsPath = joinRuntimePath(pluginPath, 'skills')
  }

  const commandFolders = await resolveExtraPaths(
    fs,
    manifest.commands,
    pluginPath,
    manifest.name,
    source,
    'commands',
    errors,
  )
  if (commandFolders.length > 0) plugin.commandFolders = commandFolders

  const agentsPaths = await resolveExtraPaths(
    fs,
    manifest.agents,
    pluginPath,
    manifest.name,
    source,
    'agents',
    errors,
  )
  if (agentsPaths.length > 0) plugin.agentsPaths = agentsPaths

  const skillsPaths = await resolveExtraPaths(
    fs,
    manifest.skills,
    pluginPath,
    manifest.name,
    source,
    'skills',
    errors,
  )
  if (skillsPaths.length > 0) plugin.skillsPaths = skillsPaths

  // Hooks: standard hooks/hooks.json, then manifest.hooks (inline or paths).
  let mergedHooks: HookTableByEvent | undefined
  const standardHooksPath = joinRuntimePath(pluginPath, 'hooks', 'hooks.json')
  if (await pathExists(fs, standardHooksPath)) {
    try {
      const standard = await loadStandardHooksFile(fs, standardHooksPath, pluginPath)
      mergedHooks = standard.hooks
      if (standard.modules.length > 0) plugin.hookModules = standard.modules
      if (standard.modulesError !== undefined) {
        errors.push({
          type: 'hook-load-failed',
          source,
          plugin: manifest.name,
          hookPath: standardHooksPath,
          reason: standard.modulesError,
        })
      }
    } catch (e) {
      errors.push({
        type: 'hook-load-failed',
        source,
        plugin: manifest.name,
        hookPath: standardHooksPath,
        reason: errorMessage(e),
      })
    }
  }
  if (manifest.hooks) {
    if (typeof manifest.hooks === 'string' || Array.isArray(manifest.hooks)) {
      const hookPaths = Array.isArray(manifest.hooks)
        ? manifest.hooks
        : [manifest.hooks]
      for (const relPath of hookPaths) {
        const hookFilePath = joinRuntimePath(pluginPath, relPath)
        if (!(await pathExists(fs, hookFilePath))) {
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: hookFilePath,
            component: 'hooks',
          })
          continue
        }
        try {
          mergedHooks = concatHookTables(
            mergedHooks,
            await loadHooksFile(fs, hookFilePath),
          )
        } catch (e) {
          errors.push({
            type: 'hook-load-failed',
            source,
            plugin: manifest.name,
            hookPath: hookFilePath,
            reason: errorMessage(e),
          })
        }
      }
    } else {
      // Inline HookTableByEvent.
      mergedHooks = concatHookTables(mergedHooks, manifest.hooks)
    }
  }
  if (mergedHooks) {
    plugin.hooksConfig = mergedHooks
  }

  // Provider mods: each provider's module must exist; one that does not is
  // reported and left out (the others stay).
  if (manifest.providers) {
    const kept = []
    for (const provider of resolveProviders(manifest.name, pluginPath, manifest.providers)) {
      if (await pathExists(fs, provider.modulePath)) {
        kept.push(provider)
        continue
      }
      errors.push({
        type: 'path-not-found',
        source,
        plugin: manifest.name,
        path: provider.modulePath,
        component: 'providers',
      })
    }
    if (kept.length > 0) plugin.providers = kept
  }

  // MCP servers: .mcp.json, then manifest.mcpServers (inline or paths).
  const mcpServers: Record<string, MCPServerConfig> = {}
  const nativeMcpServers: Record<string, NexusMcpServerLaunchConfig> = {}
  const standardMcpPath = joinRuntimePath(pluginPath, '.mcp.json')
  if (await pathExists(fs, standardMcpPath)) {
    try {
      const loaded = await loadMcpFile(fs, standardMcpPath)
      Object.assign(mcpServers, loaded.browser)
      Object.assign(nativeMcpServers, loaded.native)
    } catch (e) {
      errors.push({
        type: 'mcp-config-invalid',
        source,
        plugin: manifest.name,
        serverName: '.mcp.json',
        validationError: errorMessage(e),
      })
    }
  }
  if (manifest.mcpServers) {
    if (
      typeof manifest.mcpServers === 'string'
      || Array.isArray(manifest.mcpServers)
    ) {
      const mcpPaths = Array.isArray(manifest.mcpServers)
        ? manifest.mcpServers
        : [manifest.mcpServers]
      for (const relPath of mcpPaths) {
        const mcpFilePath = joinRuntimePath(pluginPath, relPath)
        if (!(await pathExists(fs, mcpFilePath))) {
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: mcpFilePath,
            component: 'commands',
          })
          continue
        }
        try {
          const loaded = await loadMcpFile(fs, mcpFilePath)
          Object.assign(mcpServers, loaded.browser)
          Object.assign(nativeMcpServers, loaded.native)
        } catch (e) {
          errors.push({
            type: 'mcp-config-invalid',
            source,
            plugin: manifest.name,
            serverName: relPath,
            validationError: errorMessage(e),
          })
        }
      }
    } else {
      // Inline record — already validated by checkPluginDescriptor.
      for (const [name, config] of Object.entries(manifest.mcpServers)) {
        if (isStdioMCPServerConfig(config)) {
          const nativeConfig = parseNativeMCPServerConfig(name, config)
          if (nativeConfig) nativeMcpServers[name] = nativeConfig
        } else {
          mcpServers[name] = config as MCPServerConfig
        }
      }
    }
  }
  if (Object.keys(mcpServers).length > 0) {
    plugin.mcpServers = mcpServers
  }
  if (Object.keys(nativeMcpServers).length > 0) {
    plugin.nativeMcpServers = nativeMcpServers
  }

  return { plugin, errors }
}

/**
 * The name a directory plugin is enabled by in `enabled-plugins.json`: its
 * FOLDER's, not its manifest `name`. A marketplace plugin has none.
 */
export function allowlistNameOf(plugin: Pick<ActivePlugin, 'path' | 'source'>): string | undefined {
  if (!plugin.source.startsWith('user:') && !plugin.source.startsWith('project:')) return undefined
  return basenameRuntimePath(plugin.path) || undefined
}

/** The directory-walk allowlist of these plugins: each directory plugin's
 *  folder name (`allowlistNameOf`), deduplicated. */
export function allowlistOf(plugins: ReadonlyArray<Pick<ActivePlugin, 'path' | 'source'>>): string[] {
  const names = new Set<string>()
  for (const plugin of plugins) {
    const name = allowlistNameOf(plugin)
    if (name) names.add(name)
  }
  return [...names]
}

export async function gatherPlugins(params: {
  cwd: string
  runtimeConfig: RuntimeConfig
  enabledPlugins?: string[]
  /** Bridge-resolved user home. REQUIRED in production for the user-scope
   *  root (`~/.velloc/plugins/`) to be discovered at all — the SharedWorker
   *  env carries no `HOME`/`USERPROFILE`, so `getUserPluginsRoot`'s env
   *  fallback yields null and the whole root is skipped. */
  homeDir?: string
  /** Loaded `installed_plugins.json` registry. When provided, every
   *  entry's `installPath` is loaded as a marketplace plugin. Caller
   *  is responsible for resolving + reading it (typically via
   *  `loadInstalledPlugins(pathCtx, fs)` from the install module);
   *  the loader takes the resolved value so the dependency on the
   *  install module is one-way. */
  installRegistry?: InstalledPluginsFile
  /** Sparse `<name>@<marketplace>` → enabled-state map (the same
   *  `enabledPlugins` field from `settings.json`). Default-on
   *  semantics: missing key = enabled, only explicit `false` disables. */
  enabledPluginIdentifiers?: Record<string, boolean>
  /** THIS runtime's fs; omitted → the realm-global slot (tests). */
  fs?: RuntimeFs
}): Promise<PluginScan> {
  const fs = params.fs ?? processFs()
  const roots: Array<{ root: string; sourcePrefix: 'user' | 'project' }> = []
  const userRoot = getUserPluginsRoot(params.runtimeConfig, params.homeDir)
  if (userRoot) {
    roots.push({ root: userRoot, sourcePrefix: 'user' })
  }
  // A session anchored at the home folder has the user root as its project
  // root too: walk it once, as the user root (pipeline folders skipped).
  const projectRoot = getProjectPluginsRoot(params.cwd)
  if (!userRoot || normalizeRuntimePath(userRoot).toLowerCase() !== normalizeRuntimePath(projectRoot).toLowerCase()) {
    roots.push({ root: projectRoot, sourcePrefix: 'project' })
  }

  const enabledSet =
    params.enabledPlugins && params.enabledPlugins.length > 0
      ? new Set(params.enabledPlugins)
      : null

  const enabled: ActivePlugin[] = []
  const disabled: ActivePlugin[] = []
  const errors: PluginLoadIssue[] = []
  const seenNames = new Set<string>()

  // ---- 1. Legacy directory walk ------------------------------------------
  for (const { root, sourcePrefix } of roots) {
    let entries
    try {
      entries = await fs.readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      // Skip the marketplace pipeline's internal state directories — at
      // the user root only (the project root doesn't host them).
      if (sourcePrefix === 'user' && RESERVED_USER_ROOT_DIRS.has(entry.name)) {
        continue
      }
      const pluginPath = joinRuntimePath(root, entry.name)
      const source = `${sourcePrefix}:${pluginPath}`
      const isEnabled = enabledSet ? enabledSet.has(entry.name) : false
      const { plugin, errors: pluginErrors } = await assemblePluginAt(
        pluginPath,
        source,
        isEnabled,
        entry.name,
        fs,
      )
      errors.push(...pluginErrors)
      if (seenNames.has(plugin.name)) {
        continue
      }
      seenNames.add(plugin.name)
      if (plugin.enabled) {
        enabled.push(plugin)
      } else {
        disabled.push(plugin)
      }
    }
  }

  // ---- 2. Marketplace-installed plugins ----------------------------------
  // Walk `installed_plugins.json`. For each entry, load the manifest
  // from its `installPath` and create a ActivePlugin with the install
  // identifier attached. Name collisions with legacy plugins drop the
  // marketplace entry (legacy wins — explicit user intent).
  if (params.installRegistry) {
    const marketplacePlugins = await loadInstalledMarketplacePlugins(
      params.installRegistry,
      params.enabledPluginIdentifiers,
      fs,
    )
    for (const { plugin, errors: pluginErrors } of marketplacePlugins) {
      errors.push(...pluginErrors)
      if (seenNames.has(plugin.name)) {
        // Legacy plugin with same manifest name took precedence.
        // The marketplace plugin stays installed (registry entry intact),
        // it's just shadowed in this session's discovery output.
        continue
      }
      seenNames.add(plugin.name)
      if (plugin.enabled) {
        enabled.push(plugin)
      } else {
        disabled.push(plugin)
      }
    }
  }

  return { enabled, disabled, errors }
}

/**
 * Every `installed_plugins.json` entry as an `ActivePlugin`, in stable
 * `<marketplace>/<name>` order. A bad entry yields errors for itself only.
 * Exported for tests.
 */
export async function loadInstalledMarketplacePlugins(
  registry: InstalledPluginsFile,
  enabledPluginIdentifiers?: Record<string, boolean>,
  fs: RuntimeFs = processFs(),
): Promise<Array<{ plugin: ActivePlugin; errors: PluginLoadIssue[] }>> {
  // V2: plugins[id] is an array of per-scope entries. Flatten + tag with
  // the id (which carries name + marketplace via `<name>@<marketplace>`).
  // v1 user-scope only, so every array is length 1 in practice.
  const flattened: Array<{
    id: string
    name: string
    marketplace: string
    entry: PluginSetupRecord
  }> = []
  for (const [id, entries] of Object.entries(registry.plugins)) {
    // Loader needs the strict envelope — a malformed key (missing `@`, etc.)
    // should be skipped, not loaded with `marketplace: undefined`, so use
    // the strict reader rather than the lenient `splitPluginRef`.
    const parsed = readStrictPluginRef(id)
    if (!parsed.ok) continue
    for (const entry of entries) {
      flattened.push({
        id,
        name: parsed.value.name,
        marketplace: parsed.value.marketplace,
        entry,
      })
    }
  }

  // Sort by (marketplace, name) for deterministic load order.
  flattened.sort((a, b) => {
    if (a.marketplace !== b.marketplace) {
      return a.marketplace.localeCompare(b.marketplace)
    }
    return a.name.localeCompare(b.name)
  })

  const out: Array<{ plugin: ActivePlugin; errors: PluginLoadIssue[] }> = []
  for (const { id, name, entry } of flattened) {
    const source = `marketplace:${id}`
    const isEnabled =
      isMarketplacePluginEnabled(id, enabledPluginIdentifiers)
    const result = await assemblePluginAt(
      entry.installPath,
      source,
      isEnabled,
      name,
      fs,
    )
    result.plugin.installIdentifier = id
    out.push(result)
  }
  return out
}

/** Default-on enable resolution for marketplace plugins. Mirrors
 *  `isPluginEnabled` from `enabledPlugins.ts` — duplicated here as a
 *  pure function so the loader doesn't need to spawn fs reads itself
 *  (the caller resolved the map). */
function isMarketplacePluginEnabled(
  identifier: string,
  map: Record<string, boolean> | undefined,
): boolean {
  if (!map) return true
  return map[identifier] !== false
}

/**
 * Resolve the install pipeline's registry from disk + return whatever
 * `gatherPlugins` needs. Convenience for callers (createBrowserRuntime)
 * that want one-call orchestration. Returns `undefined` for the
 * registry when the file is missing (= no marketplace installs yet —
 * a no-op for the loader's marketplace branch).
 */
export async function loadMarketplaceInstallState(
  pathCtx: PluginInstallPathContext,
  fs: RuntimeFs = processFs(),
): Promise<{
  installRegistry: InstalledPluginsFile
}> {
  const { registry } = await loadInstalledPlugins(pathCtx, fs)
  return { installRegistry: registry }
}

/** Re-export so callers don't need to know which module owns the type. */
export type {
  InstalledPluginsFile,
  PluginSetupRecord,
} from './registryFormats'
