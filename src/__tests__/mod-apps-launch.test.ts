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
import { defaultSessionPaneRecord, hasPane } from '../browser/webview/layout/paneLayout'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { PluginTopbarItems, appBadgeText, appItemId, usePluginTopbarItems } from '../browser/webview/topbar/PluginTopbarItems'
import { TooltipProvider } from '../components/ui/tooltip'
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
  function Bar(props: { session: string | undefined; onPress?: () => Promise<never>; onOpenApp?: (type: string) => void }) {
    return h(PluginTopbarItems, { state: usePluginTopbarItems(props.session, props.onPress, props.onOpenApp), folded: new Set<string>() })
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
