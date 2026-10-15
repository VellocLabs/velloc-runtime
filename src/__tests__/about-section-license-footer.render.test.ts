// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { getProductName } from '../branding/productName'

/**
 * About page: the tagline names an open-source AI coding agent, and the footer states the license and the
 * copyright on one line: "{product} is open source. © <year> VellocLabs."
 */

// Isolate the section from the host bridge routes it fetches on mount.
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

afterEach(cleanup)

describe('AboutSection licensing copy', () => {
  it('describes the product as an open-source AI coding agent', () => {
    renderAbout()

    expect(
      screen.getByText(
        `${getProductName()} is an open-source AI coding agent developed by VellocLabs.`,
      ),
    ).toBeTruthy()
  })

  it('renders the open-source footer and the copyright on a single line', () => {
    renderAbout()

    const year = new Date().getFullYear()
    const footer = screen.getByText(
      `${getProductName()} is open source. © ${year} VellocLabs.`,
    )
    expect(footer).toBeTruthy()
    // One paragraph, not two — the copyright must not wrap onto its own line.
    expect(screen.queryByText(`© ${year} VellocLabs.`, { exact: true })).toBeNull()
    expect(document.body.textContent).not.toContain('Proprietary')
  })
})
