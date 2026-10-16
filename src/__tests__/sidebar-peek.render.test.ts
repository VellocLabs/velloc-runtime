// @vitest-environment happy-dom
/**
 * The sidebar's peek drawer while the session area is too narrow to dock it
 * (F-9): opened by resting at the start edge, closed by Escape, a press
 * outside, the pointer leaving, or a session switch; passthrough when docked.
 */
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SidebarPeek } from '@/browser/webview/SidebarPeek'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Harness({ hidden = true, sessionId = 's1', initialOpen = false }: {
  hidden?: boolean
  sessionId?: string
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return createElement(
    'div',
    null,
    createElement(
      SidebarPeek,
      { hidden, open, onOpenChange: setOpen, activeSessionId: sessionId },
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
    expect(screen.queryByTestId('the-sidebar')).toBeNull()
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

  it('closes when the active session changes', () => {
    const view = render(createElement(Harness, { initialOpen: true, sessionId: 's1' }))
    expect(screen.getByTestId('sidebar-peek')).toBeTruthy()
    view.rerender(createElement(Harness, { initialOpen: true, sessionId: 's2' }))
    expect(screen.queryByTestId('sidebar-peek')).toBeNull()
  })
})
