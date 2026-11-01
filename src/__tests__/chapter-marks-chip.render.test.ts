// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

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
 * given order; a ready entry jumps and closes the list; an unreachable one says why and only removes.
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
    reveal: vi.fn(() => true),
    ...over,
  }
  render(createElement(ChapterMarksProvider, { value }, children))
  return value
}

describe('ChapterMarksChip', () => {
  it('is hidden while the session has no marks', () => {
    mount({ marks: [] })
    expect(screen.queryByTestId('chapter-marks-chip')).toBeNull()
  })

  it('lists the marks in order; a ready one jumps and closes the list', () => {
    const value = mount()
    const chip = screen.getByTestId('chapter-marks-chip')
    expect(chip.getAttribute('aria-label')).toBe('Chapters (3)')
    fireEvent.click(chip)

    const items = screen.getByTestId('chapter-marks-list').querySelectorAll('li')
    expect(Array.from(items, li => li.querySelector('[data-chapter-jump]')?.textContent)).toEqual([
      'First question',
      'Untitled step',
      'Gone stepNo longer in this conversation',
    ])
    fireEvent.click(screen.getByTestId('chapter-jump-c2'))
    expect(value.reveal).toHaveBeenCalledWith(marks[1])
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
  })

  it('an unreachable mark cannot be jumped to, only removed', () => {
    const value = mount()
    fireEvent.click(screen.getByTestId('chapter-marks-chip'))
    const jump = screen.getByTestId('chapter-jump-c3') as HTMLButtonElement
    expect(jump.disabled).toBe(true)
    expect(jump.closest('li')?.getAttribute('data-chapter-status')).toBe('unavailable')
    fireEvent.click(screen.getByTestId('chapter-remove-c3'))
    expect(value.unmark).toHaveBeenCalledWith('c3')
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
    expect(badges[0]!.getAttribute('aria-label')).toBe('Chapter: Untitled step')
  })

  it('shows on the closing reply, which renders under a turn-derived id', () => {
    mount({}, createElement(ChapterMarkBadge, { messageId: 'turn:u0:assistant' }))
    expect(screen.getAllByTestId('chapter-mark-badge')).toHaveLength(1)
  })
})
