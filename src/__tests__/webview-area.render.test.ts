// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { ShellChannel } from '../browser/runtimeClient/shellChannel'
import { WebviewArea } from '../browser/webview/WebviewArea'

/**
 * The browser pane's body (F-9): only the measured `webview-area` placeholder, nothing interactive inside it (the
 * native view paints over it); the active instance blanks the native view when it unmounts.
 */

afterEach(cleanup)

class StillResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

describe('WebviewArea', () => {
  it('renders the placeholder alone, hidden from assistive tech', () => {
    const { container, getByTestId } = render(createElement(WebviewArea, { active: false }))
    const placeholder = getByTestId('webview-area')
    expect(placeholder.getAttribute('aria-hidden')).toBe('true')
    expect(placeholder.children.length).toBe(0)
    expect(container.querySelectorAll('button').length).toBe(0)
  })

  it('the active instance posts {visible:false} when it unmounts', () => {
    vi.stubGlobal('ResizeObserver', StillResizeObserver)
    try {
      const publishLayout = vi.fn()
      const shell = { publishLayout } as unknown as ShellChannel
      const { unmount } = render(createElement(WebviewArea, { active: true, shell }))
      unmount()
      expect(publishLayout).toHaveBeenLastCalledWith({ visible: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
