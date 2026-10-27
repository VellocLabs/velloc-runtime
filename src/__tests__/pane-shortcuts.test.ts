/** The pane shortcuts (F-9), matched on physical keys with Ctrl alone. */
import { describe, expect, it } from 'vitest'

import { paneShortcutFor, paneShortcutLabel, paneShortcutStep } from '@/browser/webview/layout/paneShortcuts'

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

  it('Ctrl+Shift+E toggles the Files tree; without Shift it is nothing', () => {
    expect(paneShortcutFor(key('KeyE', { shiftKey: true }))).toEqual({ action: 'toggle-files-tree' })
    expect(paneShortcutFor(key('KeyE'))).toBeNull()
    expect(paneShortcutFor(key('KeyE', { shiftKey: true, altKey: true }))).toBeNull()
  })

  it('Ctrl+` toggles the Terminal pane; with Shift it is nothing', () => {
    expect(paneShortcutFor(key('Backquote'))).toEqual({ action: 'toggle', kind: 'terminal' })
    expect(paneShortcutFor(key('Backquote', { shiftKey: true }))).toBeNull()
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

describe('paneShortcutStep', () => {
  const cli = ['browser', 'terminal'] as const

  it('closes, expands and restores the focused pane, else the last one', () => {
    const scene = { panes: ['diff', 'files'] as const, maximized: null }
    expect(paneShortcutStep({ action: 'close-focused' }, { ...scene, panes: [...scene.panes], focused: 'diff' })).toEqual({ do: 'close', kind: 'diff' })
    expect(paneShortcutStep({ action: 'close-focused' }, { ...scene, panes: [...scene.panes], focused: 'terminal' })).toEqual({ do: 'close', kind: 'files' })
    expect(paneShortcutStep({ action: 'expand-focused' }, { ...scene, panes: [...scene.panes] })).toEqual({ do: 'maximize', kind: 'files' })
    expect(paneShortcutStep({ action: 'expand-focused' }, { ...scene, panes: [...scene.panes], maximized: 'diff' })).toEqual({ do: 'maximize', kind: null })
  })

  it('reopens the last closed pane only when it is closed', () => {
    expect(paneShortcutStep({ action: 'reopen-closed' }, { panes: [], maximized: null, lastClosed: 'diff' })).toEqual({ do: 'open', kind: 'diff' })
    expect(paneShortcutStep({ action: 'reopen-closed' }, { panes: ['diff'], maximized: null, lastClosed: 'diff' })).toBeNull()
    expect(paneShortcutStep({ action: 'reopen-closed' }, { panes: [], maximized: null })).toBeNull()
  })

  it('a CLI session with no pane open changes nothing on close, expand or reopen', () => {
    const scene = { panes: [], maximized: null, offered: [...cli] }
    expect(paneShortcutStep({ action: 'close-focused' }, scene)).toBeNull()
    expect(paneShortcutStep({ action: 'expand-focused' }, scene)).toBeNull()
    expect(paneShortcutStep({ action: 'reopen-closed' }, { ...scene, lastClosed: 'diff' })).toBeNull()
    expect(paneShortcutStep({ action: 'reopen-closed' }, { ...scene, lastClosed: 'terminal' })).toEqual({ do: 'open', kind: 'terminal' })
  })

  it('a CLI session toggles only the panes it offers', () => {
    const scene = { panes: [], maximized: null, offered: [...cli] }
    expect(paneShortcutStep({ action: 'toggle', kind: 'diff' }, scene)).toBeNull()
    expect(paneShortcutStep({ action: 'toggle', kind: 'terminal' }, scene)).toEqual({ do: 'toggle', kind: 'terminal' })
  })
})
