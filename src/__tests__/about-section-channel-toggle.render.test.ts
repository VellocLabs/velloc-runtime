// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { CapabilityAdvert } from '../browser/runtimeProtocol'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { queryFor } from './_helpers/capabilityQuery'

/**
 * About page: the Stable/Beta channel picker, which writes `nexus.webapp_url`. Pinned: it shows only for the
 * official origins; availability is probed on mount and again on switch (no pref write when the channel does not
 * serve this binary's /v<N>/); Stable clears the override; the restart tip survives the save; and a rejected
 * `appInfo.relaunch` from "Restart now" shows a notice.
 */

// Typed so `.mock.calls[n][1]` is the URL argument rather than `never` — the
// assertions below are about exactly which value gets written to the pref.
const getWebappUrl =
  vi.fn<(transport: unknown) => Promise<{ url: string; defaultUrl: string }>>()
const setWebappUrl =
  vi.fn<(transport: unknown, url: string) => Promise<void>>()
const relaunchApp = vi.fn<(transport: unknown) => Promise<{ ok: true }>>()

vi.mock('../browser/webview/nexusBridgeActions', () => ({
  getVersionInfo: vi.fn(async () => ({
    appVersion: '1.0.0',
    chromiumVersion: '120.0.0',
  })),
  getWebappUrl: (transport: unknown) => getWebappUrl(transport),
  setWebappUrl: (transport: unknown, url: string) =>
    setWebappUrl(transport, url),
  relaunchApp: (transport: unknown) => relaunchApp(transport),
}))

import { AboutSection } from '../browser/webview/settings/sections/AboutSection'

function makeBridge(): NexusSettingsBridge {
  return {
    request: vi.fn(async () => ({})),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
}

function makeTransport(): BrowserBridgeTransport {
  return {
    request: vi.fn(async () => ({ ok: true, result: {} })),
  } as unknown as BrowserBridgeTransport
}

/** `capabilities` omitted = no provider, the desktop tree every case above uses. */
function renderAbout(capabilities?: CapabilityQuery) {
  const section = createElement(
    SettingsBridgeContext.Provider,
    { value: makeBridge() },
    createElement(AboutSection, { transport: makeTransport() }),
  )
  return render(
    capabilities
      ? createElement(
          RuntimeCapabilitiesContext.Provider,
          { value: capabilities },
          section,
        )
      : section,
  )
}

/**
 * Stand in for the preflight probe. Answers `oks` in call order, the last value
 * sticking for every later call — so a test can let the mount probe succeed and
 * the switch-time probe fail. Typed so the probed URL is assertable.
 */
function stubFetch(...oks: boolean[]) {
  let call = 0
  const f = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
    async () => {
      const ok = oks[Math.min(call, oks.length - 1)] ?? true
      call += 1
      return { ok } as Response
    },
  )
  vi.stubGlobal('fetch', f)
  return f
}

/** The clickable card for a channel — carries `data-availability`. */
function channelCard(channel: 'stable' | 'beta') {
  return screen.getByTestId(`about-channel-${channel}-card`)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  getWebappUrl.mockReset()
  setWebappUrl.mockReset()
  setWebappUrl.mockResolvedValue(undefined)
  relaunchApp.mockReset()
  // Default: the host accepts. In production the page is destroyed before this
  // resolves; here it just means "the route ran".
  relaunchApp.mockResolvedValue({ ok: true })
  // Default for every test: the page probes the non-current channel as soon as
  // it knows which one it is on, so an unstubbed `fetch` would be a real
  // network call from a unit test.
  stubFetch(true)
})

describe('About channel toggle — visibility', () => {
  it('shows on an official origin, defaulting to the built-in URL', async () => {
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    expect(await screen.findByTestId('about-channel')).toBeTruthy()
    // Empty override + stable default = Stable, without writing anything.
    const stable = await screen.findByTestId('about-channel-stable')
    await waitFor(() => expect(stable.getAttribute('aria-checked')).toBe('true'))
  })

  it('reflects a beta override', async () => {
    getWebappUrl.mockResolvedValue({
      url: 'https://beta.velloc.app/',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    const beta = await screen.findByTestId('about-channel-beta')
    await waitFor(() => expect(beta.getAttribute('aria-checked')).toBe('true'))
  })

  it('hides for a hand-set URL', async () => {
    getWebappUrl.mockResolvedValue({
      url: 'https://mirror.example/nexus/',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    // The free-text field still renders; only the channel control is gone.
    await screen.findByTestId('about-force-refresh')
    expect(screen.queryByTestId('about-channel')).toBeNull()
  })

  it('hides on a dev build, whose default is localhost', async () => {
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'http://localhost:5173/index.html',
    })
    renderAbout()
    await screen.findByTestId('about-force-refresh')
    expect(screen.queryByTestId('about-channel')).toBeNull()
  })
})

describe('About channel toggle — switching', () => {
  it('probes, then writes the beta URL and keeps the restart tip up', async () => {
    const f = stubFetch(true)
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    fireEvent.click(await screen.findByTestId('about-channel-beta'))

    await waitFor(() => expect(setWebappUrl).toHaveBeenCalled())
    expect(f.mock.calls[0]?.[0]).toContain('https://beta.velloc.app/v')
    expect(setWebappUrl.mock.calls[0]?.[1]).toBe('https://beta.velloc.app/')

    // Pins the fix for the flash: the tip must still be there after the save
    // resolved, not only while the write was in flight. By testid, not text —
    // the channel hint also mentions restarting.
    expect(await screen.findByTestId('about-restart-tip')).toBeTruthy()
  })

  it('does not move the "Active" badge to beta until the switch actually takes effect', async () => {
    // Regression: the badge used to follow the radio selection, so clicking
    // Beta marked it "Active" immediately — before any restart — while
    // Stable (still the one actually running) lost the badge in the same
    // click. The switch only SAVES a pref; nothing is running off it yet.
    stubFetch(true)
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    await waitFor(() =>
      expect(
        within(channelCard('stable')).queryByText('Active'),
      ).toBeTruthy(),
    )

    fireEvent.click(await screen.findByTestId('about-channel-beta'))
    await screen.findByTestId('about-restart-tip')

    // The radio moved to beta (it's the selection)...
    await waitFor(() =>
      expect(
        screen.getByTestId('about-channel-beta').getAttribute('aria-checked'),
      ).toBe('true'),
    )
    // ...but "Active" stays on stable, the channel still actually running.
    expect(within(channelCard('stable')).queryByText('Active')).toBeTruthy()
    expect(within(channelCard('beta')).queryByText('Active')).toBeNull()
  })

  it('puts the restart tip at the bottom of the channel card, not the Runtime card', async () => {
    stubFetch(true)
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    fireEvent.click(await screen.findByTestId('about-channel-beta'))

    const tip = await screen.findByTestId('about-restart-tip')
    // Exactly one notice, and it lives under the control the user clicked.
    expect(screen.getAllByTestId('about-restart-tip')).toHaveLength(1)
    const channelCard = screen.getByTestId('about-channel')
    expect(channelCard.contains(tip)).toBe(true)
    // Last thing in the card — below the radio group and the channel hint.
    const hint = channelCard.querySelector('p.text-muted-foreground')
    expect(hint && tip.compareDocumentPosition(hint) &
      Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('keeps the restart tip on the Runtime card for a hand-edited URL', async () => {
    stubFetch(true)
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    await screen.findByTestId('about-channel')

    // Type the beta origin by hand rather than clicking the radio: an official
    // origin keeps the channel card on screen, so "not in the channel card" is
    // a real placement assertion and not just the card being gone.
    fireEvent.click(screen.getByLabelText('Edit Runtime source'))
    const field = await screen.findByLabelText('Runtime source')
    fireEvent.change(field, { target: { value: 'https://beta.velloc.app/' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    const tip = await screen.findByTestId('about-restart-tip')
    expect(screen.getByTestId('about-channel').contains(tip)).toBe(false)
  })

  it('does NOT write the pref when a stale "available" turns out to be a 404', async () => {
    // Mount says the channel is fine; by the time the user clicks, it has moved
    // on to a newer /v<N>/. The switch-time probe is the guard that matters —
    // this is the case the mount probe cannot cover.
    stubFetch(true, false)
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    await waitFor(() =>
      expect(channelCard('beta').getAttribute('data-availability')).toBe(
        'available',
      ),
    )

    fireEvent.click(screen.getByTestId('about-channel-beta'))

    // A failed probe leaves the runtime source alone, so the panel still boots
    // on the next restart — and the refusal is explained where the choice is.
    await waitFor(() =>
      expect(channelCard('beta').getAttribute('data-availability')).toBe(
        'unavailable',
      ),
    )
    expect(setWebappUrl).not.toHaveBeenCalled()
    expect(screen.getByTestId('about-channel-blocked')).toBeTruthy()
  })

  it('clears the override when switching back to stable', async () => {
    stubFetch(true)
    getWebappUrl.mockResolvedValue({
      url: 'https://beta.velloc.app/',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    fireEvent.click(await screen.findByTestId('about-channel-stable'))

    await waitFor(() => expect(setWebappUrl).toHaveBeenCalled())
    expect(setWebappUrl.mock.calls[0]?.[1]).toBe('')
  })
})

describe('About channel card — availability', () => {
  it('probes the OTHER channel on mount and takes the current one on trust', async () => {
    const f = stubFetch(true)
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()

    await waitFor(() =>
      expect(channelCard('beta').getAttribute('data-availability')).toBe(
        'available',
      ),
    )
    // The page is being served BY the current channel, so probing it would be
    // asking a question already answered — one request, for beta only.
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]?.[0]).toContain('https://beta.velloc.app/v')
    expect(channelCard('stable').getAttribute('data-availability')).toBe(
      'available',
    )
    expect(screen.queryByTestId('about-channel-blocked')).toBeNull()
  })

  it('disables an unservable channel and explains it instead of erroring', async () => {
    stubFetch(false) // 404 — channel moved on to a newer /v<N>/
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()

    // Guidance, not an error: the amber explainer names the way out, and the
    // option is unclickable rather than clickable-then-refused.
    expect(await screen.findByTestId('about-channel-blocked')).toBeTruthy()
    expect(channelCard('beta').getAttribute('data-availability')).toBe(
      'unavailable',
    )
    const beta = screen.getByTestId('about-channel-beta')
    expect(beta.hasAttribute('disabled')).toBe(true)

    fireEvent.click(beta)
    expect(setWebappUrl).not.toHaveBeenCalled()
  })

  it('has no current-channel readout or manual re-check control in the header', async () => {
    stubFetch(true)
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    await screen.findByTestId('about-channel')

    // The active channel is already shown by the selected card's "Active"
    // badge — the header carries only the icon, title, and description.
    expect(screen.queryByTestId('about-channel-current')).toBeNull()
    expect(screen.queryByTestId('about-channel-check')).toBeNull()
  })
})

describe('About restart notice — Restart now', () => {
  /** Switch to beta, which saves the pref and raises the pending-restart notice. */
  async function pendingRestart() {
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    fireEvent.click(await screen.findByTestId('about-channel-beta'))
    await screen.findByTestId('about-restart-tip')
  }

  it('is offered only once there is something pending', async () => {
    getWebappUrl.mockResolvedValue({
      url: '',
      defaultUrl: 'https://app.velloc.app/',
    })
    renderAbout()
    await screen.findByTestId('about-channel')

    // Nothing saved, nothing to apply — a restart button here would be an
    // invitation to lose the session for no reason.
    expect(screen.queryByTestId('about-restart-now')).toBeNull()
  })

  it('restarts the client through the host route', async () => {
    await pendingRestart()
    fireEvent.click(screen.getByTestId('about-restart-now'))

    await waitFor(() => expect(relaunchApp).toHaveBeenCalledTimes(1))
  })

  it('latches disabled once the restart is under way', async () => {
    await pendingRestart()
    const button = screen.getByTestId('about-restart-now')
    fireEvent.click(button)

    // The host tears this page down moments later, so the button must not come
    // back and invite a second restart during the teardown window. Clicking it
    // again in that window must not reach the host either.
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true))
    fireEvent.click(button)
    expect(relaunchApp).toHaveBeenCalledTimes(1)
  })

  it('explains a refused restart instead of leaving a dead button', async () => {
    // The live case: a binary older than the `appInfo.relaunch` route answers
    // NOT_IMPLEMENTED. Success never returns here (the page is gone), so a
    // rejection is the ONLY thing the handler ever sees — if it were swallowed,
    // the button would read as broken.
    relaunchApp.mockRejectedValue(
      new Error('NOT_IMPLEMENTED: Unsupported action for capability: relaunch'),
    )
    await pendingRestart()
    fireEvent.click(screen.getByTestId('about-restart-now'))

    const tip = await screen.findByTestId('about-restart-tip')
    await waitFor(() =>
      expect(tip.textContent).toContain('Couldn’t restart automatically.'),
    )
    // Re-enabled: the failure is the host's, not the user's, and retrying after
    // an update is the point.
    expect(
      screen.getByTestId('about-restart-now').hasAttribute('disabled'),
    ).toBe(false)
  })
})


/**
 * A connection holding less than `full`: a manager may read the runtime source (`appInfo.getWebappUrl`); writing
 * it (the URL field, the channel picker) and the relaunch need `full`; the version rows need `observe`.
 */
describe('About page under a scoped grant', () => {
  const OFFICIAL = { url: '', defaultUrl: 'https://app.velloc.app/' }
  const FULL: CapabilityAdvert[] = [
    { cap: 'appInfo', acts: ['getVersionInfo', 'getWebappUrl', 'setWebappUrl', 'relaunch'] },
  ]

  it('shows a manager the source but neither the URL field nor the channel picker', async () => {
    const f = stubFetch(true)
    getWebappUrl.mockResolvedValue(OFFICIAL)
    renderAbout(queryFor([{ cap: 'appInfo', acts: ['getVersionInfo', 'getWebappUrl'] }]))

    expect(await screen.findByText('Built-in source')).toBeTruthy()
    expect((await screen.findByTestId('about-app-version')).textContent).toBe('1.0.0')
    expect(screen.queryByTestId('about-channel')).toBeNull()
    expect(screen.queryByLabelText('Edit Runtime source')).toBeNull()
    // The channel probe feeds only the hidden picker: not issued either.
    expect(f).not.toHaveBeenCalled()
    expect(setWebappUrl).not.toHaveBeenCalled()
  })

  it('keeps the version for a connection that may not read the source', async () => {
    getWebappUrl.mockResolvedValue(OFFICIAL)
    renderAbout(queryFor([{ cap: 'appInfo', acts: ['getVersionInfo'] }]))

    // The version is observe-level and renders; the refused URL read is never
    // made, so it cannot take the version down with it.
    await waitFor(() =>
      expect(screen.getByTestId('about-app-version').textContent).toBe('1.0.0'),
    )
    expect(screen.getByTestId('about-chromium-version').textContent).toBe('120.0.0')
    expect(getWebappUrl).not.toHaveBeenCalled()
    // Not the older-binary note, and no source badge for a source never read.
    expect(
      screen.queryByText('Runtime configuration isn’t available on this build.'),
    ).toBeNull()
    expect(screen.queryByText('Built-in source')).toBeNull()
    expect(screen.queryByTestId('about-channel')).toBeNull()
    expect(screen.queryByLabelText('Edit Runtime source')).toBeNull()
  })

  it('renders the field and the picker for a full grant', async () => {
    getWebappUrl.mockResolvedValue(OFFICIAL)
    renderAbout(queryFor(FULL))

    expect(await screen.findByTestId('about-channel')).toBeTruthy()
    expect(screen.getByLabelText('Edit Runtime source')).toBeTruthy()
  })

  it('keeps the restart notice but not its button without appInfo.relaunch', async () => {
    getWebappUrl.mockResolvedValue(OFFICIAL)
    renderAbout(
      queryFor([{ cap: 'appInfo', acts: ['getVersionInfo', 'getWebappUrl', 'setWebappUrl'] }]),
    )

    fireEvent.click(await screen.findByTestId('about-channel-beta'))
    expect(await screen.findByTestId('about-restart-tip')).toBeTruthy()
    expect(screen.queryByTestId('about-restart-now')).toBeNull()
  })
})
