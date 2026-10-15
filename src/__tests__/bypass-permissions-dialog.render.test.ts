// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  BypassPermissionsDialog,
  shouldGateBypassSwitch,
} from '../browser/webview/BypassPermissionsDialog'

afterEach(() => cleanup())

// The load-bearing logic: WHEN a mode switch must be gated behind the warning.
describe('shouldGateBypassSwitch (bypass-mode gate logic)', () => {
  it('gates a switch INTO bypass from another mode when not yet accepted', () => {
    expect(
      shouldGateBypassSwitch({ next: 'bypassPermissions', current: 'default', skipFlag: false }),
    ).toBe(true)
  })

  it('does NOT gate once the warning has been accepted (the suppress edge)', () => {
    expect(
      shouldGateBypassSwitch({ next: 'bypassPermissions', current: 'default', skipFlag: true }),
    ).toBe(false)
  })

  it('does NOT re-gate when already in bypass', () => {
    expect(
      shouldGateBypassSwitch({
        next: 'bypassPermissions',
        current: 'bypassPermissions',
        skipFlag: false,
      }),
    ).toBe(false)
  })

  it('does NOT gate switches to other modes', () => {
    expect(
      shouldGateBypassSwitch({ next: 'acceptEdits', current: 'default', skipFlag: false }),
    ).toBe(false)
    expect(
      shouldGateBypassSwitch({ next: 'plan', current: 'bypassPermissions', skipFlag: false }),
    ).toBe(false)
  })
})

describe('BypassPermissionsDialog (render)', () => {
  it('renders the warning, the docs link, and both choices when open', () => {
    render(
      createElement(BypassPermissionsDialog, {
        open: true,
        onAccept: vi.fn(),
        onCancel: vi.fn(),
      }),
    )
    expect(screen.getByTestId('bypass-dialog')).toBeTruthy()
    // unique-to-title + unique-to-body substrings (the phrase "Bypass
    // Permissions mode" appears in both, so match distinct fragments)
    expect(screen.getByText(/Running in Bypass Permissions mode/i)).toBeTruthy()
    expect(screen.getByText(/potentially dangerous commands/i)).toBeTruthy()
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toContain('security')
    expect(screen.getByRole('button', { name: /accept/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /no, cancel/i })).toBeTruthy()
  })

  it('renders nothing when closed', () => {
    render(
      createElement(BypassPermissionsDialog, {
        open: false,
        onAccept: vi.fn(),
        onCancel: vi.fn(),
      }),
    )
    expect(screen.queryByTestId('bypass-dialog')).toBeNull()
  })

  it('fires onAccept (only) when the accept button is clicked', () => {
    const onAccept = vi.fn()
    const onCancel = vi.fn()
    render(createElement(BypassPermissionsDialog, { open: true, onAccept, onCancel }))
    fireEvent.click(screen.getByRole('button', { name: /accept/i }))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('fires onCancel (only) when the decline button is clicked', () => {
    const onAccept = vi.fn()
    const onCancel = vi.fn()
    render(createElement(BypassPermissionsDialog, { open: true, onAccept, onCancel }))
    fireEvent.click(screen.getByRole('button', { name: /no, cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('routes the close (X) button to onCancel, not onAccept', () => {
    const onAccept = vi.fn()
    const onCancel = vi.fn()
    render(createElement(BypassPermissionsDialog, { open: true, onAccept, onCancel }))
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onAccept).not.toHaveBeenCalled()
  })
})
