// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  PlanApprovalFooterControl,
  PlanGatedComposer,
} from '../components/assistant-ui/plan-approval-footer-control'
import {
  PlanPanelContext,
  type PlanPanelContextValue,
  type PlanPanelEntry,
} from '../components/assistant-ui/plan-panel-context'
import { ComposerCancelStateProvider } from '../components/assistant-ui/thread-contexts'
import { planHeadline } from '../components/assistant-ui/planHeadline'
import { dropPlanFeedbackDraft } from '../components/assistant-ui/planFeedbackDrafts'

/**
 * The plan card that stands in for the composer while ExitPlanMode waits
 * (F-13): Reject / Revise… / Accept, a three-row feedback box behind Revise…,
 * and the composer hidden until the plan resolves.
 */

function entry(toolCallId: string, planText: string): PlanPanelEntry {
  return {
    toolCallId,
    request: { toolName: 'ExitPlanMode', planText, planFilePath: '', restoreMode: 'default' },
  } as PlanPanelEntry
}

function tree(
  value: PlanPanelContextValue,
  onCancel?: () => void,
  extra?: ReactNode,
) {
  return createElement(
    ComposerCancelStateProvider,
    { value: { isStopping: false, onCancel } },
    createElement(
      PlanPanelContext.Provider,
      { value },
      createElement(PlanApprovalFooterControl),
      createElement(
        PlanGatedComposer,
        null,
        createElement('textarea', { 'data-testid': 'composer-input' }),
      ),
      extra,
    ),
  )
}

const slot = (name: string) =>
  document.querySelector<HTMLElement>(`[data-slot="${name}"]`)

afterEach(() => {
  cleanup()
  dropPlanFeedbackDraft('tc-1')
  dropPlanFeedbackDraft('tc-2')
})

describe('PlanApprovalFooterControl', () => {
  it('shows nothing and leaves the composer visible with no pending plan', () => {
    render(tree({ pending: null }))
    expect(slot('plan-approval-control')).toBeNull()
    const gate = slot('plan-gated-composer')!
    expect(gate.hidden).toBe(false)
    expect(gate.hasAttribute('inert')).toBe(false)
  })

  it('hides the composer and offers Reject, Revise… and Accept with the plan headline', () => {
    render(tree({ pending: entry('tc-1', '# Plan: split the store\n\n1. Step') }))
    const gate = slot('plan-gated-composer')!
    expect(gate.hidden).toBe(true)
    expect(gate.hasAttribute('inert')).toBe(true)
    expect(slot('plan-approval-headline')!.textContent).toBe('Plan: split the store')
    expect(slot('plan-approval-reject')).not.toBeNull()
    expect(slot('plan-approval-revise')).not.toBeNull()
    expect(slot('plan-approval-approve')).not.toBeNull()
    expect(slot('plan-approval-feedback')).toBeNull()
  })

  it('Open plan opens the side pane', () => {
    const openPanel = vi.fn()
    render(tree({ pending: entry('tc-1', 'p'), openPanel }))
    fireEvent.click(slot('plan-approval-view')!)
    expect(openPanel).toHaveBeenCalledTimes(1)
  })

  it('Accept approves without feedback', async () => {
    const resolve = vi.fn()
    render(tree({ pending: entry('tc-1', 'p'), resolve }))
    await act(async () => {
      fireEvent.click(slot('plan-approval-approve')!)
    })
    expect(resolve).toHaveBeenCalledWith('approve', undefined)
  })

  it('Reject stops the waiting turn and does not resolve the plan', () => {
    const resolve = vi.fn()
    const onCancel = vi.fn()
    render(tree({ pending: entry('tc-1', 'p'), resolve }, onCancel))
    fireEvent.click(slot('plan-approval-reject')!)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('Revise… shows a three-row feedback box; Back returns to the three choices', () => {
    render(tree({ pending: entry('tc-1', 'p') }))
    fireEvent.click(slot('plan-approval-revise')!)
    const box = slot('plan-approval-feedback') as HTMLTextAreaElement
    expect(box).not.toBeNull()
    expect(Number(box.getAttribute('rows'))).toBe(3)
    expect(slot('plan-approval-approve')).toBeNull()
    fireEvent.click(slot('plan-approval-back')!)
    expect(slot('plan-approval-feedback')).toBeNull()
    expect(slot('plan-approval-approve')).not.toBeNull()
  })

  it('Revise sends the feedback as a keep-planning rejection', async () => {
    const resolve = vi.fn()
    render(tree({ pending: entry('tc-1', 'p'), resolve }))
    fireEvent.click(slot('plan-approval-revise')!)
    fireEvent.change(slot('plan-approval-feedback')!, {
      target: { value: 'split the rollout' },
    })
    await act(async () => {
      fireEvent.click(slot('plan-approval-send-revision')!)
    })
    expect(resolve).toHaveBeenCalledWith('reject', 'split the rollout')
  })

  it('keeps a revise draft across a remount of the same plan, never under another plan', () => {
    const first = render(tree({ pending: entry('tc-1', 'p') }))
    fireEvent.click(slot('plan-approval-revise')!)
    fireEvent.change(slot('plan-approval-feedback')!, { target: { value: 'draft a' } })
    first.unmount()

    const again = render(tree({ pending: entry('tc-1', 'p') }))
    expect((slot('plan-approval-feedback') as HTMLTextAreaElement).value).toBe('draft a')
    again.rerender(tree({ pending: entry('tc-2', 'q') }))
    expect(slot('plan-approval-feedback')).toBeNull()
  })
})

describe('planHeadline', () => {
  it('takes the first non-empty line without markdown marks', () => {
    expect(planHeadline('\n\n## **Fix** the `store`\nmore')).toBe('Fix the store')
    expect(planHeadline('- first item')).toBe('first item')
    expect(planHeadline('')).toBe('')
    expect(planHeadline(undefined)).toBe('')
  })

  it('caps a long line', () => {
    const out = planHeadline('x'.repeat(500))
    expect(out.length).toBe(200)
    expect(out.endsWith('…')).toBe(true)
  })
})
