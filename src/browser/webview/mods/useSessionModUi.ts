/**
 * One session's whole mod UI value — the `mods/ui/<sessionId>` view plus who each
 * plugin is (`mods/state`) and the icon's jump to Settings (F-25). Readers share the
 * per-(connection, session) stores.
 */
import { useMemo } from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { ModUiContextValue } from '../../../components/assistant-ui/mod-ui-context'
import { summarizeModsByPlugin, useModsStateView } from './modsStateView'
import { useModsUiView } from './modsUiView'

export function useSessionModUi(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  sessionId: string | undefined,
  options: {
    /** `mods.list` is allowed on this connection (`useCan('mods', 'list')`). */
    canListMods: boolean
    onOpenPluginSettings?: (plugin: string) => void
    panesDocked?: boolean
    /** The docked pane whose card is open (`ModUiContextValue.dockFront`). */
    dockFront?: { plugin: string; id: string } | null
    setDockFront?: (front: { plugin: string; id: string } | null) => void
  },
): ModUiContextValue {
  const { canListMods, onOpenPluginSettings, panesDocked, dockFront, setDockFront } = options
  const lines = useModsUiView(runtimeConnection, sessionId)
  const modsState = useModsStateView(runtimeConnection, canListMods)
  const plugins = useMemo(
    () =>
      Object.fromEntries(
        summarizeModsByPlugin(modsState).map(summary => [
          summary.plugin,
          { version: summary.version, description: summary.description, state: summary.worst },
        ]),
      ),
    [modsState],
  )
  return useMemo(
    () => ({
      ...lines,
      plugins,
      ...(onOpenPluginSettings ? { openPluginSettings: onOpenPluginSettings } : {}),
      ...(panesDocked ? { panesDocked: true } : {}),
      ...(dockFront !== undefined ? { dockFront } : {}),
      ...(setDockFront ? { setDockFront } : {}),
    }),
    [lines, plugins, onOpenPluginSettings, panesDocked, dockFront, setDockFront],
  )
}
