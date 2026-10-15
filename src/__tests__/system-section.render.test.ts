// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { SystemSection } from '../browser/webview/settings/sections/SystemSection'
import { en } from '../browser/webview/i18n/messages/en'

type BridgeRequest = { route: { capability: string; action: string }; payload: unknown }

/**
 * A transport whose `systemPrefs.get` succeeds. `writes` collects every
 * request so a test can assert the route AND the payload — the host keys the
 * tray keep-alive and the background panel on exactly this write.
 */
function makeTransport(enabled = true, writeFails = false, managed = false) {
  const writes: BridgeRequest[] = []
  // The host's effective value: follows writes, unless `managed` (a
  // policy-controlled pref the host reports unchanged).
  let current = enabled
  const transport = {
    request: vi.fn(async (req: BridgeRequest) => {
      if (req.route.capability === 'systemPrefs' && req.route.action === 'get') {
        return {
          ok: true,
          // `launcherEnabled` is the host's wire-compat alias of the same pref.
          result: { backgroundModeEnabled: current, launcherEnabled: current },
        }
      }
      writes.push(req)
      if (writeFails) {
        return { ok: false, error: { code: 'SYSTEM_PREFS_ERROR', message: 'nope' } }
      }
      if (!managed) current = (req.payload as { enabled: boolean }).enabled
      return { ok: true, result: { ok: true } }
    }),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
  return { transport, writes }
}

/** A transport with no `systemPrefs` capability — an older binary. */
function makeUnavailableTransport(): BrowserBridgeTransport {
  return {
    request: vi.fn(async () => ({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'unknown capability' },
    })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
}

/** The catalog's `{product}` token is filled by the translator; match around it. */
function withoutProduct(message: string): RegExp {
  const parts = message.split('{product}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(parts.join('.+'))
}

afterEach(() => {
  cleanup()
})

describe('SystemSection', () => {
  it('renders ONE toggle — "Keep … running in the background" — with its explanation', async () => {
    const { transport } = makeTransport(true)
    render(createElement(SystemSection, { transport }))

    const switches = await screen.findAllByRole('switch')
    expect(switches).toHaveLength(1)
    expect(switches[0]!.getAttribute('aria-checked')).toBe('true')
    expect(switches[0]!.getAttribute('aria-label')).toMatch(
      withoutProduct(en['settings.system.keepRunning']),
    )
    expect(
      screen.getByText(withoutProduct(en['settings.system.keepRunningDescription'])),
    ).toBeTruthy()
    // The merged-away second toggle must not come back.
    expect(screen.queryByText(/system tray$/i)).toBeNull()
  })

  it('reflects a host that reports the toggle off', async () => {
    const { transport } = makeTransport(false)
    render(createElement(SystemSection, { transport }))
    const sw = await screen.findByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('writes systemPrefs.setBackgroundMode AND the setLauncher alias with the new value', async () => {
    // Both routes: on a host older than the toggle merge only `setLauncher`
    // drives the tray, and the interface version was not bumped.
    const { transport, writes } = makeTransport(true)
    render(createElement(SystemSection, { transport }))
    const sw = await screen.findByRole('switch')
    fireEvent.click(sw)
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.map((w) => w.route.action).sort()).toEqual(['setBackgroundMode', 'setLauncher'])
    for (const w of writes) {
      expect(w.route).toMatchObject({ capability: 'systemPrefs' })
      expect(w.payload).toEqual({ enabled: false })
    }
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('re-reads the host after a write: a policy-managed host keeps its own value', async () => {
    // The host accepts the write but keeps reporting ON (managed pref).
    const { transport } = makeTransport(true, /*writeFails=*/ false, /*managed=*/ true)
    render(createElement(SystemSection, { transport }))
    const sw = await screen.findByRole('switch')
    fireEvent.click(sw)
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'))
  })

  it('rolls the switch back when the host rejects the write', async () => {
    const { transport, writes } = makeTransport(true, /*writeFails=*/ true)
    render(createElement(SystemSection, { transport }))
    const sw = await screen.findByRole('switch')
    fireEvent.click(sw)
    await waitFor(() => expect(writes.length).toBeGreaterThan(0))
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'))
  })

  /**
   * One rejection anywhere used to invert the optimistic
   * value, although the two writes and the re-read can fail independently.
   */
  it('shows what the host holds after a partial write, not the inverted guess', async () => {
    // setBackgroundMode lands (OFF), setLauncher is refused; the re-read
    // reports the pref the C++ side actually keys on — now off.
    const prefs = { backgroundModeEnabled: true, launcherEnabled: true }
    const transport = {
      request: vi.fn(async (req: BridgeRequest) => {
        const { action } = req.route
        if (action === 'get') return { ok: true, result: { ...prefs } }
        if (action === 'setLauncher') {
          return { ok: false, error: { code: 'SYSTEM_PREFS_ERROR', message: 'nope' } }
        }
        prefs.backgroundModeEnabled = (req.payload as { enabled: boolean }).enabled
        return { ok: true, result: { ok: true } }
      }),
      subscribeEvents: () => () => {},
    } as unknown as BrowserBridgeTransport
    render(createElement(SystemSection, { transport }))
    const sw = await screen.findByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    // Settle: the get after the writes.
    await waitFor(() =>
      expect(
        (transport.request as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => (c[0] as BridgeRequest).route.action === 'get',
        ),
      ).toHaveLength(2),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the new value when both writes land but the re-read fails', async () => {
    let gets = 0
    const transport = {
      request: vi.fn(async (req: BridgeRequest) => {
        if (req.route.action === 'get') {
          gets += 1
          if (gets > 1) return { ok: false, error: { code: 'SYSTEM_PREFS_ERROR', message: 'gone' } }
          return { ok: true, result: { backgroundModeEnabled: true, launcherEnabled: true } }
        }
        return { ok: true, result: { ok: true } }
      }),
      subscribeEvents: () => () => {},
    } as unknown as BrowserBridgeTransport
    render(createElement(SystemSection, { transport }))
    const sw = await screen.findByRole('switch')
    fireEvent.click(sw)
    await waitFor(() => expect(gets).toBe(2))
    await new Promise((r) => setTimeout(r, 0))
    // Both prefs were written OFF: the switch must not snap back ON.
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('renders as one embedded card group on the General page', async () => {
    // Folded into General: the group is a headed card, not its
    // own settings page — the page must read as a stack of card-groups.
    const { transport } = makeTransport(true)
    render(createElement(SystemSection, { transport }))

    const group = await screen.findByTestId('settings-system')
    // The testid is on the <section> itself: a wrapper div made the section an
    // only child, so `first:mt-0` killed the `mt-6` above it.
    expect(group.tagName).toBe('SECTION')
    expect(group.className).toContain('mt-6')
    const cards = group.querySelectorAll('[data-settings-card]')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.contains(screen.getByRole('switch'))).toBe(true)
    expect(screen.getByRole('heading', { name: en['settings.system.title'] })).toBeTruthy()
  })

  it('renders the merged language control below the toggle card', async () => {
    // The Language group folded into System the same day: General
    // hands its language card in as a prop, and the section holds exactly two
    // settings — the background toggle, then language.
    const { transport } = makeTransport(true)
    render(
      createElement(SystemSection, {
        transport,
        languageControl: createElement('div', {
          'data-testid': 'language-card',
          'data-settings-card': '',
        }),
      }),
    )

    const group = await screen.findByTestId('settings-system')
    const title = screen.getByRole('heading', { name: en['settings.system.title'] })
    const language = screen.getByTestId('language-card')
    const toggle = await screen.findByRole('switch')
    expect(group.contains(language)).toBe(true)
    expect(group.contains(toggle)).toBe(true)
    // Title → toggle → language, in that order.
    for (const pair of [[title, toggle], [toggle, language]] as const) {
      expect(
        pair[0].compareDocumentPosition(pair[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    // The language card is NOT nested inside the toggle's card.
    const toggleCard = toggle.closest('[data-settings-card]')!
    expect(toggleCard.contains(language)).toBe(false)
  })

  it('keeps the merged language control when the host route is unavailable', async () => {
    // The language half degrades on the appearance capability, inside General —
    // a missing systemPrefs route must not take it down with the toggle.
    render(
      createElement(SystemSection, {
        transport: makeUnavailableTransport(),
        languageControl: createElement('div', { 'data-testid': 'language-card' }),
      }),
    )
    await screen.findByText(en['settings.system.unavailable'])
    expect(screen.getByTestId('language-card')).toBeTruthy()
  })

  it('keeps the group header when the host route is unavailable', async () => {
    render(createElement(SystemSection, { transport: makeUnavailableTransport() }))
    await screen.findByText(en['settings.system.unavailable'])
    expect(screen.getByRole('heading', { name: en['settings.system.title'] })).toBeTruthy()
  })

  it('shows the unavailable note instead of a toggle on a host without systemPrefs', async () => {
    render(createElement(SystemSection, { transport: makeUnavailableTransport() }))
    await screen.findByText(en['settings.system.unavailable'])
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
