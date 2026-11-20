// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import { GenerativeUISurfaceManager } from '@copilotkit/core/generative-ui'
import { STUDIO_CATALOG_ID, studioUI } from '../browser/webview/a2ui/studio/studioCatalog'
import { createStudioExpressCompiler } from '../toolkit/builtin/a2ui/express/studioExpress'
import { StudioSurfaceHost, type StudioEvent } from '../browser/webview/a2ui/studio/StudioSurfaceHost'
import {
  DASHBOARD_EXPRESS,
  DASHBOARD_START,
  DASHBOARD_SURFACE_ID,
  dashboardData,
  dashboardStep,
  type DashboardState,
} from '../browser/webview/a2ui/studio/dev/dashboardFixture'

type Compiled = { createSurface?: { surfaceId: string; catalogId: string; components: { id: string; component: string; children?: unknown }[] } }

const compiler = createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)

function compileDashboard(): Compiled[] {
  const result = compiler.compile(DASHBOARD_EXPRESS)
  if (!result.ok) throw new Error(result.message)
  return result.messages as Compiled[]
}

function operationsFor(state: DashboardState): unknown[] {
  return [
    ...compileDashboard(),
    { version: '1.0', updateDataModel: { surfaceId: DASHBOARD_SURFACE_ID, path: '/data', value: dashboardData(state) } },
  ]
}

function host(state: DashboardState, onEvent?: (event: StudioEvent) => void) {
  return createElement(StudioSurfaceHost, { surfaceId: DASHBOARD_SURFACE_ID, operations: operationsFor(state), onEvent })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('studio catalog', () => {
  it('compiles Express against its own id, standard and added components alike', () => {
    const surface = compileDashboard()[0]?.createSurface
    expect(surface?.surfaceId).toBe(DASHBOARD_SURFACE_ID)
    expect(surface?.catalogId).toBe(STUDIO_CATALOG_ID)
    const used = new Set(surface?.components.map(component => component.component))
    for (const name of ['Column', 'Heading', 'Badge', 'Button', 'Modal', 'Grid', 'Stat', 'DataTable']) {
      expect(used.has(name), name).toBe(true)
    }
  })

  it('compiles a list template to one child component per data row', () => {
    const list = compileDashboard()[0]?.createSurface?.components.find(component => component.id === 'pick_list')
    expect(list?.children).toEqual({ path: '/data/rows', componentId: 'pick_row' })
  })

  it('refuses a component the catalog does not have', () => {
    const result = compiler.compile('surface("x")\nroot = NoSuchComponent("a")\n')
    expect(result.ok).toBe(false)
  })
})

describe('studio surface host', () => {
  it('draws bound data and asks nothing of the network', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network')))
    vi.stubGlobal('fetch', fetchSpy)
    const view = render(host(DASHBOARD_START))
    await waitFor(() => expect(view.container.textContent).toContain('系统运行正常'))
    expect(view.container.textContent).toContain('已启用模型')
    expect(view.container.textContent).toContain('Atlas Large')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hands a click to the host with the event name', async () => {
    const events: StudioEvent[] = []
    const view = render(host(DASHBOARD_START, event => events.push(event)))
    const button = await waitFor(() => {
      const found = [...view.container.querySelectorAll('button')].find(node => node.textContent?.includes('刷新状态'))
      if (!found) throw new Error('no refresh button yet')
      return found
    })
    fireEvent.click(button)
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ name: 'refresh_status', surfaceId: DASHBOARD_SURFACE_ID, componentId: 'refresh_btn' })
  })

  it('redraws bound text when the whole list is given again with new data', async () => {
    const view = render(host(DASHBOARD_START))
    await waitFor(() => expect(view.container.textContent).toContain('系统运行正常'))
    view.rerender(host(dashboardStep(DASHBOARD_START, 'refresh_status', undefined)))
    await waitFor(() => expect(view.container.textContent).toContain('系统运行正常 · 1'))
  })
})

describe('studio surface host lifetime', () => {
  it('draws another surface in place of the one it drew, and unmounts cleanly', async () => {
    const second = compiler.compile('surface("second")\nroot = Text("SECOND_SURFACE")\n')
    if (!second.ok) throw new Error(second.message)
    const forget = vi.spyOn(GenerativeUISurfaceManager.prototype, 'forgetSurface')
    const view = render(host(DASHBOARD_START))
    await waitFor(() => expect(view.container.textContent).toContain('系统运行正常'))
    forget.mockClear()
    view.rerender(createElement(StudioSurfaceHost, { surfaceId: 'second', operations: second.messages }))
    expect(forget).toHaveBeenCalledWith('studio', DASHBOARD_SURFACE_ID)
    await waitFor(() => expect(view.container.textContent).toContain('SECOND_SURFACE'))
    expect(view.container.textContent).not.toContain('系统运行正常')
    view.rerender(host(DASHBOARD_START))
    await waitFor(() => expect(view.container.textContent).toContain('系统运行正常'))
    forget.mockClear()
    expect(() => view.unmount()).not.toThrow()
    expect(forget).toHaveBeenCalledWith('studio', DASHBOARD_SURFACE_ID)
    forget.mockRestore()
  })
})

describe('dev dashboard state', () => {
  it('adds and removes a member from a pick event', () => {
    const added = dashboardStep(DASHBOARD_START, 'pick', { step: 'add', model: 'model-9' })
    expect(added.members).toEqual(['model-1', 'model-2', 'model-3', 'model-9'])
    const removed = dashboardStep(added, 'pick', { step: 'remove', model: 'model-2' })
    expect(removed.members).toEqual(['model-1', 'model-3', 'model-9'])
    const rows = dashboardData(removed).rows as { id: string; step: string; mark: string }[]
    expect(rows.find(row => row.id === 'model-9')).toMatchObject({ step: 'remove', mark: '✓' })
    expect(rows.find(row => row.id === 'model-2')).toMatchObject({ step: 'add', mark: '' })
  })

  it('leaves the state alone for an event it does not know', () => {
    expect(dashboardStep(DASHBOARD_START, 'other', { model: 'model-9' })).toBe(DASHBOARD_START)
  })
})
