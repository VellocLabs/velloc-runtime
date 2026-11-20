// Dev page for the studio catalog (F-1): draws the sample app through the
// surface host, with its events answered locally. Served by the dev server
// only; no build input names it.

import '@fontsource-variable/geist'
import '@/styles/globals.css'
import { lazy, Suspense, useMemo, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DASHBOARD_EXPRESS,
  DASHBOARD_START,
  DASHBOARD_SURFACE_ID,
  dashboardData,
  dashboardStep,
} from './dashboardFixture'
import type { StudioEvent } from '../StudioSurfaceHost'

type Loaded = {
  Host: typeof import('../StudioSurfaceHost').StudioSurfaceHost
  messages: readonly unknown[]
  error: string
}

const events: StudioEvent[] = []
;(window as unknown as { __studioEvents: StudioEvent[] }).__studioEvents = events

const LazySurface = lazy(async () => {
  const [{ StudioSurfaceHost }, { studioUI }, { exportA2UICatalog }, { createStudioExpressCompiler }] = await Promise.all([
    import('../StudioSurfaceHost'),
    import('../studioCatalog'),
    import('@copilotkit/react-core/v2/generative-ui'),
    import('../studioExpress'),
  ])
  const compiled = createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>).compile(DASHBOARD_EXPRESS)
  const loaded: Loaded = {
    Host: StudioSurfaceHost,
    messages: compiled.ok ? compiled.messages : [],
    error: compiled.ok ? '' : compiled.message,
  }
  return { default: () => <Dashboard loaded={loaded} /> }
})

function Dashboard({ loaded }: { loaded: Loaded }): ReactElement {
  const [state, setState] = useState(DASHBOARD_START)
  const operations = useMemo(
    () => [
      ...loaded.messages,
      { version: '1.0', updateDataModel: { surfaceId: DASHBOARD_SURFACE_ID, path: '/data', value: dashboardData(state) } },
    ],
    [loaded, state],
  )
  if (loaded.error) return <pre data-slot="studio-dev-error">{loaded.error}</pre>
  return (
    <loaded.Host
      surfaceId={DASHBOARD_SURFACE_ID}
      operations={operations}
      onEvent={event => {
        events.push(event)
        setState(current => dashboardStep(current, event.name, event.context))
      }}
    />
  )
}

createRoot(document.getElementById('app')!).render(
  <div style={{ maxWidth: 1180, margin: '24px auto', padding: '0 16px' }}>
    <Suspense fallback={null}>
      <LazySurface />
    </Suspense>
  </div>,
)
