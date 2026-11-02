// @vitest-environment happy-dom
import { createElement, createRef, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  ChapterMarkBadge,
  ChapterMarksProvider,
  ChapterRail,
  type ChapterMarksValue,
  type ChapterStatus,
} from '../components/assistant-ui/chapter-marks'
import type { ChapterMark } from '../sessions/chapterMarks'

/**
 * The chapter rail and the marked-row badge (F-37): hidden without marks; one line per entry, the
 * session start first; hover or focus opens the titled list and leaving closes it; the line of the
 * chapter being read is marked current as the viewport scrolls; a ready entry jumps; an unreachable one
 * says why and only removes; keyboard use never deletes by accident.
 */

afterEach(() => cleanup())

const marks: ChapterMark[] = [
  { id: 'c1', entryKey: 'u1', title: 'First question', createdAt: 1 },
  { id: 'c2', entryKey: 'a1', segmentKey: 'a2', title: null, createdAt: 2 },
  { id: 'c3', entryKey: 'gone', title: 'Gone step', createdAt: 3 },
]
const rowOf: Record<string, number> = { c1: 2, c2: 5 }

let view: ReturnType<typeof render> | null = null
let viewport: HTMLDivElement

/** A viewport with rows 0..9, 100px each, scrolled to `scrollTop`; happy-dom has no layout. */
function makeViewport(scrollTop = 0): HTMLDivElement {
  const el = document.createElement('div')
  for (let index = 0; index < 10; index++) {
    const row = document.createElement('div')
    row.setAttribute('data-message-index', String(index))
    row.getBoundingClientRect = () => {
      const top = index * 100 - el.scrollTop
      return { top, bottom: top + 100, height: 100, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() {} } as DOMRect
    }
    el.appendChild(row)
  }
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 400, height: 400, left: 0, right: 600, width: 600, x: 0, y: 0, toJSON() {} }) as DOMRect
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
  el.scrollTop = scrollTop
  document.body.appendChild(el)
  return el
}

function valueWith(over: Partial<ChapterMarksValue> = {}): ChapterMarksValue {
  const status: Record<string, ChapterStatus> = { c1: 'ready', c2: 'ready', c3: 'unavailable' }
  return {
    marks,
    mark: vi.fn(async () => {}),
    unmark: vi.fn(async () => {}),
    targetFor: () => null,
    entryKeyOf: rowId => (rowId === 'turn:u0:assistant' ? 'a1' : rowId),
    statusOf: mark => status[mark.id] ?? 'loading',
    indexOf: mark => rowOf[mark.id] ?? null,
    reveal: vi.fn(async () => true),
    revealStart: vi.fn(async () => true),
    ...over,
  }
}

function rail(isForeground = true): ReactElement {
  const ref = createRef<HTMLElement>() as { current: HTMLElement | null }
  ref.current = viewport
  return createElement(ChapterRail, { viewportRef: ref, isForeground })
}

function mount(over: Partial<ChapterMarksValue> = {}, children?: ReactElement, scrollTop = 0) {
  viewport = makeViewport(scrollTop)
  const value = valueWith(over)
  view = render(createElement(ChapterMarksProvider, { value }, children ?? rail()))
  return value
}

function rerender(value: ChapterMarksValue, children?: ReactElement) {
  view!.rerender(createElement(ChapterMarksProvider, { value }, children ?? rail()))
}

const openRail = () => fireEvent.mouseEnter(screen.getByTestId('chapter-rail'))

describe('ChapterRail', () => {
  it('is hidden while the session has no marks', () => {
    mount({ marks: [] })
    expect(screen.queryByTestId('chapter-rail')).toBeNull()
  })

  it('draws one line per entry, the session start first, and opens on hover', () => {
    mount()
    const lines = screen.getByTestId('chapter-rail').querySelectorAll('[data-rail-line]')
    expect(Array.from(lines, l => l.getAttribute('data-rail-line'))).toEqual(['session-start', 'c1', 'c2', 'c3'])
    expect(screen.getByTestId('chapter-rail-lines').getAttribute('aria-label')).toBe('Chapters (3)')
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()

    openRail()
    const items = screen.getByTestId('chapter-marks-list').querySelectorAll('li')
    expect(Array.from(items, li => li.querySelector('[data-chapter-jump]')?.textContent)).toEqual([
      'Session start',
      'First question',
      'Untitled chapter',
      'Gone stepNo longer in this conversation',
    ])
    fireEvent.mouseLeave(screen.getByTestId('chapter-rail'))
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
  })

  it('marks the chapter being read current, and follows the scroll', async () => {
    mount()
    const rail = screen.getByTestId('chapter-rail')
    expect(rail.getAttribute('data-active-chapter')).toBe('session-start')
    viewport.scrollTop = 250
    await act(async () => {
      viewport.dispatchEvent(new Event('scroll'))
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    })
    await waitFor(() => expect(rail.getAttribute('data-active-chapter')).toBe('c1'))
    expect(rail.querySelector('[data-rail-line="c1"] [data-current]')).toBeTruthy()
    openRail()
    expect(screen.getByTestId('chapter-jump-c1').getAttribute('aria-current')).toBe('location')
  })

  it('a ready entry jumps and the list stays as it is; the start jumps to the beginning', async () => {
    const value = mount()
    openRail()
    fireEvent.click(screen.getByTestId('chapter-jump-c2'))
    expect(value.reveal).toHaveBeenCalledWith(marks[1])
    fireEvent.click(screen.getByTestId('chapter-jump-start'))
    expect(value.revealStart).toHaveBeenCalled()
  })

  it('resolves no status while the list is closed', () => {
    const statusOf = vi.fn((): ChapterStatus => 'ready')
    mount({ statusOf })
    expect(statusOf).not.toHaveBeenCalled()
    openRail()
    expect(statusOf).toHaveBeenCalled()
  })

  it('says so when a jump does not land', async () => {
    mount({ reveal: vi.fn(async () => false) })
    openRail()
    fireEvent.click(screen.getByTestId('chapter-jump-c1'))
    expect(await screen.findByText('Couldn\'t reach this chapter')).toBeTruthy()
  })

  it('an unreachable mark cannot be jumped to, only removed', () => {
    const value = mount()
    openRail()
    const jump = screen.getByTestId('chapter-jump-c3')
    expect(jump.getAttribute('aria-disabled')).toBe('true')
    expect(jump.closest('li')?.getAttribute('data-chapter-status')).toBe('unavailable')
    fireEvent.click(jump)
    expect(value.reveal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('chapter-remove-c3'))
    expect(value.unmark).toHaveBeenCalledWith('c3')
  })

  it('opens on focus; ArrowDown from the lines enters the list on an entry, never a remove button', () => {
    const status: Record<string, ChapterStatus> = { c1: 'loading', c2: 'ready', c3: 'unavailable' }
    mount({ statusOf: mark => status[mark.id]! })
    const lines = screen.getByTestId('chapter-rail-lines')
    lines.focus()
    fireEvent.focus(lines)
    expect(screen.getByTestId('chapter-marks-list')).toBeTruthy()
    fireEvent.keyDown(lines, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-start'))
  })

  it('arrow keys reach every entry, an unavailable one included', () => {
    mount()
    openRail()
    const list = screen.getByTestId('chapter-marks-list').querySelector('ul')!
    screen.getByTestId('chapter-jump-c2').focus()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-c3'))
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-start'))
  })

  it('Delete removes the entry once, moves focus to a neighbour, and a refused remove is not an error', async () => {
    const unmark = vi.fn(async () => {
      throw new Error('not_found')
    })
    mount({ unmark })
    openRail()
    const jump = screen.getByTestId('chapter-jump-c1')
    jump.focus()
    fireEvent.keyDown(jump, { key: 'Delete' })
    fireEvent.keyDown(jump, { key: 'Delete', repeat: true })
    expect(unmark).toHaveBeenCalledTimes(1)
    expect(unmark).toHaveBeenCalledWith('c1')
    expect(document.activeElement).toBe(screen.getByTestId('chapter-jump-c2'))
    fireEvent.click(screen.getByTestId('chapter-remove-c2'))
    expect(unmark).toHaveBeenCalledTimes(2)
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('removing the last mark removes the rail, so the next mark does not open the list', () => {
    const value = mount()
    openRail()
    rerender({ ...value, marks: [] })
    expect(screen.queryByTestId('chapter-rail')).toBeNull()
    rerender({ ...value, marks: [marks[0]!] })
    expect(screen.getByTestId('chapter-rail')).toBeTruthy()
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
  })

  it('closes and hides while its thread is hidden', () => {
    const value = mount()
    openRail()
    rerender(value, rail(false))
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
    expect(screen.getByTestId('chapter-rail').hidden).toBe(true)
    rerender(value, rail(true))
    expect(screen.queryByTestId('chapter-marks-list')).toBeNull()
  })

  it('without the right to change marks there is no remove', () => {
    mount({ mark: undefined, unmark: undefined })
    openRail()
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
