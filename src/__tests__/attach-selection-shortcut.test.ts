// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isAttachSelectionChord,
  registerAttachSelectionOwner,
} from '../browser/webview/attachSelectionShortcut'

/**
 * Ctrl+Shift+L / Command+Shift+L (F-22): the exact chord per platform; the
 * thread whose message list holds the selection takes it, trimmed, and the
 * selection clears; a field, an open dialog, a repeat, a short or outside
 * selection takes nothing and never falls back to a whole message.
 */

const chord = (over: Partial<Parameters<typeof isAttachSelectionChord>[0]> = {}) => ({
  code: 'KeyL',
  key: 'L',
  ctrlKey: true,
  metaKey: false,
  shiftKey: true,
  altKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  ...over,
})

describe('chord', () => {
  it('is Ctrl+Shift+L off macOS and Command+Shift+L on it, exactly', () => {
    expect(isAttachSelectionChord(chord(), false)).toBe(true)
    expect(isAttachSelectionChord(chord(), true)).toBe(false)
    expect(isAttachSelectionChord(chord({ ctrlKey: false, metaKey: true }), true)).toBe(true)
    expect(isAttachSelectionChord(chord({ ctrlKey: false, metaKey: true }), false)).toBe(false)
    expect(isAttachSelectionChord(chord({ altKey: true }), false)).toBe(false)
    expect(isAttachSelectionChord(chord({ shiftKey: false }), false)).toBe(false)
  })

  it('ignores a repeat, an IME composition and a claimed event', () => {
    expect(isAttachSelectionChord(chord({ repeat: true }), false)).toBe(false)
    expect(isAttachSelectionChord(chord({ isComposing: true }), false)).toBe(false)
    expect(isAttachSelectionChord(chord({ defaultPrevented: true }), false)).toBe(false)
  })
})

describe('owner registry', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.()
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  const mount = () => {
    document.body.innerHTML = `
      <div id="a"><p id="pa">  Alpha text  </p></div>
      <div id="b"><p id="pb">Beta text</p></div>
      <p id="out">Outside</p>
      <textarea id="field"></textarea>`
    const a = vi.fn(() => true)
    const b = vi.fn(() => true)
    cleanups.push(registerAttachSelectionOwner(document, { list: () => document.getElementById('a'), attach: a }))
    cleanups.push(registerAttachSelectionOwner(document, { list: () => document.getElementById('b'), attach: b }))
    return { a, b }
  }

  const select = (id: string, from = 0, to?: number) => {
    const node = document.getElementById(id)!.firstChild!
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to ?? node.textContent!.length)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
  }

  const press = (target: EventTarget = document.body, over: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: 'L',
      code: 'KeyL',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...over,
    })
    target.dispatchEvent(event)
    return event
  }

  it('hands the selection to the thread that holds it, trimmed, and clears it', () => {
    const { a, b } = mount()
    select('pb')
    const event = press()
    expect(b).toHaveBeenCalledWith('Beta text')
    expect(a).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    expect(document.getSelection()!.toString()).toBe('')
    select('pa')
    press()
    expect(a).toHaveBeenCalledWith('Alpha text')
  })

  it('takes nothing for an outside, a short or no selection', () => {
    const { a, b } = mount()
    select('out')
    expect(press().defaultPrevented).toBe(false)
    select('pb', 0, 1)
    press()
    document.getSelection()!.removeAllRanges()
    press()
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
  })

  it('leaves the keys to a focused field and an open dialog', () => {
    const { b } = mount()
    select('pb')
    press(document.getElementById('field')!)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    press()
    expect(b).not.toHaveBeenCalled()
  })

  it('leaves the keys to a menu or list box holding the focus', () => {
    const { b } = mount()
    select('pb')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.appendChild(item)
    document.body.appendChild(menu)
    item.focus()
    press(item)
    expect(b).not.toHaveBeenCalled()
  })

  it('still attaches while a list box is mounted elsewhere in the document', () => {
    const { b } = mount()
    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    listbox.innerHTML = '<div role="option">A side chat</div>'
    document.body.appendChild(listbox)
    const hiddenModal = document.createElement('div')
    hiddenModal.setAttribute('aria-modal', 'true')
    hiddenModal.hidden = true
    document.body.appendChild(hiddenModal)
    select('pb')
    press()
    expect(b).toHaveBeenCalledWith('Beta text')
  })

  it('ignores a keydown with no key', () => {
    expect(isAttachSelectionChord(chord({ code: '', key: undefined as unknown as string }), false)).toBe(false)
  })

  it('stops listening once the last owner leaves', () => {
    const { b } = mount()
    while (cleanups.length) cleanups.pop()?.()
    select('pb')
    press()
    expect(b).not.toHaveBeenCalled()
  })
})
