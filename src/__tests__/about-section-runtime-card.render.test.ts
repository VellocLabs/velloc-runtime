// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DEFAULT_PRODUCT_NAME } from '../branding/productName'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'

/**
 * About page runtime card: every visible name follows the build's branding (never "Nexus"), and the client
 * version is `appVersion`, rendered separately from the Chromium version (distinct here).
 */

const APP_VERSION = '1.2.3'
const CHROMIUM_VERSION = '149.0.7827.22'

vi.mock('../browser/webview/nexusBridgeActions', () => ({
  getVersionInfo: vi.fn(async () => ({
    appVersion: APP_VERSION,
    chromiumVersion: CHROMIUM_VERSION,
  })),
  getWebappUrl: vi.fn(async () => ({
    url: '',
    defaultUrl: 'http://localhost:5173/index.html',
  })),
  setWebappUrl: vi.fn(async () => {}),
}))

import { AboutSection } from '../browser/webview/settings/sections/AboutSection'

function makeBridge(): NexusSettingsBridge {
  return {
    request: vi.fn(async (route: { action: string }) => {
      switch (route.action) {
        case 'snapshot':
          return { values: { log: false, trace: false } }
        default:
          return {}
      }
    }),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
}

function makeTransport(): BrowserBridgeTransport {
  return {
    request: vi.fn(async () => ({ ok: true, result: {} })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
}

afterEach(() => {
  cleanup()
})

describe('AboutSection runtime card', () => {
  it('titles the page with the branded product name, never the "Nexus" codename', async () => {
    const { container } = render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: makeBridge() },
        createElement(AboutSection, { transport: makeTransport() }),
      ),
    )

    expect(
      await screen.findByText(`${DEFAULT_PRODUCT_NAME} Runtime`),
    ).toBeTruthy()
    expect(container.textContent).not.toMatch(/nexus/i)
  })

  it('shows the product version as the client version and the Chromium version separately', async () => {
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: makeBridge() },
        createElement(AboutSection, { transport: makeTransport() }),
      ),
    )

    const appVersion = await screen.findByTestId('about-app-version')
    expect(appVersion.textContent).toBe(APP_VERSION)

    const chromiumVersion = await screen.findByTestId('about-chromium-version')
    expect(chromiumVersion.textContent).toBe(CHROMIUM_VERSION)

    // Runtime status + reload affordances from the card layout.
    expect(await screen.findByText('Built-in source')).toBeTruthy()
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(await screen.findByTestId('about-runtime-active')).toBeTruthy()
    expect(await screen.findByTestId('about-force-refresh')).toBeTruthy()
  })

  it('stops showing "Connected" once a runtime-source edit is saved but not yet applied', async () => {
    // Regression: "Connected" used to reflect only whether the `appInfo`
    // bridge answered, so it stayed lit for a source that had just been
    // saved and was still waiting on a restart to actually take effect.
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: makeBridge() },
        createElement(AboutSection, { transport: makeTransport() }),
      ),
    )

    expect(await screen.findByText('Connected')).toBeTruthy()

    fireEvent.click(await screen.findByLabelText('Edit Runtime source'))
    const field = await screen.findByLabelText('Runtime source')
    fireEvent.change(field, {
      target: { value: 'https://mirror.example/nexus/' },
    })
    fireEvent.keyDown(field, { key: 'Enter' })

    // The edit is saved (the restart tip proves it), but nothing has
    // restarted yet — so the source just saved is not actually connected.
    await screen.findByTestId('about-restart-tip')
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('renders the runtime source it displays as an external link', async () => {
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: makeBridge() },
        createElement(AboutSection, { transport: makeTransport() }),
      ),
    )

    // No override is set, so the row displays the built-in default — and the
    // link must point at what it displays, not at some other URL.
    const link = await screen.findByRole('link', { name: /localhost:5173\/index\.html/ })
    expect(link.getAttribute('href')).toBe('http://localhost:5173/index.html')
    expect(link.textContent).toContain('http://localhost:5173/index.html')
    // Opened by the guest's capture-phase interceptor as a real browser tab;
    // without target/rel it would navigate the panel away from the runtime.
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('vertically centers the URL/edit/refresh controls and spaces them with gap-3', async () => {
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: makeBridge() },
        createElement(AboutSection, { transport: makeTransport() }),
      ),
    )

    // The control cluster sits beside a two-line heading; the row must center
    // it vertically (items-center), not pin it to the top (items-start).
    const controls = await screen.findByTestId('about-runtime-controls')
    const row = controls.parentElement!
    expect(row.className).toContain('items-center')
    expect(row.className).not.toContain('items-start')

    // Wider spacing between the three controls: the cluster gap
    // (EditableField ↔ refresh) …
    expect(controls.className).toContain('gap-3')

    // … and inside EditableField (URL ↔ pencil), where the className override
    // must survive the tailwind-merge with the default gap-1.
    const link = await screen.findByRole('link', { name: /localhost:5173\/index\.html/ })
    const fieldWrapper = link.parentElement!
    expect(fieldWrapper.className).toContain('gap-3')
    expect(fieldWrapper.className).not.toMatch(/\bgap-1\b/)
  })
})
