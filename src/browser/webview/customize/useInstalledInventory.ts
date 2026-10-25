import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import { summarizeModsByPlugin, useModsStateView } from '../mods/modsStateView'
import { useSettingsBridge } from '../nexusSettingsBridge'
import { mcpSettingsList, pluginsListInstalled, skillsListInstalled } from '../settings/clients'
import {
  buildInstalledRows,
  EMPTY_INVENTORY,
  type InstalledGroup,
  type InstalledInventory,
  type InstalledRow,
} from './installedRows'

export type InstalledInventoryView = {
  rows: Record<InstalledGroup, InstalledRow[]>
  /** True until the first read of the three lists has answered. */
  loading: boolean
}

/**
 * The installed column's data (F-35): plugins, skills and MCP servers read
 * once per open through the settings bridge; mods from the shared
 * `mods/state` view. A connection without the settings bridge shows the
 * groups empty.
 */
export function useInstalledInventory(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  open: boolean,
): InstalledInventoryView {
  const bridge = useSettingsBridge()
  const modsView = useModsStateView(runtimeConnection, open)
  const [lists, setLists] = React.useState<Omit<InstalledInventory, 'mods'> | null>(null)

  React.useEffect(() => {
    if (!open) return
    setLists(null)
    if (!bridge) {
      setLists({ plugins: [], skills: [], mcp: {} })
      return
    }
    let live = true
    void Promise.allSettled([
      pluginsListInstalled(bridge),
      skillsListInstalled(bridge),
      mcpSettingsList(bridge),
    ]).then(([plugins, skills, mcp]) => {
      if (!live) return
      setLists({
        plugins: plugins.status === 'fulfilled' ? plugins.value.plugins : [],
        skills: skills.status === 'fulfilled' ? skills.value.skills : [],
        mcp: mcp.status === 'fulfilled' ? mcp.value.servers : {},
      })
    })
    return () => {
      live = false
    }
  }, [bridge, open])

  const rows = React.useMemo(
    () =>
      buildInstalledRows({
        ...(lists ?? EMPTY_INVENTORY),
        mods: summarizeModsByPlugin(modsView),
      }),
    [lists, modsView],
  )
  return { rows, loading: lists === null }
}
