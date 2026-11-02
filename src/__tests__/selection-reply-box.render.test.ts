// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { createPassageDraftStore, type PassageDraftStore } from '../browser/webview/capturedPassages'
import { I18nProvider } from '../browser/webview/i18n'
import { ComposerPassagesProvider, ComposerPassageStrip } from '../components/assistant-ui/composer-passages'
import { SelectionReplyBox, selectionInside, type PendingReply } from '../components/assistant-ui/thread'

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
  rect: { top: 200, left: 100, width: 300 },
}

function renderBox(store: PassageDraftStore, onClose = vi.fn()) {
  render(
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      createElement(
        ComposerPassagesProvider,
        { store },
        createElement('textarea', { 'data-testid': 'composer-input' }),
        createElement(ComposerPassageStrip),
        createElement(SelectionReplyBox, { pending, onClose }),
      ),
    ),
  )
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
