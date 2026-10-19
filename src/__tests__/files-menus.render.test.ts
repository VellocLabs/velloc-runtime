// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The editor body is not under test here; keep CodeMirror out of the module graph.
vi.mock('../browser/webview/FilePanel', () => ({
  FilePanel: (props: { target: { path: string } }) =>
    createElement('div', { 'data-testid': `editor:${props.target.path}` }),
}))

import { defaultFilesEditorPrefs } from '../browser/webview/layout/filesEditor'
import type { FolderListing } from '../browser/webview/layout/fileTree'
import type { FilesListDir } from '../browser/webview/panes/FilesBrowse'
import { relativeToRoots, showInFolderLabel, tabMenuCloses } from '../browser/webview/panes/filesMenuModel'
import { FilesOptionsMenu } from '../browser/webview/panes/FilesOptionsMenu'
import { FilesPane, type FilesPaneProps } from '../browser/webview/panes/FilesPane'
import { FilesTabMenu, type FilesTabMenuActions } from '../browser/webview/panes/FilesTabMenu'

/**
 * The Files pane's menus (F-9): the tab menu's items, in order, with the
 * bulk closes and the host-only items present only when they apply; the row
 * menu on a tree row copies the row's paths; the options menu toggles word
 * wrap and picks a tab size.
 */

const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => cleanup())

const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })
const dir = (name: string) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false })
const REPO: Record<string, FolderListing | null> = {
  '/repo': { entries: [dir('src'), file('README.md')], truncated: false },
  '/repo/src': { entries: [file('main.ts')], truncated: false },
}
const lister: FilesListDir = async path => REPO[path] ?? null

const menuItems = (menu: string) =>
  Array.from(screen.getByTestId(menu).querySelectorAll('[data-testid^="files-menu-"]')).map(el =>
    el.getAttribute('data-testid'),
  )

function openSubmenu(testId: string) {
  act(() => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'ArrowRight' })
  })
}

describe('filesMenuModel', () => {
  it('makes a path relative to the root that holds it, in its own separator', () => {
    expect(relativeToRoots('/repo/src/a.ts', ['/other', '/repo'])).toBe('src/a.ts')
    expect(relativeToRoots('D:\\Repo\\src\\a.ts', ['d:/repo'])).toBe('src\\a.ts')
    expect(relativeToRoots('/Repo/a.ts', ['/repo'])).toBeNull()
    expect(relativeToRoots('/elsewhere/a.ts', ['/repo'])).toBeNull()
    expect(relativeToRoots('/repo', ['/repo'])).toBeNull()
  })

  it('names the file manager by platform', () => {
    expect(showInFolderLabel('Win32')).toBe('filesMenu.showInExplorer')
    expect(showInFolderLabel('MacIntel')).toBe('filesMenu.showInFinder')
    expect(showInFolderLabel('Linux x86_64')).toBe('filesMenu.showInFileManager')
    expect(showInFolderLabel(undefined)).toBe('filesMenu.showInFileManager')
  })

  it('offers the bulk closes only when they apply', () => {
    expect(tabMenuCloses(['/a'], '/a')).toEqual({ others: false, right: false, all: false })
    expect(tabMenuCloses(['/a', '/b'], '/a')).toEqual({ others: true, right: true, all: true })
    expect(tabMenuCloses(['/a', '/b'], '/b')).toEqual({ others: true, right: false, all: true })
  })
})

describe('FilesTabMenu', () => {
  const actions = (over: Partial<FilesTabMenuActions>): FilesTabMenuActions => ({
    roots: ['/repo'],
    tabs: ['/repo/a.ts', '/repo/b.ts'],
    onFind: vi.fn(),
    onCopyContents: vi.fn(),
    onReload: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseAll: vi.fn(),
    ...over,
  })
  const open = (props: FilesTabMenuActions, path = '/repo/a.ts') => {
    render(createElement(FilesTabMenu, { path, ...props, children: createElement('div', { 'data-testid': 'tab' }) }))
    fireEvent.contextMenu(screen.getByTestId('tab'))
  }

  it('lists every item in order when the host can reveal and the tree can show the file', async () => {
    open(actions({ onAttach: vi.fn(), onShowInFolder: vi.fn(), onRevealInTree: vi.fn() }))
    await screen.findByTestId('files-tab-menu')
    expect(menuItems('files-tab-menu')).toEqual([
      'files-menu-attach',
      'files-menu-copy',
      'files-menu-show-in-folder',
      'files-menu-reveal-in-tree',
      'files-menu-find',
      'files-menu-copy-contents',
      'files-menu-reload',
      'files-menu-close',
      'files-menu-close-others',
      'files-menu-close-right',
      'files-menu-close-all',
    ])
    expect(screen.getByTestId('files-tab-menu').querySelectorAll('[role="separator"]')).toHaveLength(4)
  })

  it('omits what does not apply: no host reveal, a single tab', async () => {
    open(actions({ tabs: ['/repo/a.ts'] }))
    await screen.findByTestId('files-tab-menu')
    expect(menuItems('files-tab-menu')).toEqual([
      'files-menu-copy',
      'files-menu-find',
      'files-menu-copy-contents',
      'files-menu-reload',
      'files-menu-close',
    ])
  })

  it('hands the right-clicked tab to each action', async () => {
    const props = actions({ onShowInFolder: vi.fn() })
    open(props, '/repo/a.ts')
    fireEvent.click(await screen.findByTestId('files-menu-close-others'))
    expect(props.onCloseOthers).toHaveBeenCalledWith('/repo/a.ts')
    fireEvent.contextMenu(screen.getByTestId('tab'))
    fireEvent.click(await screen.findByTestId('files-menu-show-in-folder'))
    expect(props.onShowInFolder).toHaveBeenCalledWith('/repo/a.ts')
  })
})

describe('row menu in the Files pane', () => {
  const base = (over: Partial<FilesPaneProps>): FilesPaneProps => ({
    state: { tabs: [], active: null },
    sessionKey: 's1',
    onActivate: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseTabs: vi.fn(),
    protectedPaths: new Set(),
    onDirtyChange: vi.fn(),
    onOpen: vi.fn(),
    listDir: lister,
    roots: ['/repo'],
    frame: ({ title, actions, body }) => createElement('div', null, title, actions, body),
    ...over,
  })

  it('right-clicking a tree row opens its menu; Copy ▸ Filename and Relative path write the clipboard', async () => {
    const onAttach = vi.fn()
    render(createElement(FilesPane, base({ onAttach })))
    fireEvent.contextMenu(await screen.findByTestId('files-tree-row:/repo/README.md'))
    await screen.findByTestId('files-row-menu')
    expect(menuItems('files-row-menu')).toEqual(['files-menu-attach', 'files-menu-copy'])
    openSubmenu('files-menu-copy')
    fireEvent.click(await screen.findByTestId('files-menu-copy-name'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('README.md'))

    fireEvent.contextMenu(screen.getByTestId('files-tree-row:/repo/src'))
    await screen.findByTestId('files-menu-copy')
    openSubmenu('files-menu-copy')
    fireEvent.click(await screen.findByTestId('files-menu-copy-relative'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('src'))

    fireEvent.contextMenu(screen.getByTestId('files-tree-row:/repo/src'))
    fireEvent.click(await screen.findByTestId('files-menu-attach'))
    expect(onAttach).toHaveBeenCalledWith('/repo/src')
  })

  it('a tab right-click closes others through onCloseTabs; the ⋯ menu shows while a file is open', async () => {
    const onCloseTabs = vi.fn()
    render(
      createElement(
        FilesPane,
        base({ state: { tabs: ['/repo/a.ts', '/repo/b.ts'], active: '/repo/b.ts' }, onCloseTabs }),
      ),
    )
    expect(screen.getByTestId('files-pane-options')).toBeTruthy()
    fireEvent.contextMenu(screen.getByTestId('files-pane-tab:/repo/a.ts'))
    fireEvent.click(await screen.findByTestId('files-menu-close-others'))
    expect(onCloseTabs).toHaveBeenCalledWith('others', '/repo/a.ts')
  })
})

describe('FilesOptionsMenu', () => {
  const openMenu = () =>
    act(() => {
      fireEvent.keyDown(screen.getByTestId('files-pane-options'), { key: 'Enter' })
    })

  it('toggles word wrap, keeping the menu open, and picks a tab size', async () => {
    const onEditorChange = vi.fn()
    render(createElement(FilesOptionsMenu, { editor: defaultFilesEditorPrefs(), onEditorChange }))
    openMenu()
    expect(screen.queryByTestId('files-options-tree')).toBeNull()
    const wrap = await screen.findByTestId('files-options-wrap')
    expect(wrap.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(wrap)
    expect(onEditorChange).toHaveBeenCalledWith({ wordWrap: false })
    expect(screen.getByTestId('files-options-menu')).toBeTruthy()
    openSubmenu('files-options-tab-size')
    expect(screen.getByTestId('files-options-tab-size:4').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('files-options-tab-size:8'))
    expect(onEditorChange).toHaveBeenCalledWith({ tabSize: 8 })
  })

  it('shows the file tree toggle when the pane hands one', async () => {
    const onTreeVisibleChange = vi.fn()
    render(
      createElement(FilesOptionsMenu, {
        editor: defaultFilesEditorPrefs(),
        onEditorChange: vi.fn(),
        treeVisible: false,
        onTreeVisibleChange,
      }),
    )
    openMenu()
    fireEvent.click(await screen.findByTestId('files-options-tree'))
    expect(onTreeVisibleChange).toHaveBeenCalledWith(true)
  })
})
