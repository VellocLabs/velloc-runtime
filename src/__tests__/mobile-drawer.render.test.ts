// @vitest-environment happy-dom
/**
 * The phone shell's session drawer (F-24): it closes on a backdrop tap, Escape, choosing a session
 * and a leftward swipe, not on a vertical drag; it filters by title; a long press opens a row's
 * menu without also opening the row, and moving or lifting early cancels it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../browser/webview/i18n'
import { MobileDrawer, type MobileDrawerProps } from '../mobile/MobileDrawer'
import type { MobileListSession } from '../mobile/mobileSessionGroups'
import { LONG_PRESS_DELAY_MS } from '../mobile/useLongPress'

const NOW = Date.now()
const SESSIONS: MobileListSession[] = [
  { sessionId: 'a', title: 'Fix the login page', updatedAt: NOW - 60_000 },
  { sessionId: 'b', title: 'Release notes', updatedAt: NOW - 120_000 },
]

type Callbacks = Pick<MobileDrawerProps, 'onSelectSession' | 'onSessionMenu' | 'onNewSession' | 'onDesktopView'>

function renderDrawer(overrides: Partial<MobileDrawerProps> = {}) {
  const calls = {
    onSelectSession: vi.fn(),
    onSessionMenu: vi.fn(),
    onNewSession: vi.fn(),
    onDesktopView: vi.fn(),
  } satisfies Callbacks
  const onOpenChange = vi.fn()
  function Harness() {
    const [open, setOpen] = useState(true)
    return createElement(MobileDrawer, {
      open,
      onOpenChange: (next: boolean) => {
        onOpenChange(next)
        setOpen(next)
      },
      sessions: SESSIONS,
      running: new Set(['a']),
      needsAnswer: new Set(['b']),
      activeSessionId: 'a',
      ...calls,
      ...overrides,
    })
  }
  render(createElement(I18nProvider, { locale: 'en' as const }, createElement(Harness)))
  return { ...calls, onOpenChange }
}

const rows = () => screen.queryAllByTestId('mobile-session-row').map(r => r.getAttribute('data-session-id'))
const row = (id: string) =>
  screen.getAllByTestId('mobile-session-row').find(r => r.getAttribute('data-session-id') === id)!

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('MobileDrawer', () => {
  it('lists the sessions with their state, the open one marked', () => {
    renderDrawer()
    expect(rows()).toEqual(['a', 'b'])
    expect(row('a').getAttribute('aria-current')).toBe('true')
    expect(row('a').querySelector('[data-testid="mobile-session-row-running"]')).not.toBeNull()
    expect(row('b').querySelector('[data-testid="mobile-session-row-waiting"]')?.textContent).toContain(
      'Waiting for you',
    )
  })

  it('reports a chosen session', () => {
    const calls = renderDrawer()
    fireEvent.click(row('b'))
    expect(calls.onSelectSession).toHaveBeenCalledWith('b')
  })

  it('closes on Escape', () => {
    const calls = renderDrawer()
    fireEvent.keyDown(screen.getByTestId('mobile-drawer'), { key: 'Escape' })
    expect(calls.onOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
  })

  it('closes on a tap on the backdrop', async () => {
    const calls = renderDrawer()
    // The outside-tap listener is attached a tick after the drawer opens.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const backdrop = screen.getByTestId('mobile-drawer-backdrop')
    fireEvent.pointerDown(backdrop, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(backdrop, { button: 0, pointerType: 'mouse' })
    fireEvent.click(backdrop)
    expect(calls.onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('closes on a leftward swipe, not on a vertical drag or a short nudge', () => {
    const calls = renderDrawer()
    const drawer = screen.getByTestId('mobile-drawer')
    const gesture = (dx: number, dy: number) => {
      fireEvent.pointerDown(drawer, { clientX: 200, clientY: 300, button: 0 })
      fireEvent.pointerUp(drawer, { clientX: 200 + dx, clientY: 300 + dy, button: 0 })
    }
    gesture(-30, 0)
    gesture(-80, 200)
    gesture(80, 0)
    expect(calls.onOpenChange).not.toHaveBeenCalled()
    gesture(-80, 10)
    expect(calls.onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('does not open the row a swipe ends on', () => {
    const onSelectSession = vi.fn()
    render(
      createElement(
        I18nProvider,
        { locale: 'en' as const },
        createElement(MobileDrawer, {
          open: true,
          onOpenChange: vi.fn(),
          sessions: SESSIONS,
          running: new Set<string>(),
          needsAnswer: new Set<string>(),
          activeSessionId: 'a',
          onSelectSession,
          onSessionMenu: vi.fn(),
          onNewSession: vi.fn(),
          onDesktopView: vi.fn(),
        }),
      ),
    )
    const target = row('b')
    fireEvent.pointerDown(target, { clientX: 200, clientY: 300, button: 0 })
    fireEvent.pointerUp(target, { clientX: 100, clientY: 300, button: 0 })
    fireEvent.click(target)
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it('is not closed by a drag that starts in the title filter', () => {
    const calls = renderDrawer()
    const filter = screen.getByTestId('mobile-drawer-filter')
    fireEvent.pointerDown(filter, { clientX: 220, clientY: 120, button: 0 })
    fireEvent.pointerUp(filter, { clientX: 100, clientY: 120, button: 0 })
    expect(calls.onOpenChange).not.toHaveBeenCalled()
  })

  it('clears the title filter when it closes, so reopening lists everything', () => {
    const onOpenChange = vi.fn()
    function Reopen() {
      const [open, setOpen] = useState(true)
      return createElement(
        'div',
        null,
        createElement('button', { 'data-testid': 'reopen', onClick: () => setOpen(true) }),
        createElement(MobileDrawer, {
          open,
          onOpenChange: (next: boolean) => {
            onOpenChange(next)
            setOpen(next)
          },
          sessions: SESSIONS,
          running: new Set<string>(),
          needsAnswer: new Set<string>(),
          activeSessionId: 'a',
          onSelectSession: () => setOpen(false),
          onSessionMenu: vi.fn(),
          onNewSession: vi.fn(),
          onDesktopView: vi.fn(),
        }),
      )
    }
    render(createElement(I18nProvider, { locale: 'en' as const }, createElement(Reopen)))
    fireEvent.change(screen.getByTestId('mobile-drawer-filter'), { target: { value: 'nothing like it' } })
    expect(rows()).toEqual([])
    fireEvent.keyDown(screen.getByTestId('mobile-drawer'), { key: 'Escape' })
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
    fireEvent.click(screen.getByTestId('reopen'))
    expect(rows()).toEqual(['a', 'b'])
    expect((screen.getByTestId('mobile-drawer-filter') as HTMLInputElement).value).toBe('')
    // Choosing a session closes the drawer without going through the dialog's own callback.
    fireEvent.change(screen.getByTestId('mobile-drawer-filter'), { target: { value: 'login' } })
    expect(rows()).toEqual(['a'])
    fireEvent.click(row('a'))
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
    fireEvent.click(screen.getByTestId('reopen'))
    expect(rows()).toEqual(['a', 'b'])
    expect((screen.getByTestId('mobile-drawer-filter') as HTMLInputElement).value).toBe('')
  })

  it('filters by title, and says when nothing matches', () => {
    renderDrawer()
    const filter = screen.getByTestId('mobile-drawer-filter')
    fireEvent.change(filter, { target: { value: 'LOGIN' } })
    expect(rows()).toEqual(['a'])
    fireEvent.change(filter, { target: { value: 'nothing like it' } })
    expect(rows()).toEqual([])
    expect(screen.getByTestId('mobile-drawer-empty').textContent).toBe('No session titles match')
  })

  it('says so when there are no sessions at all', () => {
    renderDrawer({ sessions: [] })
    expect(screen.getByTestId('mobile-drawer-empty').textContent).toBe('No sessions yet')
  })

  it('offers New session and the desktop view', () => {
    const calls = renderDrawer()
    fireEvent.click(screen.getByTestId('mobile-drawer-new-session'))
    fireEvent.click(screen.getByTestId('mobile-drawer-desktop-view'))
    expect(calls.onNewSession).toHaveBeenCalledTimes(1)
    expect(calls.onDesktopView).toHaveBeenCalledTimes(1)
  })
})

describe('long press on a row', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('opens the row menu after the delay, and the ending tap does not open the row', () => {
    const calls = renderDrawer()
    const target = row('b')
    fireEvent.pointerDown(target, { clientX: 50, clientY: 50, button: 0 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 1)
    })
    expect(calls.onSessionMenu).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(calls.onSessionMenu).toHaveBeenCalledWith('b')
    // A finger that stays down after the menu opened still must not tap the row on lift.
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS * 4)
    })
    fireEvent.pointerUp(target, { clientX: 50, clientY: 50, button: 0 })
    fireEvent.click(target)
    expect(calls.onSelectSession).not.toHaveBeenCalled()
  })

  it('does not spend a long press that ended without a click on a later click-only activation', () => {
    const calls = renderDrawer()
    const target = row('b')
    fireEvent.pointerDown(target, { clientX: 50, clientY: 50, button: 0 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS)
    })
    expect(calls.onSessionMenu).toHaveBeenCalledWith('b')
    // The sheet it opened takes the lift, so no click reaches the row.
    fireEvent.pointerUp(target, { clientX: 50, clientY: 50, button: 0 })
    act(() => {
      vi.runOnlyPendingTimers()
    })
    fireEvent.click(target)
    expect(calls.onSelectSession).toHaveBeenCalledWith('b')
  })

  it('is cancelled by lifting early or by moving past the tolerance (a scroll)', () => {
    const calls = renderDrawer()
    const target = row('a')
    fireEvent.pointerDown(target, { clientX: 50, clientY: 50, button: 0 })
    fireEvent.pointerUp(target, { clientX: 50, clientY: 50, button: 0 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS * 2)
    })
    fireEvent.pointerDown(target, { clientX: 50, clientY: 50, button: 0 })
    fireEvent.pointerMove(target, { clientX: 50, clientY: 70, button: 0 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS * 2)
    })
    expect(calls.onSessionMenu).not.toHaveBeenCalled()
    // A plain tap still opens the row.
    fireEvent.click(target)
    expect(calls.onSelectSession).toHaveBeenCalledWith('a')
  })
})
