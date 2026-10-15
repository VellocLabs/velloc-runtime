// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { TranscriptSearchMatch } from '../browser/bridge/protocol/search'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TopbarSearch } from '../browser/webview/topbar/TopbarSearch'
import {
  getTranscriptSearchState,
  resetTranscriptSearchStateForTests,
} from '../browser/webview/transcriptSearchStore'
import {
  clearSearchHistory,
  readSearchHistory,
  rememberSearchQuery,
} from '../browser/webview/searchHistoryStorage'

const SESSIONS = [
  { sessionId: 'sess-a', title: 'Alpha thread', updatedAt: 900 },
  { sessionId: 'sess-b', title: 'Beta thread', updatedAt: 500 },
  { sessionId: 'sess-c', title: 'Gamma thread', updatedAt: 100 },
]

function hit(sessionId: string, line: number): TranscriptSearchMatch {
  return {
    sessionId,
    projectDir: 'proj',
    transcriptPath: `/home/tester/.velloc/projects/proj/${sessionId}/transcript.jsonl`,
    lineOrdinal: line,
    messageUuid: `uuid-${sessionId}-${line}`,
    spanKind: 'userText',
    snippet: 'find the chromium build',
    matchStart: 9,
    matchLen: 8,
  }
}

/**
 * Scripted reply: each session answers with the hits it owns, and only
 * when it is in the requested slice.
 *
 * A search arrives as several slices, so a fake that returned the same
 * matches on every round trip would duplicate its own results — which is
 * neither what the host does nor what the popup must render.
 */
function scripted(
  bySession: Record<string, TranscriptSearchMatch[]>,
): (targets: string[]) => TranscriptSearchMatch[] {
  return targets => targets.flatMap(path => bySession[sessionOf(path)] ?? [])
}

/** `.../projects/<proj>/<sessionId>/transcript.jsonl` -> `<sessionId>`. */
function sessionOf(path: string): string {
  return path.split(/[\\/]/).at(-2) ?? ''
}

/**
 * Fake host. Returns a scripted match set per `search.queryTranscripts`
 * chunk, so a test can assert what the popup shows after each round trip.
 * The home directory comes from `resolveHomeDir` (the runtime's
 * `fsx.userHome` in production), never from an `fs` route.
 */
function makeTransport(
  reply: (targets: string[], call: number) => TranscriptSearchMatch[],
): { transport: BrowserBridgeTransport; calls: string[][] } {
  const calls: string[][] = []
  const transport = {
    request: async (message: {
      route: { capability: string; action: string }
      payload: Record<string, unknown>
    }) => {
      if (message.route.capability === 'fs') {
        throw new Error('the search must not ask the host for fs.* directly')
      }
      const targets = message.payload.targets as string[]
      calls.push(targets)
      return {
        ok: true,
        result: {
          generation: message.payload.generation,
          superseded: false,
          truncated: false,
          skippedFiles: 0,
          matches: reply(targets, calls.length - 1),
        },
      }
    },
  } as unknown as BrowserBridgeTransport
  return { transport, calls }
}

function renderSearch(
  transport: BrowserBridgeTransport,
  overrides: Partial<{
    onJumpToMatch: (id: string, uuid: string, line: number) => void
    onOpenSession: (id: string) => void
    activeSessionId: string | null
  }> = {},
) {
  // In production the control always renders inside NexusTopBar's
  // TooltipProvider; mirror that here.
  return render(
    createElement(
      TooltipProvider,
      null,
      createElement(TopbarSearch, {
        transport,
        resolveHomeDir: async () => '/home/tester',
        sessions: SESSIONS,
        activeSessionId: overrides.activeSessionId ?? 'sess-a',
        onJumpToMatch: overrides.onJumpToMatch ?? vi.fn(),
        onOpenSession: overrides.onOpenSession ?? vi.fn(),
      }),
    ),
  )
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

function typeQuery(value: string): void {
  fireEvent.change(screen.getByTestId('transcript-search-input'), {
    target: { value },
  })
}

describe('TopbarSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTranscriptSearchStateForTests()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('starts as an icon and expands into a box in place', () => {
    const { transport } = makeTransport(() => [])
    renderSearch(transport)
    expect(screen.getByTestId('topbar-search')).toBeTruthy()
    expect(screen.queryByTestId('transcript-search-input')).toBeNull()

    fireEvent.click(screen.getByTestId('topbar-search'))
    expect(screen.getByTestId('transcript-search-input')).toBeTruthy()
    expect(screen.queryByTestId('topbar-search')).toBeNull()
  })

  it('expands into a box as tall as the neighbouring topbar controls', () => {
    // The box sits in the topbar between icon buttons (size-8) and the
    // model-picker trigger (h-8); it was h-7, visibly shorter than both.
    const { transport } = makeTransport(() => [])
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    const box = screen.getByTestId('transcript-search-input')
        .parentElement as HTMLElement
    expect(box.className).toMatch(/\bh-8\b/)
    expect(box.className).not.toMatch(/\bh-7\b/)
  })

  it('stays collapsed on mount even though the open token starts at 0', () => {
    // Regression: reacting to the token's INITIAL value opened the box on
    // every boot, so the bar came up with a text field instead of an icon.
    const { transport } = makeTransport(() => [])
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(TopbarSearch, {
          transport,
          resolveHomeDir: async () => '/home/tester',
          sessions: SESSIONS,
          activeSessionId: 'sess-a',
          onJumpToMatch: vi.fn(),
          onOpenSession: vi.fn(),
          openToken: 0,
        }),
      ),
    )
    expect(screen.getByTestId('topbar-search')).toBeTruthy()
    expect(screen.queryByTestId('transcript-search-input')).toBeNull()
  })

  it('sends the ACTIVE session first, then the rest by recency', async () => {
    const { transport, calls } = makeTransport(() => [])
    renderSearch(transport, { activeSessionId: 'sess-c' })
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()

    // The first round trip carries the ACTIVE session by itself, so its
    // hits paint before any other transcript has been opened; the rest
    // follow by recency across the later slices. Concatenated, the calls
    // ARE the priority order — that is the contract, not the slicing.
    expect(calls[0]!.map(sessionOf)).toEqual(['sess-c'])
    expect(calls.flat().map(sessionOf)).toEqual(['sess-c', 'sess-a', 'sess-b'])
  })

  it('renders each session with its hit count, in the order searched', async () => {
    const { transport } = makeTransport(
      scripted({
        'sess-a': [hit('sess-a', 1), hit('sess-a', 2)],
        'sess-b': [hit('sess-b', 7)],
      }),
    )
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()

    const rows = screen.getAllByTestId('transcript-search-session')
    expect(rows.map(row => row.getAttribute('data-session-id'))).toEqual([
      'sess-a',
      'sess-b',
    ])
    const counts = screen
      .getAllByTestId('transcript-search-hit-count')
      .map(node => node.textContent)
    // Labelled so the number reads as a hit count, and singular is not
    // rendered as "1 times".
    expect(counts).toEqual(['2 hits', '1 hit'])
  })

  it('clicking a session opens its hits WITHOUT switching the conversation', async () => {
    // Browsing results must not move the user out of what they are
    // reading — only a hit does that.
    const onJumpToMatch = vi.fn()
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1), hit('sess-a', 4)] }))
    renderSearch(transport, { onJumpToMatch })
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()

    fireEvent.click(screen.getAllByTestId('transcript-search-session')[0]!)
    expect(onJumpToMatch).not.toHaveBeenCalled()
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()
    expect(screen.getAllByTestId('transcript-search-hit')).toHaveLength(2)
  })

  it('renders the hits in their own pane beside the session list', async () => {
    // Regression: the hits were once positioned outside the popup card,
    // which carries `overflow-hidden` — the row opened and the user saw
    // nothing. They must live in a real pane inside the card.
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1), hit('sess-a', 4)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    fireEvent.click(screen.getAllByTestId('transcript-search-session')[0]!)

    const popup = screen.getByTestId('transcript-search-popup')
    const pane = screen.getByTestId('transcript-search-hits')
    expect(popup.contains(pane)).toBe(true)
    const hits = screen.getAllByTestId('transcript-search-hit')
    expect(hits).toHaveLength(2)
    for (const node of hits) expect(pane.contains(node)).toBe(true)
    // Each hit carries its sentence.
    expect(hits[0]!.textContent).toContain('chromium')
  })

  it('clicking a hit jumps to that message', async () => {
    const onJumpToMatch = vi.fn()
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 3)] }))
    renderSearch(transport, { onJumpToMatch })
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    fireEvent.click(screen.getAllByTestId('transcript-search-session')[0]!)
    fireEvent.click(screen.getByTestId('transcript-search-hit'))

    // Three anchors ride along, strongest first: the line's uuid
    // addresses the ROW exactly (rows advertise every transcript line
    // they were rendered from), the sentence identifies it when the line
    // rendered nothing of its own, and the term picks the LINE inside
    // that row to scroll to and flash.
    expect(onJumpToMatch).toHaveBeenCalledWith(
      'sess-a',
      'uuid-sess-a-3',
      3,
      'find the chromium build',
      'chromium',
    )
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()
  })

  it('clicking outside hides the popup but keeps the box and its text', async () => {
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('transcript-search-popup')).toBeNull()
    const input = screen.getByTestId('transcript-search-input') as HTMLInputElement
    expect(input.value).toBe('chromium')

    // Clicking back in restores the same results — no new host call needed.
    fireEvent.focus(input)
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()
    expect(screen.getAllByTestId('transcript-search-session')).toHaveLength(1)
  })

  it('closes the popup when a click lands in an inline iframe (focus leaves the document)', async () => {
    // Regression: the dismiss rule listened only for `pointerdown` on
    // `document`, so a click inside an inline iframe — a `show_location`
    // map, an a2ui surface — fired in the frame's OWN document, never
    // reached the handler, and the popup sat open over what was clicked.
    // Focus entering the frame blurs the window with the iframe as the
    // active element; the popup must close on that.
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()

    // Simulate focus moving into an iframe outside the search control.
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => frame,
    })
    try {
      fireEvent.blur(window)
      expect(screen.queryByTestId('transcript-search-popup')).toBeNull()
      // The box and its query survive, exactly as a pointerdown outside.
      const input = screen.getByTestId(
        'transcript-search-input',
      ) as HTMLInputElement
      expect(input.value).toBe('chromium')
    } finally {
      Reflect.deleteProperty(document, 'activeElement')
      frame.remove()
    }
  })

  it('keeps the popup open on a plain window blur (an app-switch, not an iframe click)', async () => {
    // The counter-case to the iframe rule: a window blur with no iframe
    // taking focus is an app-switch, not an outside click, so the popup
    // must stay — returning to the app finds it as it was.
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()

    fireEvent.blur(window)
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()
  })

  it('emptying the text clears the results, and closing then collapses to the icon', async () => {
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    expect(getTranscriptSearchState().groups).toHaveLength(1)

    typeQuery('')
    expect(getTranscriptSearchState().groups).toBeNull()
    expect(screen.queryByTestId('transcript-search-session')).toBeNull()

    fireEvent.pointerDown(document.body)
    expect(screen.getByTestId('topbar-search')).toBeTruthy()
    expect(screen.queryByTestId('transcript-search-input')).toBeNull()
  })

  it('collapses an emptied box even when the popup is already closed', async () => {
    // Regression: the outside-click listener was armed only while the
    // POPUP was open, so a box left empty with the popup already closed
    // could never collapse back to its icon.
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('transcript-search-popup')).toBeNull()
    typeQuery('')
    fireEvent.pointerDown(document.body)
    expect(screen.getByTestId('topbar-search')).toBeTruthy()
  })

  it('dismiss (X) returns to the icon in one gesture', async () => {
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    fireEvent.click(screen.getByTestId('transcript-search-dismiss'))
    expect(screen.getByTestId('topbar-search')).toBeTruthy()
  })

  it('finds a session by TITLE even with no body hit', async () => {
    // A title lives in the meta sidecar, which the host never reads, so
    // "Beta" would otherwise match nothing at all.
    const { transport } = makeTransport(() => [])
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('Beta thread')
    await flush()

    const rows = screen.getAllByTestId('transcript-search-session')
    expect(rows.map(row => row.getAttribute('data-session-id'))).toEqual([
      'sess-b',
    ])
    expect(
      screen.getByTestId('transcript-search-hit-count').textContent,
    ).toBe('title')
  })

  it('clicking a TITLE-only row goes straight to the session — no flyout', async () => {
    // Regression: the row opened an EMPTY hits pane instead, and neither
    // the row nor the empty pane could move the user — a dead end. With
    // no hits to show there is nothing a flyout could hold, so the click
    // must switch to the conversation directly.
    const onOpenSession = vi.fn()
    const onJumpToMatch = vi.fn()
    const { transport } = makeTransport(() => [])
    renderSearch(transport, { onOpenSession, onJumpToMatch })
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('Beta thread')
    await flush()

    const row = screen.getAllByTestId('transcript-search-session')[0]!
    // The row advertises it has nothing to expand into.
    expect(row.getAttribute('data-title-only')).toBe('true')
    expect(row.getAttribute('aria-expanded')).toBeNull()

    fireEvent.click(row)
    expect(onOpenSession).toHaveBeenCalledWith('sess-b')
    expect(onJumpToMatch).not.toHaveBeenCalled()
    // No flyout opened — and the popup itself survives the switch, like
    // any session-row click.
    expect(screen.queryByTestId('transcript-search-hits')).toBeNull()
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()
    expect(getTranscriptSearchState().expandedSessionId).toBeNull()
  })

  it('a TITLE-only click hands focus back to the box even when no animation frame ever comes', async () => {
    // Regression: the re-focus after a row click waited for the next
    // animation frame, and an occluded window delivers none — the switch
    // landed, focus stayed wherever it was, and typing no longer reached
    // the search. Seen as the e2e "search box kept focus" timeout under load.
    vi.stubGlobal('requestAnimationFrame', () => 0)
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    try {
      const { transport } = makeTransport(() => [])
      renderSearch(transport, { onOpenSession: vi.fn() })
      fireEvent.click(screen.getByTestId('topbar-search'))
      typeQuery('Beta thread')
      await flush()
      const input = screen.getByTestId('transcript-search-input')

      elsewhere.focus()
      fireEvent.click(screen.getAllByTestId('transcript-search-session')[0]!)
      await vi.advanceTimersByTimeAsync(60)

      expect(document.activeElement).toBe(input)
    } finally {
      elsewhere.remove()
      vi.unstubAllGlobals()
    }
  })

  it('a TITLE-only click closes a flyout left open for ANOTHER session', async () => {
    // Regression: the title-only branch switched the conversation and
    // returned without touching the expanded session, so a flyout already
    // open for session X stayed on screen — X's hits, X's row highlighted
    // — while Y was now the active conversation, and clicking one of those
    // hits yanked the user straight back to X.
    const onOpenSession = vi.fn()
    // sess-a answers with a body hit; 'Beta thread' matches sess-b's TITLE
    // only, so the popup shows both kinds of row at once.
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport, { onOpenSession })
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('Beta thread')
    await flush()

    const rowFor = (id: string) =>
      screen
        .getAllByTestId('transcript-search-session')
        .find(row => row.getAttribute('data-session-id') === id)!
    fireEvent.click(rowFor('sess-a'))
    expect(screen.getByTestId('transcript-search-hits')).toBeTruthy()
    expect(getTranscriptSearchState().expandedSessionId).toBe('sess-a')

    fireEvent.click(rowFor('sess-b'))
    expect(onOpenSession).toHaveBeenCalledWith('sess-b')
    expect(screen.queryByTestId('transcript-search-hits')).toBeNull()
    expect(getTranscriptSearchState().expandedSessionId).toBeNull()
    expect(getTranscriptSearchState().selectedSessionId).toBeNull()
    expect(rowFor('sess-a').getAttribute('aria-expanded')).toBe('false')
  })

  it('takes focus back from a composer that autofocuses while the popup is open', async () => {
    // Regression: opening a result switches the conversation, and the
    // thread that mounts (or REmounts once its snapshot lands) carries a
    // composer that autofocuses — after the box's one-frame re-focus, so
    // the next keystrokes went into the composer and Escape no longer
    // reached the popup. While the popup is open, a programmatic composer
    // focus is handed straight back to the search box.
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    const input = screen.getByTestId('transcript-search-input') as HTMLInputElement
    input.focus()

    const composer = document.createElement('textarea')
    composer.className = 'aui-composer-input'
    document.body.appendChild(composer)
    try {
      composer.focus() // the library's autofocus, not a user gesture
      expect(document.activeElement).toBe(input)

      // Counter-case: once the popup is closed the rule ends — the same
      // programmatic focus lands in the composer, as it always did.
      fireEvent.pointerDown(document.body)
      expect(screen.queryByTestId('transcript-search-popup')).toBeNull()
      composer.focus()
      expect(document.activeElement).toBe(composer)
    } finally {
      composer.remove()
    }
  })

  it('a session WITH hits still opens its flyout without switching', async () => {
    // Counter-case to the title-only rule above: rows that DO have hits
    // keep the browse-first behaviour.
    const onOpenSession = vi.fn()
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport, { onOpenSession })
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()

    const row = screen.getAllByTestId('transcript-search-session')[0]!
    expect(row.getAttribute('data-title-only')).toBeNull()
    fireEvent.click(row)
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('transcript-search-hits')).toBeTruthy()
  })

  it('pointerdown in the popup gap beside a flyout dismisses; the cards do not', async () => {
    // Regression: with a flyout open, the popup BOX claims the full window
    // width, and the dismiss rule tested containment on it — so the empty
    // space beside a SHORT flyout (above the list card's bottom) counted
    // as "inside" and a click there dismissed nothing. "Inside" is the
    // three visible surfaces only: the input box and the two cards.
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    fireEvent.click(screen.getAllByTestId('transcript-search-session')[0]!)
    expect(screen.getByTestId('transcript-search-hits')).toBeTruthy()

    // Clicks that land on either card keep everything open.
    fireEvent.pointerDown(screen.getByTestId('transcript-search-hits'))
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()
    fireEvent.pointerDown(screen.getAllByTestId('transcript-search-session')[0]!)
    expect(screen.getByTestId('transcript-search-popup')).toBeTruthy()

    // A click inside the popup box but OUTSIDE both cards — the gap the
    // full-width box creates beside the flyout — dismisses it.
    fireEvent.pointerDown(screen.getByTestId('transcript-search-popup'))
    expect(screen.queryByTestId('transcript-search-popup')).toBeNull()
    // The box and its text survive, exactly as any outside click.
    const input = screen.getByTestId('transcript-search-input') as HTMLInputElement
    expect(input.value).toBe('chromium')
  })

  it('offers recent searches when the box is empty, and clears them', () => {
    clearSearchHistory()
    rememberSearchQuery('chromium')
    const { transport } = makeTransport(() => [])
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))

    const items = screen.getAllByTestId('transcript-search-history-item')
    expect(items.map(node => node.textContent)).toContain('chromium')

    fireEvent.click(screen.getByTestId('transcript-search-history-clear'))
    expect(screen.queryByTestId('transcript-search-history-item')).toBeNull()
    expect(readSearchHistory()).toEqual([])
  })

  it('records a query only when a result is opened', async () => {
    clearSearchHistory()
    const { transport } = makeTransport(scripted({ 'sess-a': [hit('sess-a', 1)] }))
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('chromium')
    await flush()
    // Typing alone must not fill the history with every prefix.
    expect(readSearchHistory()).toEqual([])

    fireEvent.click(screen.getAllByTestId('transcript-search-session')[0]!)
    expect(readSearchHistory()).toEqual(['chromium'])
  })

  it('surfaces a bad regex as translated text, never the protocol code', async () => {
    const transport = {
      request: async (message: { route: { capability: string } }) => {
        if (message.route.capability === 'fs') {
          return { ok: true, result: '/home/tester' }
        }
        return {
          ok: false,
          error: { code: 'SEARCH_BAD_PATTERN', message: 'missing ]' },
        }
      },
    } as unknown as BrowserBridgeTransport
    renderSearch(transport)
    fireEvent.click(screen.getByTestId('topbar-search'))
    typeQuery('([')
    await flush()

    const error = screen.getByTestId('transcript-search-error').textContent ?? ''
    expect(error).not.toContain('SEARCH_BAD_PATTERN')
    expect(error.length).toBeGreaterThan(0)
  })
})
