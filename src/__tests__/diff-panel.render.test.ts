// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DiffPanel } from '../browser/webview/DiffPanel'
import type { TurnDiffMeta, TurnFileChange } from '../utils/turnDiffs'

// The right-panel Diff view's entry is the "Changes this turn" history from the
// LIVE per-session props (kind:'turnHistory', also the default): a turns/files
// list. A file row swaps the whole view for that file's diff (lazily fetched),
// whose header leads back to the list. A kind:'file' target — one Edit's diff
// (pre-computed hunks + counts, from the card) — opens as that detail directly.

afterEach(() => cleanup())

const HUNKS = [
  { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+added-line'] },
]

const HISTORY: TurnDiffMeta[] = [
  {
    turnIndex: 1,
    promptPreview: 'do the thing',
    timestamp: '2026-09-02T10:00:00.000Z',
    stats: { touchedFiles: 1, plusLines: 1, minusLines: 0 },
    files: [{ filePath: '/repo/x.ts', fileWasCreated: false, plusLines: 1, minusLines: 0 }],
  },
]

describe('DiffPanel', () => {
  // A NULL target is how the always-open Diff TAB mounts (only the composer
  // chip and the Edit-card title supply one), so it must mean "the session's
  // turn history", not a "no diff open" dead end.
  it('defaults to the turn-diff history when no target is set', () => {
    render(
      createElement(DiffPanel, {
        target: null,
        turnDiffHistory: HISTORY,
        loadTurnDiffDetail: async () => null,
      }),
    )
    expect(screen.getByTestId('diff-panel').getAttribute('data-diff-kind')).toBe(
      'turn-history',
    )
    expect(screen.getByTestId('turn-diff-file')).toBeTruthy()
    expect(screen.queryByText(/No diff open/)).toBeNull()
  })

  it('shows the history empty state when there is no target AND no history', () => {
    render(createElement(DiffPanel, { target: null }))
    expect(screen.getByText(/No changes yet/)).toBeTruthy()
    expect(screen.queryByText(/No diff open/)).toBeNull()
  })

  it('asks for the history while showing it without one, and not for a file target or once it is there', () => {
    const requestTurnDiffHistory = vi.fn()
    const { rerender } = render(createElement(DiffPanel, { target: null, requestTurnDiffHistory }))
    expect(requestTurnDiffHistory).toHaveBeenCalledTimes(1)
    rerender(createElement(DiffPanel, { target: null, turnDiffHistory: [], requestTurnDiffHistory }))
    expect(requestTurnDiffHistory).toHaveBeenCalledTimes(1)
    cleanup()
    const forFile = vi.fn()
    render(
      createElement(DiffPanel, {
        target: { kind: 'file', filePath: '/w/a.ts', hunks: [], plusLines: 0, minusLines: 0 },
        requestTurnDiffHistory: forFile,
      }),
    )
    expect(forFile).not.toHaveBeenCalled()
  })

  it('renders a file diff target with its hunks and +/- counts', () => {
    render(
      createElement(DiffPanel, {
        target: {
          kind: 'file',
          filePath: '/repo/a.ts',
          plusLines: 1,
          minusLines: 0,
          hunks: HUNKS,
        },
      }),
    )
    expect(screen.getByTestId('diff-panel')).toBeTruthy()
    expect(screen.getByText('added-line')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()
  })

  it('renders the turn-diff history list for a turnHistory target, with no detail open', () => {
    render(
      createElement(DiffPanel, {
        target: { kind: 'turnHistory' },
        turnDiffHistory: HISTORY,
        loadTurnDiffDetail: async () => null,
      }),
    )
    expect(screen.getByTestId('diff-panel')).toBeTruthy()
    // Top list has the turn + file; bottom detail waits for a selection.
    // The row leads with the turn's START time (locale-formatted), not "Turn N".
    // A turn from an earlier day than today carries its date as well as its time.
    expect(screen.getByText(new Date('2026-09-02T10:00:00.000Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))).toBeTruthy()
    expect(screen.queryByText(/\bTurn \d+/)).toBeNull()
    expect(screen.getByTestId('turn-diff-file')).toBeTruthy()
    expect(screen.getByTestId('turn-diff-history').getAttribute('data-view')).toBe('list')
    expect(screen.queryByTestId('turn-diff-detail')).toBeNull()
  })

  it('fetches + shows a file\'s diff as the whole view only when its row is clicked', async () => {
    const detail: TurnFileChange[] = [
      { filePath: '/repo/x.ts', fileWasCreated: false, plusLines: 1, minusLines: 0, hunks: HUNKS },
    ]
    const loadTurnDiffDetail = vi.fn(async () => detail)
    render(
      createElement(DiffPanel, {
        target: { kind: 'turnHistory' },
        turnDiffHistory: HISTORY,
        loadTurnDiffDetail,
      }),
    )
    expect(loadTurnDiffDetail).not.toHaveBeenCalled()
    expect(document.querySelector('.aui-edit-diff-body')).toBeNull()
    fireEvent.click(screen.getByTestId('turn-diff-file'))
    await waitFor(() =>
      expect(document.querySelector('[data-testid="turn-diff-detail"] .aui-edit-diff-body')).not.toBeNull(),
    )
    expect(loadTurnDiffDetail).toHaveBeenCalledWith(1)
    expect(screen.getByText('added-line')).toBeTruthy()
    // The detail REPLACES the list: no file rows while a diff is open.
    expect(screen.getByTestId('turn-diff-history').getAttribute('data-view')).toBe('detail')
    expect(screen.queryByTestId('turn-diff-file')).toBeNull()
  })

  it('routes the detail header path click to onOpenFile (Files view)', async () => {
    const detail: TurnFileChange[] = [
      { filePath: '/repo/x.ts', fileWasCreated: false, plusLines: 1, minusLines: 0, hunks: HUNKS },
    ]
    const onOpenFile = vi.fn()
    render(
      createElement(DiffPanel, {
        target: { kind: 'turnHistory' },
        turnDiffHistory: HISTORY,
        loadTurnDiffDetail: async () => detail,
        onOpenFile,
      }),
    )
    fireEvent.click(screen.getByTestId('turn-diff-file'))
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
    expect(onOpenFile).toHaveBeenCalledWith({ path: '/repo/x.ts' })
  })

  it('the detail\'s back control returns to the list', async () => {
    render(
      createElement(DiffPanel, {
        target: { kind: 'turnHistory' },
        turnDiffHistory: HISTORY,
        loadTurnDiffDetail: async () => null,
      }),
    )
    fireEvent.click(screen.getByTestId('turn-diff-file'))
    await waitFor(() => expect(screen.getByTestId('turn-diff-detail-back')).toBeTruthy())
    fireEvent.click(screen.getByTestId('turn-diff-detail-back'))
    expect(screen.queryByTestId('turn-diff-detail')).toBeNull()
    expect(screen.getByTestId('turn-diff-file')).toBeTruthy()
    expect(screen.getByTestId('turn-diff-history').getAttribute('data-view')).toBe('list')
  })

  it('a file target opens as the detail, and its back control shows the history until a new target arrives', () => {
    const fileTarget = { kind: 'file' as const, filePath: '/repo/a.ts', hunks: HUNKS, plusLines: 1, minusLines: 0 }
    const { rerender } = render(
      createElement(DiffPanel, { target: fileTarget, turnDiffHistory: HISTORY, loadTurnDiffDetail: async () => null }),
    )
    expect(screen.getByTestId('diff-panel').getAttribute('data-diff-kind')).toBe('file')
    expect(screen.getByText('added-line')).toBeTruthy()
    fireEvent.click(screen.getByTestId('turn-diff-detail-back'))
    expect(screen.getByTestId('diff-panel').getAttribute('data-diff-kind')).toBe('turn-history')
    expect(screen.getByTestId('turn-diff-file')).toBeTruthy()
    // The same (dismissed) target re-rendered keeps the history…
    rerender(createElement(DiffPanel, { target: fileTarget, turnDiffHistory: HISTORY, loadTurnDiffDetail: async () => null }))
    expect(screen.getByTestId('diff-panel').getAttribute('data-diff-kind')).toBe('turn-history')
    // …a new target opens its detail again.
    rerender(createElement(DiffPanel, { target: { ...fileTarget }, turnDiffHistory: HISTORY, loadTurnDiffDetail: async () => null }))
    expect(screen.getByTestId('diff-panel').getAttribute('data-diff-kind')).toBe('file')
  })

  it('shows an empty message when a turnHistory target has no history yet', () => {
    render(
      createElement(DiffPanel, {
        target: { kind: 'turnHistory' },
        turnDiffHistory: null,
      }),
    )
    expect(screen.getByText(/No changes yet/)).toBeTruthy()
  })
})
