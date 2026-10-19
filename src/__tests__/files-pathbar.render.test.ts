// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { FolderListing } from '../browser/webview/layout/fileTree'
import type { FilesListDir } from '../browser/webview/panes/FilesBrowse'
import { FilesPathBar } from '../browser/webview/panes/FilesPathBar'

/**
 * The Files pane's path bar (F-9): segments relative to the root; a folder
 * segment opens a dropdown of that folder's entries, folders first, with the
 * first row focused; folders expand in place, listed lazily; a file opens on
 * click or Enter and closes the dropdown; Escape closes it and returns focus
 * to the segment; the file-name segment opens its own folder with the file
 * selected; typed letters jump by name.
 */

const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })
const dir = (name: string) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false })

/** A lister over a fixed map; a path mapped to `null` (or missing) cannot be read. */
function fakeLister(table: Record<string, FolderListing | null>): FilesListDir & ReturnType<typeof vi.fn> {
  return vi.fn(async (path: string) => table[path] ?? null) as never
}

const REPO: Record<string, FolderListing | null> = {
  '/repo/a': { entries: [dir('b'), dir('docs'), file('notes.txt')], truncated: false },
  '/repo/a/b': { entries: [file('c.txt'), file('d.txt')], truncated: false },
  '/repo/a/docs': { entries: [], truncated: false },
}

const segment = (path: string) => screen.getByTestId(`files-pathbar-segment:${path}`)
const row = (path: string) => screen.getByTestId(`files-pathbar-dropdown-row:${path}`)
const findRow = (path: string) => screen.findByTestId(`files-pathbar-dropdown-row:${path}`)
const dropdown = () => screen.queryByTestId('files-pathbar-dropdown')

function renderBar(
  over: { listDir?: ReturnType<typeof fakeLister>; onOpen?: (path: string) => void; path?: string } = {},
) {
  const listDir = over.listDir ?? fakeLister(REPO)
  const onOpen = over.onOpen ?? vi.fn()
  render(
    createElement(FilesPathBar, {
      path: over.path ?? '/repo/a/b/c.txt',
      root: '/repo',
      listDir,
      onOpen,
      trailing: createElement('span', { 'data-testid': 'trailing' }),
    }),
  )
  return { listDir, onOpen }
}

/** Radix opens on pointerdown + click; a plain click is what a keyboard press gives too. */
const press = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { button: 0, pointerType: 'mouse' })
  fireEvent.click(el)
}

afterEach(cleanup)

describe('FilesPathBar', () => {
  it('shows the root-relative segments, the file name last, and keeps the trailing controls', () => {
    renderBar()
    const bar = screen.getByTestId('files-pathbar')
    const buttons = [...bar.querySelectorAll('[data-testid^="files-pathbar-segment:"]')]
    expect(buttons.map(button => button.textContent)).toEqual(['a', 'b', 'c.txt'])
    expect(buttons.map(button => button.getAttribute('data-kind'))).toEqual(['dir', 'dir', 'file'])
    expect(buttons[0].getAttribute('aria-haspopup')).toBe('tree')
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false')
    expect(bar.lastElementChild?.getAttribute('data-testid')).toBe('trailing')
  })

  it('a folder segment lists that folder, folders first, and focuses the first row', async () => {
    const { listDir } = renderBar()
    press(segment('/repo/a'))
    await findRow('/repo/a/b')
    expect(segment('/repo/a').getAttribute('aria-expanded')).toBe('true')
    expect(listDir).toHaveBeenCalledWith('/repo/a')
    const rows = [...dropdown()!.querySelectorAll('[data-testid^="files-pathbar-dropdown-row:"]')]
    expect(rows.map(each => each.getAttribute('data-kind'))).toEqual(['dir', 'dir', 'file'])
    await waitFor(() => expect(document.activeElement).toBe(row('/repo/a/b')))
  })

  it('expands a folder in place, listing it lazily, with → and by click', async () => {
    const { listDir } = renderBar()
    press(segment('/repo/a'))
    await findRow('/repo/a/b')
    await waitFor(() => expect(document.activeElement).toBe(row('/repo/a/b')))
    expect(listDir).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(row('/repo/a/b'), { key: 'ArrowRight' })
    await findRow('/repo/a/b/c.txt')
    expect(row('/repo/a/b').getAttribute('aria-expanded')).toBe('true')
    expect(row('/repo/a/b/c.txt').getAttribute('aria-level')).toBe('2')
    fireEvent.click(row('/repo/a/docs'))
    await screen.findByTestId('files-pathbar-dropdown-status:empty:/repo/a/docs')
    expect(listDir.mock.calls.map(call => call[0])).toEqual(['/repo/a', '/repo/a/b', '/repo/a/docs'])
    fireEvent.keyDown(row('/repo/a/b'), { key: 'ArrowLeft' })
    expect(screen.queryByTestId('files-pathbar-dropdown-row:/repo/a/b/c.txt')).toBeNull()
  })

  it('Enter on a file opens it and closes the dropdown; a click does the same', async () => {
    const { onOpen } = renderBar()
    press(segment('/repo/a'))
    await findRow('/repo/a/notes.txt')
    fireEvent.keyDown(row('/repo/a/notes.txt'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('/repo/a/notes.txt')
    await waitFor(() => expect(dropdown()).toBeNull())
    press(segment('/repo/a/b'))
    fireEvent.click(await findRow('/repo/a/b/d.txt'))
    expect(onOpen).toHaveBeenLastCalledWith('/repo/a/b/d.txt')
    await waitFor(() => expect(dropdown()).toBeNull())
  })

  it('Escape closes the dropdown and returns focus to the segment', async () => {
    renderBar()
    press(segment('/repo/a'))
    await findRow('/repo/a/b')
    await waitFor(() => expect(document.activeElement).toBe(row('/repo/a/b')))
    fireEvent.keyDown(row('/repo/a/b'), { key: 'Escape' })
    await waitFor(() => expect(dropdown()).toBeNull())
    expect(document.activeElement).toBe(segment('/repo/a'))
    expect(segment('/repo/a').getAttribute('aria-expanded')).toBe('false')
  })

  it("the file-name segment opens the file's own folder with the file selected", async () => {
    renderBar()
    press(segment('/repo/a/b/c.txt'))
    await findRow('/repo/a/b/c.txt')
    expect(row('/repo/a/b/c.txt').getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(row('/repo/a/b/c.txt')))
    fireEvent.keyDown(row('/repo/a/b/c.txt'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('/repo/a/b/d.txt'))
  })

  it('typing jumps to the next row starting with those letters', async () => {
    renderBar()
    press(segment('/repo/a'))
    await findRow('/repo/a/b')
    await waitFor(() => expect(document.activeElement).toBe(row('/repo/a/b')))
    let now = 10_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      fireEvent.keyDown(row('/repo/a/b'), { key: 'n' })
      expect(document.activeElement).toBe(row('/repo/a/notes.txt'))
      // Within the gap the letters extend one prefix: no row starts with "nd".
      now += 100
      fireEvent.keyDown(row('/repo/a/notes.txt'), { key: 'd' })
      expect(document.activeElement).toBe(row('/repo/a/notes.txt'))
      now += 5_000
      fireEvent.keyDown(row('/repo/a/notes.txt'), { key: 'd' })
      expect(document.activeElement).toBe(row('/repo/a/docs'))
    } finally {
      clock.mockRestore()
    }
  })

  it('an unreadable folder shows the read-error row', async () => {
    renderBar({ listDir: fakeLister({}) })
    press(segment('/repo/a'))
    await screen.findByTestId('files-pathbar-dropdown-status:error:/repo/a')
  })
})
