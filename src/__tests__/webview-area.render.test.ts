// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { WebviewArea } from '../browser/webview/WebviewArea'

/**
 * The docked browser view's header: it and its close button live OUTSIDE the measured `webview-area` placeholder
 * (the native view paints over it), and the X calls `onHide`. `active={false}` keeps the ResizeObserver effect off.
 */

afterEach(cleanup)

describe('WebviewArea header', () => {
  it('renders the header with a close button, separate from the placeholder', () => {
    const { getByTestId } = render(
      createElement(WebviewArea, { active: false, width: 400 }),
    )
    const header = getByTestId('webview-area-header')
    const placeholder = getByTestId('webview-area')
    const hide = getByTestId('webview-area-hide')

    // The close button must be in the header, NOT inside the measured
    // placeholder the native view paints over.
    expect(header.contains(hide)).toBe(true)
    expect(placeholder.contains(hide)).toBe(false)
    expect(header.contains(placeholder)).toBe(false)
    expect(hide.getAttribute('aria-label')).toBe('Hide browser view')
  })

  it('invokes onHide when the close button is clicked', () => {
    const onHide = vi.fn()
    const { getByTestId } = render(
      createElement(WebviewArea, { active: false, width: 400, onHide }),
    )
    fireEvent.click(getByTestId('webview-area-hide'))
    expect(onHide).toHaveBeenCalledTimes(1)
  })
})
