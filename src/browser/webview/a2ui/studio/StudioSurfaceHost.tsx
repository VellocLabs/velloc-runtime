// Draws one studio-catalog surface from compiled A2UI operations (F-1). The
// engine's runtime is built here, so nothing is asked of a remote runtime.
//
// Contract: `operations` is the whole list for the surface (the surface, then
// its data); a change replaces it and the engine keeps what the person typed
// and which overlays are open. `onEvent` gets each event a component raises.
// With `dataFromApp`, an event hands back only the values it carries, a value
// the person set gives way where the app's `appData` changes, and a dialog
// closes on its own submit or close control or the app's write (F-1).

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

type EngineComponent = { type?: string; properties?: unknown }
type EngineSurface = {
  key?: string
  model?: {
    dataModel?: { set(path: string, value: unknown): void }
    componentsModel?: {
      get(id: string): EngineComponent | undefined
      entries?: Iterable<[string, EngineComponent]>
    }
  }
}
type OwnedValues = Map<string, Map<string, unknown>>

/** The engine's per-surface map of the values the person set; undefined (and logged) when the engine has none. */
function ownedValues(manager: GenerativeUISurfaceManager): OwnedValues | undefined {
  const owned = (manager as unknown as { owned?: OwnedValues }).owned
  if (owned instanceof Map) return owned
  console.warn('[a2ui] studio engine has no person-value map; app writes may be refused')
  return undefined
}

const atOrBelow = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`)

/** The ids of the components below `id`: every property string that names a component of the surface. */
function descendants(surface: EngineSurface, id: string, out = new Set<string>()): Set<string> {
  const model = surface.model?.componentsModel
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!out.has(value) && model?.get(value)) {
        out.add(value)
        visit(model.get(value)?.properties)
      }
    } else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(model?.get(id)?.properties)
  return out
}

/**
 * The `open` paths of the dialogs whose content holds `componentId`, when that
 * component is a Button: the dialog's own submit or close control.
 */
function dialogsClosedBy(surface: EngineSurface, componentId: string): string[] {
  const model = surface.model?.componentsModel
  if (model?.get(componentId)?.type !== 'Button') return []
  if (model.entries === undefined) {
    console.warn('[a2ui] studio engine has no component list; a dialog stays open after its submit control')
    return []
  }
  const out: string[] = []
  for (const [id, component] of model.entries) {
    if (component?.type !== 'Modal') continue
    const props = component.properties as { open?: unknown; content?: unknown } | undefined
    if (typeof props?.content !== 'string') continue
    const inside = props.content === componentId || descendants(surface, props.content).has(componentId)
    if (inside && id !== componentId) out.push(...boundPaths(props.open))
  }
  return out
}

/**
 * After an event: hands back to the app only the values the event carries (the
 * paths its component binds), so the app's next write to them applies; every
 * other value the person set stays. A Button inside a dialog's content is that
 * dialog's submit or close control: the dialog closes, and its `open` is the
 * app's again.
 */
export function releaseEventValues(manager: GenerativeUISurfaceManager, surfaceId: string, componentId: string | undefined): void {
  const surface = manager.getSurface(THREAD, surfaceId) as EngineSurface | undefined
  const owned = ownedValues(manager)
  if (!owned || !surface?.key || componentId === undefined) return
  const values = owned.get(surface.key)
  const carried = boundPaths(surface.model?.componentsModel?.get(componentId)?.properties)
  if (values) for (const path of [...values.keys()]) if (carried.some(base => atOrBelow(path, base))) values.delete(path)
  for (const path of dialogsClosedBy(surface, componentId)) {
    values?.delete(path)
    surface.model?.dataModel?.set(path, false)
  }
}

/**
 * Before the app's new data is applied: hands back each value the person set
 * whose path the app's value changed at, so that write shows; a key the app
 * left as it was keeps the person's value.
 */
export function releaseChangedValues(manager: GenerativeUISurfaceManager, surfaceId: string, before: unknown, after: unknown): void {
  const surface = manager.getSurface(THREAD, surfaceId) as EngineSurface | undefined
  if (!surface?.key) return
  const values = ownedValues(manager)?.get(surface.key)
  if (!values) return
  for (const path of [...values.keys()]) {
    if (!path.startsWith('/data/')) continue
    const was = valueAt({ data: before }, path)
    const now = valueAt({ data: after }, path)
    if (JSON.stringify(was) !== JSON.stringify(now)) values.delete(path)
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
  /** The app's data value; a value the person set gives way where this changes. */
  appData?: unknown
}): ReactElement {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const dataFromAppRef = useRef(dataFromApp)
  dataFromAppRef.current = dataFromApp
  const appDataRef = useRef(appData)
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
        if (dataFromAppRef.current) releaseEventValues(manager, event.surfaceId, event.componentId)
        return { ok: true as const, result: null }
      },
      reportError,
    }
  }, [])
  const runtime = useMemo(() => ({ ...core, theme }), [core, theme])
  const target = `studio:${surfaceId}`
  useEffect(() => {
    if (dataFromAppRef.current && appDataRef.current !== appData) releaseChangedValues(core.manager, surfaceId, appDataRef.current, appData)
    appDataRef.current = appData
    core.manager.ingest(THREAD, undefined, {
      surfaceId,
      target,
      catalogId: studioUI.id,
      operations: operations as never,
      status: 'ready',
      rejected: [],
    } as never)
  }, [core, surfaceId, target, operations, appData])
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
