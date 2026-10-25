// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { RewindButton } from '../components/assistant-ui/rewind-button'
import { TooltipProvider } from '../components/ui/tooltip'

/**
 * "Rewind to here" confirms through an in-app modal. The webview guest suppresses `window.confirm` (it returns false
 * without a dialog), so the test pins it to that behaviour: a confirm-based action would never rewind.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mount = (onRewind: () => void) =>
  render(createElement(TooltipProvider, null, createElement(RewindButton, { onRewind })))

describe('RewindButton', () => {
  it('asks in a modal and rewinds on confirm, without window.confirm', () => {
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    const onRewind = vi.fn()
    mount(onRewind)

    fireEvent.click(screen.getByRole('button', { name: 'Rewind to here' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onRewind).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-rewind'))
    expect(onRewind).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancel closes the modal without rewinding', () => {
    const onRewind = vi.fn()
    mount(onRewind)

    fireEvent.click(screen.getByRole('button', { name: 'Rewind to here' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRewind).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
