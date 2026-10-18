// @vitest-environment happy-dom
/**
 * Dragging a pane by its handle (F-9): the 6px threshold, the lifted state
 * (area flag, dimmed source, chip), the indicator over the drop zone, the
 * drop reported as a target, Escape / no zone / a tree change cancelling,
 * no drag while expanded or seated, and the arrow keys moving the pane
 * within its group with the handle's focus kept.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PaneArea, type PaneAreaProps } from '@/browser/webview/panes/PaneArea'
import { PaneFrame } from '@/browser/webview/panes/PaneFrame'
import {
  defaultPaneLayout,
  movePane,
  placePane,
  type PaneDropTarget,
  type PaneLayout,
  type SidePaneKind,
} from '@/browser/webview/layout/paneLayout'

const chatColumn = () =>
  placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })

const NAMES: Record<string, string> = { diff: 'Diff', tasks: 'Tasks', plan: 'Plan' }

function renderArea(over: Partial<PaneAreaProps> = {}) {
  const props: PaneAreaProps = {
    layout: chatColumn(),
    maximized: null,
    form: 'beside',
    chatWidth: 600,
    seatWidth: 0,
    chat: createElement('div', { 'data-testid': 'chat-body' }),
    renderPane: (kind: SidePaneKind) =>
      createElement(PaneFrame, {
        kind,
        name: NAMES[kind] ?? kind,
        title: createElement('span', null, NAMES[kind] ?? kind),
        maximized: over.maximized === kind,
        onToggleMaximized: () => {},
        onClose: () => {},
        className: 'h-full',
        children: createElement('div', { 'data-testid': `body-${kind}` }),
      }),
    onResizeCommit: vi.fn(),
    onPaneMove: vi.fn(),
    ...over,
  }
  const view = render(createElement(PaneArea, props))
  return {
    ...view,
    props,
    rerender: (next: Partial<PaneAreaProps>) => view.rerender(createElement(PaneArea, { ...props, ...next })),
  }
}

const area = () => screen.getByTestId('pane-area')
const handle = (kind: string) => screen.getByTestId(`pane-${kind}-handle`)
const slot = (kind: string) => document.querySelector<HTMLElement>(`[data-pane-slot="${kind}"]`)!
const indicator = () => document.querySelector<HTMLElement>('[data-testid="pane-drop-indicator"]')
const chip = () => document.querySelector<HTMLElement>('[data-testid="pane-drag-chip"]')
const moves = (props: PaneAreaProps) => (props.onPaneMove as ReturnType<typeof vi.fn>).mock.calls

/** A pointer press on a handle, then moves and a release on the area (where a captured pointer reports). */
function press(kind: string, x: number, y: number) {
  fireEvent.pointerDown(handle(kind), { button: 0, pointerId: 1, clientX: x, clientY: y })
}
function moveTo(x: number, y: number) {
  fireEvent.pointerMove(area(), { pointerId: 1, clientX: x, clientY: y })
}
function release(x: number, y: number) {
  fireEvent.pointerUp(area(), { pointerId: 1, clientX: x, clientY: y })
}

beforeEach(() => {
  // The area measures itself; happy-dom lays nothing out, so the area's
  // client rect is the origin and pointer positions are area px.
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
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('dragging a pane', () => {
  it('under 6px of travel nothing lifts, and the release is a click', () => {
    const { props } = renderArea()
    press('tasks', 1000, 320)
    moveTo(1003, 322)
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)
    expect(chip()).toBeNull()
    expect(slot('tasks').style.opacity).toBe('')
    release(1003, 322)
    expect(moves(props)).toEqual([])
  })

  it('past the threshold the pane lifts: the area says so, the source dims, a chip names the pane, the indicator follows the zone', () => {
    const { props } = renderArea()
    press('tasks', 1000, 320)
    moveTo(1000, 330)
    expect(area().getAttribute('data-pane-dragging')).toBe('tasks')
    expect(slot('tasks').style.opacity).toBe('0.4')
    expect(chip()?.textContent).toBe('Tasks')
    expect(chip()?.style.left).toBe('1012px')
    expect(document.body.style.cursor).toBe('grabbing')
    // Over the source's own card: no zone, the indicator hidden.
    expect(indicator()?.style.display).toBe('none')
    // Over Diff's top strip: the indicator is the top half of Diff's card.
    moveTo(1000, 50)
    const shown = indicator()!
    expect(shown.style.display).toBe('')
    expect(shown.dataset.dropType).toBe('wrap')
    expect(shown.dataset.dropAt).toBe('diff:top')
    expect([shown.style.left, shown.style.top, shown.style.width, shown.style.height]).toEqual([
      '608px',
      '8px',
      '892px',
      '144px',
    ])
    // The gutter beside the chat: the indicator is the gap widened to 24px.
    moveTo(604, 300)
    expect(indicator()?.dataset.dropType).toBe('insert')
    expect(indicator()?.dataset.dropAt).toBe('root:1')
    expect(indicator()?.style.width).toBe('24px')
    expect(moves(props)).toEqual([])
  })

  it('the drop reports the zone’s target once and restores the source', () => {
    const { props } = renderArea()
    press('tasks', 1000, 320)
    moveTo(1000, 330)
    moveTo(1000, 50)
    release(1000, 50)
    expect(moves(props)).toEqual([['tasks', { type: 'wrap', pane: 'diff', side: 'top' }]])
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)
    expect(slot('tasks').style.opacity).toBe('')
    expect(chip()).toBeNull()
    expect(indicator()).toBeNull()
    expect(document.body.style.cursor).toBe('')
  })

  it('Escape, a release over no zone, or a pointer cancel ends the drag with no move', () => {
    const { props } = renderArea()
    press('tasks', 1000, 320)
    moveTo(1000, 50)
    expect(indicator()?.dataset.dropType).toBe('wrap')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)
    expect(slot('tasks').style.opacity).toBe('')
    release(1000, 50)
    expect(moves(props)).toEqual([])

    press('tasks', 1000, 320)
    moveTo(1000, 150)
    expect(area().getAttribute('data-pane-dragging')).toBe('tasks')
    release(1000, 150)
    expect(moves(props)).toEqual([])
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)

    press('tasks', 1000, 320)
    moveTo(1000, 50)
    fireEvent.pointerCancel(area(), { pointerId: 1 })
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)
    expect(moves(props)).toEqual([])
  })

  it('the tree changing under the drag (a session switch) cancels it', () => {
    const { props, rerender } = renderArea()
    press('tasks', 1000, 320)
    moveTo(1000, 50)
    expect(area().getAttribute('data-pane-dragging')).toBe('tasks')
    rerender({ layout: placePane(chatColumn(), 'plan', { weight: 1 }) })
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)
    release(1000, 50)
    expect(moves(props)).toEqual([])
  })

  it('no drag while a pane is expanded or the region is a seat', () => {
    const expanded = renderArea({ maximized: 'diff' })
    press('diff', 1000, 20)
    moveTo(1000, 60)
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)
    expect(chip()).toBeNull()
    release(1000, 60)
    expect(moves(expanded.props)).toEqual([])
    cleanup()
    const floating = renderArea({ form: 'float', seatWidth: 500 })
    press('tasks', 1200, 320)
    moveTo(1200, 360)
    expect(area().hasAttribute('data-pane-dragging')).toBe(false)
    release(1200, 360)
    expect(moves(floating.props)).toEqual([])
  })
})

describe('moving a pane with the keyboard', () => {
  it('the arrow keys move it one place within its group, Home and End to the ends', () => {
    const { props } = renderArea()
    const tasks = handle('tasks')
    tasks.focus()
    for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Home', 'End']) {
      fireEvent.keyDown(tasks, { key })
    }
    expect(moves(props).map(call => call[1])).toEqual<PaneDropTarget[]>([
      { type: 'insert', groupId: 'g1', index: 0 },
      { type: 'insert', groupId: 'g1', index: 0 },
      { type: 'insert', groupId: 'g1', index: 2 },
      { type: 'insert', groupId: 'g1', index: 2 },
      { type: 'insert', groupId: 'g1', index: 0 },
      { type: 'insert', groupId: 'g1', index: 2 },
    ])
    expect(moves(props).every(call => call[0] === 'tasks')).toBe(true)
    // With a modifier the key is someone else's; expanded, the keys do nothing.
    fireEvent.keyDown(tasks, { key: 'ArrowUp', ctrlKey: true })
    fireEvent.keyDown(tasks, { key: 'Enter' })
    expect(moves(props)).toHaveLength(6)
  })

  it('the move re-renders the panes in their new order and the handle keeps focus', () => {
    let layout: PaneLayout = chatColumn()
    const { rerender } = renderArea({
      onPaneMove: (kind, target) => {
        layout = movePane(layout, kind, target)
        rerender({ layout })
      },
    })
    const tasks = handle('tasks')
    tasks.focus()
    expect(area().getAttribute('data-panes')).toBe('diff tasks')
    fireEvent.keyDown(tasks, { key: 'ArrowUp' })
    expect(area().getAttribute('data-panes')).toBe('tasks diff')
    expect(slot('tasks').style.top).toBe('8px')
    expect(slot('diff').style.top).toBe('304px')
    expect(document.activeElement).toBe(handle('tasks'))
    fireEvent.keyDown(handle('tasks'), { key: 'End' })
    expect(area().getAttribute('data-panes')).toBe('diff tasks')
  })

  it('expanded, the keys move nothing', () => {
    const { props } = renderArea({ maximized: 'diff' })
    const diff = handle('diff')
    diff.focus()
    fireEvent.keyDown(diff, { key: 'ArrowUp' })
    expect(moves(props)).toEqual([])
  })
})
