// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  ChapterMarkBadge,
  ChapterMarksChip,
  ChapterMarksProvider,
  type ChapterMarksValue,
  type ChapterStatus,
} from '../components/assistant-ui/chapter-marks'
import type { ChapterMark } from '../sessions/chapterMarks'

/**
 * The composer's Chapters chip and the marked-row badge (F-37): hidden without marks; the list in the
 * given order; a ready entry jumps and closes the list once it lands; an unreachable one says why and only
 * removes; keyboard use never deletes by accident.
 */

afterEach(() => cleanup())

const marks: ChapterMark[] = [
  { id: 'c1', entryKey: 'u1', title: 'First question', createdAt: 1 },
  { id: 'c2', entryKey: 'a1', segmentKey: 'a2', title: null, createdAt: 2 },
  { id: 'c3', entryKey: 'gone', title: 'Gone step', createdAt: 3 },
]

function mount(over: Partial<ChapterMarksValue> = {}, children: ReactElement = createElement(ChapterMarksChip)) {
  const status: Record<string, ChapterStatus> = { c1: 'ready', c2: 'ready', c3: 'unavailable' }
  const value: ChapterMarksValue = {
    marks,
    mark: vi.fn(async () => {}),
    unmark: vi.fn(async () => {}),
    targetFor: () => null,
    entryKeyOf: rowId => (rowId === 'turn:u0:assistant' ? 'a1' : rowId),
    statusOf: mark => status[mark.id] ?? 'loading',
    reveal: vi.fn(async () => true),
    ...over,
  }
  view = render(createElement(ChapterMarksProvider, { value }, children))
  return value
}

let view: ReturnType<typeof render> | null = null

/** Renders the mounted tree again with `value` (and optionally other children). */
function rerender(value: ChapterMarksValue, children: ReactElement = createElement(ChapterMarksChip)) {
  view!.rerender(createElement(ChapterMarksProvider, { value }, children))
}

describe('ChapterMarksChip', () => {
  it('is hidden while the session has no marks', () => {
    mount({ marks: [] })
    expect(screen.queryByTestId('chapter-marks-chip')).toBeNull()
  })

  it('lists the marks in order; a ready one jumps and closes the list once it lands', async () => {
    const value = mount()
    const chip = screen.getByTestId('chapter-marks-chip')
    expect(chip.getAttribute('aria-label')).toBe('Chapters (3)')
    fireEvent.click(chip)

    const items = screen.getByTestId('chapter-marks-list').querySelectorAll('li')
    expect(Array.from(items, li => li.querySelector('[data-chapter-jump]')?.textContent)).toEqual([
      'First question',
      'Untitled chapter',
      'Gone stepNo longer in this conversation',
    ])
    fireEvent.click(screen.getByTestId('chapter-jump-c2'))
    expect(value.reveal).toHaveBeenCalledWith(marks[1])
    await waitFor(() => expect(screen.queryByTestId('chapter-marks-list')).toBeNull())
  })

  it('resolves no mark while the list is closed', () => {
    const statusOf = vi.fn((): ChapterStatus => 'ready')
    mount({ statusOf })
    expect(screen.getByTestId('chapter-marks-chip')).toBeTruthy()
    expect(statusOf).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    expect(statusOf).toHaveBeenCalled()
  })

  it('stays open and says so when a jump does not land', async () => {
    mount({ reveal: vi.fn(async () => false) })
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    fireEvent.click(screen.getByTestId('chapter-jump-c1'))
    expect(await screen.findByText('Couldn\'t reach this chapter')).toBeTruthy()
    expect(screen.getByTestId('chapter-marks-list')).toBeTruthy()
  })

  it('an unreachable mark cannot be jumped to, only removed', () => {
    const value = mount()
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    const jump = screen.getByTestId('chapter-jump-c3')
    expect(jump.getAttribute('aria-disabled')).toBe('true')
    expect(jump.closest('li')?.getAttribute('data-chapter-status')).toBe('unavailable')
    fireEvent.click(jump)
    expect(value.reveal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('chapter-remove-c3'))
    expect(value.unmark).toHaveBeenCalledWith('c3')
  })

  it('opens on the first entry that can be taken, never on a remove button', () => {
    const status: Record<string, ChapterStatus> = { c1: 'loading', c2: 'ready', c3: 'unavailable' }
    mount({ statusOf: mark => status[mark.id]! })
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-c2'))
  })

  it('arrow keys reach every entry, an unavailable one included', () => {
    mount()
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    const list = screen.getByTestId('chapter-marks-list').querySelector('ul')!
    screen.getByTestId('chapter-jump-c2').focus()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-c3'))
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-c1'))
  })

  it('Delete removes the entry once, moves focus to a neighbour, and a refused remove is not an error', async () => {
    const unmark = vi.fn(async () => {
      throw new Error('not_found')
    })
    mount({ unmark })
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    const jump = screen.getByTestId('chapter-jump-c1')
    jump.focus()
    fireEvent.keyDown(jump, { key: 'Delete' })
    fireEvent.keyDown(jump, { key: 'Delete', repeat: true })
    expect(unmark).toHaveBeenCalledTimes(1)
    expect(unmark).toHaveBeenCalledWith('c1')
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-c2'))
    fireEvent.click(screen.getByTestId('chapter-remove-c2'))
    expect(unmark).toHaveBeenCalledTimes(2)
    // A rejection left unhandled would fail the run.
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('removing the last mark closes the list, so the next mark does not open it', () => {
    const value = mount()
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    rerender({ ...value, marks: [] })
    expect(screen.queryByTestId('chapter-marks-chip')).toBeNull()
    rerender({ ...value, marks: [marks[0]!] })
    expect(screen.getByTestId('chapter-marks-chip')).toBeTruthy()
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
  })

  it('closes while its thread is hidden', () => {
    const value = mount()
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    expect(screen.getByTestId('chapter-marks-list')).toBeTruthy()
    rerender(value, createElement(ChapterMarksChip, { isForeground: false }))
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
    rerender(value, createElement(ChapterMarksChip, { isForeground: true }))
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
  })

  it('Delete on an entry removes it; without the right to change marks there is no remove', () => {
    const value = mount()
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    fireEvent.keyDown(screen.getByTestId('chapter-jump-c1'), { key: 'Delete' })
    expect(value.unmark).toHaveBeenCalledWith('c1')
    cleanup()

    mount({ mark: undefined, unmark: undefined })
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    expect(screen.queryByTestId('chapter-remove-c1')).toBeNull()
  })
})

describe('ChapterMarkBadge', () => {
  it('shows on a marked message with the mark titles, and nowhere else', () => {
    mount({}, createElement('div', null, createElement(ChapterMarkBadge, { messageId: 'a1' }), createElement(ChapterMarkBadge, { messageId: 'u9' })))
    const badges = screen.getAllByTestId('chapter-mark-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]!.getAttribute('aria-label')).toBe('Chapter: Untitled chapter')
  })

  it('shows on the closing reply, which renders under a turn-derived id', () => {
    mount({}, createElement(ChapterMarkBadge, { messageId: 'turn:u0:assistant' }))
    expect(screen.getAllByTestId('chapter-mark-badge')).toHaveLength(1)
  })
})
