/**
 * What the window gives a conversation's theme menu (F-25): the theme mods,
 * which of them are enabled — read from the plugin lists, the same answer
 * Settings shows — and the asks this connection may make.
 */
import * as React from 'react'

import type { ThemeModsContextValue } from '../../../components/assistant-ui/theme-mods-context'
import type { ThemeModEntry } from '../../../mods/themeMods'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'
import {
  pluginsListBuiltin,
  pluginsListInstalled,
  pluginsListLocal,
  pluginsSetEnabled,
  pluginsSetLocalEnabled,
} from '../settings/clients'
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
}

/** Undefined until the runtime has answered the theme mods. */
export function useThemeModsMenu(options: ThemeModsMenuOptions): ThemeModsContextValue | undefined {
  const { view, bridge, canSetEnabled, canSetBackdropScope, openThemeStore } = options
  const [lists, setLists] = React.useState<PluginEnablement | null>(null)
  const round = React.useRef(0)

  const readLists = React.useCallback(async () => {
    if (!bridge) return
    const mine = ++round.current
    const next = await readPluginEnablement(bridge).catch(() => null)
    // A later read has started: its answer is the one to show.
    if (next && mine === round.current) setLists(next)
  }, [bridge])

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
      } finally {
        // Whatever the ask did, the rows show what is stored now.
        await readLists()
      }
    },
    [bridge, readLists],
  )

  const state = view.state
  const setBackdropScope = view.setBackdropScope
  return React.useMemo(() => {
    if (!state) return undefined
    return {
      mods: state.mods,
      backdropScope: state.backdropScope,
      ...(lists ? { enabled: themeModEnablement(state.mods, lists) } : {}),
      refresh,
      ...(canSetBackdropScope ? { setBackdropScope } : {}),
      ...(bridge && canSetEnabled ? { setEnabled } : {}),
      ...(openThemeStore ? { openThemeStore } : {}),
    }
  }, [state, lists, refresh, setBackdropScope, setEnabled, bridge, canSetEnabled, canSetBackdropScope, openThemeStore])
}
