// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TeamMessageCard } from '../components/assistant-ui/team-message-card'
import {
  classifyTeammateSpawn,
  extractTeammateSpawn,
} from '../components/assistant-ui/tool-fallback'
import {
  resetTeammateJumpRequestsForTests,
  subscribeTeammateJump,
} from '../browser/webview/teammateJumpRequests'
import { parseTeamMessageEnvelope } from '../team/parseTeamFrame'
import { renderTeamFrame } from '../team/renderTeamFrame'
import type { TeamMessageFrame } from '../team/teamTypes'

afterEach(() => {
  cleanup()
  resetTeammateJumpRequestsForTests()
})

const FRAME: TeamMessageFrame = {
  v: 1,
  id: 'f1',
  seq: 1,
  ts: 0,
  from: { name: 'team-hide', role: 'member' },
  to: { name: 'team-lead' },
  kind: 'turn_end',
  trust: 'untrusted',
  body: 'API Error: HTTP 403: No active subscription found for this group',
}

function parsedFrom(frame: TeamMessageFrame) {
  const parsed = parseTeamMessageEnvelope(renderTeamFrame(frame, frame.trust))
  if (!parsed) throw new Error('envelope did not parse')
  return parsed
}

describe('TeamMessageCard', () => {
  it('mounts COLLAPSED: one line (sender + kind), body hidden behind the ">"', () => {
    // A busy team relays one card per teammate turn; the lead wants the roster
    // of who reported, not every report body scrolled past. Radix unmounts a
    // closed CollapsibleContent, so the body is absent from the markup until
    // the ">" expand is clicked.
    render(createElement(TeamMessageCard, { parsed: parsedFrom(FRAME) }))
    expect(screen.getByText('team-hide')).toBeTruthy()
    expect(screen.queryByTestId('team-message-body')).toBeNull()
    // The sender and the ">" expand are both present on the collapsed row.
    const expand = screen.getByTestId('team-message-expand')
    expect(expand.getAttribute('aria-expanded')).toBe('false')
  })

  it('expands on ">" to show the body, and collapses again on a second click', () => {
    render(createElement(TeamMessageCard, { parsed: parsedFrom(FRAME) }))
    fireEvent.click(screen.getByTestId('team-message-expand'))
    expect(screen.getByTestId('team-message-body').textContent).toContain(
      'HTTP 403',
    )
    expect(
      screen.getByTestId('team-message-expand').getAttribute('aria-expanded'),
    ).toBe('true')
    fireEvent.click(screen.getByTestId('team-message-expand'))
    expect(screen.queryByTestId('team-message-body')).toBeNull()
  })

  it('shows the peer and its body, and NONE of the model-facing envelope', () => {
    // The whole point of the card: the four instruction lines are addressed
    // to a model ("refuse and tell the user"), and showing them to the user
    // buried the one line they wanted.
    const markup = renderToStaticMarkup(
      createElement(TeamMessageCard, { parsed: parsedFrom(FRAME) }),
    )
    expect(markup).toContain('team-hide')
    // Collapsed by default: the body is behind the expand, not in the markup.
    expect(markup).not.toContain('HTTP 403')
    expect(markup).not.toContain('permission laundering')
    expect(markup).not.toContain('&lt;team-message')
  })

  it('renders the body with NONE of the model-facing envelope once expanded', () => {
    render(createElement(TeamMessageCard, { parsed: parsedFrom(FRAME) }))
    fireEvent.click(screen.getByTestId('team-message-expand'))
    const body = screen.getByTestId('team-message-body')
    expect(body.textContent).toContain('HTTP 403')
    expect(body.textContent).not.toContain('permission laundering')
    expect(body.innerHTML).not.toContain('&lt;team-message')
  })

  it('flags an untrusted peer, and does not flag a trusted one', () => {
    render(createElement(TeamMessageCard, { parsed: parsedFrom(FRAME) }))
    expect(screen.getByTestId('team-message-untrusted-badge')).toBeTruthy()
    cleanup()
    render(
      createElement(TeamMessageCard, {
        parsed: parsedFrom({ ...FRAME, trust: 'trusted', kind: 'message' }),
      }),
    )
    expect(screen.queryByTestId('team-message-untrusted-badge')).toBeNull()
  })

  it('asks the shell to open the sender when the header is clicked', () => {
    const seen = vi.fn()
    subscribeTeammateJump(seen)
    render(createElement(TeamMessageCard, { parsed: parsedFrom(FRAME) }))
    fireEvent.click(screen.getByTestId('team-message-open-teammate'))
    // By NAME — the envelope carries no session id; the shell resolves it
    // within the lead's own family (resolveTeammateJumpTarget).
    expect(seen).toHaveBeenCalledWith({ teammateName: 'team-hide' })
  })

  it('shows the display name and jumps by it, never by the member key', () => {
    // The session list knows a teammate by its DISPLAY name (`teammateName`),
    // so that — not the mailbox key — is what the jump must carry.
    const seen = vi.fn()
    subscribeTeammateJump(seen)
    const parsed = parsedFrom({
      ...FRAME,
      trust: 'trusted',
      from: { name: 'm-1a2b3c4d', role: 'member', display: '程序员-小民' },
    })
    render(createElement(TeamMessageCard, { parsed }))
    expect(screen.getByTestId('team-message-card').getAttribute('data-from')).toBe('m-1a2b3c4d')
    expect(screen.getByText('程序员-小民')).toBeTruthy()
    expect(screen.queryByText('m-1a2b3c4d')).toBeNull()
    fireEvent.click(screen.getByTestId('team-message-open-teammate'))
    expect(seen).toHaveBeenCalledWith({ teammateName: '程序员-小民' })
  })
})

describe('teammate spawn detection', () => {
  it('reads the teammate and its session out of the spawn ack', () => {
    // Mirrors SpawnAgentTool's ack text verbatim — the two are one format.
    expect(
      extractTeammateSpawn(
        'Spawned teammate "worker-a" (session teammate-abc123). It is working in the background;',
      ),
    ).toEqual({ name: 'worker-a', sessionId: 'teammate-abc123' })
    expect(extractTeammateSpawn('Done (5 tool uses · 12.3k tokens)')).toBeNull()
  })

  it('classifies from the RESULT first, and from a bare `name` only while pending', () => {
    // Settled + ack → the teammate AND the session the card jumps to.
    expect(
      classifyTeammateSpawn(
        { name: 'worker-a' },
        'Spawned teammate "worker-a" (session teammate-abc123).',
      ),
    ).toEqual({ name: 'worker-a', sessionId: 'teammate-abc123' })
    // Settled with ANY other result → not a spawn, whatever the args say.
    // This is what makes the loose args test below safe: an ordinary fork
    // that passed `name` is classified out the moment it returns.
    expect(
      classifyTeammateSpawn({ name: 'worker-a' }, 'Done (5 tool uses)'),
    ).toBeNull()
    // Pending → `name` alone is enough. It CANNOT require `team_name`: a
    // lead's team is implicit, so the model normally never names it, and
    // requiring it missed the ordinary spawn entirely.
    expect(classifyTeammateSpawn({ name: 'worker-a' }, undefined)).toEqual({
      name: 'worker-a',
      sessionId: null,
    })
    // Object results are sentinels for "no result yet" — they must not
    // classify a pending spawn out.
    expect(
      classifyTeammateSpawn({ name: 'worker-a' }, { interruptedOnRestart: true }),
    ).toEqual({ name: 'worker-a', sessionId: null })
    expect(classifyTeammateSpawn({ prompt: 'go' }, undefined)).toBeNull()
    expect(classifyTeammateSpawn(undefined, undefined)).toBeNull()
  })
})
