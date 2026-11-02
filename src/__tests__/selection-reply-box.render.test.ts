// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { createPassageDraftStore, type PassageDraftStore } from '../browser/webview/capturedPassages'
import { I18nProvider } from '../browser/webview/i18n'
import { ComposerPassagesProvider, ComposerPassageStrip } from '../components/assistant-ui/composer-passages'
import {
  SelectionReplyBox,
  holdSelectionForReply,
  placeReplyBox,
  selectionInside,
  useSelectionOwned,
  type PendingReply,
} from '../components/assistant-ui/thread'

/**
 * Reply on a transcript selection (F-22): the reply box shows the selection and
 * a field labelled "Reply"; Enter puts the selection and the reply in the
 * composer as one card; an empty reply adds the plain quote; Escape and a click
 * outside close it without adding anything.
 */

afterEach(() => cleanup())

const pending: PendingReply = {
  body: 'own file history, so its edit-tool and shell writes are captured too.',
  messageId: 'm1',
  row: null,
  rect: { top: 200, left: 100, width: 300, height: 20 },
}

function boxTree(store: PassageDraftStore, onClose: () => void, isForeground?: boolean) {
  return createElement(
    I18nProvider,
    { locale: 'en' as const },
    createElement(
      ComposerPassagesProvider,
      { store },
      createElement('textarea', { 'data-testid': 'composer-input' }),
      createElement(ComposerPassageStrip),
      createElement(SelectionReplyBox, { pending, onClose, isForeground }),
    ),
  )
}

function renderBox(store: PassageDraftStore, onClose = vi.fn()) {
  render(boxTree(store, onClose))
  return onClose
}

describe('selection reply box', () => {
  it('shows the selection and a field labelled Reply, focused', () => {
    renderBox(createPassageDraftStore())
    expect(screen.getByTestId('selection-reply-quote').textContent).toBe(pending.body)
    const input = screen.getByTestId('selection-reply-input') as HTMLInputElement
    expect(input.placeholder).toBe('Reply')
    expect(document.activeElement).toBe(input)
  })

  it('Enter adds the selection and the reply as one card, shown on the card, and closes', () => {
    const store = createPassageDraftStore()
    const onClose = renderBox(store)
    const input = screen.getByTestId('selection-reply-input')
    fireEvent.change(input, { target: { value: 'please replay it' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(store.getPassages(), 'the card waits for the key to come up').toHaveLength(0)
    act(() => {
      fireEvent.keyUp(input, { key: 'Enter' })
    })
    expect(store.getPassages().map(p => p.payload)).toEqual([
      { media: 'text/plain', body: pending.body, note: 'please replay it' },
    ])
    expect(store.getPassages()[0]!.capture.anchors).toEqual([{ threadKey: '', entryKey: 'm1' }])
    expect(onClose).toHaveBeenCalledTimes(1)
    const tile = screen.getByTestId('passage-tile')
    expect(tile.querySelector('blockquote')!.textContent).toBe(pending.body)
    expect(screen.getByTestId('passage-note').textContent).toBe('please replay it')
  })

  it('an empty reply adds the plain quote', () => {
    const store = createPassageDraftStore()
    renderBox(store)
    act(() => {
      fireEvent.click(screen.getByTestId('selection-reply-submit'))
    })
    expect(store.getPassages().map(p => p.payload)).toEqual([{ media: 'text/plain', body: pending.body }])
    expect(screen.queryByTestId('passage-note')).toBeNull()
  })

  it('Escape or a click outside closes it and adds nothing', () => {
    const store = createPassageDraftStore()
    const onClose = renderBox(store)
    fireEvent.keyDown(screen.getByTestId('selection-reply-input'), { key: 'Escape' })
    fireEvent.pointerDown(screen.getByTestId('composer-input'))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(store.getPassages()).toHaveLength(0)
  })

  it('closes when the person scrolls outside it, not when the page scrolls itself', () => {
    const store = createPassageDraftStore()
    const onClose = renderBox(store)
    const outside = screen.getByTestId('composer-input')
    fireEvent.scroll(outside)
    fireEvent.scroll(document)
    expect(onClose, 'a programmatic scroll keeps the box').not.toHaveBeenCalled()
    fireEvent.wheel(screen.getByTestId('selection-reply-input'))
    fireEvent.keyDown(screen.getByTestId('selection-reply-input'), { key: 'ArrowDown' })
    expect(onClose, 'wheel or keys inside the box keep it').not.toHaveBeenCalled()
    fireEvent.wheel(outside)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.touchMove(outside)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(outside, { key: 'PageDown' })
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(store.getPassages()).toHaveLength(0)
  })

  it('closes and disappears when its thread leaves the foreground', () => {
    const store = createPassageDraftStore()
    const onClose = vi.fn()
    const { rerender } = render(boxTree(store, onClose, true))
    expect(screen.queryByTestId('selection-reply-box')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    rerender(boxTree(store, onClose, false))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('selection-reply-box')).toBeNull()
  })

  it('focuses the composer of the thread the selection was in', () => {
    const store = createPassageDraftStore()
    const threads = document.createElement('div')
    document.body.append(threads)
    threads.innerHTML =
      '<div class="aui-thread-root"><textarea data-testid="composer-input" id="other"></textarea></div>' +
      '<div class="aui-thread-root"><div data-message-id="m1"><p id="para">alpha beta gamma</p></div>' +
      '<textarea data-testid="composer-input" id="mine"></textarea></div>'
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('para')!)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const held = holdSelectionForReply(selection)!
    expect(held.row, 'the row is read before the selection is cleared').not.toBeNull()
    expect(held.messageId).toBe('m1')
    expect(selection.rangeCount).toBe(0)
    const onClose = vi.fn()
    render(
      createElement(
        I18nProvider,
        { locale: 'en' as const },
        createElement(
          ComposerPassagesProvider,
          { store },
          createElement(SelectionReplyBox, { pending: held, onClose }),
        ),
      ),
    )
    act(() => {
      fireEvent.click(screen.getByTestId('selection-reply-submit'))
    })
    expect(store.getPassages()).toHaveLength(1)
    expect(document.activeElement?.id).toBe('mine')
    threads.remove()
  })

  it('Shift+Enter and an IME composition do not submit', () => {
    const store = createPassageDraftStore()
    renderBox(store)
    const input = screen.getByTestId('selection-reply-input')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyUp(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyUp(input, { key: 'Enter' })
    fireEvent.keyUp(input, { key: 'Enter' })
    expect(store.getPassages()).toHaveLength(0)
  })
})

describe('where the reply box goes', () => {
  const viewport = { width: 1000, height: 800 }
  const box = { width: 352, height: 112 }

  it('sits above the selection, centred, when there is room', () => {
    expect(placeReplyBox({ top: 400, left: 300, width: 200, height: 20 }, box, viewport)).toEqual({
      top: 400 - 8 - 112,
      left: 400 - 176,
    })
  })

  it('goes below a selection near the top, and stays inside the viewport', () => {
    const place = placeReplyBox({ top: 30, left: 300, width: 200, height: 20 }, box, viewport)
    expect(place.top).toBe(30 + 20 + 8)
    const bottom = placeReplyBox({ top: 50, left: 300, width: 200, height: 790 }, box, viewport)
    expect(bottom.top).toBe(800 - 112 - 8)
  })

  it('is clamped at either side', () => {
    expect(placeReplyBox({ top: 400, left: 0, width: 20, height: 20 }, box, viewport).left).toBe(8)
    expect(placeReplyBox({ top: 400, left: 980, width: 20, height: 20 }, box, viewport).left).toBe(1000 - 352 - 8)
  })
})

describe('selection ownership tracking', () => {
  it('asks for one frame at a time and cancels it on unmount', () => {
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 7)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const list = { current: document.createElement('div') }
    const Probe = () => {
      useSelectionOwned(list)
      return null
    }
    const { unmount } = render(createElement(Probe))
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new Event('mouseup'))
    document.dispatchEvent(new Event('keyup'))
    expect(request).toHaveBeenCalledTimes(1)
    unmount()
    expect(cancel).toHaveBeenCalledWith(7)
    request.mockRestore()
    cancel.mockRestore()
  })
})

describe('which thread owns a selection', () => {
  it('is the list holding both ends, never another mounted thread', () => {
    const here = document.createElement('div')
    const other = document.createElement('div')
    here.innerHTML = '<p>alpha beta gamma</p>'
    other.innerHTML = '<p>other session text</p>'
    document.body.append(here, other)
    const range = document.createRange()
    range.selectNodeContents(here.querySelector('p')!)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectionInside(here, selection)).toBe(true)
    expect(selectionInside(other, selection)).toBe(false)
    expect(selectionInside(null, selection)).toBe(false)
    selection.removeAllRanges()
    expect(selectionInside(here, selection)).toBe(false)
    here.remove()
    other.remove()
  })
})
