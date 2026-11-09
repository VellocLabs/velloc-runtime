// @vitest-environment happy-dom
/**
 * The app on screen (F-40), page side: its topbar icon reads as pressed while
 * its pane is open in the shown session; once another session, another app
 * or Settings covers it, its pane closes and the icon is released. Every
 * change is reported to the runtime as `mods.appView`.
 */
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { appCoveredBy, shownAppOf, useShownApp, type ShownApp } from '../browser/webview/apps/appView'
import { appPaneRecord } from '../browser/webview/apps/appLaunch'
import { closePane, defaultSessionPaneRecord, hasPane, setMaximized, type SessionPaneRecord } from '../browser/webview/layout/paneLayout'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { PluginTopbarItems, usePluginTopbarItems } from '../browser/webview/topbar/PluginTopbarItems'
import { TooltipProvider } from '../components/ui/tooltip'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import type { ModContributionsState } from '../browser/runtimeProtocol/modContributions'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'

afterEach(() => cleanup())

const WEIGHTS = {} as never
const APPS: ReadonlySet<string> = new Set(['pay:board', 'crm:board'])
const open = (): SessionPaneRecord => appPaneRecord(defaultSessionPaneRecord(), WEIGHTS)

describe('shownAppOf', () => {
  it('is the app of the shown session while its pane is open and nothing covers it, full or beside the chat', () => {
    const base = { sessionId: 's1', templateType: 'pay:board', appTypes: APPS, covered: false }
    expect(shownAppOf({ ...base, record: open() })).toEqual({ sessionId: 's1', type: 'pay:board', layout: 'full' })
    expect(shownAppOf({ ...base, record: setMaximized(open(), null) })).toEqual({ sessionId: 's1', type: 'pay:board', layout: 'beside' })
    expect(shownAppOf({ ...base, record: closePane(open(), 'a2ui') })).toBeNull()
    expect(shownAppOf({ ...base, record: open(), covered: true })).toBeNull()
    expect(shownAppOf({ ...base, templateType: 'chat', record: open() })).toBeNull()
    expect(shownAppOf({ ...base, templateType: undefined, record: open() })).toBeNull()
    expect(shownAppOf({ ...base, sessionId: undefined, record: open() })).toBeNull()
  })

  it('counts an app as covered when the shown session or a page moves over it, not when the person closes or restores its pane', () => {
    const app: ShownApp = { sessionId: 's1', type: 'pay:board', layout: 'full' }
    expect(appCoveredBy(app, null, 's2', false)).toBe(true)
    expect(appCoveredBy(app, { sessionId: 's2', type: 'crm:board', layout: 'full' }, 's2', false)).toBe(true)
    expect(appCoveredBy(app, null, 's1', true)).toBe(true)
    expect(appCoveredBy(app, null, 's1', false)).toBe(false)
    expect(appCoveredBy(app, { ...app, layout: 'beside' }, 's1', false)).toBe(false)
    expect(appCoveredBy(null, app, 's1', false)).toBe(false)
  })
})

describe('useShownApp', () => {
  type Props = { sessionId: string; covered?: boolean; linkReady?: boolean }

  function rig(types: Record<string, string>) {
    const records = new Map<string, SessionPaneRecord>(Object.keys(types).map(id => [id, types[id]!.endsWith(':board') ? open() : defaultSessionPaneRecord()]))
    const reports: unknown[] = []
    const connection = { request: vi.fn(async (route: string, payload: unknown) => { reports.push([route, payload]); return {} }) } as unknown as RuntimeConnection
    const runtimeConnection = async () => connection
    const updatePaneRecord = vi.fn((fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => {
      records.set(sessionId!, fn(records.get(sessionId!)!))
    })
    const view = renderHook(
      (props: Props) =>
        useShownApp({
          sessionId: props.sessionId,
          templateType: types[props.sessionId],
          appTypes: APPS,
          record: records.get(props.sessionId)!,
          covered: props.covered ?? false,
          updatePaneRecord,
          runtimeConnection,
          linkReady: props.linkReady ?? true,
        }),
      { initialProps: { sessionId: 'app1' } as Props },
    )
    const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    return { view, records, reports, updatePaneRecord, flush }
  }

  it('reports the app open; another session over it closes its pane and reports it closed', async () => {
    const { view, records, reports, flush } = rig({ app1: 'pay:board', chat: 'chat' })
    expect(view.result.current).toBe('pay:board')
    await flush()
    expect(reports).toEqual([['mods.appView', { sessionId: 'app1', layout: 'full' }]])
    view.rerender({ sessionId: 'chat' })
    await flush()
    expect(view.result.current).toBeUndefined()
    expect(hasPane(records.get('app1')!.layout, 'a2ui')).toBe(false)
    expect(reports.at(-1)).toEqual(['mods.appView', { sessionId: 'app1', layout: null }])
  })

  it('another app over it closes the first and opens the second, in that order', async () => {
    const { view, records, reports, flush } = rig({ app1: 'pay:board', app2: 'crm:board' })
    await flush()
    view.rerender({ sessionId: 'app2' })
    await flush()
    expect(view.result.current).toBe('crm:board')
    expect(hasPane(records.get('app1')!.layout, 'a2ui')).toBe(false)
    expect(hasPane(records.get('app2')!.layout, 'a2ui')).toBe(true)
    expect(reports.slice(1)).toEqual([
      ['mods.appView', { sessionId: 'app1', layout: null }],
      ['mods.appView', { sessionId: 'app2', layout: 'full' }],
    ])
  })

  it('a page such as Settings over it closes its pane; closing the page leaves the chat, not the app', async () => {
    const { view, records, reports, flush } = rig({ app1: 'pay:board' })
    await flush()
    view.rerender({ sessionId: 'app1', covered: true })
    await flush()
    expect(view.result.current).toBeUndefined()
    expect(hasPane(records.get('app1')!.layout, 'a2ui')).toBe(false)
    view.rerender({ sessionId: 'app1', covered: false })
    await flush()
    expect(view.result.current).toBeUndefined()
    expect(reports.slice(1)).toEqual([['mods.appView', { sessionId: 'app1', layout: null }]])
  })

  it('a restore beside the chat is a layout change, the app stays open; the person closing the pane closes nothing else', async () => {
    const { view, records, reports, updatePaneRecord, flush } = rig({ app1: 'pay:board' })
    await flush()
    records.set('app1', setMaximized(records.get('app1')!, null))
    view.rerender({ sessionId: 'app1' })
    await flush()
    expect(view.result.current).toBe('pay:board')
    expect(reports.at(-1)).toEqual(['mods.appView', { sessionId: 'app1', layout: 'beside' }])
    records.set('app1', closePane(records.get('app1')!, 'a2ui'))
    view.rerender({ sessionId: 'app1' })
    await flush()
    expect(reports.at(-1)).toEqual(['mods.appView', { sessionId: 'app1', layout: null }])
    expect(updatePaneRecord).not.toHaveBeenCalled()
  })

  it('sends nothing while the link is down, and reports the app again when it comes back', async () => {
    const { view, reports, flush } = rig({ app1: 'pay:board' })
    await flush()
    view.rerender({ sessionId: 'app1', linkReady: false })
    await flush()
    expect(reports).toHaveLength(1)
    view.rerender({ sessionId: 'app1', linkReady: true })
    await flush()
    expect(reports).toEqual([
      ['mods.appView', { sessionId: 'app1', layout: 'full' }],
      ['mods.appView', { sessionId: 'app1', layout: 'full' }],
    ])
  })
})

const STATE: ModContributionsState = {
  templates: [{ type: 'pay:board', plugin: 'pay', owner: 'pay@mkt', title: 'Payments', launcher: 'hidden' }],
  topbar: [{ id: 'pay:sync', plugin: 'pay', title: 'Sync', icon: { lucide: 'zap' } }],
  apps: [{ type: 'pay:board', appId: 'pay-board', plugin: 'pay', title: 'Payments', icon: { lucide: 'star' } }],
  icons: {},
  waiting: [],
}

describe("an app's topbar icon on screen", () => {
  function Bar(props: { shown?: string }) {
    return h(PluginTopbarItems, { state: usePluginTopbarItems('s1', vi.fn(), vi.fn(), props.shown), folded: new Set<string>() })
  }
  const renderBar = (shown?: string) =>
    render(h(RuntimeCapabilitiesContext.Provider, { value: { can: () => true } }, h(TooltipProvider, null, h(Bar, { shown }))))

  it('is pressed while its app is on screen and released otherwise; a command item has no pressed state', () => {
    act(() => setModContributions(STATE))
    const view = renderBar('pay:board')
    expect(screen.getByTestId('topbar-app-pay-board').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('topbar-plugin-item-pay--sync').hasAttribute('aria-pressed')).toBe(false)
    view.rerender(h(RuntimeCapabilitiesContext.Provider, { value: { can: () => true } }, h(TooltipProvider, null, h(Bar, {}))))
    expect(screen.getByTestId('topbar-app-pay-board').getAttribute('aria-pressed')).toBe('false')
  })
})
