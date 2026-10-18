/** The focused terminal's key policy (F-31): what the app keeps, what the view does, what the shell gets. */
import { describe, expect, it } from 'vitest'

import { terminalKeyDecision, type TerminalKeyEvent } from '@/browser/webview/terminal/terminalKeys'

const key = (code: string, over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  type: 'keydown',
  code,
  key: code,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

describe('terminalKeyDecision', () => {
  it('leaves the app its pane and session chords', () => {
    const none = { hasSelection: false }
    expect(terminalKeyDecision(key('Backquote'), none)).toBe('app')
    expect(terminalKeyDecision(key('Tab'), none)).toBe('app')
    expect(terminalKeyDecision(key('Tab', { shiftKey: true }), none)).toBe('app')
    expect(terminalKeyDecision(key('Backslash'), none)).toBe('app')
    expect(terminalKeyDecision(key('Backslash', { shiftKey: true }), none)).toBe('app')
    expect(terminalKeyDecision(key('KeyD', { shiftKey: true }), none)).toBe('app')
    expect(terminalKeyDecision(key('KeyT', { shiftKey: true }), none)).toBe('app')
  })

  it('Ctrl+C copies a selection and otherwise interrupts the program', () => {
    expect(terminalKeyDecision(key('KeyC'), { hasSelection: true })).toBe('copy')
    expect(terminalKeyDecision(key('KeyC'), { hasSelection: false })).toBe('shell')
  })

  it('Ctrl+V pastes; Ctrl+Shift+C / V always copy and paste', () => {
    expect(terminalKeyDecision(key('KeyV'), { hasSelection: false })).toBe('paste')
    expect(terminalKeyDecision(key('KeyC', { shiftKey: true }), { hasSelection: false })).toBe('copy')
    expect(terminalKeyDecision(key('KeyV', { shiftKey: true }), { hasSelection: true })).toBe('paste')
  })

  it('Ctrl+Shift+F opens the find bar', () => {
    expect(terminalKeyDecision(key('KeyF', { shiftKey: true }), { hasSelection: false })).toBe('search')
    expect(terminalKeyDecision(key('KeyF'), { hasSelection: false })).toBe('shell')
  })

  it('everything else reaches the shell, including Ctrl+D and plain or Alt keys', () => {
    const none = { hasSelection: false }
    expect(terminalKeyDecision(key('KeyD'), none)).toBe('shell')
    expect(terminalKeyDecision(key('KeyL'), none)).toBe('shell')
    expect(terminalKeyDecision(key('KeyA', { ctrlKey: false }), none)).toBe('shell')
    expect(terminalKeyDecision(key('Backquote', { ctrlKey: false }), none)).toBe('shell')
    expect(terminalKeyDecision(key('Backquote', { altKey: true }), none)).toBe('shell')
    expect(terminalKeyDecision(key('KeyC', { metaKey: true }), { hasSelection: true })).toBe('shell')
  })
})
