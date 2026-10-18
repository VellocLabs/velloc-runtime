/** The pane shortcuts (F-9), matched on physical keys with Ctrl alone. */
import { describe, expect, it } from 'vitest'

import { paneShortcutFor, paneShortcutLabel } from '@/browser/webview/layout/paneShortcuts'

const key = (code: string, over: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  code,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

describe('paneShortcutFor', () => {
  it('maps the four shortcuts', () => {
    expect(paneShortcutFor(key('KeyD', { shiftKey: true }))).toEqual({ action: 'toggle', kind: 'diff' })
    expect(paneShortcutFor(key('Backslash'))).toEqual({ action: 'close-focused' })
    expect(paneShortcutFor(key('Backslash', { shiftKey: true }))).toEqual({ action: 'expand-focused' })
    expect(paneShortcutFor(key('KeyT', { shiftKey: true }))).toEqual({ action: 'reopen-closed' })
  })

  it('ignores other chords and keys', () => {
    expect(paneShortcutFor(key('KeyD'))).toBeNull()
    expect(paneShortcutFor(key('KeyT'))).toBeNull()
    expect(paneShortcutFor(key('KeyD', { shiftKey: true, ctrlKey: false }))).toBeNull()
    expect(paneShortcutFor(key('KeyD', { shiftKey: true, altKey: true }))).toBeNull()
    expect(paneShortcutFor(key('KeyD', { shiftKey: true, metaKey: true }))).toBeNull()
    expect(paneShortcutFor(key('KeyX', { shiftKey: true }))).toBeNull()
  })

  it('labels only the kinds with a shortcut', () => {
    expect(paneShortcutLabel('diff')).toBe('Ctrl+Shift+D')
    expect(paneShortcutLabel('tasks')).toBeNull()
  })
})
