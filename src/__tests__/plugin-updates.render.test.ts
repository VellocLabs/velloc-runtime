// @vitest-environment happy-dom
/**
 * The plugin update controls (F-14): the auto-update card (switch, last check,
 * count and Update all only while the switch is off), the row's Update / Retry
 * button or its read-only chip, and the line under the row.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { createTranslate } from '../browser/webview/i18n'
import {
  PluginAutoUpdateCard,
  PluginUpdateButton,
  PluginUpdateLine,
} from '../browser/webview/settings/sections/PluginUpdates'
import { readPluginUpdatesState } from '../browser/webview/settings/pluginUpdatesView'
import type { PluginUpdateStatus } from '../pluginHost/pluginUpdates'
import type { PluginUpdatesState } from '../pluginHost/pluginUpdatesProtocol'

afterEach(() => cleanup())

const t = createTranslate('en')

const AVAILABLE: PluginUpdateStatus = {
  identifier: 'cool@shop',
  version: '1.0.0',
  state: 'available',
  offer: { version: '1.1.0' },
}

function state(over: Partial<PluginUpdatesState> = {}): PluginUpdatesState {
  return {
    autoUpdate: false,
    checking: false,
    lastCheckedAt: '2026-10-12T00:00:00.000Z',
    unreachable: [],
    plugins: [AVAILABLE, { identifier: 'calm@shop', version: '2.0.0', state: 'up-to-date' }],
    ...over,
  }
}

function card(s: PluginUpdatesState, over: { canUpdate?: boolean; canSetAuto?: boolean } = {}) {
  const calls = { check: 0, auto: [] as boolean[], all: 0 }
  render(
    createElement(PluginAutoUpdateCard, {
      state: s,
      canCheck: true,
      canSetAuto: over.canSetAuto ?? true,
      canUpdate: over.canUpdate ?? true,
      updatingAll: false,
      onCheckNow: () => void calls.check++,
      onToggleAuto: on => void calls.auto.push(on),
      onUpdateAll: () => void calls.all++,
      formatTime: () => '5 minutes ago',
      t,
    }),
  )
  return calls
}

describe('PluginAutoUpdateCard', () => {
  it('with the switch off, counts the waiting plugins and offers Update all', () => {
    const calls = card(state())
    expect(screen.getByTestId('plugin-updates-card').getAttribute('data-auto-update')).toBe('false')
    expect(screen.getByText('Update plugins automatically')).toBeTruthy()
    expect(screen.getByTestId('plugin-updates-checked').textContent).toBe('Last checked 5 minutes ago')
    expect(screen.getByTestId('plugin-updates-waiting').textContent).toBe('Updates available: 1')
    fireEvent.click(screen.getByTestId('plugin-updates-update-all'))
    fireEvent.click(screen.getByTestId('plugin-updates-check-now'))
    expect(calls).toMatchObject({ all: 1, check: 1 })
  })

  it('with the switch on, shows no count and no Update all', () => {
    card(state({ autoUpdate: true }))
    expect(screen.queryByTestId('plugin-updates-waiting')).toBeNull()
    expect(screen.queryByTestId('plugin-updates-update-all')).toBeNull()
  })

  it('heads the switch with its own title and no explanatory paragraph', () => {
    card(state())
    const title = screen.getByTestId('plugin-updates-title')
    expect(title.textContent).toBe('Update plugins automatically')
    expect(title.parentElement?.querySelectorAll('p')).toHaveLength(0)
  })

  it('turns the switch on through the callback', () => {
    const calls = card(state())
    fireEvent.click(screen.getByTestId('plugin-auto-update-toggle'))
    expect(calls.auto).toEqual([true])
  })

  it('shows a check in progress and an unreachable marketplace', () => {
    card(state({ checking: true, unreachable: [{ marketplace: 'shop', reason: 'HTTP 503' }] }))
    expect(screen.getByTestId('plugin-updates-checked').textContent).toBe('Checking for updates…')
    expect(screen.queryByTestId('plugin-updates-check-now')).toBeNull()
    expect(screen.getByTestId('plugin-updates-unreachable-shop').textContent).toBe("Couldn't check shop")
  })

  it('a read-only connection sees the count but no Update all, and a disabled switch', () => {
    card(state(), { canUpdate: false, canSetAuto: false })
    expect(screen.getByTestId('plugin-updates-waiting')).toBeTruthy()
    expect(screen.queryByTestId('plugin-updates-update-all')).toBeNull()
    expect((screen.getByTestId('plugin-auto-update-toggle') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('PluginUpdateButton', () => {
  it('shows Update when a newer version waits, and calls back', () => {
    const onUpdate = vi.fn()
    render(createElement(PluginUpdateButton, { name: 'cool', status: AVAILABLE, canUpdate: true, busy: false, onUpdate, t }))
    const button = screen.getByTestId('plugin-update-cool')
    expect(button.textContent).toBe('Update')
    expect(button.getAttribute('aria-label')).toBe('Update cool to 1.1.0')
    fireEvent.click(button)
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when no newer version waits', () => {
    render(
      createElement(PluginUpdateButton, {
        name: 'calm',
        status: { identifier: 'calm@shop', state: 'up-to-date' },
        canUpdate: true,
        busy: false,
        onUpdate: () => undefined,
        t,
      }),
    )
    expect(screen.queryByTestId('plugin-update-calm')).toBeNull()
  })

  it('reads Retry after a failure and Updating… while busy', () => {
    const failed: PluginUpdateStatus = { ...AVAILABLE, state: 'failed', failure: { at: 'x', reason: 'HTTP 404' } }
    const { rerender } = render(
      createElement(PluginUpdateButton, { name: 'cool', status: failed, canUpdate: true, busy: false, onUpdate: () => undefined, t }),
    )
    expect(screen.getByTestId('plugin-update-cool').textContent).toBe('Retry')
    rerender(createElement(PluginUpdateButton, { name: 'cool', status: failed, canUpdate: true, busy: true, onUpdate: () => undefined, t }))
    expect(screen.getByTestId('plugin-update-cool').textContent).toBe('Updating…')
  })

  it('a connection that may not update sees a chip, not a button', () => {
    render(createElement(PluginUpdateButton, { name: 'cool', status: AVAILABLE, canUpdate: false, busy: false, onUpdate: () => undefined, t }))
    expect(screen.queryByTestId('plugin-update-cool')).toBeNull()
    expect(screen.getByTestId('plugin-update-chip-cool').textContent).toBe('Update available')
  })
})

describe('PluginUpdateLine', () => {
  it('names the failure, or the version an update brought', () => {
    const { rerender } = render(
      createElement(PluginUpdateLine, {
        name: 'cool',
        status: { ...AVAILABLE, state: 'failed', failure: { at: 'x', reason: 'HTTP 404' } },
        t,
      }),
    )
    expect(screen.getByTestId('plugin-update-failed-cool').textContent).toBe('Update failed: HTTP 404')
    rerender(
      createElement(PluginUpdateLine, {
        name: 'cool',
        status: { identifier: 'cool@shop', state: 'up-to-date', applied: { version: '1.1.0', at: 'x', auto: true } },
        t,
      }),
    )
    expect(screen.getByTestId('plugin-update-applied-cool').textContent).toBe('Updated automatically to version 1.1.0')
  })
})

describe('readPluginUpdatesState', () => {
  it('keeps well-formed rows and refuses a payload with no plugin list', () => {
    expect(readPluginUpdatesState({ autoUpdate: true })).toBeNull()
    const read = readPluginUpdatesState({ autoUpdate: true, plugins: [AVAILABLE, { bad: 1 }], unreachable: 'x' })
    expect(read).toEqual({ autoUpdate: true, checking: false, unreachable: [], plugins: [AVAILABLE] })
  })
})
