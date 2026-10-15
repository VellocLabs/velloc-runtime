// @vitest-environment happy-dom
/**
 * Settings · Plugins · a mod's Options (F-25): after Save, a short tip
 * says what happened — the mod reloaded in the sessions that run it, or (none
 * runs it) that the values apply the next time it loads — and then fades.
 */
import { createElement } from 'react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { ModsUserConfig } from '../browser/runtimeProtocol'
import { ModOptionsForm } from '../browser/webview/settings/sections/ModOptionsForm'

const CONFIG: ModsUserConfig = {
  fields: { limit: { type: 'number', title: 'Limit', description: 'At most', default: 3 } },
  values: { limit: 3 },
} as ModsUserConfig

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function saveWith(loadedSessions: number) {
  const onSave = vi.fn(async () => {})
  render(createElement(ModOptionsForm, { plugin: 'budget-guard', config: CONFIG, loadedSessions, onSave }))
  fireEvent.change(screen.getByTestId('mod-option-budget-guard-limit'), { target: { value: '9' } })
  await act(async () => {
    fireEvent.click(screen.getByTestId('mod-options-save-budget-guard'))
  })
  expect(onSave).toHaveBeenCalledWith({ limit: 9 }, [])
}

describe('ModOptionsForm saved tip', () => {
  it('names the sessions that reloaded the mod, then fades', async () => {
    vi.useFakeTimers()
    await saveWith(2)
    const tip = screen.getByTestId('mod-options-saved-tip-budget-guard')
    expect(tip.textContent).toBe('Saved. budget-guard reloaded in 2 session(s).')
    // Portaled to the body, so no settings container can clip or pin it.
    expect(tip.parentElement).toBe(document.body)
    expect(tip.className).not.toContain('opacity-0')
    // Its last moment it fades, rather than blinking out.
    act(() => {
      vi.advanceTimersByTime(2400)
    })
    expect(screen.getByTestId('mod-options-saved-tip-budget-guard').className).toContain('opacity-0')
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.queryByTestId('mod-options-saved-tip-budget-guard')).toBeNull()
    // The live region stays, emptied, for the next save to fill.
    expect(screen.getByTestId('mod-options-announce-budget-guard').textContent).toBe('')
  })

  it('with no session running the mod, says the values apply at its next load', async () => {
    await saveWith(0)
    expect(screen.getByTestId('mod-options-saved-tip-budget-guard').textContent).toBe(
      'Saved. budget-guard uses the new values the next time it loads.',
    )
  })

  it('a failed save shows no tip, only the error before the button', async () => {
    render(
      createElement(ModOptionsForm, {
        plugin: 'budget-guard',
        config: CONFIG,
        loadedSessions: 2,
        onSave: async () => {
          throw new Error('disk full')
        },
      }),
    )
    fireEvent.change(screen.getByTestId('mod-option-budget-guard-limit'), { target: { value: '9' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('mod-options-save-budget-guard'))
    })
    expect(screen.queryByTestId('mod-options-saved-tip-budget-guard')).toBeNull()
    expect(screen.getByTestId('mod-options-status-budget-guard').textContent).toContain('disk full')
  })
})
