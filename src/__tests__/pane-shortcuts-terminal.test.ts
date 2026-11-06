// @vitest-environment happy-dom
/** Which pane shortcuts a focused terminal emulator keeps (F-9, F-31). */
import { afterEach, describe, expect, it } from 'vitest'

import { paneShortcutYieldsToTerminal } from '@/browser/webview/layout/paneShortcuts'

const files = { action: 'toggle', kind: 'files' } as const

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body
}

describe('paneShortcutYieldsToTerminal', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('leaves Ctrl+Shift+F to a live emulator, including its find bar', () => {
    const body = mount(
      '<section data-pane="terminal"><div data-terminal-view="live"><textarea id="xterm"></textarea><input id="find"></div></section>',
    )
    expect(paneShortcutYieldsToTerminal(files, body.querySelector('#xterm'))).toBe(true)
    expect(paneShortcutYieldsToTerminal(files, body.querySelector('#find'))).toBe(true)
  })

  it('keeps Ctrl+Shift+F a pane shortcut elsewhere in the Terminal pane and outside it', () => {
    const body = mount(
      '<section data-pane="terminal"><button id="close"></button><button id="new"></button><div data-terminal-view="released"><span id="parked"></span></div></section><div id="chat"></div>',
    )
    expect(paneShortcutYieldsToTerminal(files, body.querySelector('#close'))).toBe(false)
    expect(paneShortcutYieldsToTerminal(files, body.querySelector('#new'))).toBe(false)
    expect(paneShortcutYieldsToTerminal(files, body.querySelector('#parked'))).toBe(false)
    expect(paneShortcutYieldsToTerminal(files, body.querySelector('#chat'))).toBe(false)
    expect(paneShortcutYieldsToTerminal(files, null)).toBe(false)
  })

  it('never keeps the other pane shortcuts', () => {
    const body = mount('<div data-terminal-view="live"><textarea id="xterm"></textarea></div>')
    const xterm = body.querySelector('#xterm')
    expect(paneShortcutYieldsToTerminal({ action: 'toggle', kind: 'browser' }, xterm)).toBe(false)
    expect(paneShortcutYieldsToTerminal({ action: 'toggle', kind: 'diff' }, xterm)).toBe(false)
    expect(paneShortcutYieldsToTerminal({ action: 'close-focused' }, xterm)).toBe(false)
  })
})
