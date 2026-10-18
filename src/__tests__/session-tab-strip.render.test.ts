// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SessionTabStrip } from '../browser/webview/topbar/SessionTabStrip'
import {
  deriveSessionTabs,
  fitTabLabels,
  groupOverflowMenu,
  MIN_OVERFLOWED_TABS,
  planTabOverflow,
  resolveTeammateJumpTarget,
  sidebarActiveSessionId,
} from '../browser/webview/sessionTabs'
import type { SessionListItem } from '../browser/webview/SessionRows'
import { publishOffscreenRunStatus } from '../components/assistant-ui/offscreen-run-status'

afterEach(cleanup)

function item(partial: Partial<SessionListItem> & { sessionId: string }): SessionListItem {
  return {
    title: partial.sessionId,
    previewText: '',
    updatedAt: 0,
    ...partial,
  }
}

const LEAD = item({ sessionId: 'lead-1', title: 'Ship the parser' })
const CHILD = item({
  sessionId: 'teammate-1',
  title: 'fix the lexer',
  spawnerSessionId: 'lead-1',
  teammateName: 'worker-a',
})

describe('sidebarActiveSessionId', () => {
  it('resolves a teammate to its lead so the lead row stays highlighted', () => {
    // Teammates are filtered out of the sidebar list, so the raw child id
    // matches no row; the highlight must fall on the lead instead.
    expect(sidebarActiveSessionId([LEAD, CHILD], 'teammate-1')).toBe('lead-1')
  })

  it('returns an ordinary (parentless) session unchanged', () => {
    expect(sidebarActiveSessionId([LEAD, CHILD], 'lead-1')).toBe('lead-1')
  })

  it('returns an unknown id unchanged, and a child always resolves to its parent id', () => {
    expect(sidebarActiveSessionId([LEAD], 'other')).toBe('other')
    // One hop to spawnerSessionId even when the lead is not in the list -- the
    // returned id then matches no row, so nothing is highlighted either way.
    expect(sidebarActiveSessionId([CHILD], 'teammate-1')).toBe('lead-1')
  })
})

describe('deriveSessionTabs', () => {
  it('lists a lead with its children when the lead is active', () => {
    expect(
      deriveSessionTabs([LEAD, CHILD], 'lead-1').map(s => s.sessionId),
    ).toEqual(['lead-1', 'teammate-1'])
  })

  it('roots on the PARENT when a child is active', () => {
    // Selecting a teammate must not collapse the strip to that teammate —
    // the user has to be able to get back to the lead.
    expect(
      deriveSessionTabs([LEAD, CHILD], 'teammate-1').map(s => s.sessionId),
    ).toEqual(['lead-1', 'teammate-1'])
  })

  it('yields the session itself for an ordinary session', () => {
    // One entry, which the strip renders as the single current-session tab.
    expect(deriveSessionTabs([LEAD], 'lead-1')).toHaveLength(1)
    // An id that is not in the list at all yields nothing.
    expect(deriveSessionTabs([LEAD, CHILD], 'other')).toEqual([])
  })

  it('orders children NEWEST FIRST, so the newest sits next to the lead', () => {
    // A new teammate is added immediately to the right of the lead, which
    // makes the RIGHTMOST tab the oldest child. Deliberately fed in the order
    // the sidebar would supply (by activity), which is not creation order.
    const older = item({
      sessionId: 'child-old',
      spawnerSessionId: 'lead-1',
      createdAt: 100,
    })
    const newer = item({
      sessionId: 'child-new',
      spawnerSessionId: 'lead-1',
      createdAt: 200,
    })
    expect(
      deriveSessionTabs([LEAD, older, newer], 'lead-1').map(s => s.sessionId),
    ).toEqual(['lead-1', 'child-new', 'child-old'])
    expect(
      deriveSessionTabs([LEAD, newer, older], 'lead-1').map(s => s.sessionId),
    ).toEqual(['lead-1', 'child-new', 'child-old'])
  })

  it('orders children with no creation time stably, by id', () => {
    // An fs-summary-only session carries no createdAt. It must not make the
    // order depend on the incoming array, or tabs would move under the pointer.
    const a = item({ sessionId: 'child-a', spawnerSessionId: 'lead-1' })
    const b = item({ sessionId: 'child-b', spawnerSessionId: 'lead-1' })
    expect(
      deriveSessionTabs([LEAD, b, a], 'lead-1').map(s => s.sessionId),
    ).toEqual(['lead-1', 'child-a', 'child-b'])
  })

  it('orders a real teammate by the SPAWN TIME in its id, not by createdAt', () => {
    // The bug this pins: `createdAt` is a real creation time only for a
    // session THIS webview created, which a teammate never is. For every
    // other session the manager fills it from the persisted summary's
    // `updatedAt` -- an ACTIVITY clock that is 0 until the session speaks.
    // A teammate spawned a second ago therefore arrived with createdAt 0 and
    // landed LAST, behind siblings that had been chatting for minutes; it
    // jumped to the front only when the user clicked it and a local entry was
    // finally minted. Both halves go away by reading the id's own stamp.
    const team = 'team-lead-1'
    const older = item({
      sessionId: `teammate-${team}-alpha-1000`,
      spawnerSessionId: 'lead-1',
      teammateName: 'alpha',
      // Busy: its activity clock is the newest of the three.
      createdAt: 9_000,
    })
    const newer = item({
      sessionId: `teammate-${team}-bravo-2000`,
      spawnerSessionId: 'lead-1',
      teammateName: 'bravo',
      createdAt: 5_000,
    })
    const justSpawned = item({
      sessionId: `teammate-${team}-charlie-3000`,
      spawnerSessionId: 'lead-1',
      teammateName: 'charlie',
      // Has not spoken yet, so the summary carried no updatedAt at all.
      createdAt: 0,
    })
    expect(
      deriveSessionTabs([LEAD, older, newer, justSpawned], 'lead-1')
        .map(s => s.teammateName),
    ).toEqual([undefined, 'charlie', 'bravo', 'alpha'])
  })

  it('keeps that order as a teammate works and its activity clock moves', () => {
    // The order must not depend on what the teammates are doing -- tabs
    // moving under the pointer is the thing the creation order exists to
    // prevent. Same two sessions, opposite activity clocks, same tabs.
    const team = 'team-lead-1'
    const first = (createdAt: number) =>
      item({
        sessionId: `teammate-${team}-alpha-1000`,
        spawnerSessionId: 'lead-1',
        createdAt,
      })
    const second = (createdAt: number) =>
      item({
        sessionId: `teammate-${team}-bravo-2000`,
        spawnerSessionId: 'lead-1',
        createdAt,
      })
    const order = (a: number, b: number) =>
      deriveSessionTabs([LEAD, first(a), second(b)], 'lead-1')
        .map(s => s.sessionId)
    expect(order(1, 2)).toEqual(order(2, 1))
    expect(order(1, 2)).toEqual([
      'lead-1',
      `teammate-${team}-bravo-2000`,
      `teammate-${team}-alpha-1000`,
    ])
  })

  it('yields only itself for a child whose parent is missing from the list', () => {
    // A partially loaded / malformed chain must still render something
    // reachable rather than throwing or showing an empty family.
    expect(deriveSessionTabs([CHILD], 'teammate-1').map(s => s.sessionId)).toEqual(
      ['teammate-1'],
    )
  })
})

describe('SessionTabStrip', () => {
  it('renders the single tab of an ordinary session', () => {
    // The strip is how the user sees WHICH session the window is showing,
    // so a childless session gets a tab too - it is not a team-only
    // affordance.
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]!.textContent).toContain('Ship the parser')
  })

  it('renders nothing with no tabs at all', () => {
    const { container } = render(
      createElement(SessionTabStrip, {
        tabs: [],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    expect(container.firstChild).toBeNull()
  })

  it("carries the session's template icon on every tab", () => {
    // The icon is the launcher icon the sidebar row uses, so a tab says what
    // KIND of session it is without the user opening the sidebar. Rendered as
    // an aria-hidden <svg>, one per tab.
    render(
      createElement(SessionTabStrip, {
        tabs: [item({ sessionId: 'a', title: 'A', templateType: 'code' }), CHILD],
        activeSessionId: 'a',
        onSelect: () => {},
      }),
    )
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.querySelector('svg')).not.toBeNull()
    }
  })

  it('shows every title when it has no measured budget', () => {
    // The dev mock and the first paint pass no budget; nothing is hidden then,
    // which is also what keeps a non-layout environment rendering the titles.
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, CHILD],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('data-label-hidden')).toBe('false')
    }
  })

  it('names an icon-only tab through aria-label, not its text', () => {
    // A tab that has given up its title must not go nameless: the accessible
    // name is on the button either way, so dropping the text is safe.
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, CHILD],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    expect(screen.getByTestId('session-tab-teammate-1').getAttribute('aria-label'))
      .toBe('worker-a')
  })

  it('falls back to the type placeholder for an untitled session', () => {
    // Same rule as the sidebar row: the literal 'New Thread' is a placeholder,
    // not content, so the tab shows the localized type name instead.
    render(
      createElement(SessionTabStrip, {
        tabs: [item({ sessionId: 'fresh', title: 'New Thread' })],
        activeSessionId: 'fresh',
        onSelect: () => {},
      }),
    )
    expect(screen.getByRole('tab').textContent).not.toContain('New Thread')
  })

  it('renders one tab per session and marks the active one', () => {
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, CHILD],
        activeSessionId: 'teammate-1',
        onSelect: () => {},
      }),
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    // A teammate is labelled by its member name, not the prompt-derived title.
    expect(tabs[1]!.textContent).toContain('worker-a')
  })

  it('selects on click', () => {
    const onSelect = vi.fn()
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, CHILD],
        activeSessionId: 'lead-1',
        onSelect,
      }),
    )
    fireEvent.click(screen.getByTestId('session-tab-teammate-1'))
    expect(onSelect).toHaveBeenCalledWith('teammate-1')
  })

  // --- Status animators -------------------------------------------------
  // The tab's icon slot doubles as its status light, sharing BOTH indicators
  // with the session list: the busy ripple and the needs-answer dot. The
  // strip is the only place a teammate is reachable, so these are the user's
  // only view of a child session's state while they read another tab.

  it('replaces the icon with the busy ripple on a running tab', () => {
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, { ...CHILD, running: true }],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    const [lead, child] = screen.getAllByRole('tab')
    // The running tab shows the ripple INSTEAD of its type icon — covering
    // it, not sitting beside it, so the tab's width does not change.
    expect(
      child!.querySelector('[data-slot="session-tab-running-icon"]'),
    ).not.toBeNull()
    expect(
      child!.querySelector('[data-slot="session-tab-type-icon"]'),
    ).toBeNull()
    expect(child!.getAttribute('data-running')).toBe('true')
    // The idle tab is untouched: icon, no ripple, no flag.
    expect(
      lead!.querySelector('[data-slot="session-tab-type-icon"]'),
    ).not.toBeNull()
    expect(
      lead!.querySelector('[data-slot="session-tab-running-icon"]'),
    ).toBeNull()
    expect(lead!.getAttribute('data-running')).toBeNull()
  })

  it('restores the icon when the session stops running', () => {
    // The ripple is a view of `running`, not a latched state: a re-render
    // with the flag cleared must put the type icon back.
    const props = (running: boolean) => ({
      tabs: [LEAD, { ...CHILD, running }],
      activeSessionId: 'lead-1',
      onSelect: () => {},
    })
    const { rerender } = render(createElement(SessionTabStrip, props(true)))
    rerender(createElement(SessionTabStrip, props(false)))
    const child = screen.getAllByRole('tab')[1]!
    expect(
      child.querySelector('[data-slot="session-tab-type-icon"]'),
    ).not.toBeNull()
    expect(
      child.querySelector('[data-slot="session-tab-running-icon"]'),
    ).toBeNull()
    expect(child.getAttribute('data-running')).toBeNull()
  })

  it('shows the run status in place of the icon and title while it is offscreen', () => {
    render(
      createElement(SessionTabStrip, {
        tabs: [{ ...LEAD, running: true }, CHILD],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    act(() => publishOffscreenRunStatus('lead-1', { label: 'Thinking', detail: '12s · Thinking · 1.2k tokens' }))
    const [lead, child] = screen.getAllByRole('tab')
    expect(lead!.getAttribute('data-run-status')).toBe('true')
    expect(lead!.querySelector('[data-slot="session-tab-run-status"]')?.textContent).toBe('Thinking')
    expect(lead!.querySelector('.nexus-running-blob')).not.toBeNull()
    // The icon slot and the title both give way to the status.
    expect(lead!.querySelector('[data-slot="session-tab-type-icon"]')).toBeNull()
    expect(lead!.querySelector('[data-slot="session-tab-running-icon"]')).toBeNull()
    expect(lead!.textContent).not.toContain('Ship the parser')
    // The accessible name stays the session's; the tooltip adds the full status.
    expect(lead!.getAttribute('aria-label')).toBe('Ship the parser')
    expect(lead!.getAttribute('title')).toBe('Ship the parser — 12s · Thinking · 1.2k tokens')
    // Only the active tab carries it.
    expect(child!.getAttribute('data-run-status')).toBeNull()
    expect(child!.textContent).toContain('worker-a')

    // Back in view: the tab returns to its own icon and title.
    act(() => publishOffscreenRunStatus('lead-1', null))
    const restored = screen.getAllByRole('tab')[0]!
    expect(restored.getAttribute('data-run-status')).toBeNull()
    expect(restored.textContent).toContain('Ship the parser')
    expect(restored.querySelector('[data-slot="session-tab-run-status"]')).toBeNull()
  })

  it('ignores a run status published for a session that is not active', () => {
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, CHILD],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    act(() => publishOffscreenRunStatus('teammate-1', { label: 'Bash', detail: '3s · Bash' }))
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('data-run-status')).toBeNull()
    }
    act(() => publishOffscreenRunStatus('teammate-1', null))
  })

  it('shows the attention dot on a background tab that needs a response', () => {
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, { ...CHILD, needsAnswer: true }],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    const child = screen.getAllByRole('tab')[1]!
    expect(
      child.querySelector('[data-slot="session-attention-dot"]'),
    ).not.toBeNull()
    expect(child.querySelector('[data-needs-answer]')).not.toBeNull()
    // The state has to reach the accessible name. The dot's own sr-only text
    // cannot do it here — the tab carries an explicit aria-label, which
    // replaces its contents — so the label folds the state in.
    expect(child.getAttribute('aria-label')).toContain('worker-a')
    expect(child.getAttribute('aria-label')).toContain('Needs your response')
    const lead = screen.getAllByRole('tab')[0]!
    expect(lead.querySelector('[data-needs-answer]')).toBeNull()
    expect(lead.getAttribute('aria-label')).toBe('Ship the parser')
  })

  it('suppresses the attention dot on the ACTIVE tab', () => {
    // That session is on screen — its approval control is right there, so a
    // dot pointing at it would be noise. Same rule as the sidebar row.
    render(
      createElement(SessionTabStrip, {
        tabs: [{ ...LEAD, needsAnswer: true }, CHILD],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    expect(
      document.querySelectorAll('[data-slot="session-attention-dot"]').length,
    ).toBe(0)
  })

  it('shows both indicators at once on a tab that is running AND waiting', () => {
    // A session can be busy and still be halted on an approval (the turn is
    // in flight, blocked on the user); the dot rides on TOP of the ripple.
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, { ...CHILD, running: true, needsAnswer: true }],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    const child = screen.getAllByRole('tab')[1]!
    expect(
      child.querySelector('[data-slot="session-tab-running-icon"]'),
    ).not.toBeNull()
    expect(
      child.querySelector('[data-slot="session-attention-dot"]'),
    ).not.toBeNull()
  })

  it('opts the strip out of the window drag region', () => {
    // Without this the topbar's OS drag map swallows the click and the
    // window moves instead of the session switching.
    render(
      createElement(SessionTabStrip, {
        tabs: [LEAD, CHILD],
        activeSessionId: 'lead-1',
        onSelect: () => {},
      }),
    )
    expect(
      screen.getByTestId('session-tab-strip').getAttribute('data-app-region'),
    ).toBe('no-drag')
  })
})

describe('resolveTeammateJumpTarget', () => {
  it('resolves a spawn card\'s session id', () => {
    expect(
      resolveTeammateJumpTarget([LEAD, CHILD], 'lead-1', {
        sessionId: 'teammate-1',
      }),
    ).toBe('teammate-1')
  })

  it('resolves a message card\'s member NAME within the active family', () => {
    expect(
      resolveTeammateJumpTarget([LEAD, CHILD], 'lead-1', {
        teammateName: 'worker-a',
      }),
    ).toBe('teammate-1')
  })

  it('never crosses to another lead\'s teammate of the same name', () => {
    // Member names are unique per TEAM, not globally. A `worker-a` card in
    // one lead's transcript resolving to a different lead's `worker-a` would
    // switch the user into an unrelated conversation — the same scoping bug
    // TeamCoordinator.sessionIdForMemberOfLead exists to prevent.
    const otherLead = item({ sessionId: 'lead-2' })
    const otherChild = item({
      sessionId: 'teammate-2',
      spawnerSessionId: 'lead-2',
      teammateName: 'worker-a',
    })
    expect(
      resolveTeammateJumpTarget(
        [LEAD, CHILD, otherLead, otherChild],
        'lead-2',
        { teammateName: 'worker-a' },
      ),
    ).toBe('teammate-2')
  })

  it('resolves `team-lead` on a teammate\'s SendMessage card to the lead', () => {
    // A teammate reports to its lead under the reserved key `team-lead` —
    // no tab carries that as a name, so the ">>" on such a card matched
    // nothing and the click was silently dropped.
    expect(
      resolveTeammateJumpTarget([LEAD, CHILD], 'teammate-1', {
        teammateName: 'team-lead',
      }),
    ).toBe('lead-1')
    expect(
      resolveTeammateJumpTarget([LEAD, CHILD], 'lead-1', { teammateName: 'lead' }),
    ).toBe('lead-1')
    // A child whose lead is not in the list has nothing to jump to.
    expect(
      resolveTeammateJumpTarget([CHILD], 'teammate-1', { teammateName: 'team-lead' }),
    ).toBeNull()
  })

  it('is null for a teammate that is gone, and for an unknown session id', () => {
    expect(
      resolveTeammateJumpTarget([LEAD], 'lead-1', { teammateName: 'worker-a' }),
    ).toBeNull()
    expect(
      resolveTeammateJumpTarget([LEAD], 'lead-1', { sessionId: 'teammate-1' }),
    ).toBeNull()
  })
})

describe('fitTabLabels', () => {
  // Widths in px, as the strip measures them: a tab costs `iconWidth` with no
  // title and `iconWidth + labelWidth` with one.
  const sample = (sessionId: string, labelWidth: number) => ({
    sessionId,
    iconWidth: 20,
    labelWidth,
  })
  const SAMPLES = [sample('a', 100), sample('b', 100), sample('c', 100)]
  const fit = (budget: number | undefined, activeSessionId = 'a') =>
    [...fitTabLabels({ samples: SAMPLES, activeSessionId, budget, chrome: 0 })]

  it('shows every title when they all fit', () => {
    expect(fit(360)).toEqual([])
  })

  it('drops the LAST title first, then leftwards, and stops as soon as it fits', () => {
    // 360 needed, 300 available: dropping one 100px title is enough, and it is
    // the rightmost tab that loses it.
    expect(fit(300)).toEqual(['c'])
    // Tighter: the last two go.
    expect(fit(200)).toEqual(['c', 'b'])
  })

  it('never drops the ACTIVE tab title, wherever it sits', () => {
    // With 'c' active the strip gives up 'b' and then 'a' instead -- the tab
    // the user is reading keeps its title even when it is the last one.
    expect(fitTabLabels({
      samples: SAMPLES,
      activeSessionId: 'c',
      budget: 40,
      chrome: 0,
    })).toEqual(new Set(['b', 'a']))
    // Everything else is already icon-only and it still does not fit: the
    // active title stays and truncates instead (the caller's max-width).
    expect(fit(0)).toEqual(['c', 'b'])
  })

  it('counts the strip chrome against the budget', () => {
    // 360 of tabs + 12 of padding/gaps does not fit in 365, so one title goes.
    expect(fitTabLabels({
      samples: SAMPLES,
      activeSessionId: 'a',
      budget: 365,
      chrome: 12,
    })).toEqual(new Set(['c']))
  })

  it('hides nothing before the budget has been measured', () => {
    expect(fit(undefined)).toEqual([])
  })
})
describe('planTabOverflow', () => {
  // Widths in px, as the strip measures them: a tab's `width` is its FULL
  // width, title included. Padding and gap are zero unless a test needs them,
  // so the arithmetic under test is the collapse rule and not the chrome.
  const tab = (sessionId: string, shutdown = false) => ({
    sessionId,
    width: 100,
    shutdown,
  })
  const FAMILY = [tab('lead'), tab('c1'), tab('c2'), tab('c3')]
  const plan = (params: {
    samples?: readonly { sessionId: string; width: number; shutdown: boolean }[]
    activeSessionId?: string
    budget: number | undefined
    padding?: number
    gap?: number
    overflowWidth?: number
  }) =>
    planTabOverflow({
      samples: params.samples ?? FAMILY,
      activeSessionId: params.activeSessionId ?? 'lead',
      budget: params.budget,
      padding: params.padding ?? 0,
      gap: params.gap ?? 0,
      overflowWidth: params.overflowWidth ?? 50,
    })

  it('collapses nothing while the whole family fits', () => {
    expect(plan({ budget: 400 })).toEqual(new Set())
  })

  it('collapses from the RIGHT, and stops as soon as it fits', () => {
    // 400 needed, 300 available. Dropping the last two leaves 200 of tabs
    // plus the 50 the overflow tab costs = 250, which fits; the newest child
    // keeps its place next to the lead.
    expect(plan({ budget: 300 })).toEqual(new Set(['c3', 'c2']))
  })

  it('collapses CLOSED teammates first, wherever they sit', () => {
    // c1 is the newest child and sits right beside the lead -- and it is shut
    // down, so it goes before either live sibling. A closed session is a
    // record of finished work; a live one may still be running.
    const samples = [tab('lead'), tab('c1', true), tab('c2'), tab('c3')]
    expect(plan({ samples, budget: 300 })).toEqual(new Set(['c1', 'c3']))
  })

  it('never collapses the lead or the active tab', () => {
    // Nothing fits in 0px, so everything that CAN collapse does -- and what
    // is left is exactly the root the strip exists to get back to plus the
    // session on screen.
    expect(plan({ budget: 0, activeSessionId: 'c1' })).toEqual(
      new Set(['c3', 'c2']),
    )
  })

  it(`never collapses fewer than ${MIN_OVERFLOWED_TABS} tabs`, () => {
    // A lead with one teammate has exactly one collapsible tab, and a chip
    // standing for a single session is worse than the icon-only tab it
    // replaced: it hides that session's status light and costs a click. The
    // caller falls back to dropping titles, which is what it always did.
    expect(plan({ samples: [tab('lead'), tab('c1')], budget: 0 })).toEqual(
      new Set(),
    )
  })

  it('declines to collapse when the overflow tab costs more than it saves', () => {
    // Trading width away AND making the user open a menu is the worst of
    // both; collapsing is only ever allowed to help.
    expect(plan({ budget: 100, overflowWidth: 300 })).toEqual(new Set())
  })

  it('counts the padding, the gaps, and the overflow tab s own gap', () => {
    // 4 x 100 + 3 gaps of 10 + 4 of padding = 434 against a 300 budget.
    // Collapsing two leaves 2 tabs + the chip: 200 + 50 + 2 gaps + 4 = 274.
    // Collapsing one would leave 3 tabs + the chip = 384, which does not fit.
    expect(plan({ budget: 300, padding: 4, gap: 10 })).toEqual(
      new Set(['c3', 'c2']),
    )
  })

  it('collapses nothing before the budget has been measured', () => {
    expect(plan({ budget: undefined })).toEqual(new Set())
  })
})

describe('groupOverflowMenu', () => {
  const live = item({ sessionId: 'c1', spawnerSessionId: 'lead-1' })
  const closed = item({
    sessionId: 'c2',
    spawnerSessionId: 'lead-1',
    shutdown: true,
  })

  it('puts live teammates above the closed ones, with a separator between', () => {
    const menu = groupOverflowMenu(
      [LEAD, live, closed],
      new Set(['c1', 'c2']),
    )
    expect(menu.live.map(s => s.sessionId)).toEqual(['c1'])
    expect(menu.closed.map(s => s.sessionId)).toEqual(['c2'])
    expect(menu.separated).toBe(true)
  })

  it('draws no separator when the menu holds only one kind', () => {
    expect(groupOverflowMenu([LEAD, closed], new Set(['c2'])).separated).toBe(
      false,
    )
    expect(groupOverflowMenu([LEAD, live], new Set(['c1'])).separated).toBe(
      false,
    )
  })

  it('keeps the strip order inside each group and ignores unknown ids', () => {
    const second = item({ sessionId: 'c3', spawnerSessionId: 'lead-1' })
    const menu = groupOverflowMenu(
      [LEAD, live, second, closed],
      new Set(['c3', 'c1', 'gone']),
    )
    expect(menu.live.map(s => s.sessionId)).toEqual(['c1', 'c3'])
    expect(menu.closed).toEqual([])
  })
})

describe('SessionTabStrip — measured collapse', () => {
  // happy-dom has no layout engine, so the widths the strip measures are
  // stubbed: every tab is 130px with its title (a 30px status slot plus a
  // 100px label) and the overflow tab is 50px. That is enough to drive the
  // real component through the real policy, which is the only way to cover
  // the measure → collapse → re-measure loop without a browser.
  const ICON = 30
  const LABEL = 100
  const CHIP = 50
  const offsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  )
  const scrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollWidth',
  )

  function measure(el: HTMLElement): number {
    if (el.getAttribute('role') === 'tab') return ICON + LABEL
    if (el.getAttribute('data-testid') === 'session-tab-overflow') return CHIP
    // The label span inside a tab; the menu rows are portalled and unmeasured.
    if (el.classList.contains('truncate')) return LABEL
    return 0
  }

  const stub = (key: 'offsetWidth' | 'scrollWidth') =>
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return measure(this)
      },
    })
  const restore = (
    key: 'offsetWidth' | 'scrollWidth',
    descriptor: PropertyDescriptor | undefined,
  ) => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, key)
  }

  beforeEach(() => {
    stub('offsetWidth')
    stub('scrollWidth')
  })
  afterEach(() => {
    restore('offsetWidth', offsetWidth)
    restore('scrollWidth', scrollWidth)
  })

  const child = (name: string, extra: Partial<SessionListItem> = {}) =>
    item({
      sessionId: `teammate-team-lead-1-${name}-1000`,
      spawnerSessionId: 'lead-1',
      teammateName: name,
      ...extra,
    })

  const strip = (tabs: SessionListItem[], maxWidth: number, onSelect = () => {}) =>
    render(
      createElement(SessionTabStrip, {
        tabs,
        activeSessionId: 'lead-1',
        onSelect,
        maxWidth,
      }),
    )

  const tabIds = () =>
    screen.getAllByRole('tab').map(el => el.getAttribute('data-testid'))

  it('collapses the tabs that do not fit into one overflow tab', () => {
    // 4 x 130 = 520 against 260: only the lead survives on the strip, and the
    // three teammates are behind a tab that says how many there are.
    strip([LEAD, child('alpha'), child('bravo'), child('charlie')], 260)
    expect(tabIds()).toEqual(['session-tab-lead-1'])
    const overflow = screen.getByTestId('session-tab-overflow')
    expect(overflow.getAttribute('data-count')).toBe('3')
    expect(overflow.textContent).toContain('3')
    expect(overflow.getAttribute('aria-label')).toBe('3 more teammates')
  })

  it('keeps as many tabs on the strip as the budget allows', () => {
    // 320 fits the lead, the newest child, and the overflow tab.
    strip([LEAD, child('alpha'), child('bravo'), child('charlie')], 320)
    expect(tabIds()).toHaveLength(2)
    expect(screen.getByTestId('session-tab-overflow').getAttribute('data-count'))
      .toBe('2')
  })

  it('drops a lone teammate s TITLE rather than collapsing it', () => {
    // The floor, end to end: with one collapsible tab the strip degrades the
    // way it always has -- an icon-only tab, still named, still one click.
    strip([LEAD, child('alpha')], 100)
    expect(screen.queryByTestId('session-tab-overflow')).toBeNull()
    expect(
      screen.getAllByRole('tab').map(el => el.getAttribute('data-label-hidden')),
    ).toEqual(['false', 'true'])
  })

  it('shows every tab and no overflow when they all fit', () => {
    strip([LEAD, child('alpha'), child('bravo'), child('charlie')], 600)
    expect(tabIds()).toHaveLength(4)
    expect(screen.queryByTestId('session-tab-overflow')).toBeNull()
  })

  it('carries a collapsed teammate s attention state on the overflow tab', () => {
    // A collapsed session's status has nowhere else to go, and the strip is
    // the only place a teammate is reachable: without this the user cannot
    // see that a child is blocked on them.
    strip(
      [
        LEAD,
        child('alpha'),
        child('bravo', { needsAnswer: true }),
        child('charlie', { running: true }),
      ],
      260,
    )
    const overflow = screen.getByTestId('session-tab-overflow')
    expect(overflow.getAttribute('data-needs-answer')).toBe('true')
    expect(overflow.getAttribute('data-running')).toBe('true')
    expect(overflow.getAttribute('aria-label')).toContain('Needs your response')
    expect(
      overflow.querySelector('[data-slot="session-attention-dot"]'),
    ).not.toBeNull()
  })

  it('lists live teammates above the closed ones, split by a separator', async () => {
    // 'alpha' is the NEWEST child and sits beside the lead, but it is shut
    // down, so it collapses before a live sibling -- and then sits BELOW the
    // separator, because what the user is looking for is the live one.
    const onSelect = vi.fn()
    strip(
      [LEAD, child('alpha', { shutdown: true }), child('bravo'), child('charlie')],
      320,
      onSelect,
    )
    const overflow = screen.getByTestId('session-tab-overflow')
    expect(overflow.getAttribute('data-count')).toBe('2')
    fireEvent.pointerDown(overflow)
    fireEvent.click(overflow)
    const menu = await screen.findByTestId('session-tab-overflow-menu')
    const rows = Array.from(
      menu.querySelectorAll('[data-testid^="session-tab-overflow-item-"]'),
    )
    expect(rows.map(el => el.getAttribute('aria-label'))).toEqual([
      'charlie',
      'alpha — Shut down',
    ])
    // The separator sits between them, which is what says the tail is closed.
    const separator = menu.querySelector(
      '[data-testid="session-tab-overflow-separator"]',
    )
    expect(separator).not.toBeNull()
    expect(
      rows[0]!.compareDocumentPosition(separator!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      rows[1]!.compareDocumentPosition(separator!) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy()

    fireEvent.click(rows[0]!)
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        'teammate-team-lead-1-charlie-1000',
      ),
    )
  })

  it('draws no separator when every collapsed teammate is live', async () => {
    strip([LEAD, child('alpha'), child('bravo'), child('charlie')], 260)
    fireEvent.pointerDown(screen.getByTestId('session-tab-overflow'))
    fireEvent.click(screen.getByTestId('session-tab-overflow'))
    const menu = await screen.findByTestId('session-tab-overflow-menu')
    expect(
      menu.querySelector('[data-testid="session-tab-overflow-separator"]'),
    ).toBeNull()
    expect(
      menu.querySelectorAll('[data-testid^="session-tab-overflow-item-"]'),
    ).toHaveLength(3)
  })

  it('keeps the tablist free of anything that is not a tab', () => {
    // The overflow tab is a menu button; inside a tablist it would be neither
    // a tab nor a valid child of one.
    strip([LEAD, child('alpha'), child('bravo'), child('charlie')], 260)
    const tablist = screen.getByRole('tablist')
    expect(
      tablist.querySelector('[data-testid="session-tab-overflow"]'),
    ).toBeNull()
    expect(
      screen
        .getByTestId('session-tab-strip')
        .querySelector('[data-testid="session-tab-overflow"]'),
    ).not.toBeNull()
  })
})
