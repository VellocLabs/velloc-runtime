// @vitest-environment happy-dom
/**
 * The resize handle's drag lifecycle: a drag that ends because the handle
 * unmounts (the layout dropped its column) still restores the page cursor and
 * reports its end.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SidebarSplitter } from '@/browser/webview/SidebarSplitter'

afterEach(() => {
  cleanup()
  document.body.style.cursor = ''
})

describe('SidebarSplitter', () => {
  it('unmounted mid-drag, restores the cursor and reports the end', () => {
    const onResizeEnd = vi.fn()
    const view = render(
      createElement(SidebarSplitter, {
        width: 280,
        minWidth: 200,
        maxWidth: 360,
        onResize: () => {},
        onResizeEnd,
      }),
    )
    const handle = screen.getByRole('separator')
    handle.setPointerCapture = () => {}
    handle.releasePointerCapture = () => {}
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 280 })
    expect(document.body.style.cursor).toBe('col-resize')
    view.unmount()
    expect(document.body.style.cursor).toBe('')
    expect(onResizeEnd).toHaveBeenCalledTimes(1)
  })

  it('an ordinary release ends the drag once', () => {
    const onResizeEnd = vi.fn()
    const view = render(
      createElement(SidebarSplitter, {
        width: 280,
        minWidth: 200,
        maxWidth: 360,
        onResize: () => {},
        onResizeEnd,
      }),
    )
    const handle = screen.getByRole('separator')
    handle.setPointerCapture = () => {}
    handle.releasePointerCapture = () => {}
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 280 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300 })
    view.unmount()
    expect(onResizeEnd).toHaveBeenCalledTimes(1)
    expect(document.body.style.cursor).toBe('')
  })
})
