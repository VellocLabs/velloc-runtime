// @vitest-environment happy-dom
/**
 * Settings - Models - "Model data": shows the status the runtime publishes on
 * `catalog/status` and asks `catalog.refresh`. Driven by a fake connection; no
 * catalog service is involved.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { ModelDataSection } from '../browser/webview/settings/sections/ModelDataSection'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { CATALOG_STATUS_TOPIC, type CatalogStatusState } from '../catalog/catalogProtocol'
import { queryFor } from './_helpers/capabilityQuery'

afterEach(cleanup)

function rig(initial: CatalogStatusState, onRefresh?: () => unknown) {
  const requests: Array<{ route: string; payload: unknown }> = []
  let push: (s: CatalogStatusState) => void = () => {}
  const conn = {
    subscribe: (topic: string, listener: (event: { payload: unknown }) => void) => {
      if (topic === CATALOG_STATUS_TOPIC) {
        push = s => listener({ payload: s })
        queueMicrotask(() => push(initial))
      }
      return () => {}
    },
    request: async (route: string, payload: unknown) => {
      requests.push({ route, payload })
      return onRefresh ? onRefresh() : { available: true }
    },
  } as unknown as RuntimeConnection
  return { requests, connection: () => Promise.resolve(conn), push: (s: CatalogStatusState) => push(s) }
}

function show(r: ReturnType<typeof rig>, acts: string[] = ['refresh']) {
  render(
    createElement(
      RuntimeCapabilitiesContext.Provider,
      { value: queryFor(acts.length ? [{ cap: 'catalog', acts }] : []) },
      createElement(ModelDataSection, { runtimeConnection: r.connection }),
    ),
  )
}

describe('ModelDataSection', () => {
  it('renders nothing without a connection', () => {
    const { container } = render(createElement(ModelDataSection, {}))
    expect(container.textContent).toBe('')
  })

  it('shows source, time, count and the last error', async () => {
    const r = rig({
      available: true,
      status: { source: 'cache', fetchedAt: Date.UTC(2026, 9, 1, 12, 0), models: 321, lastError: 'catalog source answered HTTP 503' },
    })
    show(r)
    await waitFor(() => expect(screen.getByTestId('model-data-source')).toBeTruthy())
    expect(screen.getByTestId('model-data-source').textContent).toBe('Source: Saved copy')
    expect(screen.getByTestId('model-data-source').getAttribute('data-source')).toBe('cache')
    expect(screen.getByTestId('model-data-updated').textContent).toMatch(/^Updated .*2026.* · 321 models$/)
    expect(screen.getByTestId('model-data-error').textContent).toBe('Last error: catalog source answered HTTP 503')
  })

  it('a snapshot shows its generation time; none says the time is unknown', async () => {
    const r = rig({ available: true, status: { source: 'snapshot', generatedAt: Date.UTC(2026, 9, 1), models: 5 } })
    show(r)
    await waitFor(() => expect(screen.getByTestId('model-data-source').textContent).toBe('Source: Built-in snapshot'))
    r.push({ available: true, status: { source: 'none', models: 0 } })
    await waitFor(() => expect(screen.getByTestId('model-data-source').textContent).toBe('Source: None'))
    expect(screen.getByTestId('model-data-updated').textContent).toBe('Update time unknown')
  })

  it('Refresh model data asks catalog.refresh and shows the status the topic then publishes', async () => {
    const r = rig({ available: true, status: { source: 'snapshot', generatedAt: 1, models: 5 } })
    show(r)
    const button = await screen.findByTestId('model-data-refresh')
    expect(button.textContent).toBe('Refresh model data')
    fireEvent.click(button)
    await waitFor(() => expect(r.requests).toEqual([{ route: 'catalog.refresh', payload: {} }]))
    r.push({ available: true, status: { source: 'live', fetchedAt: Date.UTC(2026, 9, 2), generatedAt: 2, models: 6 } })
    await waitFor(() => expect(screen.getByTestId('model-data-source').textContent).toBe('Source: Live'))
  })

  it('a refused refresh says so; the status stands', async () => {
    const r = rig({ available: true, status: { source: 'snapshot', generatedAt: 1, models: 5 } }, () => {
      throw new Error('forbidden_scope')
    })
    show(r)
    fireEvent.click(await screen.findByTestId('model-data-refresh'))
    await waitFor(() => expect(screen.getByTestId('model-data-refresh-failed').textContent).toBe('Could not refresh model data.'))
    expect(screen.getByTestId('model-data-source').textContent).toBe('Source: Built-in snapshot')
  })

  it('a connection without the refresh grant sees the status and no button', async () => {
    const r = rig({ available: true, status: { source: 'live', fetchedAt: 1, models: 5 } })
    show(r, [])
    await screen.findByTestId('model-data-source')
    expect(screen.queryByTestId('model-data-refresh')).toBeNull()
  })

  it('without a service in the runtime it says so and the button is disabled', async () => {
    const r = rig({ available: false })
    show(r)
    expect((await screen.findByTestId('model-data-unavailable')).textContent).toBe('Model data is not available right now.')
    expect((screen.getByTestId('model-data-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})
