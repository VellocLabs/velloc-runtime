// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { formatBuildTime, setBuildTime } from '../branding/buildInfo'

// The build time reaches the bundle through the entry (src/glic/main.tsx),
// which is the only module allowed to name `__NEXUS_BUILD_TIME__` — see
// branding/buildInfo.ts. No entry runs under vitest, so stand in for it.
const TEST_BUILD_TIME = '2026-01-01T00:00:00.000Z'
setBuildTime(TEST_BUILD_TIME)

/**
 * About page: the runtime heading renders "Runtime (<timestamp>)" from the injected build time, and "Refresh to
 * newest" calls `window.location.replace` with a fresh `_r=` cache-busting query param.
 */

// Isolate the section from the host bridge routes it fetches on mount (version
// + webapp URL) — neither is relevant here.
vi.mock('../browser/webview/nexusBridgeActions', () => ({
  getVersionInfo: vi.fn(async () => ({
    appVersion: '1.0.0',
    chromiumVersion: '120.0.0',
  })),
  getWebappUrl: vi.fn(async () => ({ url: '', defaultUrl: '' })),
  setWebappUrl: vi.fn(async () => {}),
}))

import { AboutSection } from '../browser/webview/settings/sections/AboutSection'

function makeBridge(): NexusSettingsBridge {
  return {
    request: vi.fn(async (route: { action: string }) => {
      switch (route.action) {
        case 'snapshot':
          return { values: { log: false, trace: false } }
        case 'setField':
          return { ok: true, values: { log: false, trace: false } }
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

function renderAbout() {
  return render(
    createElement(
      SettingsBridgeContext.Provider,
      { value: makeBridge() },
      createElement(AboutSection, { transport: makeTransport() }),
    ),
  )
}

const originalLocation = window.location

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  })
})

describe('AboutSection build info + force refresh', () => {
  it('renders the injected build time (not the dash fallback)', () => {
    const expected = formatBuildTime(TEST_BUILD_TIME, 'en')
    expect(expected).not.toBe('')

    renderAbout()

    expect(screen.getByText(`Runtime (${expected})`)).toBeTruthy()
  })

  it('force-refresh navigates with a cache-busting `_r` param', async () => {
    const replace = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'https://nexus.example.test/app/', replace, reload: vi.fn() },
    })

    renderAbout()

    fireEvent.click(await screen.findByTestId('about-force-refresh'))

    expect(replace).toHaveBeenCalledTimes(1)
    const target = String(replace.mock.calls[0][0])
    expect(target).toContain('_r=')
    // The cache-buster is a query param on the original origin/path.
    expect(target.startsWith('https://nexus.example.test/app/')).toBe(true)
  })
})
