/**
 * A session's mod slot (F-25): selects the slot's modules, builds its mod runtime on demand,
 * follows plugin reloads, and holds tool / agent registrations made before the engine binds.
 */

import type { ConversationEngine } from '../../engine/conversationEngine'
import type { ResolvedMemorySettings } from '../../memory/memoryPaths'
import type { PluginContributions } from '../../pluginHost'
import type { PluginProviderKeysMap } from '../../pluginHost/pluginMcpUserConfig'
import { isModSlot, selectModModules } from '../../mods/modSlot'
import { createModIdleUnload, type ModIdleUnload } from '../../mods/modIdleUnload'
import { createDevModsFolder, type DevModsFolder } from '../../mods/devModsFolder'
import { assemblePluginAt } from '../../pluginHost/loadPlugins'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { traceLine } from '../../utils/debugLog'
import {
  modRoster,
  openDevModsAsk,
  showDevModsNotice,
  type ModSlot,
  undoWhenScopeEnds,
  watchModRoster,
} from '../../mods/modSlotRegistry'
import type { ModSlotHost } from './modSlotBuilder'

export type SessionModSlotInput = Pick<
  ModSlotHost,
  | 'options'
  | 'appSurface'
  | 'resolvedOptions'
  | 'resolvedSessionId'
  | 'resolvedCwd'
  | 'resolvedProjectRoot'
  | 'templateType'
  | 'homeDir'
  | 'settingsHomeDir'
  | 'settingsHome'
  | 'runtimeConfig'
  | 'hostBridge'
  | 'coreState'
  | 'supportedSlashCommands'
  | 'allowsMcp'
  | 'mcpPool'
  | 'mcpOrigins'
  | 'offerLaunchedMcpServer'
  | 'readPluginConfigs'
  | 'installedFs'
> & {
  modSlotFacts: Parameters<typeof selectModModules>[0]
  isHeadlessSession: boolean
  pluginContributions: PluginContributions
  currentMemory: () => ResolvedMemorySettings
  currentMcpPluginConfigs: () => ModSlotHost['mcpPluginConfigs']
  currentMcpProviderKeys: () => PluginProviderKeysMap
}

/** Opens the slot; its mod runtime, if any module is selected, is built before this resolves. */
export async function openSessionModSlot(input: SessionModSlotInput) {
  const {
    options,
    appSurface,
    resolvedOptions,
    resolvedSessionId,
    resolvedCwd,
    resolvedProjectRoot,
    templateType,
    homeDir,
    settingsHomeDir,
    settingsHome,
    runtimeConfig,
    hostBridge,
    coreState,
    supportedSlashCommands,
    allowsMcp,
    mcpPool,
    mcpOrigins,
    offerLaunchedMcpServer,
    readPluginConfigs,
    installedFs,
    modSlotFacts,
    isHeadlessSession,
    pluginContributions,
    currentMemory,
    currentMcpPluginConfigs,
    currentMcpProviderKeys,
  } = input
  // settings.json `enabledPlugins`: a built-in's `<name>@builtin` entry
  // switches it over its default — read on every select, so the Settings
  // toggle's reload applies it.
  const readEnabledPlugins = async (): Promise<Record<string, boolean>> => {
    try {
      const { getEnabledPluginsMap } = await import('../../pluginHost/enabledPlugins')
      return await getEnabledPluginsMap({ homeDir: settingsHome() }, installedFs)
    } catch (e) {
      console.warn(`[mods] enabled plugins skipped: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    }
  }
  // The product's built-ins, registered once per runtime realm before
  // the first slot selects its modules.
  await import('../../mods/bundledBuiltinMods').then(m => m.registerBundledBuiltinMods())
  const modModules = selectModModules(modSlotFacts, pluginContributions.plugins, await readPluginConfigs(), await readEnabledPlugins())
  /** The enabled plugins as the slot's mods were last selected from:
   *  `$.mcp.connect` reads the calling plugin's manifest servers off them. */
  let modPlugins = pluginContributions.plugins
  /** The session's dev mods folder (F-25); set below for an interactive slot. */
  let devMods: DevModsFolder | undefined
  /** `plugins` with the dev folder's own, an installed name winning. */
  const withDevMods = (plugins: typeof pluginContributions.plugins): typeof pluginContributions.plugins => {
    const dev = devMods?.plugins() ?? []
    if (dev.length === 0) return plugins
    const taken = new Set(plugins.map(plugin => plugin.name))
    return [...plugins, ...dev.filter(plugin => !taken.has(plugin.name))]
  }
  let mods: import('../../mods/ModRuntime').ModRuntime | undefined
  /** Undo of the slot's registry entry; replaced when the runtime is. */
  let unregisterModSlot: (() => void) | undefined
  // The slot this runtime announced: only it may publish the slot's tools.
  let ownSlot: ModSlot | undefined
  let engineForMods: ConversationEngine | undefined
  const modEngine = (what: string): ConversationEngine => {
    if (!engineForMods) {
      const error = new Error(`${what} is not available yet: the session is still starting`)
      error.name = 'NotSupportedError'
      throw error
    }
    return engineForMods
  }
  const modToolHost = () => modEngine('$.tool').modTools
  /**
   * `$.tool.register` / `$.agent.register` made before the engine binds (e.g. at `session.start`),
   * applied in order when it binds.
   */
  const earlyRegistrations: Array<{ kind: 'tool' | 'agent'; plugin: string; apply: (engine: ConversationEngine) => void }> = []
  const registerOnEngine = (
    kind: 'tool' | 'agent',
    plugin: string,
    apply: (engine: ConversationEngine) => string,
    fullName: string,
    report: (line: string) => void,
  ): string => {
    if (engineForMods) return apply(engineForMods)
    earlyRegistrations.push({
      kind,
      plugin,
      apply: engine => {
        try {
          apply(engine)
        } catch (error) {
          report(`${plugin}: $.${kind}.register(${fullName}) failed when the session bound: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    return fullName
  }
  const forgetOnEngine = (kind: 'tool' | 'agent', plugin: string, forget: (engine: ConversationEngine) => void): void => {
    for (let i = earlyRegistrations.length - 1; i >= 0; i -= 1) {
      const entry = earlyRegistrations[i]!
      if (entry.kind === kind && entry.plugin === plugin) earlyRegistrations.splice(i, 1)
    }
    if (engineForMods) forget(engineForMods)
  }
  /** The slot's `$.state`: memory alone, as long as the slot. Every runtime
   *  the slot builds shares it, so the idle unload's reload keeps it. */
  let slotModState: import('../../mods/modState').ModStateStore | undefined
  const modSlotHost: ModSlotHost = {
    allowsMcp,
    appSurface,
    coreState,
    get engineForMods() {
      return engineForMods
    },
    forgetOnEngine,
    homeDir,
    hostBridge,
    get installedFs() {
      return installedFs
    },
    mcpOrigins,
    get mcpPluginConfigs() {
      return currentMcpPluginConfigs()
    },
    mcpPool,
    get mcpProviderKeys() {
      return currentMcpProviderKeys()
    },
    modEngine,
    get modPlugins() {
      return withDevMods(modPlugins)
    },
    modToolHost,
    get mods() {
      return mods
    },
    offerLaunchedMcpServer,
    options,
    get ownSlot() {
      return ownSlot
    },
    set ownSlot(value) {
      ownSlot = value
    },
    readPluginConfigs,
    registerOnEngine,
    resolvedCwd,
    get resolvedMemory() {
      return currentMemory()
    },
    resolvedOptions,
    resolvedProjectRoot,
    resolvedSessionId,
    runtimeConfig,
    settingsHome,
    settingsHomeDir,
    get slotModState() {
      return slotModState
    },
    set slotModState(value) {
      slotModState = value
    },
    supportedSlashCommands,
    templateType,
    get unregisterModSlot() {
      return unregisterModSlot
    },
    set unregisterModSlot(value) {
      unregisterModSlot = value
    },
  }
  /**
   * Build the slot's mod runtime for `modules` — at boot when an enabled
   * plugin carries a hooks module, or LATER, when `/plugins enable` (or the
   * Settings toggle) gives a session that had none its first one.
   * `selectModModules` stays the one predicate; this is its consequence.
   */
  const buildModRuntime = async (
    modules: ReturnType<typeof selectModModules>,
  ): Promise<import('../../mods/ModRuntime').ModRuntime> => {
    const { buildSlotModRuntime } = await import('./modSlotBuilder')
    return buildSlotModRuntime(modSlotHost, modules)
  }
  if (modModules.length > 0) mods = await buildModRuntime(modModules)
  /**
   * Reconcile the slot's mods after a plugin reload: unload removed modules, load added ones with
   * their own `session.start`. Serialized, or concurrent reloads orphan a runtime.
   */
  let reconcilingMods: Promise<void> = Promise.resolve()
  const reconcileMods = (plugins: typeof pluginContributions.plugins): Promise<void> => {
    const run = reconcilingMods.then(() => reconcileModsNow(plugins))
    reconcilingMods = run.catch(() => undefined)
    return run
  }
  const reconcileModsNow = async (plugins: typeof pluginContributions.plugins): Promise<void> => {
    modPlugins = plugins
    // Unloaded while idle: a plugin reload keeps the slot empty until a
    // client comes back (or a message arrives) and loads them again.
    const next = modIdle?.isUnloaded()
      ? []
      : selectModModules(modSlotFacts, withDevMods(plugins), await readPluginConfigs(), await readEnabledPlugins())
    if (mods) {
      if (next.length > 0) {
        await mods.reconcile(next)
        return
      }
      const ending = mods
      mods = undefined
      unregisterModSlot?.()
      unregisterModSlot = undefined
      engineForMods?.setMods(undefined)
      await ending.end('other')
      return
    }
    if (next.length === 0) return
    mods = await buildModRuntime(next)
    engineForMods?.setMods(mods)
  }
  /**
   * The idle unload (mods/modIdleUnload.ts): a session no client has attached
   * to for a while and that never ran in this process gives its mods back;
   * an attach or a submitted message loads them again. Every slot that may
   * carry mods has one, whether or not it has any now — a plugin enabled
   * later is held to the same rule. Not a headless run: no client ever
   * attaches to one, and it runs at once.
   */
  const modIdle: ModIdleUnload | undefined = isModSlot(modSlotFacts) && !isHeadlessSession
    ? createModIdleUnload({
        rosterSize: () => modRoster(resolvedSessionId).length,
        watchRoster: watcher => watchModRoster(resolvedSessionId, watcher),
        isBusy: () => mods?.isBusy() ?? false,
        unload: () => reconcileMods(modPlugins),
        load: () => reconcileMods(modPlugins),
      })
    : undefined
  if (modIdle) undoWhenScopeEnds(() => modIdle.dispose(), options.runtimeScopeSignal)

  // The session's dev mods folder: `<home>/.velloc/dev-mods/<sessionId>/`,
  // scanned at each turn end and loaded into this session alone once the
  // person turns it on (F-25). An interactive slot only.
  if (isModSlot(modSlotFacts) && !isHeadlessSession) {
    try {
      const folder = joinRuntimePath(settingsHome(), RUNTIME_DIR_NAME, 'dev-mods', resolvedSessionId)
      devMods = createDevModsFolder({
        folder,
        readdir: path => installedFs.readdir(path),
        mtime: path => installedFs.stat(path).then(stat => stat.mtimeMs, () => undefined),
        join: (base, ...segments) => joinRuntimePath(base, ...segments),
        assemble: (dir, folderName) =>
          assemblePluginAt(dir, `dev:${dir}`, true, folderName, installedFs).then(({ plugin }) =>
            (plugin.hookModules?.length ?? 0) > 0 ? plugin : undefined,
          ),
        isInstalled: name => modPlugins.some(plugin => plugin.name === name),
        permissionMode: () => String(coreState.getAppState().permissionRules.mode),
        canAsk: true,
        ask: plugins => openDevModsAsk(resolvedSessionId, plugins, options.runtimeScopeSignal),
        notifyOn: plugins => showDevModsNotice(resolvedSessionId, plugins, options.runtimeScopeSignal),
        onPluginsChanged: () => reconcileMods(modPlugins),
        report: line => {
          traceLine(`[mods] ${line}`, { level: 'warn' })
          console.warn(`[mods] ${line}`)
        },
      })
    } catch (e) {
      console.warn(`[mods] dev mods folder skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    /** The slot's mod runtime now; replaced or cleared by a reload. */
    get mods() {
      return mods
    },
    /** The slot this runtime announced: only it may publish the slot's tools. */
    get ownSlot() {
      return ownSlot
    },
    modIdle,
    reconcileMods,
    /** The dev mods folder's turn-end scan; absent when the slot has none. */
    afterTurnUpkeep: devMods ? (folder => () => folder.afterTurn())(devMods) : undefined,
    /** Binds the engine and applies the registrations made before it existed, in order. */
    bindEngine(engine: ConversationEngine): void {
      engineForMods = engine
      for (const entry of earlyRegistrations.splice(0)) entry.apply(engine)
    },
  }
}
