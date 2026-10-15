// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'

/**
 * The About page has no "Developer options" section: the verbose/trace toggles are the `/debug verbose` /
 * `/debug trace` slash subcommands. Queried by `data-testid` so the assertion is i18n independent.
 */

// Isolate the section from the host bridge routes it fetches on mount
// (version + webapp URL) — neither is relevant to this assertion.
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
    request: vi.fn(async () => ({})),
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

describe('AboutSection developer options removal', () => {
  it('no longer renders the Verbose-logging / Trace-overlay toggles', async () => {
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: makeBridge() },
        createElement(AboutSection, { transport: makeTransport() }),
      ),
    )

    // Wait for the mount round-trip to settle on a stable anchor…
    await screen.findByTestId('about-app-version')

    // …then assert the old developer toggles are absent.
    expect(screen.queryByTestId('agent-flag-toggle-log')).toBeNull()
    expect(screen.queryByTestId('agent-flag-toggle-trace')).toBeNull()
  })
})
