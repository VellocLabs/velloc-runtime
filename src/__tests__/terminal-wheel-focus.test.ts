// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { takesFocusOnWheel } from '../browser/webview/terminal/wheelFocus'

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.getElementById('host')!
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('takesFocusOnWheel (F-34)', () => {
  it('takes focus from nothing, a button or a sidebar row', () => {
    const host = mount('<div id="host"><textarea id="term"></textarea></div><button id="row">Row</button>')
    expect(takesFocusOnWheel(null, host)).toBe(true)
    expect(takesFocusOnWheel(document.body, host)).toBe(true)
    expect(takesFocusOnWheel(document.getElementById('row'), host)).toBe(true)
  })

  it('leaves focus that is already in the terminal', () => {
    const host = mount('<div id="host"><textarea id="term"></textarea></div>')
    expect(takesFocusOnWheel(document.getElementById('term'), host)).toBe(false)
  })

  it('leaves focus in a text field, an editable region, a menu or a dialog', () => {
    const host = mount(`
      <div id="host"></div>
      <input id="text" type="text" />
      <input id="check" type="checkbox" />
      <textarea id="area"></textarea>
      <div id="edit" contenteditable="true"></div>
      <div role="menu"><button id="item">Item</button></div>
      <div role="dialog"><button id="ok">OK</button></div>`)
    for (const id of ['text', 'area', 'edit', 'item', 'ok']) {
      expect(takesFocusOnWheel(document.getElementById(id), host), id).toBe(false)
    }
    expect(takesFocusOnWheel(document.getElementById('check'), host)).toBe(true)
  })
})
