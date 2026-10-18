// @vitest-environment happy-dom
/**
 * The pane frame (F-9): renders outside any TooltipProvider, carries the
 * title slot, Expand / Restore and Close, and reports presses as focus.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PaneFrame } from '@/browser/webview/panes/PaneFrame'

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

  it('close closes, and a press inside focuses the pane', () => {
    const props = renderFrame()
    fireEvent.click(screen.getByTestId('pane-diff-close'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(screen.getByTestId('body'))
    expect(props.onFocus).toHaveBeenCalled()
  })
})
