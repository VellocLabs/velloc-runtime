// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  TurnDiffHistoryView,
  formatTurnStart,
} from '../components/assistant-ui/TurnDiffSummary'
import { I18nProvider } from '../browser/webview/i18n'
import { SESSION_TOTAL_TURN_INDEX } from '../utils/turnDiffs'
import type { TurnDiffMeta, TurnFileChange } from '../utils/turnDiffs'

// The Diff view body (`TurnDiffHistoryView`) is a master/detail split — a
// turns/files list on top, the selected file's diff on the bottom (lazily
// fetched).

afterEach(() => cleanup())

const HISTORY: TurnDiffMeta[] = [
  {
    turnIndex: 2,
    promptPreview: 'do the thing',
    stats: { touchedFiles: 1, plusLines: 78, minusLines: 16 },
    files: [
      { filePath: 'C:/shift/wexond_component_update_service.cc', fileWasCreated: false, plusLines: 78, minusLines: 16 },
    ],
  },
]

const DETAIL: TurnFileChange[] = [
  {
    filePath: 'C:/shift/wexond_component_update_service.cc',
    fileWasCreated: false,
    plusLines: 78,
    minusLines: 16,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }],
  },
]

describe('TurnDiffHistoryView — master/detail split', () => {
  it('lists turns + files up top with an empty detail pane, fetching nothing yet', () => {
    const loadDetail = vi.fn(async () => DETAIL)
    render(createElement(TurnDiffHistoryView, { history: HISTORY, loadDetail }))
    expect(screen.getByTestId('turn-diff-history')).toBeTruthy()
    // The row leads with the turn's START time (turnIndex renumbers across
    // compaction and misleads) — pinned in the multi-turn test below. HISTORY
    // carries no timestamps, so here the rows show the keyed "Turn N" fallback.
    expect(screen.getByText('Turn 2')).toBeTruthy()
    // File row present (latest turn open by default), but no diff selected yet.
    expect(screen.getByTestId('turn-diff-file')).toBeTruthy()
    expect(screen.getByText(/Select a changed file/)).toBeTruthy()
    expect(loadDetail).not.toHaveBeenCalled()
    expect(document.querySelector('.aui-edit-diff-body')).toBeNull()
    // The removed "Changes this turn" header must NOT be inside the panel body.
    expect(screen.queryByText('Changes this turn')).toBeNull()
  })

  it('shows a file\'s diff in the detail pane when its row is clicked (lazy fetch)', async () => {
    const loadDetail = vi.fn(async () => DETAIL)
    render(createElement(TurnDiffHistoryView, { history: HISTORY, loadDetail }))
    fireEvent.click(screen.getByTestId('turn-diff-file-diff'))
    await waitFor(() =>
      expect(document.querySelector('[data-testid="turn-diff-detail"] .aui-edit-diff-body')).not.toBeNull(),
    )
    expect(loadDetail).toHaveBeenCalledWith(2)
  })

  it('splits the file row: the path opens the file, the counts pill opens the diff', async () => {
    const loadDetail = vi.fn(async () => DETAIL)
    const onOpenFile = vi.fn()
    render(
      createElement(TurnDiffHistoryView, { history: HISTORY, loadDetail, onOpenFile }),
    )
    // The path button opens the file directly — no diff selection/fetch.
    fireEvent.click(screen.getByTestId('turn-diff-file-path'))
    expect(onOpenFile).toHaveBeenCalledWith({
      path: 'C:/shift/wexond_component_update_service.cc',
    })
    expect(loadDetail).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="turn-diff-detail"] .aui-edit-diff-body')).toBeNull()

    // The counts pill opens the diff in the detail pane (and does NOT re-open the file).
    onOpenFile.mockClear()
    fireEvent.click(screen.getByTestId('turn-diff-file-diff'))
    await waitFor(() =>
      expect(document.querySelector('[data-testid="turn-diff-detail"] .aui-edit-diff-body')).not.toBeNull(),
    )
    expect(loadDetail).toHaveBeenCalledWith(2)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('opens the file in the Files view when the detail header path is clicked', async () => {
    const loadDetail = vi.fn(async () => DETAIL)
    const onOpenFile = vi.fn()
    render(
      createElement(TurnDiffHistoryView, { history: HISTORY, loadDetail, onOpenFile }),
    )
    // No detail header (shared FilePathHeader) until a file is selected.
    expect(
      document.querySelector('[data-testid="turn-diff-detail"] [data-slot="file-path-open"]'),
    ).toBeNull()
    fireEvent.click(screen.getByTestId('turn-diff-file-diff'))
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="turn-diff-detail"] [data-slot="file-path-open"]'),
      ).not.toBeNull(),
    )
    fireEvent.click(
      document.querySelector(
        '[data-testid="turn-diff-detail"] [data-slot="file-path-open"]',
      ) as HTMLElement,
    )
    expect(onOpenFile).toHaveBeenCalledWith({
      path: 'C:/shift/wexond_component_update_service.cc',
    })
  })

  it('renders one row per turn and NO synthetic "All changes" row', () => {
    // The combined "All changes (this session)" entry was removed: stacking
    // every turn's snapshot-relative hunks repeated intermediate states, which
    // read as duplicate +/− changes. The panel lists per-turn rows only.
    const multiTurnHistory: TurnDiffMeta[] = [
      {
        turnIndex: 2,
        promptPreview: 'second',
        timestamp: '2026-09-02T14:30:00.000Z',
        stats: { touchedFiles: 1, plusLines: 2, minusLines: 0 },
        files: [{ filePath: '/b.ts', fileWasCreated: true, plusLines: 2, minusLines: 0 }],
      },
      {
        turnIndex: 1,
        promptPreview: 'first',
        timestamp: '2026-09-02T09:15:00.000Z',
        stats: { touchedFiles: 1, plusLines: 3, minusLines: 1 },
        files: [{ filePath: '/a.ts', fileWasCreated: false, plusLines: 3, minusLines: 1 }],
      },
    ]
    const loadDetail = vi.fn(async () => null)
    render(createElement(TurnDiffHistoryView, { history: multiTurnHistory, loadDetail }))
    // Rows are labeled by START time (locale-formatted), not "Turn N". These
    // turns are from an earlier day, so the label carries the date too.
    const expected = (ts: string) =>
      new Date(ts).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    expect(screen.getByText(expected('2026-09-02T14:30:00.000Z'))).toBeTruthy()
    expect(screen.getByText(expected('2026-09-02T09:15:00.000Z'))).toBeTruthy()
    expect(screen.queryByText(/\bTurn \d+/)).toBeNull()
    expect(screen.queryByText('All changes')).toBeNull()
    expect(screen.queryByTestId('turn-diff-combined')).toBeNull()
    expect(document.querySelectorAll('.aui-turn-diff-turn')).toHaveLength(2)
  })

  it('labels a same-day turn by time alone and an earlier-day turn with its date', () => {
    // Time-of-day alone is ambiguous once a session spans days: two turns a
    // day apart read as the same "10:03:12".
    const now = new Date(2026, 8, 3, 15, 0, 0).getTime()
    const today = new Date(2026, 8, 3, 10, 3, 12)
    const yesterday = new Date(2026, 8, 2, 10, 3, 12)
    const todayLabel = formatTurnStart(today.toISOString(), now)
    const yesterdayLabel = formatTurnStart(yesterday.toISOString(), now)
    expect(todayLabel).toBe(
      today.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    )
    expect(yesterdayLabel).not.toBe(todayLabel)
    expect(yesterdayLabel).toContain(
      yesterday.toLocaleString(undefined, { day: 'numeric' }),
    )
  })

  it('falls back to the keyed "Turn N" label when a turn has no parseable timestamp', () => {
    // A row must never have a blank title: no timestamp (legacy history) and an
    // unparseable one both fall back to the ordinal, never "Invalid Date".
    const history: TurnDiffMeta[] = [
      {
        turnIndex: 7,
        promptPreview: 'no clock',
        stats: { touchedFiles: 1, plusLines: 1, minusLines: 0 },
        files: [{ filePath: '/a.ts', fileWasCreated: false, plusLines: 1, minusLines: 0 }],
      },
      {
        turnIndex: 6,
        promptPreview: 'bad clock',
        timestamp: 'not-a-date',
        stats: { touchedFiles: 1, plusLines: 1, minusLines: 0 },
        files: [{ filePath: '/b.ts', fileWasCreated: false, plusLines: 1, minusLines: 0 }],
      },
    ]
    render(createElement(TurnDiffHistoryView, { history, loadDetail: vi.fn(async () => null) }))
    expect(screen.getByText('Turn 7')).toBeTruthy()
    expect(screen.getByText('Turn 6')).toBeTruthy()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
  })

  it('swaps the detail pane to the newly clicked file', async () => {
    const twoFileHistory: TurnDiffMeta[] = [
      {
        turnIndex: 5,
        promptPreview: 'edit two files',
        stats: { touchedFiles: 2, plusLines: 3, minusLines: 0 },
        files: [
          { filePath: '/a.ts', fileWasCreated: false, plusLines: 1, minusLines: 0 },
          { filePath: '/b.ts', fileWasCreated: true, plusLines: 2, minusLines: 0 },
        ],
      },
    ]
    const loadDetail = vi.fn(async () => [
      { filePath: '/a.ts', fileWasCreated: false, plusLines: 1, minusLines: 0, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' x', '+AAA'] }] },
      { filePath: '/b.ts', fileWasCreated: true, plusLines: 2, minusLines: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+BBB', '+CCC'] }] },
    ])
    render(createElement(TurnDiffHistoryView, { history: twoFileHistory, loadDetail }))
    // Each file's diff opens from its own counts pill (DOM order: a.ts, b.ts).
    const diffButtons = screen.getAllByTestId('turn-diff-file-diff')
    fireEvent.click(diffButtons[0]!)
    await waitFor(() => expect(screen.getByText('AAA')).toBeTruthy())
    fireEvent.click(diffButtons[1]!)
    await waitFor(() => expect(screen.getByText('BBB')).toBeTruthy())
    // The previous file's hunk is gone — the detail pane swapped, not appended.
    expect(screen.queryByText('AAA')).toBeNull()
  })

  it('labels the turnIndex-0 row "Whole session" and warns on a file changed outside the session', () => {
    // The worker prepends this synthetic total row (snapshot-anchored,
    // continuity-checked). Its label is "Whole session", not a turn time, and a
    // file whose chain broke carries the external-change warning.
    const history: TurnDiffMeta[] = [
      {
        turnIndex: SESSION_TOTAL_TURN_INDEX,
        promptPreview: '',
        stats: { touchedFiles: 1, plusLines: 2, minusLines: 1 },
        files: [
          {
            filePath: '/a.ts',
            fileWasCreated: false,
            plusLines: 2,
            minusLines: 1,
            externalChange: { afterTurn: 1, beforeTurn: 3 },
          },
        ],
      },
      {
        turnIndex: 1,
        promptPreview: 'first',
        stats: { touchedFiles: 1, plusLines: 1, minusLines: 0 },
        files: [{ filePath: '/a.ts', fileWasCreated: false, plusLines: 1, minusLines: 0 }],
      },
    ]
    render(
      createElement(TurnDiffHistoryView, {
        history,
        loadDetail: vi.fn(async () => null),
      }),
    )
    expect(screen.getByText('Whole session')).toBeTruthy()
    expect(screen.queryByText('Turn 0')).toBeNull()
    // Row default-open (idx 0) → the flagged file's warning is visible.
    const warning = screen.getByTestId('turn-diff-external-warning')
    expect(warning.textContent).toMatch(/outside this session/i)
    expect(warning.textContent).toContain('turn 1')
    expect(warning.textContent).toContain('turn 3')
  })
})

describe('TurnRow file count — catalog-driven pluralization', () => {
  const twoFileHistory: TurnDiffMeta[] = [
    {
      turnIndex: 3,
      promptPreview: 'edit two files',
      stats: { touchedFiles: 2, plusLines: 3, minusLines: 0 },
      files: [
        { filePath: '/a.ts', fileWasCreated: false, plusLines: 1, minusLines: 0 },
        { filePath: '/b.ts', fileWasCreated: true, plusLines: 2, minusLines: 0 },
      ],
    },
  ]

  it('renders the singular form for one changed file', () => {
    render(createElement(TurnDiffHistoryView, { history: HISTORY }))
    expect(screen.getByText('1 file')).toBeTruthy()
    expect(screen.queryByText('1 files')).toBeNull()
  })

  it('renders the plural form for several changed files', () => {
    render(createElement(TurnDiffHistoryView, { history: twoFileHistory }))
    expect(screen.getByText('2 files')).toBeTruthy()
  })

  it('takes the count text from the locale catalog, not a hard-coded literal', () => {
    // Rendered under the German catalog the row must read "1 Datei" — this
    // fails if the count is assembled from English literals at the call site.
    render(
      createElement(
        I18nProvider,
        { locale: 'de' },
        createElement(TurnDiffHistoryView, { history: HISTORY }),
      ),
    )
    expect(screen.getByText('1 Datei')).toBeTruthy()
    expect(screen.queryByText(/1 file\b/)).toBeNull()
  })
})
