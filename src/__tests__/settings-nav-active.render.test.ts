// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { SettingsScreen } from '../browser/webview/settings/SettingsScreen'

/**
 * The selected nav entry and a hovered one must not resolve to the same fill. The fixture entry is 'models'.
 */
function makeTransport(): BrowserBridgeTransport {
  return {
    request: vi.fn(async () => ({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'not in this test' },
    })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
}

afterEach(() => {
  cleanup()
})

describe('settings nav selected state', () => {
  it('does not paint hover with the selected fill', () => {
    render(
      createElement(SettingsScreen, {
        section: 'models' as const,
        onNavigate: () => {},
        onClose: () => {},
        catalog: null,
        transport: makeTransport(),
      }),
    )

    const selected = screen.getByTestId('settings-nav-models')
    const other = screen.getByTestId('settings-nav-general')

    expect(selected.getAttribute('data-active')).toBe('true')
    expect(other.getAttribute('data-active')).toBeNull()

    const classes = (el: Element) => (el.className || '').split(/\s+/)

    // The selected entry carries the accent fill, and keeps it under hover so
    // the pointer cannot wash it out.
    expect(classes(selected)).toContain('bg-accent')
    expect(classes(selected)).toContain('hover:bg-accent')

    // An unselected entry never reaches the accent fill, hovered or not.
    expect(classes(other)).not.toContain('bg-accent')
    expect(classes(other)).not.toContain('hover:bg-accent')
    expect(classes(other)).toContain('hover:bg-muted')
  })
})

/**
 * The settings surface is full-bleed below the topbar: no corner radius and no outer border.
 */
describe('settings surface edges', () => {
  it('renders full-bleed: no corner radius and no outer border', () => {
    render(
      createElement(SettingsScreen, {
        section: 'general' as const,
        onNavigate: () => {},
        onClose: () => {},
        catalog: null,
        transport: makeTransport(),
      }),
    )

    const root = screen.getByTestId('nexus-settings')
    const classes = (root.className || '').split(/\s+/)

    expect(classes).not.toContain('border')
    for (const cls of classes) {
      expect(cls, 'the settings root must not round any corner').not.toMatch(
        /^rounded(-|$)/,
      )
    }
  })
})
