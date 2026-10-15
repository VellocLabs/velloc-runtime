// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'

/**
 * The session-list "needs your response" attention dot. It must:
 *  - appear on a BACKGROUND session that needs an answer, in BOTH the expanded
 *    list and the collapsed icon rail (the panel can be collapsed to icons);
 *  - be SUPPRESSED on the active row (its control is already on screen);
 *  - not appear on an idle background session.
 */

const SESSIONS: SessionListItem[] = [
  { sessionId: 'active', title: 'Active', previewText: '', updatedAt: 2, needsAnswer: false },
  { sessionId: 'bg-waiting', title: 'Waiting', previewText: '', updatedAt: 1, needsAnswer: true },
  { sessionId: 'bg-idle', title: 'Idle', previewText: '', updatedAt: 0, needsAnswer: false },
  // Active session that (somehow) reports needsAnswer — the dot must be suppressed.
  { sessionId: 'active', title: 'Active', previewText: '', updatedAt: 2, needsAnswer: true },
]

function renderSidebar(collapsed: boolean) {
  return render(
    createElement(Sidebar, {
      title: 'Conversation',
      sessionId: 'active',
      activeSessionId: 'active',
      collapsed,
      sessions: SESSIONS.slice(0, 3),
    }),
  )
}

afterEach(() => cleanup())

describe('Sidebar needs-answer attention dot', () => {
  it('shows the dot on a waiting background row (expanded), not on active/idle', () => {
    renderSidebar(false)
    const dots = document.querySelectorAll('[data-slot="session-attention-dot"]')
    expect(dots.length).toBe(1)
    // The dot's row is the waiting one; the anchor carries data-needs-answer.
    const anchors = document.querySelectorAll('[data-needs-answer]')
    expect(anchors.length).toBe(1)
    // Its accessible label is present.
    expect(document.body.textContent).toContain('Needs your response')
  })

  it('shows the dot in the collapsed icon rail too', () => {
    renderSidebar(true)
    const dots = document.querySelectorAll('[data-slot="session-attention-dot"]')
    expect(dots.length).toBe(1)
    const railButton = document.querySelector('[data-needs-answer]')
    expect(railButton).not.toBeNull()
  })

  it('suppresses the dot on the active row even if it reports needsAnswer', () => {
    render(
      createElement(Sidebar, {
        title: 'Conversation',
        sessionId: 'active',
        activeSessionId: 'active',
        collapsed: false,
        // Only the active session, and it claims needsAnswer.
        sessions: [SESSIONS[3]!],
      }),
    )
    expect(
      document.querySelectorAll('[data-slot="session-attention-dot"]').length,
    ).toBe(0)
  })
})
