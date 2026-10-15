// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DiffPanel } from '../browser/webview/DiffPanel'
import type { TurnDiffMeta, TurnFileChange } from '../utils/turnDiffs'

// The right-panel Diff view renders one of two targets:
//   • kind:'file' — one Edit's diff (pre-computed hunks + counts, from the card);
//   • kind:'turnHistory' — the whole "Changes this turn" history from the LIVE
//     per-session props, as a master/detail split: a turns/files list on top
//     and the selected file's diff (lazily fetched) on the bottom.

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

  it('renders the turn-diff history master/detail split for a turnHistory target', () => {
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
    expect(screen.getByText(/Select a changed file/)).toBeTruthy()
  })

  it('fetches + shows a file\'s diff in the detail pane only when its row is clicked', async () => {
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
    fireEvent.click(screen.getByTestId('turn-diff-file-diff'))
    await waitFor(() =>
      expect(document.querySelector('[data-testid="turn-diff-detail"] .aui-edit-diff-body')).not.toBeNull(),
    )
    expect(loadTurnDiffDetail).toHaveBeenCalledWith(1)
    expect(screen.getByText('added-line')).toBeTruthy()
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
    expect(onOpenFile).toHaveBeenCalledWith({ path: '/repo/x.ts' })
  })

  it('opens the file directly from the top-list path button (no diff fetch)', () => {
    // The top file row is split: the PATH opens the file in the Files view,
    // separate from the counts pill that opens the diff. Clicking the path must
    // open the file WITHOUT selecting/fetching the diff.
    const loadTurnDiffDetail = vi.fn(async () => null)
    const onOpenFile = vi.fn()
    render(
      createElement(DiffPanel, {
        target: { kind: 'turnHistory' },
        turnDiffHistory: HISTORY,
        loadTurnDiffDetail,
        onOpenFile,
      }),
    )
    fireEvent.click(screen.getByTestId('turn-diff-file-path'))
    expect(onOpenFile).toHaveBeenCalledWith({ path: '/repo/x.ts' })
    // The path opener must not trigger a diff fetch (that's the pill's job).
    expect(loadTurnDiffDetail).not.toHaveBeenCalled()
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
