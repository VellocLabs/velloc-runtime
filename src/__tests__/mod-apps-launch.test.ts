// @vitest-environment happy-dom
/**
 * Opening an app (F-40): which session an icon press lands on, which app
 * sessions the list leaves out, the pane the app opens with, and the icon.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  appPaneRecord,
  createOpenApp,
  pickAppSession,
  unlistedAppSessionIds,
  unlistedAppSessionKey,
  unlistedAppSessionSet,
  type AppSessionEntry,
} from '../browser/webview/apps/appLaunch'
import { APP_RUN_SESSION_PREFIX } from '../mods/app/appAgentRun'
import { defaultSessionPaneRecord, hasPane } from '../browser/webview/layout/paneLayout'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { createAppSignIn, dueSignIns } from '../browser/webview/mcpAuthView'
import type { McpAuthServerState, McpAuthState } from '../mcp/oauth/mcpAuthProtocol'
import { PluginTopbarItems, appBadgeText, appItemId, usePluginTopbarItems } from '../browser/webview/topbar/PluginTopbarItems'
import { TooltipProvider } from '../components/ui/tooltip'
import { I18nProvider } from '../browser/webview/i18n'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { EMPTY_MOD_CONTRIBUTIONS, type ModContributionsState } from '../browser/runtimeProtocol/modContributions'

beforeAll(() => {
  let n = 0
  URL.createObjectURL ??= (() => `blob:test/${++n}`) as never
  URL.revokeObjectURL ??= (() => {}) as never
})

afterEach(() => {
  cleanup()
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0).getTime()
const NOW = at(7, 9)
const entry = (sessionId: string, extra: Partial<AppSessionEntry> = {}): AppSessionEntry => ({
  sessionId,
  templateType: 'pay:board',
  updatedAt: at(7, 8),
  messageCount: 2,
  ...extra,
})

describe('the session an app\'s icon lands on', () => {
  it('the newest one of the app used today, by local day', () => {
    const sessions = [
      entry('yesterday-late', { updatedAt: at(6, 23) }),
      entry('today-early', { updatedAt: at(7, 0) }),
      entry('today-later', { updatedAt: at(7, 1), lastComposerEditAt: at(7, 8) }),
      entry('other-app', { templateType: 'pay:ledger', updatedAt: at(7, 9) }),
    ]
    expect(pickAppSession(sessions, 'pay:board', NOW)?.sessionId).toBe('today-later')
  })

  it('none from another day, archived, a teammate, or with no clock yet', () => {
    const sessions = [
      entry('yesterday', { updatedAt: at(6, 12) }),
      entry('archived', { archived: true }),
      entry('teammate', { spawnerSessionId: 'lead' }),
      entry('no-clock', { updatedAt: 0 }),
    ]
    expect(pickAppSession(sessions, 'pay:board', NOW)).toBeUndefined()
  })

  it('not a side chat under the app session, though it carries the app\'s type and is newer', () => {
    const sessions = [
      entry('app', { updatedAt: at(7, 7) }),
      entry('side', { updatedAt: at(7, 8), sideChat: true, parentSessionId: 'app' }),
    ]
    expect(pickAppSession(sessions, 'pay:board', NOW)?.sessionId).toBe('app')
    const detached = [...sessions.slice(0, 1), entry('side', { updatedAt: at(7, 8), sideChat: true, parentSessionId: 'app', detached: true })]
    expect(pickAppSession(detached, 'pay:board', NOW)?.sessionId).toBe('side')
  })

  it("never an agent run of the app, though it carries the app's type, is newer and was written in", () => {
    const sessions = [
      entry('app', { updatedAt: at(7, 7) }),
      entry(`${APP_RUN_SESSION_PREFIX}1`, { updatedAt: at(7, 9), messageCount: 3 }),
    ]
    expect(pickAppSession(sessions, 'pay:board', NOW)?.sessionId).toBe('app')
    expect(pickAppSession(sessions.slice(1), 'pay:board', NOW)).toBeUndefined()
  })

  it('today as the sidebar files it, a clock running a little ahead included', () => {
    const late = new Date(2026, 10, 7, 23, 58).getTime()
    const ahead = entry('ahead', { updatedAt: new Date(2026, 10, 8, 0, 3).getTime() })
    expect(pickAppSession([ahead], 'pay:board', late)?.sessionId).toBe('ahead')
  })
})

describe('app sessions the list leaves out', () => {
  it('an app session never written in, unless it is on screen; nothing else', () => {
    const sessions = [
      entry('untouched', { messageCount: 0 }),
      entry('on-screen', { messageCount: 0 }),
      entry('used'),
      entry('empty-agent', { templateType: 'agent', messageCount: 0 }),
    ]
    expect([...unlistedAppSessionIds(sessions, new Set(['pay:board']), 'on-screen')]).toEqual(['untouched'])
    expect(unlistedAppSessionIds(sessions, new Set(), 'on-screen').size).toBe(0)
  })

  it('an app agent run, written in or not, unless it is on screen', () => {
    const run = `${APP_RUN_SESSION_PREFIX}1`
    const sessions = [entry(run, { messageCount: 3 }), entry('used')]
    expect([...unlistedAppSessionIds(sessions, new Set(['pay:board']), 'used')]).toEqual([run])
    expect(unlistedAppSessionIds(sessions, new Set(['pay:board']), run).size).toBe(0)
  })

  it('the same ids give the same key, so the list keeps its identity across a switch', () => {
    const sessions = [entry('untouched', { messageCount: 0 }), entry('used')]
    const apps = new Set(['pay:board'])
    const onUsed = unlistedAppSessionKey(unlistedAppSessionIds(sessions, apps, 'used'))
    expect(unlistedAppSessionKey(unlistedAppSessionIds(sessions, apps, 'other'))).toBe(onUsed)
    expect([...unlistedAppSessionSet(onUsed)]).toEqual(['untouched'])
    expect(unlistedAppSessionSet('')).toBe(unlistedAppSessionSet(unlistedAppSessionKey(new Set())))
  })
})

describe('an app press', () => {
  it('opens the A2UI pane and has it cover the chat', () => {
    const record = appPaneRecord(defaultSessionPaneRecord(), {})
    expect(hasPane(record.layout, 'a2ui')).toBe(true)
    expect(record.maximized).toBe('a2ui')
  })

  function rig(sessions: AppSessionEntry[]) {
    const records = new Map<string, ReturnType<typeof defaultSessionPaneRecord>>()
    const focusSession = vi.fn()
    const openNewSession = vi.fn(() => 'new-session')
    const focusedPane = { current: new Map<string, 'a2ui' | 'browser'>() }
    const presence = vi.fn()
    const open = createOpenApp(
      { current: sessions },
      focusSession,
      openNewSession,
      (fn, sessionId) => {
        records.set(sessionId!, fn(records.get(sessionId!) ?? defaultSessionPaneRecord()))
      },
      { getSnapshot: () => ({ weights: {} }) },
      focusedPane as never,
      presence,
      () => NOW,
    )
    return { open, records, focusSession, openNewSession, focusedPane, presence }
  }

  it('focuses today\'s session of the app and shows its pane', () => {
    const { open, records, focusSession, openNewSession, focusedPane, presence } = rig([entry('today')])
    focusedPane.current.set('today', 'browser')
    expect(open('pay:board')).toBe('today')
    expect(focusSession).toHaveBeenCalledWith('today')
    expect(openNewSession).not.toHaveBeenCalled()
    expect(records.get('today')?.maximized).toBe('a2ui')
    expect(focusedPane.current.get('today')).toBe('a2ui')
    expect(presence).toHaveBeenCalledWith({ type: 'personOpen', view: 'a2ui' })
  })

  it('opens a session of the app when none was used today, and shows its pane', () => {
    const { open, records, focusSession, openNewSession } = rig([entry('yesterday', { updatedAt: at(6, 12) })])
    expect(open('pay:board')).toBe('new-session')
    expect(openNewSession).toHaveBeenCalledWith('pay:board')
    expect(focusSession).not.toHaveBeenCalled()
    expect(records.get('new-session')?.maximized).toBe('a2ui')
  })
})

const STATE: ModContributionsState = {
  templates: [{ type: 'pay:board', plugin: 'pay', owner: 'pay@mkt', title: 'Payments', launcher: 'hidden' }],
  topbar: [{ id: 'pay:sync', plugin: 'pay', title: 'Sync', icon: { lucide: 'zap' } }],
  apps: [{ type: 'pay:board', appId: 'pay-board', plugin: 'pay', title: { en: 'Payments', zh: '收付款' }, icon: { lucide: 'star' } }],
  icons: {},
  waiting: [],
}

describe('an app\'s topbar icon', () => {
  function Bar(props: {
    session: string | undefined
    onPress?: () => Promise<never>
    onOpenApp?: (type: string) => void
    onAppSignIn?: (urls: readonly string[]) => void
  }) {
    return h(PluginTopbarItems, {
      state: usePluginTopbarItems(props.session, props.onPress, props.onOpenApp, undefined, props.onAppSignIn),
      folded: new Set<string>(),
    })
  }
  const renderBar = (props: Parameters<typeof Bar>[0], canPress = true) =>
    render(
      h(
        RuntimeCapabilitiesContext.Provider,
        { value: { can: (cap: string, act?: string) => canPress || !(cap === 'mods' && act === 'pressTopbar') } },
        h(TooltipProvider, null, h(Bar, props)),
      ),
    )

  it('is named for the app, opens it by its type, and needs no session on screen', () => {
    act(() => setModContributions(STATE))
    const onOpenApp = vi.fn()
    const onPress = vi.fn(async () => ({ ok: true }) as never)
    renderBar({ session: undefined, onPress, onOpenApp })
    const icon = screen.getByTestId('topbar-app-pay-board')
    expect(icon.getAttribute('aria-label')).toBe('Open Payments')
    expect((icon as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('topbar-plugin-item-pay--sync') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(icon)
    expect(onOpenApp).toHaveBeenCalledWith('pay:board')
    expect(onPress).not.toHaveBeenCalled()
    expect(appItemId('pay:board')).toBe('app:pay:board')
  })

  it("hands its MCP servers' sign-in URLs on with the press after opening it; none when it declares none", () => {
    const urls = ['https://mcp.example.com/mcp']
    act(() => setModContributions({ ...STATE, apps: [{ ...STATE.apps![0]!, signInUrls: urls }] }))
    const order: string[] = []
    const onOpenApp = vi.fn(() => order.push('open'))
    const onAppSignIn = vi.fn(() => order.push('sign-in'))
    renderBar({ session: undefined, onOpenApp, onAppSignIn })
    fireEvent.click(screen.getByTestId('topbar-app-pay-board'))
    expect(onAppSignIn).toHaveBeenCalledWith(urls)
    expect(order).toEqual(['open', 'sign-in'])
    cleanup()
    act(() => setModContributions(STATE))
    onAppSignIn.mockClear()
    renderBar({ session: undefined, onOpenApp, onAppSignIn })
    fireEvent.click(screen.getByTestId('topbar-app-pay-board'))
    expect(onAppSignIn).not.toHaveBeenCalled()
  })

  it('shows for a connection that may not press commands; not without an opener', () => {
    act(() => setModContributions(STATE))
    renderBar({ session: 's1', onPress: vi.fn(), onOpenApp: vi.fn() }, false)
    expect(screen.queryByTestId('topbar-plugin-item-pay--sync')).toBeNull()
    expect(screen.getByTestId('topbar-app-pay-board')).not.toBeNull()
    cleanup()
    renderBar({ session: 's1', onPress: vi.fn() })
    expect(screen.queryByTestId('topbar-app-pay-board')).toBeNull()
    expect(screen.getByTestId('topbar-plugin-item-pay--sync')).not.toBeNull()
  })

  it("draws the module's badge as a pill with the count in the label and tooltip, capped at 99+; none for 0 or no badge", () => {
    const withBadge = (badge: number | undefined): ModContributionsState => ({
      ...STATE,
      apps: [{ ...STATE.apps![0]!, ...(badge === undefined ? {} : { badge }) }],
    })
    act(() => setModContributions(withBadge(3)))
    renderBar({ session: undefined, onPress: vi.fn(), onOpenApp: vi.fn() })
    expect(screen.getByTestId('topbar-app-pay-board-badge').textContent).toBe('3')
    expect(screen.getByTestId('topbar-app-pay-board-badge').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('topbar-app-pay-board').getAttribute('aria-label')).toBe('Open Payments. Needs attention: 3')
    act(() => setModContributions(withBadge(250)))
    expect(screen.getByTestId('topbar-app-pay-board-badge').textContent).toBe('99+')
    expect(screen.getByTestId('topbar-app-pay-board').getAttribute('aria-label')).toBe('Open Payments. Needs attention: 99+')
    cleanup()
    render(h(I18nProvider, { locale: 'zh' }, h(RuntimeCapabilitiesContext.Provider, { value: { can: () => true } }, h(TooltipProvider, null, h(Bar, { session: undefined, onPress: vi.fn(), onOpenApp: vi.fn() })))))
    expect(screen.getByTestId('topbar-app-pay-board').getAttribute('aria-label')).toBe('打开 收付款。需要你处理：99+')
    cleanup()
    renderBar({ session: undefined, onPress: vi.fn(), onOpenApp: vi.fn() })
    act(() => setModContributions(withBadge(0)))
    expect(screen.queryByTestId('topbar-app-pay-board-badge')).toBeNull()
    expect(screen.getByTestId('topbar-app-pay-board').getAttribute('aria-label')).toBe('Open Payments')
    act(() => setModContributions(withBadge(undefined)))
    expect(screen.queryByTestId('topbar-app-pay-board-badge')).toBeNull()
    expect([appBadgeText(undefined), appBadgeText(0), appBadgeText(1), appBadgeText(99), appBadgeText(100), appBadgeText(2.7)]).toEqual(['', '', '1', '99', '99+', '2'])
  })

  it('carries its id in the More menu once folded, apart from a command item\'s', () => {
    act(() => setModContributions(STATE))
    let state: ReturnType<typeof usePluginTopbarItems> = null
    function Probe() {
      state = usePluginTopbarItems('s1', vi.fn(), vi.fn())
      return null
    }
    render(h(RuntimeCapabilitiesContext.Provider, { value: { can: () => true } }, h(Probe)))
    expect(state!.items.map(item => item.foldedTestId)).toEqual(['topbar-folded-plugin-pay--sync', 'topbar-folded-app-pay-board'])
  })
})

describe('the sign-ins an app press starts', () => {
  it('only servers the runtime reads as needing one, never one that waits on a client id or a key, or is not known', () => {
    const states: Record<string, McpAuthServerState> = {
      'https://a.example/mcp': { url: 'https://a.example/mcp', phase: 'needs-sign-in' },
      'https://b.example/mcp': { url: 'https://b.example/mcp', phase: 'signed-in' },
      'https://c.example/mcp': { url: 'https://c.example/mcp', phase: 'signing-in' },
      'https://d.example/mcp': { url: 'https://d.example/mcp', phase: 'needs-sign-in', needsCredentials: true },
      'https://f.example/mcp': { url: 'https://f.example/mcp', phase: 'needs-sign-in', needsClient: true },
    }
    const urls = [...Object.keys(states), 'https://e.example/mcp']
    expect(dueSignIns(urls, url => states[url])).toEqual(['https://a.example/mcp'])
    expect(dueSignIns(undefined, url => states[url])).toEqual([])
  })

  function starter(request: (route: string, payload: unknown) => Promise<unknown>) {
    const latest: { current: McpAuthState | null } = {
      current: {
        available: true,
        servers: [
          { url: 'https://a.example/mcp', phase: 'needs-sign-in' },
          { url: 'https://b.example/mcp', phase: 'signed-in' },
        ],
      },
    }
    const conn = { request: vi.fn(request) }
    const context = {
      current: {
        runtimeConnection: async () => conn as never,
        t: ((key: string, params?: Record<string, string | number>) => `${key}:${params?.server}`) as never,
      },
    }
    return { start: createAppSignIn(latest, context), conn }
  }

  it('signs in each due server at the press, its window titled by the server, and a refusal does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { start, conn } = starter(async () => { throw new Error('refused') })
    start(['https://a.example/mcp/', 'https://b.example/mcp'])
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(conn.request).toHaveBeenCalledTimes(1)
    expect(conn.request).toHaveBeenCalledWith('mcpAuth.signIn', {
      url: 'https://a.example/mcp/',
      windowTitle: 'mcpAuth.windowTitle:a.example',
    })
    warn.mockRestore()
  })

  it('a second press while the first is unanswered asks once; answered, a later press may ask again', async () => {
    let answer!: () => void
    const { start, conn } = starter(() => new Promise<unknown>(resolve => { answer = () => resolve({}) }))
    start(['https://a.example/mcp'])
    start(['https://a.example/mcp/', 'https://A.example/mcp'])
    await vi.waitFor(() => expect(conn.request).toHaveBeenCalledTimes(1))
    answer()
    await new Promise(resolve => setTimeout(resolve, 0))
    start(['https://a.example/mcp'])
    await vi.waitFor(() => expect(conn.request).toHaveBeenCalledTimes(2))
  })
})
