// @vitest-environment happy-dom
import { createElement, useCallback, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The editor body is not under test here; keep CodeMirror out of the module graph.
vi.mock('../browser/webview/FilePanel', () => ({
  FilePanel: (props: { target: { path: string } }) =>
    createElement('div', { 'data-testid': `editor:${props.target.path}` }),
}))

import { emptyFileTree, type FileTreeState, type FolderListing } from '../browser/webview/layout/fileTree'
import { FilesBrowse, type FilesListDir } from '../browser/webview/panes/FilesBrowse'
import { FilesPane, type FilesPaneProps } from '../browser/webview/panes/FilesPane'

/**
 * The Files pane's browse state (F-9): the roots are listed on mount, a click
 * on a folder lists and expands it, a file opens on click or Enter, an
 * unreadable folder shows a Retry that lists it again, the filter box narrows
 * the listed rows, and the arrow keys move between the box and the rows. The
 * pane shows browse only with no active tab, and a notice while it has no
 * lister or no folder.
 */

const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })
const dir = (name: string) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false })

/** A lister over a fixed map; a path mapped to `null` (or missing) cannot be read. */
function fakeLister(table: Record<string, FolderListing | null>): FilesListDir & ReturnType<typeof vi.fn> {
  return vi.fn(async (path: string) => table[path] ?? null) as never
}

const REPO: Record<string, FolderListing | null> = {
  '/repo': { entries: [dir('src'), file('README.md')], truncated: false },
  '/repo/src': { entries: [file('main.ts'), file('util.ts')], truncated: false },
}

function Harness(props: { listDir: FilesListDir; onOpen: (path: string) => void }): ReactNode {
  const [tree, setTree] = useState<FileTreeState>(() => emptyFileTree(['/repo']))
  const onTreeChange = useCallback((update: (tree: FileTreeState) => FileTreeState) => setTree(update), [])
  return createElement(FilesBrowse, { tree, onTreeChange, listDir: props.listDir, onOpen: props.onOpen })
}

const row = (path: string) => screen.getByTestId(`files-tree-row:${path}`)
const findRow = (path: string) => screen.findByTestId(`files-tree-row:${path}`)

afterEach(cleanup)

describe('FilesBrowse', () => {
  it('lists the root on mount and shows its entries', async () => {
    const listDir = fakeLister(REPO)
    render(createElement(Harness, { listDir, onOpen: vi.fn() }))
    expect(row('/repo').getAttribute('aria-expanded')).toBe('true')
    await findRow('/repo/README.md')
    expect(listDir).toHaveBeenCalledTimes(1)
    expect(listDir).toHaveBeenCalledWith('/repo')
    expect(row('/repo/src').getAttribute('aria-expanded')).toBe('false')
    expect(row('/repo/src').getAttribute('aria-level')).toBe('2')
  })

  it('expands a folder on click, listing it once, and collapses it again', async () => {
    const listDir = fakeLister(REPO)
    render(createElement(Harness, { listDir, onOpen: vi.fn() }))
    fireEvent.click(await findRow('/repo/src'))
    await findRow('/repo/src/main.ts')
    expect(row('/repo/src').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row('/repo/src'))
    expect(screen.queryByTestId('files-tree-row:/repo/src/main.ts')).toBeNull()
    fireEvent.click(row('/repo/src'))
    await findRow('/repo/src/main.ts')
    expect(listDir.mock.calls.map(call => call[0])).toEqual(['/repo', '/repo/src'])
  })

  it('opens a file on click and on Enter, never a folder', async () => {
    const onOpen = vi.fn()
    render(createElement(Harness, { listDir: fakeLister(REPO), onOpen }))
    fireEvent.click(await findRow('/repo/README.md'))
    expect(onOpen).toHaveBeenLastCalledWith('/repo/README.md')
    fireEvent.keyDown(row('/repo/README.md'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(row('/repo/src'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('shows an unreadable folder as an error row whose Retry lists it again', async () => {
    const table: Record<string, FolderListing | null> = { ...REPO, '/repo/src': null }
    const listDir = fakeLister(table)
    render(createElement(Harness, { listDir, onOpen: vi.fn() }))
    fireEvent.click(await findRow('/repo/src'))
    const retry = await screen.findByTestId('files-tree-retry:/repo/src')
    table['/repo/src'] = REPO['/repo/src']
    fireEvent.click(retry)
    await findRow('/repo/src/util.ts')
    expect(screen.queryByTestId('files-tree-status:error:/repo/src')).toBeNull()
    expect(listDir.mock.calls.filter(call => call[0] === '/repo/src')).toHaveLength(2)
  })

  it('narrows the listed rows by the filter, says when nothing matches, and Escape clears', async () => {
    const onOpen = vi.fn()
    render(createElement(Harness, { listDir: fakeLister(REPO), onOpen }))
    fireEvent.click(await findRow('/repo/src'))
    await findRow('/repo/src/main.ts')
    const box = screen.getByTestId('files-browse-filter')
    fireEvent.change(box, { target: { value: 'MAIN' } })
    expect(screen.getByTestId('files-tree-row:/repo/src/main.ts')).toBeTruthy()
    expect(screen.queryByTestId('files-tree-row:/repo/src/util.ts')).toBeNull()
    expect(screen.queryByTestId('files-tree-row:/repo/README.md')).toBeNull()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('/repo/src/main.ts')
    fireEvent.change(box, { target: { value: 'zzz' } })
    expect(screen.getByTestId('files-browse-no-matches')).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect((box as HTMLInputElement).value).toBe('')
    expect(row('/repo/README.md')).toBeTruthy()
  })

  it('↓ from the box enters the rows; ↑ on the first row returns; → expands a folder', async () => {
    render(createElement(Harness, { listDir: fakeLister(REPO), onOpen: vi.fn() }))
    await findRow('/repo/src')
    const box = screen.getByTestId('files-browse-filter')
    box.focus()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('/repo'))
    fireEvent.keyDown(row('/repo'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('/repo/src'))
    expect(row('/repo/src').tabIndex).toBe(0)
    expect(row('/repo').tabIndex).toBe(-1)
    fireEvent.keyDown(row('/repo/src'), { key: 'ArrowRight' })
    await findRow('/repo/src/main.ts')
    fireEvent.keyDown(row('/repo/src'), { key: 'ArrowUp' })
    fireEvent.keyDown(row('/repo'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(box)
  })
})

describe('FilesPane browse branch', () => {
  const base = (over: Partial<FilesPaneProps>): FilesPaneProps => ({
    state: { tabs: [], active: null },
    sessionKey: 's1',
    onActivate: vi.fn(),
    onCloseTab: vi.fn(),
    protectedPaths: new Set(),
    onDirtyChange: vi.fn(),
    onOpen: vi.fn(),
    frame: ({ title, body }) => createElement('div', null, title, body),
    ...over,
  })

  it('without a lister or before the session reports its folders, asks to start the session', () => {
    const { rerender } = render(createElement(FilesPane, base({ roots: ['/repo'] })))
    expect(screen.getByTestId('files-browse-not-started')).toBeTruthy()
    rerender(createElement(FilesPane, base({ listDir: fakeLister(REPO), roots: null })))
    expect(screen.getByTestId('files-browse-not-started')).toBeTruthy()
    rerender(createElement(FilesPane, base({ listDir: fakeLister(REPO), roots: [] })))
    expect(screen.getByTestId('files-browse-no-folder')).toBeTruthy()
  })

  it('browses with no active tab, hands a file click to onOpen, and shows the editor once a tab is active', async () => {
    const onOpen = vi.fn()
    const listDir = fakeLister(REPO)
    const { rerender } = render(createElement(FilesPane, base({ listDir, roots: ['/repo'], onOpen })))
    expect(screen.getByTestId('files-pane-browse-title')).toBeTruthy()
    fireEvent.click(await findRow('/repo/README.md'))
    expect(onOpen).toHaveBeenCalledWith('/repo/README.md')
    rerender(
      createElement(
        FilesPane,
        base({ listDir, roots: ['/repo'], onOpen, state: { tabs: ['/repo/README.md'], active: '/repo/README.md' } }),
      ),
    )
    expect(screen.queryByTestId('files-browse')).toBeNull()
    expect(screen.getByTestId('editor:/repo/README.md')).toBeTruthy()
    rerender(createElement(FilesPane, base({ listDir, roots: ['/repo'], onOpen })))
    await findRow('/repo/README.md')
    expect(listDir).toHaveBeenCalledTimes(1)
  })
})
