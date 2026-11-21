// Draws one studio-catalog surface from compiled A2UI operations (F-1). The
// engine's runtime is built here, so nothing is asked of a remote runtime.
//
// Contract: `operations` is the whole list for the surface (the surface, then
// its data); a change replaces it and the engine keeps what the person typed
// and which overlays are open. `onEvent` gets each event a component raises.
// With `dataFromApp`, each sent event hands the values the person set back to
// the app: its later writes to those paths take effect (F-1).

import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { createGenerativeUIDispatcher, GenerativeUISurfaceManager } from '@copilotkit/core/generative-ui'
import { GenerativeUISurface } from '@copilotkit/react-core/v2/generative-ui'
import { GenerativeUIRuntimeContext } from '@copilotkit/react-core/v2/generative-ui/native'
import '@copilotkit/react-core/v2/styles.css'
import './studio.css'
import './vendor/styles/tokens.css'
import './vendor/styles/motion.css'
import { shownColorScheme, watchShownColorScheme } from '@/lib/shownColorScheme'
import { studioTheme, studioUI } from './studioCatalog'
import { setStudioTranslate } from './studioText'
import { useT } from '../../i18n'

export type StudioEvent = {
  name: string
  surfaceId: string
  componentId?: string
  context?: Record<string, unknown>
}

const THREAD = 'studio'

const { dark: DARK_VARIABLES, ...THEME_VARIABLES } = studioTheme as Record<string, unknown> & { dark?: Record<string, unknown> }
/** Marks an overlay drawn outside the surface as a studio one, for studio.css. */
export const STUDIO_OVERLAY_MARK = '--velloc-studio-overlay'
/** The accent follows Velloc's own primary colour (set on the root by the host theme), light and dark alike. */
const HOST_ACCENT = {
  '--a2ui-color-accent': 'var(--velloc-host-primary)',
  '--a2ui-color-on-accent': 'var(--velloc-host-primary-foreground)',
}
const LIGHT_VARIABLES = { ...THEME_VARIABLES, [STUDIO_OVERLAY_MARK]: '1', ...HOST_ACCENT }
const DARK_THEME = { ...LIGHT_VARIABLES, ...DARK_VARIABLES, ...HOST_ACCENT }

/**
 * The theme variables of the mode the window shows. An overlay the engine
 * draws outside the surface takes only the top-level variables, so the dark
 * values are given as those rather than under `dark`.
 */
function useShownTheme(): Record<string, unknown> {
  const scheme = useSyncExternalStore(watchShownColorScheme, () => shownColorScheme(), () => 'light' as const)
  return scheme === 'dark' ? DARK_THEME : LIGHT_VARIABLES
}

/**
 * Forgets the values the person set on `surfaceId`, so the source's next write
 * to those paths is applied instead of refused. The engine keeps them in a
 * per-surface map it does not expose.
 */
export function releasePersonValues(manager: GenerativeUISurfaceManager, surfaceId: string): void {
  const key = (manager.getSurface(THREAD, surfaceId) as { key?: string } | undefined)?.key
  const owned = (manager as unknown as { owned?: Map<string, unknown> }).owned
  if (key !== undefined && owned instanceof Map) owned.delete(key)
}

export function StudioSurfaceHost({
  surfaceId,
  operations,
  onEvent,
  dataFromApp = false,
}: {
  surfaceId: string
  operations: readonly unknown[]
  onEvent?: (event: StudioEvent) => void
  dataFromApp?: boolean
}): ReactElement {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const dataFromAppRef = useRef(dataFromApp)
  dataFromAppRef.current = dataFromApp
  const theme = useShownTheme()
  setStudioTranslate(useT())
  const core = useMemo(() => {
    const reportError = (info: unknown): void => console.warn('[a2ui] studio surface error', info)
    const manager = new GenerativeUISurfaceManager(studioUI as never, {
      onOperationRejected: info => console.warn('[a2ui] studio operation rejected', info),
    })
    manager.setActiveThread(THREAD)
    const dispatcher = createGenerativeUIDispatcher({
      getDeclared: () => (studioUI as unknown as { functions: never }).functions,
    })
    return {
      manager,
      dispatcher,
      ui: studioUI,
      transport: 'tool' as const,
      config: { ui: studioUI },
      forwardEvent: async (event: StudioEvent) => {
        onEventRef.current?.(event)
        if (dataFromAppRef.current) releasePersonValues(manager, event.surfaceId)
        return { ok: true as const, result: null }
      },
      reportError,
    }
  }, [])
  const runtime = useMemo(() => ({ ...core, theme }), [core, theme])
  const target = `studio:${surfaceId}`
  useEffect(() => {
    core.manager.ingest(THREAD, undefined, {
      surfaceId,
      target,
      catalogId: studioUI.id,
      operations: operations as never,
      status: 'ready',
      rejected: [],
    } as never)
  }, [core, surfaceId, target, operations])
  // A surface this host no longer draws leaves its manager.
  useEffect(() => () => core.manager.forgetSurface(THREAD, surfaceId), [core, surfaceId])
  return (
    <GenerativeUIRuntimeContext.Provider value={runtime as never}>
      <div data-slot="a2ui-studio-surface" className="a2-surface-host a2-static">
        <GenerativeUISurface id={target} ui={studioUI as never} autoScroll={false} />
      </div>
    </GenerativeUIRuntimeContext.Provider>
  )
}
