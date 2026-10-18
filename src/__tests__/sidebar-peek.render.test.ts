// @vitest-environment happy-dom
/**
 * The sidebar's peek drawer (F-9): from the hidden form opened by resting at
 * the start edge, from the rail by resting on the rail (its width held in the
 * layout); closed by Escape, a press outside, the pointer leaving, or a
 * session switch; passthrough when docked expanded.
 */
import { createElement, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SidebarPeek } from '@/browser/webview/SidebarPeek'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Harness({ hidden = true, railWidth, sessionId = 's1', initialOpen = false }: {
  hidden?: boolean
  railWidth?: number
  sessionId?: string
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return createElement(
    'div',
    null,
    createElement(
      SidebarPeek,
      { hidden, railWidth, open, onOpenChange: setOpen, activeSessionId: sessionId },
      createElement('aside', { 'data-testid': 'the-sidebar' }, 'list'),
    ),
    createElement('button', { 'data-testid': 'topbar-sidebar-toggle', onClick: () => setOpen(o => !o) }, 't'),
    createElement('main', { 'data-testid': 'outside' }, 'chat'),
  )
}

describe('SidebarPeek', () => {
  it('draws the sidebar as it is when not hidden', () => {
    render(createElement(Harness, { hidden: false }))
    expect(screen.getByTestId('the-sidebar')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
    expect(screen.queryByTestId('sidebar-peek-edge')).toBeNull()
  })

  it('opens after the pointer rests at the start edge; a pass that leaves early does not', () => {
    vi.useFakeTimers()
    render(createElement(Harness))
    expect(screen.getByTestId('the-sidebar').closest('.hidden')).toBeTruthy()
    const edge = screen.getByTestId('sidebar-peek-edge')
    fireEvent.pointerEnter(edge)
    act(() => void vi.advanceTimersByTime(50))
    fireEvent.pointerLeave(edge)
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
    fireEvent.pointerEnter(screen.getByTestId('sidebar-peek-edge'))
    act(() => void vi.advanceTimersByTime(100))
    expect(screen.getByTestId('sidebar-peek').textContent).toBe('list')
  })

  it('closes on Escape, on a press outside, and on the pointer leaving; a press inside keeps it', () => {
    render(createElement(Harness, { initialOpen: true }))
    fireEvent.pointerDown(screen.getByTestId('the-sidebar'))
    expect(screen.getByTestId('sidebar-peek')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()

    fireEvent.click(screen.getByTestId('topbar-sidebar-toggle'))
    expect(screen.getByTestId('sidebar-peek')).toBeTruthy()
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()

    fireEvent.click(screen.getByTestId('topbar-sidebar-toggle'))
    fireEvent.pointerLeave(screen.getByTestId('sidebar-peek'))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
  })

  it('the topbar toggle closes it through its own click, not as an outside press', () => {
    render(createElement(Harness, { initialOpen: true }))
    const toggle = screen.getByTestId('topbar-sidebar-toggle')
    fireEvent.pointerDown(toggle)
    expect(screen.getByTestId('sidebar-peek')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
  })

  it('keeps the sidebar mounted across peek open/close and hidden/docked crossings', () => {
    let mounts = 0
    function Counted() {
      useEffect(() => {
        mounts += 1
      }, [])
      return createElement('aside', { 'data-testid': 'counted' }, 'list')
    }
    const peek = (hidden: boolean, open: boolean) =>
      createElement(
        SidebarPeek,
        { hidden, open, onOpenChange: () => {}, activeSessionId: 's1' },
        createElement(Counted),
      )
    const view = render(peek(false, false))
    view.rerender(peek(true, false))
    view.rerender(peek(true, true))
    view.rerender(peek(true, false))
    view.rerender(peek(false, false))
    expect(mounts).toBe(1)
  })

  it('from the rail: a pointer resting on it floats the sidebar over the chat, holding the rail width', () => {
    vi.useFakeTimers()
    render(createElement(Harness, { hidden: false, railWidth: 56 }))
    const rail = screen.getByTestId('sidebar-rail-peek')
    expect(rail.className).toBe('contents')
    expect(screen.queryByTestId('sidebar-peek-edge')).toBeNull()
    fireEvent.pointerEnter(screen.getByTestId('the-sidebar'))
    act(() => void vi.advanceTimersByTime(250))
    fireEvent.pointerLeave(screen.getByTestId('the-sidebar'))
    act(() => void vi.advanceTimersByTime(500))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()

    fireEvent.pointerEnter(screen.getByTestId('the-sidebar'))
    act(() => void vi.advanceTimersByTime(299))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
    act(() => void vi.advanceTimersByTime(1))
    const peek = screen.getByTestId('sidebar-peek')
    expect(peek.getAttribute('data-peek-from')).toBe('rail')
    expect(peek.className).toContain('absolute')
    expect(screen.getByTestId('sidebar-rail-spacer').style.width).toBe('56px')

    fireEvent.pointerDown(screen.getByTestId('the-sidebar'))
    expect(screen.getByTestId('sidebar-peek')).toBeTruthy()
    fireEvent.pointerLeave(peek)
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
    expect(screen.queryByTestId('sidebar-rail-spacer')).toBeNull()
    expect(screen.getByTestId('sidebar-rail-peek').className).toBe('contents')
  })

  it('a pointer move outside closes it even without a leave event; a move inside keeps it', () => {
    render(createElement(Harness, { hidden: false, railWidth: 56, initialOpen: true }))
    fireEvent.pointerMove(screen.getByTestId('the-sidebar'))
    expect(screen.getByTestId('sidebar-peek')).toBeTruthy()
    fireEvent.pointerMove(screen.getByTestId('outside'))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
  })

  it('from the rail: Escape and a press outside close it', () => {
    render(createElement(Harness, { hidden: false, railWidth: 56, initialOpen: true }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
    cleanup()
    render(createElement(Harness, { hidden: false, railWidth: 56, initialOpen: true }))
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
  })

  it('keeps the sidebar mounted across rail peeks and rail/expanded crossings', () => {
    let mounts = 0
    function Counted() {
      useEffect(() => {
        mounts += 1
      }, [])
      return createElement('aside', null, 'list')
    }
    const peek = (railWidth: number | undefined, open: boolean) =>
      createElement(
        SidebarPeek,
        { hidden: false, railWidth, open, onOpenChange: () => {}, activeSessionId: 's1' },
        createElement(Counted),
      )
    const view = render(peek(56, false))
    view.rerender(peek(56, true))
    view.rerender(peek(56, false))
    view.rerender(peek(undefined, false))
    expect(mounts).toBe(1)
  })

  it('closes when the active session changes', () => {
    const view = render(createElement(Harness, { initialOpen: true, sessionId: 's1' }))
    expect(screen.getByTestId('sidebar-peek')).toBeTruthy()
    view.rerender(createElement(Harness, { initialOpen: true, sessionId: 's2' }))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
  })
})
