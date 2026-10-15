// @vitest-environment happy-dom
/**
 * F-24, the UI half: desktop is pixel-identical (a `full` grant answers every `can()` true, and no provider defaults
 * to allow); then the trimming, the offline overlay and the `forbidden_scope` safety net.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { I18nProvider } from '../browser/webview/i18n'
import { __setUiChannelForTest } from '../branding/updateChannels'
import { SettingsScreen, visibleNav } from '../browser/webview/settings/SettingsScreen'
import {
  isSettingsSectionVisible,
  resolveSettingsPage,
} from '../browser/webview/settings/settingsNav'
import {
  ALLOW_ALL,
  RuntimeCapabilitiesContext,
  capabilityQueryOf,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import {
  RuntimeReadyContext,
  isDesktopOffline,
  isRuntimeReady,
} from '../browser/webview/RuntimeConnectionBanner'
import { RemoteOfflineOverlay } from '../browser/webview/remote/RemoteOfflineOverlay'
import { secondsUntil } from '../browser/webview/remote/DesktopUnreachableCard'
import { Composer } from '../components/assistant-ui/thread'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  isForbiddenScope,
  watchForbiddenScope,
} from '../browser/webview/forbiddenScopeNotice'
import {
  RuntimeRequestError,
  type ConnectionState,
  type RuntimeConnection,
} from '../browser/runtimeClient/RuntimeConnection'
import { wireError, type CapabilityAdvert, type WelcomeFrame } from '../browser/runtimeProtocol'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { queryFor } from './_helpers/capabilityQuery'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  __setUiChannelForTest(null)
})

/** Every capability the settings nav gates on, as a `full` desktop sees them. */
const DESKTOP_CAPABILITIES: CapabilityAdvert[] = [
  { cap: 'providers', acts: ['list', 'upsert', 'remove', 'setActive'] },
  { cap: 'mcpSettings', acts: ['list', 'upsert', 'remove'] },
  { cap: 'memory', acts: ['snapshot', 'userInstructions', 'writeUserInstructions'] },
  // The desktop can manage remote access (every remote.* action is full).
  { cap: 'remote', acts: ['pairList', 'pairStart', 'pairRevoke', 'getAccess', 'setAccess'] },
]

/** What a `control` remote connection is advertised: the reads, not the writes. */
const REMOTE_CAPABILITIES: CapabilityAdvert[] = [
  { cap: 'memory', acts: ['snapshot'] },
  { cap: 'features', acts: ['catalog', 'snapshot', 'setEnabled'] },
]

// No 'sessionModels': on a connection that has the Models page it is that
// page's second group, not an entry of its own (settingsNav `onlyWithout`).
const NAV_IDS = [
  'general',
  'models',
  'mcp',
  'instructions',
  'memory',
  'features',
  'plugins',
  'about',
]

function renderSettings(capabilities: CapabilityQuery | undefined) {
  const transport = {
    request: async () => ({ ok: false, error: { code: 'unavailable', message: 'test' } }),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
  const settings = createElement(SettingsScreen, {
    section: 'general' as const,
    onNavigate: () => {},
    onClose: () => {},
    catalog: null,
    transport,
  })
  return render(
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      capabilities
        ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, settings)
        : settings,
    ),
  )
}

describe('useCan — desktop is pixel-identical', () => {
  it('a full grant answers every can() true', () => {
    const query = queryFor(DESKTOP_CAPABILITIES)
    expect(query.can('providers', 'list')).toBe(true)
    expect(query.can('mcpSettings', 'list')).toBe(true)
    expect(query.can('memory', 'userInstructions')).toBe(true)
    expect(visibleNav(query).map(entry => entry.id)).toEqual(NAV_IDS)
  })

  it('renders every settings nav entry for a full connection', () => {
    renderSettings(queryFor(DESKTOP_CAPABILITIES))
    for (const id of NAV_IDS) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeTruthy()
    }
  })

  it('renders every entry with NO provider at all (the pre-WP-6 tree)', () => {
    // The default context value. This is what every existing render test and
    // every mock host sees, and it must be indistinguishable from `full`.
    expect(visibleNav(ALLOW_ALL).map(entry => entry.id)).toEqual(NAV_IDS)
    renderSettings(undefined)
    for (const id of NAV_IDS) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeTruthy()
    }
  })

  it('treats a connection with no welcome yet as allowed, not as empty', () => {
    // Unknown must mean ALLOWED: the alternative is a desktop that flickers
    // its settings nav away for the length of a handshake.
    const connecting = { welcome: null, can: () => false } as unknown as RuntimeConnection
    expect(capabilityQueryOf(connecting).can('providers', 'list')).toBe(true)
    expect(capabilityQueryOf(null).can('anything')).toBe(true)
  })

  it('allSessions reads the welcome scope, and an unknown grant answers yes', () => {
    const withSessions = (sessions: unknown) =>
      ({ welcome: { scope: { mode: 'control', sessions } }, can: () => true }) as unknown as RuntimeConnection
    expect(capabilityQueryOf(withSessions('all')).allSessions?.()).toBe(true)
    expect(capabilityQueryOf(withSessions(['s-1'])).allSessions?.()).toBe(false)
    const connecting = { welcome: null, can: () => false } as unknown as RuntimeConnection
    expect(capabilityQueryOf(connecting).allSessions?.()).toBe(true)
  })
})

describe('useCan — trimming a smaller grant', () => {
  it('drops the entries whose capability is absent, keeping the readable ones', () => {
    const ids = visibleNav(queryFor(REMOTE_CAPABILITIES)).map(entry => entry.id)
    // Gone: every action behind them is `full`.
    expect(ids).not.toContain('models')
    expect(ids).not.toContain('mcp')
    expect(ids).not.toContain('instructions')
    // Kept: readable at observe/control.
    expect(ids).toEqual(['general', 'sessionModels', 'memory', 'features', 'plugins', 'about'])
  })

  it('Session models is a page of its own only where Models is absent', () => {
    const full = visibleNav(queryFor(DESKTOP_CAPABILITIES))
    const remote = visibleNav(queryFor(REMOTE_CAPABILITIES))
    expect(full.map(e => e.id)).not.toContain('sessionModels')
    // A deep link to it lands on the Models page that hosts it...
    expect(resolveSettingsPage('sessionModels', full)).toBe('models')
    // ...and on its own page where Models is trimmed.
    expect(resolveSettingsPage('sessionModels', remote)).toBe('sessionModels')
    // A plain trimmed page has no host to fall back to.
    expect(resolveSettingsPage('models', remote)).toBeUndefined()
  })

  it('does not render a trimmed entry — not rendered-then-error', () => {
    renderSettings(queryFor(REMOTE_CAPABILITIES))
    expect(screen.queryByTestId('settings-nav-models')).toBeNull()
    expect(screen.queryByTestId('settings-nav-mcp')).toBeNull()
    expect(screen.queryByTestId('settings-nav-instructions')).toBeNull()
    expect(screen.getByTestId('settings-nav-general')).toBeTruthy()
  })

  it('gates Remote access on BOTH the capability and the host manifest (WP-7)', () => {
    // The manifest gate's UI half: even a full (desktop) connection does NOT
    // see the entry until remote/state.access.supported is true — an older
    // binary publishes supported:false and simply has no Remote access page.
    // (The entry is beta-only in v1; pin beta so THIS test exercises only the
    // capability + manifest gates. The channel gate is its own describe.)
    __setUiChannelForTest('beta')
    const full = queryFor(DESKTOP_CAPABILITIES)
    expect(visibleNav(full, false).map(e => e.id)).not.toContain('remoteAccess')
    expect(visibleNav(full, true).map(e => e.id)).toContain('remoteAccess')
    // And the capability half: a remote (control) connection lacks remote.pairList,
    // so it never sees the entry even when the host supports it.
    const remote = queryFor(REMOTE_CAPABILITIES)
    expect(visibleNav(remote, true).map(e => e.id)).not.toContain('remoteAccess')
    expect(visibleNav(remote, false).map(e => e.id)).not.toContain('remoteAccess')
  })

  it('falls back off a trimmed section reached by a stale pointer', () => {
    // Hiding the nav entry while still rendering the page would be trimming
    // in name only — the page's first read would be refused.
    const transport = {
      request: async () => ({ ok: false, error: { code: 'unavailable', message: 'test' } }),
      subscribeEvents: () => () => {},
    } as unknown as BrowserBridgeTransport
    const { container } = render(
      createElement(
        I18nProvider,
        { locale: 'en' as const },
        createElement(
          RuntimeCapabilitiesContext.Provider,
          { value: queryFor(REMOTE_CAPABILITIES) },
          createElement(SettingsScreen, {
            section: 'models' as const,
            onNavigate: () => {},
            onClose: () => {},
            catalog: null,
            transport,
          }),
        ),
      ),
    )
    const root = container.querySelector('[data-testid="nexus-settings"]')
    expect(root?.getAttribute('data-section')).toBe('general')
  })
})

describe('the Remote access entry follows the channel (beta-only in v1)', () => {
  // The entry carries a declarative `betaOnly` flag: deleting it ships the
  // page to stable. Until then a full desktop connection on STABLE does not
  // see Remote access — the capability AND the host manifest both pass and it
  // is still hidden — while BETA shows it. `__setUiChannelForTest` pins the
  // channel the way `__setTemplateChannelForTest` pins the template one.
  it('hidden on stable, shown on beta', () => {
    const full = queryFor(DESKTOP_CAPABILITIES)
    __setUiChannelForTest('stable')
    expect(visibleNav(full, true).map(e => e.id)).not.toContain('remoteAccess')
    __setUiChannelForTest('beta')
    expect(visibleNav(full, true).map(e => e.id)).toContain('remoteAccess')
  })

  it('an explicit channel argument decides over the pinned realm', () => {
    // `visibleNav` takes the channel as a parameter (defaulting to the
    // realm's): a caller can ask about another channel without mutating state.
    const full = queryFor(DESKTOP_CAPABILITIES)
    __setUiChannelForTest('beta')
    expect(visibleNav(full, true, 'stable').map(e => e.id)).not.toContain('remoteAccess')
    expect(visibleNav(full, true, 'beta').map(e => e.id)).toContain('remoteAccess')
  })

  it('the render hides the nav entry on stable even when the host supports it', () => {
    __setUiChannelForTest('stable')
    renderSettings(queryFor(DESKTOP_CAPABILITIES))
    expect(screen.queryByTestId('settings-nav-remoteAccess')).toBeNull()
    __setUiChannelForTest('beta')
    // The capability passes, but the manifest gate still holds the entry off
    // until remote/state publishes supported:true — the beta channel alone is
    // not sufficient. (That settle is the nav-gate test above; here the entry
    // is simply reachable by visibleNav.)
    expect(visibleNav(queryFor(DESKTOP_CAPABILITIES), true).map(e => e.id)).toContain('remoteAccess')
  })
})

describe('the Remote access entry is desktop-only (never on a remote client page)', () => {
  // The page manages the DESKTOP's listener: who is connected, pairing links,
  // the on/off switch. On a remote client page it is about a machine the user
  // is not at — and switching it off from there cuts off that very page. The
  // capability gate cannot express this (a `full` remote grant holds
  // remote.pairList too), so the entry carries `desktopOnly` and the remote
  // boot's `remoteHost` drops it. Without the fix a full remote grant on beta
  // shows the entry exactly like the desktop does.
  it('a remote client never sees it, even with every other gate passing', () => {
    const full = queryFor(DESKTOP_CAPABILITIES)
    expect(visibleNav(full, true, 'beta', false).map(e => e.id)).toContain('remoteAccess')
    expect(visibleNav(full, true, 'beta', true).map(e => e.id)).not.toContain('remoteAccess')
    expect(isSettingsSectionVisible('remoteAccess', full, true, 'beta', true)).toBe(false)
    expect(isSettingsSectionVisible('remoteAccess', full, true, 'beta', false)).toBe(true)
  })

  it('drops nothing else on a remote client', () => {
    const full = queryFor(DESKTOP_CAPABILITIES)
    const desktop = visibleNav(full, true, 'beta', false).map(e => e.id)
    const remote = visibleNav(full, true, 'beta', true).map(e => e.id)
    expect(remote).toEqual(desktop.filter(id => id !== 'remoteAccess'))
  })
})

describe('the offline overlay', () => {
  const ready: ConnectionState = {
    status: 'ready',
    welcome: { connectionId: 'c1' } as WelcomeFrame,
  }
  const lastWelcome = { connectionId: 'c1' } as WelcomeFrame

  function renderOverlay(state: ConnectionState | null, onReconnectNow = () => {}) {
    return render(
      createElement(
        I18nProvider,
        { locale: 'en' as const },
        createElement(RemoteOfflineOverlay, { state, onReconnectNow }),
      ),
    )
  }

  it('renders nothing while ready — the desktop’s permanent state', () => {
    const { container } = renderOverlay(ready)
    expect(container.textContent).toBe('')
  })

  it('renders nothing with no connection at all', () => {
    const { container } = renderOverlay(null)
    expect(container.textContent).toBe('')
  })

  it('covers the shell while reconnecting: not connected, the countdown, and a button that dials now', () => {
    // THE unification this overlay is for: the desktop going
    // away used to be a strip under the topbar, then a torn-down shell, then
    // the browser's own error page. One modal surface now, over the kept
    // shell, saying when the next try is and letting the user make it.
    vi.useFakeTimers()
    try {
      const onReconnectNow = vi.fn()
      renderOverlay(
        { status: 'reconnecting', attempt: 2, lastWelcome, nextAttemptAt: Date.now() + 30_000 },
        onReconnectNow,
      )
      const overlay = screen.getByTestId('remote-offline-overlay')
      expect(overlay.getAttribute('role')).toBe('alertdialog')
      expect(overlay.getAttribute('aria-modal')).toBe('true')
      // Fixed over the whole viewport — not a strip in the shell's column.
      expect(overlay.className).toContain('fixed')
      expect(overlay.className).toContain('inset-0')
      expect(overlay.textContent).toContain('Connection to your desktop lost')
      expect(screen.getByTestId('remote-offline-countdown').textContent).toBe('Reconnecting in 30 s')

      // The clock runs.
      act(() => { vi.advanceTimersByTime(12_000) })
      expect(screen.getByTestId('remote-offline-countdown').textContent).toBe('Reconnecting in 18 s')

      const button = screen.getByRole('button', { name: 'Reconnect now' })
      fireEvent.click(button)
      expect(onReconnectNow).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('once the attempt is due it says it is reconnecting, and the button STAYS pressable', () => {
    // Reported: the button was disabled while a dial was on the
    // wire, and a dial that hung left it disabled for good — the page could
    // only be reloaded. The connection now decides what a press does (no-op
    // on a young dial, a fresh dial over a hung one); the button never greys.
    const onReconnectNow = vi.fn()
    renderOverlay({ status: 'reconnecting', attempt: 1, lastWelcome, nextAttemptAt: Date.now() - 1 }, onReconnectNow)
    const overlay = screen.getByTestId('remote-offline-overlay')
    expect(overlay.getAttribute('data-dialing')).toBe('true')
    expect(screen.getByTestId('remote-offline-countdown').textContent).toBe('Trying to establish a connection')
    expect(screen.getByTestId('remote-offline-card').getAttribute('data-phase')).toBe('connecting')
    const button = screen.getByRole('button', { name: 'Reconnect now' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onReconnectNow).toHaveBeenCalledTimes(1)
  })

  it('dials now when the user comes back to the page or the network returns', () => {
    // Reopening the desktop happens in ANOTHER window; coming back to this
    // one is the moment to try, not the next tick of a 30 s countdown.
    const onReconnectNow = vi.fn()
    renderOverlay(
      { status: 'reconnecting', attempt: 2, lastWelcome, nextAttemptAt: Date.now() + 30_000 },
      onReconnectNow,
    )
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(onReconnectNow).toHaveBeenCalledTimes(1)
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(onReconnectNow).toHaveBeenCalledTimes(2)
  })

  it('does not blur the kept shell underneath (a per-frame re-composite)', () => {
    renderOverlay({ status: 'reconnecting', attempt: 2, lastWelcome, nextAttemptAt: Date.now() + 30_000 })
    expect(screen.getByTestId('remote-offline-overlay').className).not.toContain('backdrop-blur')
  })

  it('stops listening for the user coming back once connected again', () => {
    const onReconnectNow = vi.fn()
    const { rerender } = renderOverlay(
      { status: 'reconnecting', attempt: 2, lastWelcome, nextAttemptAt: Date.now() + 30_000 },
      onReconnectNow,
    )
    rerender(
      createElement(
        I18nProvider,
        { locale: 'en' as const },
        createElement(RemoteOfflineOverlay, { state: ready, onReconnectNow }),
      ),
    )
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(onReconnectNow).not.toHaveBeenCalled()
  })

  it('after several failed attempts it says it is still trying, and offers another go', () => {
    // The fourth state of the unified card. Past a handful of
    // failures "connection lost" undersells it; the card says it still cannot
    // reach the desktop, what to check, and keeps the countdown.
    const onReconnectNow = vi.fn()
    renderOverlay(
      { status: 'reconnecting', attempt: 5, lastWelcome, nextAttemptAt: Date.now() + 30_000 },
      onReconnectNow,
    )
    const card = screen.getByTestId('remote-offline-card')
    expect(card.getAttribute('data-phase')).toBe('stuck')
    expect(card.textContent).toContain('Still unable to reach your desktop')
    expect(screen.getByTestId('remote-offline-countdown').textContent).toBe('Reconnecting in 30 s')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onReconnectNow).toHaveBeenCalledTimes(1)
  })

  it('counts a long wait in whole minutes, switching to seconds for the last minute', () => {
    // The retry ladder climbs to an hour; "3600 s" is not a number anyone reads.
    vi.useFakeTimers()
    try {
      renderOverlay({ status: 'reconnecting', attempt: 12, lastWelcome, nextAttemptAt: Date.now() + 3_600_000 })
      const countdown = () => screen.getByTestId('remote-offline-countdown').textContent
      expect(countdown()).toBe('Reconnecting in 60 min')
      act(() => { vi.advanceTimersByTime(3_600_000 - 90_000) })
      expect(countdown()).toBe('Reconnecting in 2 min') // 90 s rounds up
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(countdown()).toBe('Reconnecting in 1 min') // exactly 60 s
      act(() => { vi.advanceTimersByTime(1_000) })
      expect(countdown()).toBe('Reconnecting in 59 s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts whole seconds up, never below zero', () => {
    expect(secondsUntil(30_000, 0)).toBe(30)
    expect(secondsUntil(29_001, 0)).toBe(30)
    expect(secondsUntil(1, 0)).toBe(1)
    expect(secondsUntil(0, 0)).toBe(0)
    expect(secondsUntil(0, 5_000)).toBe(0)
  })

  it('treats only 4001 as desktop-offline', () => {
    const lastWelcome = { connectionId: 'c1' } as WelcomeFrame
    expect(isDesktopOffline({ status: 'reconnecting', attempt: 1, lastWelcome, reason: 'ws-4001', nextAttemptAt: 0 })).toBe(true)
    // 4004 (`too_many_clients`) shares the slow cadence but NOT the meaning —
    // the desktop is reachable, so it must not borrow the copy.
    expect(isDesktopOffline({ status: 'reconnecting', attempt: 1, lastWelcome, reason: 'ws-4004', nextAttemptAt: 0 })).toBe(false)
    expect(isDesktopOffline({ status: 'reconnecting', attempt: 1, lastWelcome, nextAttemptAt: 0 })).toBe(false)
    expect(isDesktopOffline(ready)).toBe(false)
    expect(isDesktopOffline(null)).toBe(false)
  })

  it('gates the composer only while not ready', () => {
    expect(isRuntimeReady(null)).toBe(true)
    expect(isRuntimeReady(ready)).toBe(true)
    expect(isRuntimeReady({ status: 'closed', code: 'transport' })).toBe(false)
    expect(
      isRuntimeReady({
        status: 'reconnecting',
        attempt: 1,
        lastWelcome: { connectionId: 'c1' } as WelcomeFrame,
        nextAttemptAt: 0,
      }),
    ).toBe(false)
  })
})

describe('the composer gate explains itself', () => {
  /** The composer, mounted against a real assistant-ui runtime. */
  function Harness({ runtimeReady }: { runtimeReady: boolean }) {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      convertMessage: m => m,
      isRunning: false,
      onNew: async () => {},
    })
    return createElement(
      TooltipProvider,
      null,
      createElement(
        I18nProvider,
        { locale: 'en' as const },
        createElement(
          AssistantRuntimeProvider,
          { runtime },
          createElement(
            RuntimeReadyContext.Provider,
            { value: runtimeReady },
            createElement(Composer),
          ),
        ),
      ),
    )
  }

  it('tells the user WHY the box is dead while the wire is down', () => {
    // A disabled input with no explanation is the failure this key exists to
    // prevent: the banner says the connection is away, but the composer is
    // where the user's hands are, and it said nothing at all.
    const { container } = render(createElement(Harness, { runtimeReady: false }))
    const input = container.querySelector('[data-testid="composer-input"]')
    expect(input?.getAttribute('disabled')).not.toBeNull()
    expect(input?.getAttribute('title')).toBe('Waiting for the connection to your desktop.')
  })

  it('adds no tooltip on the desktop, where the composer is never runtime-gated', () => {
    // `RuntimeReadyContext` defaults to true and a MessagePort connection never
    // leaves `ready`, so this is every desktop frame: the attribute must be
    // absent, not empty.
    const { container } = render(createElement(Harness, { runtimeReady: true }))
    const input = container.querySelector('[data-testid="composer-input"]')
    expect(input?.getAttribute('disabled')).toBeNull()
    expect(input?.getAttribute('title')).toBeNull()
  })
})

describe('the forbidden_scope safety net', () => {
  function rejectionEvent(reason: unknown): Event & { defaultPrevented: boolean } {
    const event = new Event('unhandledrejection', { cancelable: true })
    Object.defineProperty(event, 'reason', { value: reason })
    return event as Event & { defaultPrevented: boolean }
  }

  it('recognises a forbidden_scope refusal and nothing else', () => {
    const forbidden = new RuntimeRequestError(
      wireError('forbidden_scope', 'needs full scope'),
      'providers.list',
    )
    expect(isForbiddenScope(forbidden)).toBe(true)
    expect(
      isForbiddenScope(new RuntimeRequestError(wireError('timeout', 'slow'), 'providers.list')),
    ).toBe(false)
    expect(isForbiddenScope(new Error('unrelated'))).toBe(false)
  })

  it('marks the rejection handled so it is not an unhandled rejection', () => {
    const target = new EventTarget() as unknown as Window
    const seen = vi.fn()
    const stop = watchForbiddenScope(seen, target)
    const event = rejectionEvent(
      new RuntimeRequestError(wireError('forbidden_scope', 'nope'), 'providers.list'),
    )
    target.dispatchEvent(event)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    stop()
  })

  it('leaves an unrelated rejection alone', () => {
    const target = new EventTarget() as unknown as Window
    const seen = vi.fn()
    const stop = watchForbiddenScope(seen, target)
    const event = rejectionEvent(new Error('boom'))
    target.dispatchEvent(event)
    expect(seen).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    stop()
  })
})
