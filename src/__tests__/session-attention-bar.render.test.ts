// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { SessionAttentionBar } from '../browser/webview/SessionAttentionBar'
import type { AttentionEvent } from '../browser/webview/sessionAttention'

/**
 * The in-app bar: what a session says when it wants the user and the user is
 * in the window but somewhere else.
 *
 * The queue logic is covered in `session-attention.test.ts`; this file covers
 * only what the component decides — when it takes layout space at all, when
 * it collapses to a summary, and that the whole row is the "go there" action.
 */

const NEEDS_INPUT: AttentionEvent = {
  id: 's1:needs_input',
  sessionId: 's1',
  kind: 'needs_input',
  title: 'Auth refactor',
  createdAt: 1,
}
const QUESTION: AttentionEvent = {
  id: 's2:ended_with_question',
  sessionId: 's2',
  kind: 'ended_with_question',
  title: 'Docs pass',
  detail: 'Should I also bump the minor?',
  createdAt: 2,
}

function renderBar(
  events: AttentionEvent[],
  onSelect = vi.fn(),
  windowFocused = true,
) {
  const result = render(
    createElement(SessionAttentionBar, { events, windowFocused, onSelect }),
  )
  return { ...result, onSelect }
}

afterEach(cleanup)

describe('SessionAttentionBar', () => {
  it('renders nothing while the queue is empty', () => {
    // The bar sits in the shell's flex column and PUSHES the conversation
    // down, so an empty queue must cost no layout at all.
    const { queryByTestId } = renderBar([])
    expect(queryByTestId('session-attention-bar')).toBeNull()
  })

  it('renders nothing while the window is not the active surface', () => {
    // An event raised while the user is away took the `notify` route (the OS
    // toast) and waits in the QUEUE, not in the layout: the bar is the
    // in-window surface and there is no one in the window. The same queue
    // renders the moment the window is active again.
    const { queryByTestId, rerender } = renderBar([NEEDS_INPUT], vi.fn(), false)
    expect(queryByTestId('session-attention-bar')).toBeNull()
    rerender(
      createElement(SessionAttentionBar, {
        events: [NEEDS_INPUT],
        windowFocused: true,
        onSelect: vi.fn(),
      }),
    )
    expect(queryByTestId('session-attention-bar')).toBeTruthy()
  })

  it('shows a single waiting session as one row, with no summary line', () => {
    const { getByTestId, queryByTestId, getAllByTestId } = renderBar([
      NEEDS_INPUT,
    ])
    expect(getByTestId('session-attention-bar')).toBeTruthy()
    expect(queryByTestId('session-attention-bar-summary')).toBeNull()
    const items = getAllByTestId('session-attention-bar-item')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('Auth refactor')
    expect(items[0]?.textContent).toContain('Waiting for your answer')
  })

  it('leads a row with the session icon and title, and ends in the jump glyph', () => {
    // The row reads like the sidebar row for that session — icon, then
    // title — so the user recognises WHICH session before reading WHY. The
    // trailing `>>` is the same glyph the teammate cards use for "this takes
    // you to another session"; there is no text link.
    const { getAllByTestId } = renderBar([NEEDS_INPUT])
    const row = getAllByTestId('session-attention-bar-item')[0]!
    const children = [...row.children]
    expect(children[0]?.getAttribute('data-slot')).toBe(
      'session-attention-bar-type-icon',
    )
    expect(children[1]?.textContent).toBe('Auth refactor')
    expect(children[children.length - 1]?.getAttribute('data-slot')).toBe(
      'session-attention-bar-jump',
    )
    expect(row.textContent).not.toContain('Open')
  })

  it('shows the question itself for an ended-with-question event', () => {
    // The question is the whole reason to go back, so it beats a generic label.
    const { getAllByTestId } = renderBar([QUESTION])
    expect(getAllByTestId('session-attention-bar-item')[0]?.textContent).toContain(
      'Should I also bump the minor?',
    )
  })

  it('collapses two or more behind a counted summary, expandable on click', () => {
    // A growing stack would eat the conversation area exactly when the user
    // has several things to get through and needs the space most.
    const { getByTestId, queryAllByTestId, getAllByTestId } = renderBar([
      NEEDS_INPUT,
      QUESTION,
    ])
    const summary = getByTestId('session-attention-bar-summary')
    expect(summary.textContent).toContain('2 sessions need you')
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(queryAllByTestId('session-attention-bar-item')).toHaveLength(0)

    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(getAllByTestId('session-attention-bar-item')).toHaveLength(2)
  })

  it('sends the session id when a row is clicked', () => {
    const { getAllByTestId, onSelect } = renderBar([QUESTION])
    fireEvent.click(getAllByTestId('session-attention-bar-item')[0]!)
    expect(onSelect).toHaveBeenCalledWith('s2')
  })

  it('offers no dismiss control', () => {
    // An event leaves the queue by being VISITED. A dismiss button would let a
    // user swat away an ask that is still blocking a session.
    const { getByTestId } = renderBar([NEEDS_INPUT, QUESTION])
    const bar = getByTestId('session-attention-bar')
    for (const button of bar.querySelectorAll('button')) {
      expect(button.textContent?.toLowerCase()).not.toContain('dismiss')
    }
  })

  it('announces politely rather than interrupting', () => {
    // Advisory, not an alert: it must not cut a screen reader off mid-sentence.
    const { getByTestId } = renderBar([NEEDS_INPUT])
    const bar = getByTestId('session-attention-bar')
    expect(bar.getAttribute('role')).toBe('status')
    expect(bar.getAttribute('aria-live')).toBe('polite')
  })
})
