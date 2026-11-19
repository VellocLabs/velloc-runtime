/**
 * What the window gives a conversation's theme menu (F-25): the theme mods,
 * which of them are enabled — read from the plugin lists, the same answer
 * Settings shows — and the asks this connection may make.
 */
import * as React from 'react'

import type { ThemeModsContextValue } from '../../../components/assistant-ui/theme-mods-context'
import type { ThemeModEntry } from '../../../mods/themeMods'
import { BUILTIN_MARKETPLACE_KEY } from '../../../pluginHost/builtinMarketplace'
import { joinPluginRef } from '../../../pluginHost/pluginRef'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'
import {
  pluginsListBuiltin,
  pluginsListInstalled,
  pluginsListLocal,
  pluginsSetEnabled,
  pluginsSetLocalEnabled,
} from '../settings/clients'
import { askUseLook, readThemePlugins, turnOffThemePlugins, type ThemePlugin } from './themeLooks'
import type { ThemeModsView } from './themeModsView'

const folderKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Whether each plugin source is enabled, by id (`<name>@<source>`) and, for a directory plugin, by folder. */
export type PluginEnablement = { byId: ReadonlyMap<string, boolean>; byFolder: ReadonlyMap<string, boolean> }

/** The enabled state of every installed, built-in and directory plugin. A list that cannot be read adds nothing. */
export async function readPluginEnablement(bridge: NexusSettingsBridge): Promise<PluginEnablement> {
  const [installed, builtin, local] = await Promise.all([
    pluginsListInstalled(bridge).catch(() => undefined),
    pluginsListBuiltin(bridge).catch(() => undefined),
    pluginsListLocal(bridge).catch(() => undefined),
  ])
  const byId = new Map<string, boolean>()
  const byFolder = new Map<string, boolean>()
  for (const plugin of installed?.plugins ?? []) byId.set(`${plugin.name}@${plugin.marketplace}`, plugin.enabled)
  for (const mod of builtin?.mods ?? []) byId.set(mod.identifier, mod.enabled)
  for (const root of local?.roots ?? []) {
    for (const plugin of root.plugins) byFolder.set(folderKey(plugin.path), plugin.enabled)
  }
  return { byId, byFolder }
}

/** Each theme mod the lists know, by plugin name: whether it is enabled. */
export function themeModEnablement(mods: readonly ThemeModEntry[], lists: PluginEnablement): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const mod of mods) {
    const found = mod.id.endsWith('@inline')
      ? mod.root !== undefined
        ? lists.byFolder.get(folderKey(mod.root))
        : undefined
      : lists.byId.get(mod.id)
    if (found !== undefined) out[mod.plugin] = found
  }
  return out
}

export type ThemeModsMenuOptions = {
  view: ThemeModsView
  bridge: NexusSettingsBridge | null | undefined
  canSetEnabled: boolean
  canSetBackdropScope: boolean
  /** Absent where there is nowhere to install a theme from. */
  openThemeStore?: () => void
  /** Called once a press has turned `plugin` on. */
  afterEnable?: (plugin: string) => void
  canTurnOffAll?: boolean
  /** Looks are applied through it; absent, the menu lists none. */
  runtimeConnection?: () => Promise<RuntimeConnection>
  canUseLook?: boolean
  /** The session the window shows, unless a CLI runs it. */
  lookTarget?: { sessionId: string; busy: boolean } | null
}

/** The listings whose plugin the lists say is on: its built-in install, or a theme mod of that name. */
export function enabledThemeListings(
  listings: readonly ThemePlugin[],
  lists: PluginEnablement,
  modsEnabled: Readonly<Record<string, boolean>>,
): ThemePlugin[] {
  return listings.filter(
    listing => lists.byId.get(joinPluginRef(listing.name, BUILTIN_MARKETPLACE_KEY)) === true || modsEnabled[listing.name] === true,
  )
}

/** Undefined until the runtime has answered the theme mods. */
export function useThemeModsMenu(options: ThemeModsMenuOptions): ThemeModsContextValue | undefined {
  const { view, bridge, canSetEnabled, canSetBackdropScope, openThemeStore, afterEnable } = options
  const { canTurnOffAll = false, runtimeConnection, canUseLook = false, lookTarget = null } = options
  const [lists, setLists] = React.useState<PluginEnablement | null>(null)
  const [listings, setListings] = React.useState<readonly ThemePlugin[]>([])
  const round = React.useRef(0)
  const wantsLooks = canUseLook && runtimeConnection !== undefined

  const readLists = React.useCallback(async () => {
    if (!bridge) return
    const mine = ++round.current
    // A later read has started: its answer is the one to show.
    const current = () => mine === round.current
    await Promise.all([
      readPluginEnablement(bridge)
        .catch(() => null)
        .then(next => {
          if (next && current()) setLists(next)
        }),
      wantsLooks
        ? readThemePlugins(bridge)
            .catch(() => null)
            .then(themes => {
              if (themes && current()) setListings(themes.plugins)
            })
        : undefined,
    ])
  }, [bridge, wantsLooks])

  React.useEffect(() => {
    void readLists()
  }, [readLists])

  const viewRefresh = view.refresh
  const refresh = React.useCallback(() => {
    viewRefresh()
    void readLists()
  }, [viewRefresh, readLists])

  const setEnabled = React.useCallback(
    async (mod: ThemeModEntry, enabled: boolean): Promise<void> => {
      if (!bridge) throw new Error(mod.plugin)
      try {
        if (!mod.id.endsWith('@inline')) await pluginsSetEnabled(bridge, mod.id, enabled)
        else if (mod.root) await pluginsSetLocalEnabled(bridge, mod.root, enabled)
        else throw new Error(mod.plugin)
        if (enabled) afterEnable?.(mod.plugin)
      } finally {
        // Whatever the ask did, the rows show what is stored now.
        await readLists()
      }
    },
    [bridge, readLists, afterEnable],
  )

  const viewTurnOffAll = view.turnOffAll
  const turnOffAll = React.useCallback(async (): Promise<number> => {
    try {
      return await turnOffThemePlugins(viewTurnOffAll)
    } finally {
      await readLists()
    }
  }, [viewTurnOffAll, readLists])

  const applyLook = React.useCallback(
    (sessionId: string, plugin: string, lookId: string) => askUseLook(runtimeConnection!, sessionId, plugin, lookId),
    [runtimeConnection],
  )

  const state = view.state
  const setBackdropScope = view.setBackdropScope
  const targetId = lookTarget?.sessionId
  const targetBusy = lookTarget?.busy ?? false
  return React.useMemo(() => {
    if (!state) return undefined
    const enabled = lists ? themeModEnablement(state.mods, lists) : undefined
    return {
      mods: state.mods,
      backdropScope: state.backdropScope,
      single: state.single,
      pluginsOn: state.on,
      ...(enabled ? { enabled } : {}),
      refresh,
      ...(canSetBackdropScope ? { setBackdropScope } : {}),
      ...(bridge && canSetEnabled ? { setEnabled } : {}),
      ...(openThemeStore ? { openThemeStore } : {}),
      ...(canTurnOffAll ? { turnOffAll } : {}),
      ...(wantsLooks && lists && enabled
        ? {
            looks: enabledThemeListings(listings, lists, enabled),
            lookTarget: targetId === undefined ? null : { sessionId: targetId, busy: targetBusy },
            applyLook,
          }
        : {}),
    }
  }, [
    state,
    lists,
    listings,
    refresh,
    setBackdropScope,
    setEnabled,
    bridge,
    canSetEnabled,
    canSetBackdropScope,
    openThemeStore,
    canTurnOffAll,
    turnOffAll,
    wantsLooks,
    targetId,
    targetBusy,
    applyLook,
  ])
}
