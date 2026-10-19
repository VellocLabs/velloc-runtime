// @vitest-environment happy-dom
import { createElement, useState, type ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The editor body is not under test here; keep CodeMirror out of the module graph.
vi.mock('../browser/webview/FilePanel', () => ({
  FilePanel: (props: { target: { path: string } }) =>
    createElement('div', { 'data-testid': `editor:${props.target.path}` }),
}))

import type { FolderListing } from '../browser/webview/layout/fileTree'
import { activateFileTab, closeFileTab, openFileTab } from '../browser/webview/layout/filesPane'
import { flushLayoutStorage, loadLayoutStorage } from '../browser/webview/layout/layoutStorage'
import type { FilesPaneState } from '../browser/webview/layout/paneLayout'
import type { FilesListDir } from '../browser/webview/panes/FilesBrowse'
import { FilesPane } from '../browser/webview/panes/FilesPane'
import { setFilesTreeVisible, setFilesTreeWidth } from '../browser/webview/panes/filesTreePrefs'

/**
 * The Files pane header and docked tree (F-9): with a file open the header
 * carries Go to file and the Show file tree toggle, off by default. Shown,
 * the tree docks after the file, reveals the active file and follows tab
 * switches; a file clicked in it opens. Closing the last tab lands in
 * browse with the closed file's row current.
 */

const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })
const dir = (name: string) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false })

const REPO: Record<string, FolderListing> = {
  '/repo': { entries: [dir('src'), file('README.md')], truncated: false },
  '/repo/src': { entries: [dir('deep'), file('main.ts'), file('util.ts')], truncated: false },
  '/repo/src/deep': { entries: [file('leaf.ts')], truncated: false },
}

function fakeLister(): FilesListDir & ReturnType<typeof vi.fn> {
  return vi.fn(async (path: string) => REPO[path] ?? null) as never
}

/** The pane with its tabs held as the shell holds them. */
function Harness(props: { initial: FilesPaneState; listDir: FilesListDir; onOpen?: (path: string) => void }): ReactNode {
  const [state, setState] = useState(props.initial)
  return createElement(FilesPane, {
    state,
    sessionKey: 's1',
    onActivate: path => setState(current => activateFileTab(current, path)),
    onCloseTab: path => setState(current => closeFileTab(current, path)),
    onCloseTabs: vi.fn(),
    protectedPaths: new Set<string>(),
    onDirtyChange: vi.fn(),
    onOpen: path => {
      props.onOpen?.(path)
      setState(current => openFileTab(current, path))
    },
    listDir: props.listDir,
    roots: ['/repo'],
    frame: ({ title, actions, body }) => createElement('div', null, title, actions, body),
  })
}

const opened = (...tabs: string[]): FilesPaneState => ({ tabs, active: tabs[tabs.length - 1] ?? null })
const toggle = () => screen.getByTestId('files-pane-tree-toggle')
const dock = () => screen.queryByTestId('files-pane-tree-dock')
const row = (path: string) => screen.getByTestId(`files-tree-row:${path}`)

const store = new Map<string, string>()
beforeAll(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
})
afterAll(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

afterEach(() => {
  cleanup()
  setFilesTreeVisible(false)
  setFilesTreeWidth(260)
  flushLayoutStorage()
})

describe('FilesPane header and docked tree', () => {
  it('the toggle is off by default; pressing it docks the tree after the file and remembers it', async () => {
    render(createElement(Harness, { initial: opened('/repo/README.md'), listDir: fakeLister() }))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(dock()).toBeNull()
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    const docked = dock()!
    const editor = screen.getByTestId('editor:/repo/README.md')
    expect(editor.compareDocumentPosition(docked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('files-pane-tree-handle').getAttribute('aria-valuenow')).toBe('260')
    await screen.findByTestId('files-tree-row:/repo/README.md')
    flushLayoutStorage()
    expect(loadLayoutStorage().filesTreeVisible).toBe(true)
    fireEvent.click(toggle())
    expect(dock()).toBeNull()
    expect(screen.getByTestId('editor:/repo/README.md')).toBe(editor)
  })

  it('reveals the active file: its folders expand, its row is current, and it follows tab switches', async () => {
    const listDir = fakeLister()
    render(createElement(Harness, { initial: opened('/repo/README.md', '/repo/src/deep/leaf.ts'), listDir }))
    fireEvent.click(toggle())
    await waitFor(() => expect(row('/repo/src/deep/leaf.ts').getAttribute('aria-current')).toBe('true'))
    expect(row('/repo/src').getAttribute('aria-expanded')).toBe('true')
    expect(row('/repo/src/deep').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByTestId('files-pane-tab:/repo/README.md'))
    expect(row('/repo/README.md').getAttribute('aria-current')).toBe('true')
    expect(row('/repo/src/deep/leaf.ts').getAttribute('aria-current')).toBeNull()
  })

  it('a file clicked in the docked tree opens; the tree stays and its selection follows', async () => {
    const onOpen = vi.fn()
    render(createElement(Harness, { initial: opened('/repo/src/main.ts'), listDir: fakeLister(), onOpen }))
    fireEvent.click(toggle())
    fireEvent.click(await screen.findByTestId('files-tree-row:/repo/src/util.ts'))
    expect(onOpen).toHaveBeenCalledWith('/repo/src/util.ts')
    expect(screen.getByTestId('files-pane-tab:/repo/src/util.ts').getAttribute('aria-selected')).toBe('true')
    expect(dock()).toBeTruthy()
    expect(row('/repo/src/util.ts').getAttribute('aria-current')).toBe('true')
  })

  it('Go to file shows the tree and focuses its filter box', async () => {
    render(createElement(Harness, { initial: opened('/repo/README.md'), listDir: fakeLister() }))
    fireEvent.click(screen.getByTestId('files-pane-go-to-file'))
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(document.activeElement?.getAttribute('data-testid')).toBe('files-browse-filter'))
    expect(dock()!.contains(document.activeElement)).toBe(true)
  })

  it('closing the last tab lands in browse with the closed file revealed and current', async () => {
    render(createElement(Harness, { initial: opened('/repo/src/deep/leaf.ts'), listDir: fakeLister() }))
    expect(screen.queryByTestId('files-browse')).toBeNull()
    fireEvent.click(screen.getByTestId('files-pane-close:/repo/src/deep/leaf.ts'))
    expect(screen.queryByTestId('files-pane-tree-toggle')).toBeNull()
    await waitFor(() => expect(row('/repo/src/deep/leaf.ts').getAttribute('aria-current')).toBe('true'))
    expect(row('/repo/src/deep').getAttribute('aria-expanded')).toBe('true')
  })

  it("the tab menu's Reveal in file tree docks the tree on that file; the pane options hide it again", async () => {
    render(createElement(Harness, { initial: opened('/repo/src/deep/leaf.ts', '/repo/README.md'), listDir: fakeLister() }))
    expect(dock()).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('files-pane-tab:/repo/src/deep/leaf.ts'))
    fireEvent.click(await screen.findByTestId('files-menu-reveal-in-tree'))
    expect(screen.getByTestId('files-pane-tab:/repo/src/deep/leaf.ts').getAttribute('aria-selected')).toBe('true')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(row('/repo/src/deep/leaf.ts').getAttribute('aria-current')).toBe('true'))
    act(() => {
      fireEvent.keyDown(screen.getByTestId('files-pane-options'), { key: 'Enter' })
    })
    const item = await screen.findByTestId('files-options-tree')
    expect(item.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(item)
    expect(dock()).toBeNull()
  })

  it('the handle resizes the tree with the arrow keys and remembers the width', async () => {
    render(createElement(Harness, { initial: opened('/repo/README.md'), listDir: fakeLister() }))
    fireEvent.click(toggle())
    const handle = screen.getByTestId('files-pane-tree-handle')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('276')
    expect(dock()!.style.width).toBe('276px')
    await act(async () => {})
    flushLayoutStorage()
    expect(loadLayoutStorage().filesTreeWidth).toBe(276)
  })
})
