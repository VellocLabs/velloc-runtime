// @vitest-environment happy-dom
/**
 * The pane frame (F-9): renders outside any TooltipProvider, carries the
 * title slot, Expand / Restore and Close, and reports presses as focus;
 * every pane, maximized, drops the header and keeps its buttons in the
 * corner — over the body, or beside the title content the pane keeps there;
 * beside the chat, its header flashes on an open signal.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PaneFrame } from '@/browser/webview/panes/PaneFrame'
import { requestPaneFlash } from '@/browser/webview/panes/paneFlash'
import { PaneHandleContext } from '@/browser/webview/panes/usePaneDrag'

afterEach(cleanup)

function renderFrame(over: Partial<Parameters<typeof PaneFrame>[0]> = {}) {
  const props = {
    kind: 'diff' as const,
    name: 'Diff',
    title: createElement('span', { 'data-testid': 'title-slot' }, 'Session changes'),
    maximized: false,
    onToggleMaximized: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
    children: createElement('div', { 'data-testid': 'body' }, 'body'),
    ...over,
  }
  render(createElement(PaneFrame, props))
  return props
}

describe('PaneFrame', () => {
  it('renders standalone with the title slot, the body and the controls', () => {
    renderFrame()
    const frame = screen.getByTestId('pane-diff')
    expect(frame.getAttribute('aria-label')).toBe('Diff')
    expect(frame.hasAttribute('data-maximized')).toBe(false)
    expect(screen.getByTestId('title-slot').textContent).toBe('Session changes')
    expect(screen.getByTestId('body')).toBeTruthy()
    expect(screen.getByTestId('pane-diff-handle').getAttribute('aria-label')).toBe('Move Diff')
    expect(screen.getByTestId('pane-diff-expand').getAttribute('aria-label')).toBe('Expand pane')
    expect(screen.getByTestId('pane-diff-close').getAttribute('aria-label')).toBe('Close pane')
  })

  it('expanded, the frame says so and the button restores', () => {
    const props = renderFrame({ maximized: true })
    expect(screen.getByTestId('pane-diff').getAttribute('data-maximized')).toBe('true')
    const expand = screen.getByTestId('pane-diff-expand')
    expect(expand.getAttribute('aria-label')).toBe('Restore pane')
    expect(expand.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(expand)
    expect(props.onToggleMaximized).toHaveBeenCalledTimes(1)
  })

  it('maximized, the header is gone; actions, Restore and Close float in the corner', () => {
    const action = createElement('button', { 'data-testid': 'own-action', type: 'button' }, 'Reload')
    const props = renderFrame({ maximized: true, actions: action })
    expect(screen.queryByTestId('pane-diff-header')).toBeNull()
    expect(screen.queryByTestId('title-slot')).toBeNull()
    const bar = screen.getByTestId('pane-diff-float-bar')
    expect([...bar.querySelectorAll('button')].map(b => b.getAttribute('data-testid'))).toEqual([
      'own-action',
      'pane-diff-expand',
      'pane-diff-close',
    ])
    expect(bar.className, 'hidden until hovered or focused').toContain('opacity-0')
    expect(bar.className).toContain('hover:opacity-100')
    expect(bar.className).toContain('focus-within:opacity-100')
    fireEvent.click(screen.getByTestId('pane-diff-expand'))
    expect(props.onToggleMaximized).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('pane-diff-close'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('maximized, a pane that keeps title content shows it instead of its name', () => {
    const kept = createElement('button', { 'data-testid': 'kept-tab', type: 'button' }, 'dock-inner.ts')
    renderFrame({ maximized: true, titleWhenMaximized: kept })
    expect(screen.queryByTestId('pane-diff-header')).toBeNull()
    expect(screen.queryByTestId('title-slot'), 'the name is not drawn').toBeNull()
    const title = screen.getByTestId('pane-diff-title')
    expect(title.querySelector('[data-testid="kept-tab"]')).toBeTruthy()
    const bar = screen.getByTestId('pane-diff-float-bar')
    expect(bar.className, 'the corner cluster sits in the row, not over it').not.toContain('absolute')
    expect([...bar.querySelectorAll('button')].map(b => b.getAttribute('data-testid'))).toEqual([
      'kept-tab',
      'pane-diff-expand',
      'pane-diff-close',
    ])
    const buttons = bar.querySelector('[data-testid="pane-diff-expand"]')!.parentElement!
    expect(buttons.className, 'the buttons stay hidden until hovered').toContain('opacity-0')
    expect(buttons.className).toContain('hover:opacity-100')
    expect(buttons.className).toContain('focus-within:opacity-100')
  })

  it('beside the chat, title content kept for the maximized pane is not drawn', () => {
    renderFrame({ titleWhenMaximized: createElement('span', { 'data-testid': 'kept-tab' }, 'tab') })
    expect(screen.getByTestId('title-slot')).toBeTruthy()
    expect(screen.queryByTestId('kept-tab')).toBeNull()
  })

  it('Expand and Restore keep the same button, so it keeps keyboard focus', () => {
    const props = {
      kind: 'diff' as const,
      name: 'Diff',
      title: 'Diff',
      maximized: false,
      onToggleMaximized: vi.fn(),
      onClose: vi.fn(),
      children: null,
    }
    const view = render(createElement(PaneFrame, props))
    const expand = screen.getByTestId('pane-diff-expand')
    expand.focus()
    view.rerender(createElement(PaneFrame, { ...props, maximized: true }))
    expect(screen.getByTestId('pane-diff-expand')).toBe(expand)
    expect(document.activeElement).toBe(expand)
    view.rerender(createElement(PaneFrame, props))
    expect(screen.getByTestId('pane-diff-expand')).toBe(expand)
    expect(document.activeElement).toBe(expand)
  })

  it('not maximized, the header stays with the actions first', () => {
    const action = createElement('button', { 'data-testid': 'own-action', type: 'button' }, 'Reload')
    renderFrame({ actions: action })
    const header = screen.getByTestId('pane-diff-header')
    expect([...header.querySelectorAll('button')].map(b => b.getAttribute('data-testid'))).toEqual([
      'own-action',
      'pane-diff-expand',
      'pane-diff-close',
    ])
    expect(screen.queryByTestId('pane-diff-float-bar')).toBeNull()
  })

  it('every pane kind, maximized, floats its buttons with no header', () => {
    for (const kind of ['tasks', 'files', 'terminal', 'browser', 'a2ui'] as const) {
      renderFrame({ kind, maximized: true })
      expect(screen.queryByTestId(`pane-${kind}-header`), kind).toBeNull()
      expect(screen.getByTestId(`pane-${kind}-float-bar`), kind).toBeTruthy()
      cleanup()
    }
  })

  it('maximized, the pane drops its rounded border; otherwise it keeps it', () => {
    const frameClasses = () => screen.getByTestId('pane-diff').className.split(/\s+/)
    renderFrame({ maximized: true })
    expect(frameClasses()).not.toContain('border')
    expect(frameClasses()).not.toContain('rounded-lg')
    cleanup()
    renderFrame()
    expect(frameClasses()).toEqual(expect.arrayContaining(['border', 'rounded-lg']))
  })

  it('a pane opened beside the chat flashes the header its own open signal asked for', () => {
    requestPaneFlash('files')
    renderFrame({ kind: 'files' })
    const opened = screen.getByTestId('pane-files-flash')
    expect(opened.getAttribute('data-pane-flash')).toBe('true')
    expect(screen.getByTestId('pane-files-header').contains(opened)).toBe(true)
    cleanup()
    renderFrame({ kind: 'files' })
    expect(screen.queryByTestId('pane-files-flash'), 'the signal is spent once').toBeNull()
  })

  it('a pane mounting with no open signal for it does not flash, and a signal is spent once', () => {
    renderFrame()
    expect(screen.queryByTestId('pane-diff-flash')).toBeNull()
    cleanup()
    renderFrame()
    expect(screen.queryByTestId('pane-diff-flash'), 'a session switch back does not flash').toBeNull()
  })

  it('a signal on a mounted pane flashes it, restarts on the next signal, and leaves another kind alone', () => {
    renderFrame()
    act(() => requestPaneFlash('a2ui'))
    expect(screen.queryByTestId('pane-diff-flash'), 'another kind does not flash').toBeNull()
    act(() => requestPaneFlash('diff'))
    const first = screen.getByTestId('pane-diff-flash')
    act(() => requestPaneFlash('diff'))
    expect(screen.getByTestId('pane-diff-flash'), 'a new signal restarts the flash').not.toBe(first)
  })

  it('maximized, no flash is drawn', () => {
    renderFrame({ maximized: true })
    act(() => requestPaneFlash('diff'))
    expect(screen.queryByTestId('pane-diff-flash')).toBeNull()
  })

  it('close closes, and a press inside focuses the pane', () => {
    const props = renderFrame()
    fireEvent.click(screen.getByTestId('pane-diff-close'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(screen.getByTestId('body'))
    expect(props.onFocus).toHaveBeenCalled()
  })

  it('only the grip starts a drag: a press on the title or a control does not', () => {
    const onPointerDown = vi.fn()
    const onKeyDown = vi.fn()
    const props = {
      kind: 'browser' as const,
      name: 'Browser',
      title: createElement('button', { 'data-testid': 'tab', type: 'button' }, 'Tab 1'),
      maximized: false,
      onToggleMaximized: vi.fn(),
      onClose: vi.fn(),
      children: createElement('div', null, 'body'),
    }
    render(
      createElement(
        PaneHandleContext.Provider,
        { value: () => ({ onPointerDown, onKeyDown }) },
        createElement(PaneFrame, props),
      ),
    )
    const handle = screen.getByTestId('pane-browser-handle')
    expect(handle.contains(screen.getByTestId('tab'))).toBe(false)
    expect(handle.className).toContain('cursor-grab')
    expect(screen.getByTestId('pane-browser-title').className).not.toContain('cursor-grab')
    fireEvent.pointerDown(screen.getByTestId('tab'))
    fireEvent.pointerDown(screen.getByTestId('pane-browser-title'))
    fireEvent.pointerDown(screen.getByTestId('pane-browser-header'))
    fireEvent.pointerDown(screen.getByTestId('pane-browser-close'))
    expect(onPointerDown).not.toHaveBeenCalled()
    fireEvent.pointerDown(handle)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  it('the header shows the pane icon, swapped for the grip while the header is hovered', () => {
    render(
      createElement(
        PaneHandleContext.Provider,
        { value: () => ({ onPointerDown: vi.fn(), onKeyDown: vi.fn() }) },
        createElement(PaneFrame, {
          kind: 'terminal',
          name: 'Terminal',
          title: 'Terminal',
          maximized: false,
          onToggleMaximized: vi.fn(),
          onClose: vi.fn(),
          children: null,
        }),
      ),
    )
    const header = screen.getByTestId('pane-terminal-header')
    const handle = screen.getByTestId('pane-terminal-handle')
    const icon = screen.getByTestId('pane-terminal-icon')
    const grip = screen.getByTestId('pane-terminal-grip')
    expect(header.className).toContain('group/pane-header')
    expect(handle.contains(icon) && handle.contains(grip)).toBe(true)
    expect(icon.getAttribute('class')).toContain('group-hover/pane-header:hidden')
    expect(grip.getAttribute('class')).toMatch(/(^| )hidden( |$)/)
    expect(grip.getAttribute('class')).toContain('group-hover/pane-header:block')
    expect(header.className).not.toContain('cursor-grab')
  })

  it('outside an area the icon stays and no grip is drawn', () => {
    renderFrame()
    expect(screen.getByTestId('pane-diff-icon')).toBeTruthy()
    expect(screen.queryByTestId('pane-diff-grip')).toBeNull()
  })
})
