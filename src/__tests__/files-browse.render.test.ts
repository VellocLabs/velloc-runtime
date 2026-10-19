// @vitest-environment happy-dom
import { createElement, useCallback, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The editor body is not under test here; keep CodeMirror out of the module graph.
vi.mock('../browser/webview/FilePanel', () => ({
  FilePanel: (props: { target: { path: string } }) =>
    createElement('div', { 'data-testid': `editor:${props.target.path}` }),
}))

import { emptyFileTree, type FileTreeState, type FolderListing } from '../browser/webview/layout/fileTree'
import type { FileSearchRequest } from '../browser/runtimeClient/fileAccess'
import type { FsxFileMatch, FsxSearchState } from '../browser/runtimeProtocol'
import { FilesBrowse, type FilesListDir, type FilesSearch } from '../browser/webview/panes/FilesBrowse'
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
    onCloseTabs: vi.fn(),
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


/**
 * The filter box's search modes (F-9): a name searches file names below the session folder through
 * `search`, `folder/` lists that folder flat under a go-up row, and `?text` searches contents with
 * the three toggles. A fake `search` records each request and lets the test publish states.
 */
describe('FilesBrowse search modes', () => {
  type Started = { request: FileSearchRequest; publish: (state: FsxSearchState) => void; stopped: boolean }

  function fakeSearch() {
    const started: Started[] = []
    const search: FilesSearch = async (request, onState) => {
      const entry: Started = { request, publish: onState, stopped: false }
      started.push(entry)
      return () => {
        entry.stopped = true
      }
    }
    return { started, search }
  }

  function SearchHarness(props: {
    listDir: FilesListDir
    search: FilesSearch
    onOpen: (path: string, line?: number) => void
  }): ReactNode {
    const [tree, setTree] = useState<FileTreeState>(() => emptyFileTree(['/repo']))
    const onTreeChange = useCallback((update: (tree: FileTreeState) => FileTreeState) => setTree(update), [])
    return createElement(FilesBrowse, { tree, onTreeChange, ...props })
  }

  const filesState = (files: FsxFileMatch[], scanning: boolean, matched = files.length): FsxSearchState => ({
    kind: 'files',
    searchId: 'x',
    scanning,
    files,
    matched,
    indexTruncated: false,
  })

  function setup() {
    const fake = fakeSearch()
    const onOpen = vi.fn()
    const listDir = fakeLister({
      ...REPO,
      '/repo/src/lib': { entries: [file('deep.ts')], truncated: false },
      '/repo/src': { entries: [dir('lib'), file('main.ts')], truncated: false },
    })
    render(createElement(SearchHarness, { listDir, search: fake.search, onOpen }))
    const box = screen.getByTestId('files-browse-filter') as HTMLInputElement
    const type = (value: string) => fireEvent.change(box, { target: { value } })
    return { ...fake, onOpen, listDir, box, type }
  }

  it('a name searches file names below the root; results stream in and Enter opens the first', async () => {
    const { started, onOpen, box, type } = setup()
    type('deep')
    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]!.request).toEqual({ kind: 'files', path: '/repo', query: 'deep', refresh: true })
    expect(screen.getByTestId('files-find-spinner')).toBeTruthy()
    act(() => started[0]!.publish(filesState([{ path: 'src/lib/deep.ts', ranges: [8, 12] }], true)))
    const result = await screen.findByTestId('files-find-file:src/lib/deep.ts')
    expect(result.textContent).toContain('deep.ts')
    expect(result.textContent).toContain('src/lib')
    expect(result.querySelector('mark')?.textContent).toBe('deep')
    expect(screen.getByTestId('files-find-spinner')).toBeTruthy()
    act(() => started[0]!.publish(filesState([{ path: 'src/lib/deep.ts', ranges: [8, 12] }], false, 120)))
    await waitFor(() => expect(screen.queryByTestId('files-find-spinner')).toBeNull())
    expect(screen.getByTestId('files-find-capped')).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('/repo/src/lib/deep.ts')
  })

  it('a newer query starts before the older search ends, and only the first lists the folder again', async () => {
    const { started, type } = setup()
    type('de')
    await waitFor(() => expect(started).toHaveLength(1))
    type('deep')
    await waitFor(() => expect(started).toHaveLength(2))
    expect(started[1]!.request).toEqual({ kind: 'files', path: '/repo', query: 'deep' })
    await waitFor(() => expect(started[0]!.stopped).toBe(true))
    expect(started[1]!.stopped).toBe(false)
    act(() => started[1]!.publish(filesState([], false)))
    expect(await screen.findByTestId('files-find-no-matches')).toBeTruthy()
    type('')
    await waitFor(() => expect(started[1]!.stopped).toBe(true))
    expect(screen.getByTestId('files-tree')).toBeTruthy()
  })

  it('`folder/` lists the folder flat; a folder row drills in and go-up leads to the parent, then the tree', async () => {
    const { started, listDir, box, type, onOpen } = setup()
    type('src/')
    fireEvent.click(await screen.findByTestId('files-find-entry:lib'))
    expect(box.value).toBe('src/lib/')
    fireEvent.click(await screen.findByTestId('files-find-entry:deep.ts'))
    expect(onOpen).toHaveBeenCalledWith('/repo/src/lib/deep.ts')
    expect(listDir).toHaveBeenCalledWith('/repo/src/lib')
    const goUp = screen.getByTestId('files-find-go-up')
    expect(goUp.textContent).toBe('Go up to src')
    fireEvent.click(goUp)
    expect(box.value).toBe('src/')
    await screen.findByTestId('files-find-entry:main.ts')
    expect(screen.getByTestId('files-find-go-up').textContent).toBe('Go up to project files')
    fireEvent.click(screen.getByTestId('files-find-go-up'))
    expect(box.value).toBe('')
    expect(screen.getByTestId('files-tree')).toBeTruthy()
    // `folder/name` finds inside that folder.
    type('src/ma')
    await waitFor(() => expect(started.at(-1)?.request).toMatchObject({ kind: 'files', path: '/repo/src', query: 'ma' }))
  })

  it('`?text` searches contents with the toggles; hits are grouped by file and open at their line', async () => {
    const { started, type, onOpen } = setup()
    type('?')
    expect(screen.getByTestId('files-find-content-hint')).toBeTruthy()
    type('?needle')
    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]!.request).toEqual({
      kind: 'text',
      path: '/repo',
      query: 'needle',
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    })
    fireEvent.click(screen.getByTestId('files-find-match-case'))
    await waitFor(() => expect(started).toHaveLength(2))
    expect(started[1]!.request).toMatchObject({ caseSensitive: true })
    expect(screen.getByTestId('files-find-match-case').getAttribute('aria-pressed')).toBe('true')
    act(() =>
      started[1]!.publish({
        kind: 'text',
        searchId: 'y',
        scanning: false,
        truncated: false,
        files: [
          {
            path: 'src/main.ts',
            moreInFile: true,
            hits: [{ line: 7, text: 'const needle = 1', ranges: [6, 12] }],
          },
        ],
      }),
    )
    const hit = await screen.findByTestId('files-find-hit:src/main.ts:7')
    expect(hit.querySelector('mark')?.textContent).toBe('needle')
    expect(screen.getByTestId('files-find-hits:src/main.ts')).toBeTruthy()
    expect(screen.getByTestId('files-find-more-in-file:src/main.ts')).toBeTruthy()
    fireEvent.click(hit)
    expect(onOpen).toHaveBeenCalledWith('/repo/src/main.ts', 7)
  })

  it('a rejected regular expression marks the box invalid', async () => {
    const { started, box, type } = setup()
    type('?a(')
    fireEvent.click(screen.getByTestId('files-find-regex'))
    await waitFor(() => expect(started.at(-1)?.request).toMatchObject({ regex: true }))
    act(() =>
      started.at(-1)!.publish({ kind: 'text', searchId: 'z', scanning: false, truncated: false, files: [], error: 'invalid_regex' }),
    )
    expect(await screen.findByTestId('files-find-invalid-regex')).toBeTruthy()
    expect(box.getAttribute('aria-invalid')).toBe('true')
  })

  it('↓ from the box enters the results and ↑ on the first result returns', async () => {
    const { started, box, type } = setup()
    type('deep')
    await waitFor(() => expect(started).toHaveLength(1))
    act(() => started[0]!.publish(filesState([{ path: 'a.ts', ranges: [] }, { path: 'b.ts', ranges: [] }], false)))
    const first = await screen.findByTestId('files-find-file:a.ts')
    box.focus()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('files-find-file:b.ts'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(box)
  })
})
