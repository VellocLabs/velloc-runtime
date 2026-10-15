// @vitest-environment happy-dom
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { EnterPlanModeFooterControl } from '../components/assistant-ui/enter-plan-mode-footer-control'
import {
  EnterPlanApprovalContext,
  type EnterPlanApprovalContextValue,
} from '../components/assistant-ui/enter-plan-approval-context'

/**
 * The "Enter plan mode?" footer ask, which gates a model-invoked
 * EnterPlanMode. Two contracts:
 *  1. It renders nothing when there is no pending ask.
 *  2. Its body must NOT name a vendor to users — the visible model name follows
 *     the build brand via the i18n `{product}` token (defaults to "Velloc").
 */

function harness(value: EnterPlanApprovalContextValue): FC {
  return function Harness() {
    return createElement(
      EnterPlanApprovalContext.Provider,
      { value },
      createElement(EnterPlanModeFooterControl),
    )
  }
}

afterEach(() => cleanup())

describe('EnterPlanModeFooterControl', () => {
  it('renders nothing when there is no pending ask', () => {
    render(createElement(harness({ pending: null })))
    expect(
      document.querySelector('[data-slot="enter-plan-mode-control"]'),
    ).toBeNull()
  })

  it('shows the brand product name, never a vendor name, and both decisions', () => {
    const resolve = vi.fn()
    render(
      createElement(
        harness({ pending: { toolCallId: 'tc-1' }, resolve }),
      ),
    )
    const control = document.querySelector(
      '[data-slot="enter-plan-mode-control"]',
    )
    expect(control).not.toBeNull()
    const text = control!.textContent ?? ''
    // No vendor branding facing the user.
    expect(text).not.toContain('Claude')
    // The i18n `{product}` token resolved to the default brand.
    expect(text).toContain('Velloc')
    // Both decisions are present and wired.
    const approve = document.querySelector(
      '[data-slot="enter-plan-mode-approve"]',
    ) as HTMLButtonElement | null
    const reject = document.querySelector(
      '[data-slot="enter-plan-mode-reject"]',
    ) as HTMLButtonElement | null
    expect(approve).not.toBeNull()
    expect(reject).not.toBeNull()
    approve!.click()
    expect(resolve).toHaveBeenCalledWith('approve')
    reject!.click()
    expect(resolve).toHaveBeenCalledWith('reject')
  })
})
