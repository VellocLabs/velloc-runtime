// Draws one studio-catalog surface from compiled A2UI operations (F-1). The
// engine's runtime is built here, so nothing is asked of a remote runtime.
//
// Contract: `operations` is the whole list for the surface (the surface, then
// its data); a change replaces it and the engine keeps what the person typed
// and which overlays are open. `onEvent` gets each event a component raises.
// With `dataFromApp`, each sent event hands the values the person set back to
// the app: its later writes to those paths take effect, and a dialog's `open`
// returns to the app's value (`appData`) at once (F-1).

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

/** The data paths a component's properties bind, at any depth. */
function boundPaths(properties: unknown, out: string[] = []): string[] {
  if (Array.isArray(properties)) for (const item of properties) boundPaths(item, out)
  else if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties)) {
      if ((key === '@path' || key === 'path') && typeof value === 'string') {
        if (value.startsWith('/')) out.push(value)
      }
      else boundPaths(value, out)
    }
  }
  return out
}

/** The value at a JSON pointer inside `root`; undefined when a step is missing. */
function valueAt(root: unknown, pointer: string): unknown {
  let at: unknown = root
  for (const raw of pointer.split('/').slice(1)) {
    const step = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (at === null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, step)) return undefined
    at = (at as Record<string, unknown>)[step]
  }
  return at
}

type EngineSurface = {
  key?: string
  model?: {
    dataModel?: { set(path: string, value: unknown): void }
    componentsModel?: {
      get(id: string): { properties?: unknown } | undefined
      entries?: Iterable<[string, { type?: string; properties?: unknown }]>
    }
  }
}

/** The data paths the surface's dialogs bind their `open` to, except a dialog `trigger` opens. */
function dialogOpenPaths(surface: EngineSurface, trigger: string | undefined): string[] {
  const out: string[] = []
  const entries = surface.model?.componentsModel?.entries
  if (entries === undefined) {
    console.warn('[a2ui] studio engine has no component list; dialogs keep the open value the person set')
    return out
  }
  for (const [, component] of entries) {
    if (component?.type !== 'Modal') continue
    const props = component.properties as { open?: unknown; trigger?: unknown } | undefined
    if (trigger !== undefined && props?.trigger === trigger) continue
    out.push(...boundPaths(props?.open))
  }
  return out
}

/**
 * Hands the values the person set on `surfaceId` back to the app once an event
 * is sent, so the app's later writes to those paths apply. A dialog's `open`
 * also goes back to the app's own value at once (`appData` under `/data`), so
 * a dialog the app keeps closed closes on any event from inside it, unless the
 * event comes from that dialog's own trigger. Other values (typed text,
 * a checked row) stay as the person left them until the app writes. The
 * engine keeps these values in a per-surface map it does not expose.
 */
export function releasePersonValues(
  manager: GenerativeUISurfaceManager,
  surfaceId: string,
  componentId: string | undefined,
  appData: unknown,
): void {
  const surface = manager.getSurface(THREAD, surfaceId) as EngineSurface | undefined
  const owned = (manager as unknown as { owned?: Map<string, Map<string, unknown>> }).owned
  if (!(owned instanceof Map)) {
    console.warn('[a2ui] studio engine has no person-value map; app writes after an event may be refused')
    return
  }
  if (!surface?.key) return
  owned.delete(surface.key)
  for (const path of dialogOpenPaths(surface, componentId)) {
    surface.model?.dataModel?.set(path, valueAt({ data: appData }, path))
  }
}

export function StudioSurfaceHost({
  surfaceId,
  operations,
  onEvent,
  dataFromApp = false,
  appData,
}: {
  surfaceId: string
  operations: readonly unknown[]
  onEvent?: (event: StudioEvent) => void
  dataFromApp?: boolean
  /** The app's own data value, which a released person value goes back to. */
  appData?: unknown
}): ReactElement {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const dataFromAppRef = useRef(dataFromApp)
  dataFromAppRef.current = dataFromApp
  const appDataRef = useRef(appData)
  appDataRef.current = appData
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
        if (dataFromAppRef.current) releasePersonValues(manager, event.surfaceId, event.componentId, appDataRef.current)
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
