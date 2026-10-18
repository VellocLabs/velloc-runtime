// @vitest-environment happy-dom
/**
 * The pane separators in the area (F-9): one focusable `separator` per gutter
 * between siblings with its orientation and the first flank's share, moved
 * live by the pointer and the arrow keys, committed once when the run ends;
 * none while a pane is expanded or the region is a seat.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PaneArea, type PaneAreaProps } from '@/browser/webview/panes/PaneArea'
import { defaultPaneLayout, placePane, type PaneLayout } from '@/browser/webview/layout/paneLayout'

const chatColumn = () =>
  placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })

function renderArea(over: Partial<PaneAreaProps> = {}) {
  const props: PaneAreaProps = {
    layout: chatColumn(),
    maximized: null,
    form: 'beside',
    chatWidth: 600,
    seatWidth: 0,
    chat: createElement('div', { 'data-testid': 'chat-body' }),
    renderPane: kind => createElement('div', { 'data-testid': `body-${kind}` }),
    onResizeCommit: vi.fn(),
    ...over,
  }
  const view = render(createElement(PaneArea, props))
  return { ...view, props, rerender: (next: Partial<PaneAreaProps>) => view.rerender(createElement(PaneArea, { ...props, ...next })) }
}

const separator = (key: string) => document.querySelector<HTMLElement>(`[data-separator="${key}"]`)!
const styleOf = (testId: string) => screen.getByTestId(testId).style

beforeEach(() => {
  // The area measures itself; happy-dom lays nothing out.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1508)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PaneArea separators', () => {
  it('one per gutter: role, orientation, label, the first flank as a percentage, focusable', () => {
    renderArea()
    const all = screen.getAllByRole('separator')
    expect(all.map(el => el.getAttribute('data-separator'))).toEqual(['root:0', 'g1:0'])
    const chatDiff = separator('root:0')
    expect(chatDiff.getAttribute('aria-orientation')).toBe('vertical')
    expect(chatDiff.getAttribute('aria-label')).toBe('Resize panes')
    expect(chatDiff.getAttribute('aria-valuenow')).toBe(String(Math.round((100 * 600) / 1492)))
    expect(chatDiff.tabIndex).toBe(0)
    // The 8px gutter, widened to the 12px hit area.
    expect(chatDiff.style.left).toBe('598px')
    expect(chatDiff.style.width).toBe('12px')
    const column = separator('g1:0')
    expect(column.getAttribute('aria-orientation')).toBe('horizontal')
    expect(column.getAttribute('aria-valuenow')).toBe('50')
    expect(column.style.top).toBe('294px')
    expect(column.style.height).toBe('12px')
  })

  it('arrow keys move the panes 16px live and commit on release', () => {
    const { props, rerender } = renderArea()
    const chatDiff = separator('root:0')
    chatDiff.focus()
    fireEvent.keyDown(chatDiff, { key: 'ArrowRight' })
    // Painted through the elements, nothing committed yet.
    expect(styleOf('pane-chat').width).toBe('616px')
    expect(styleOf('side-region').left).toBe('624px')
    expect(chatDiff.style.left).toBe('614px')
    expect(props.onResizeCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(chatDiff, { key: 'ArrowRight' })
    expect(styleOf('pane-chat').width).toBe('632px')
    fireEvent.keyUp(chatDiff, { key: 'ArrowRight' })
    expect(props.onResizeCommit).toHaveBeenCalledTimes(1)
    const committed = (props.onResizeCommit as ReturnType<typeof vi.fn>).mock.calls[0][0] as PaneLayout
    const [chat, column] = committed.root.children
    expect(chat.weight).toBeCloseTo((5 * 632) / 1500, 6)
    expect(column.weight).toBeCloseTo(5 - (5 * 632) / 1500, 6)
    // The commit re-renders with the new layout and the cascade's chat width; the value follows.
    rerender({ layout: committed, chatWidth: 632 })
    expect(separator('root:0').getAttribute('aria-valuenow')).toBe(String(Math.round((100 * 632) / 1492)))
    expect(document.activeElement).toBe(separator('root:0'))
  })

  it('a pointer drag paints each move and commits once on release', () => {
    const { props } = renderArea()
    const column = separator('g1:0')
    fireEvent.pointerDown(column, { button: 0, pointerId: 1, clientX: 1000, clientY: 300 })
    fireEvent.pointerMove(column, { pointerId: 1, clientX: 1000, clientY: 350 })
    fireEvent.pointerMove(column, { pointerId: 1, clientX: 1000, clientY: 400 })
    const diffSlot = document.querySelector<HTMLElement>('[data-pane-slot="diff"]')!
    const tasksSlot = document.querySelector<HTMLElement>('[data-pane-slot="tasks"]')!
    expect(diffSlot.style.height).toBe('388px')
    expect(tasksSlot.style.top).toBe('404px')
    expect(column.style.top).toBe('394px')
    expect(props.onResizeCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(column, { pointerId: 1, clientX: 1000, clientY: 400 })
    expect(props.onResizeCommit).toHaveBeenCalledTimes(1)
    const committed = (props.onResizeCommit as ReturnType<typeof vi.fn>).mock.calls[0][0] as PaneLayout
    const group = committed.root.children[1]
    const weights = 'children' in group ? group.children.map(c => c.weight) : []
    expect(weights[0]).toBeCloseTo((2 * 388) / 576, 9)
    expect(weights[1]).toBeCloseTo((2 * 188) / 576, 9)
    expect(committed.root.children[0]).toBe(props.layout.root.children[0])
  })

  it('a run that moves nothing commits nothing and leaves the rects', () => {
    const { props } = renderArea()
    const chatDiff = separator('root:0')
    fireEvent.pointerDown(chatDiff, { button: 0, pointerId: 1, clientX: 604, clientY: 300 })
    fireEvent.pointerMove(chatDiff, { pointerId: 1, clientX: 100, clientY: 300 })
    expect(styleOf('pane-chat').width).toBe('100px')
    // The slot at its 100 keeps the content at 360, its end under a cover.
    expect(styleOf('pane-chat-content').width).toBe('360px')
    const [cover] = screen.getAllByTestId('pane-chat-cover')
    expect([cover.style.display, cover.style.left, cover.style.width]).toEqual(['', '100px', '260px'])
    fireEvent.pointerMove(chatDiff, { pointerId: 1, clientX: 604, clientY: 300 })
    fireEvent.pointerUp(chatDiff, { pointerId: 1, clientX: 604, clientY: 300 })
    expect(props.onResizeCommit).not.toHaveBeenCalled()
    expect(styleOf('pane-chat').width).toBe('600px')
  })

  it('no separator while a pane is expanded or the region is a seat', () => {
    const { rerender } = renderArea({ maximized: 'diff' })
    expect(screen.queryAllByRole('separator')).toEqual([])
    rerender({ maximized: null, form: 'float', seatWidth: 500 })
    expect(screen.queryAllByRole('separator')).toEqual([])
    rerender({ maximized: null, form: 'beside' })
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })
})
