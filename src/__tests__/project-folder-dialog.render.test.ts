// @vitest-environment happy-dom
/**
 * The forced "open a project folder" dialog: its known-folder quick picks (the
 * way out for a client that may not use the desktop's picker — any scope may
 * bind a folder the runtime already knows) and the picker button gated on the
 * connection's grant.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  MAX_DIALOG_KNOWN_FOLDERS,
  ProjectFolderDialog,
  WorkspaceProjectFolderDialog,
  knownProjectFolders,
} from '../browser/webview/ThreadDialogs'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { WorkspaceStore, resetWorkspaceStoreForTests } from '../browser/webview/workspaceStore'

afterEach(() => {
  cleanup()
  resetWorkspaceStoreForTests(null)
})

describe('knownProjectFolders', () => {
  it('lists workspace projects, then recent folders, once each, capped', () => {
    const folders = knownProjectFolders(
      [{ path: '/work/api', addedAt: 1 }, { path: 'C:\\Code\\web', addedAt: 2 }],
      [
        { path: '/work/api/', name: 'api', lastUsedAt: 3 },
        { path: '/tmp/scratch', name: 'scratch', lastUsedAt: 4 },
      ],
    )
    expect(folders).toEqual([
      { path: '/work/api', name: 'api' },
      { path: 'C:\\Code\\web', name: 'web' },
      { path: '/tmp/scratch', name: 'scratch' },
    ])
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `/p${i}`, addedAt: i }))
    expect(knownProjectFolders(many, [])).toHaveLength(MAX_DIALOG_KNOWN_FOLDERS)
  })
})

describe('ProjectFolderDialog (render)', () => {
  const known = [
    { path: '/work/api', name: 'api' },
    { path: '/tmp/scratch', name: 'scratch' },
  ]

  it('binds a known folder directly, and still offers the picker when the connection may use it', () => {
    const onSelectFolder = vi.fn()
    const onOpenFolder = vi.fn()
    render(
      createElement(ProjectFolderDialog, {
        onOpenFolder,
        onSelectFolder,
        knownFolders: known,
        onCancel: vi.fn(),
      }),
    )
    expect(screen.getByRole('group', { name: 'Your folders' })).toBeTruthy()
    fireEvent.click(screen.getByTitle('/tmp/scratch'))
    expect(onSelectFolder).toHaveBeenCalledWith('/tmp/scratch')
    expect(onOpenFolder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
  })

  it('a connection without the picker gets the known folders and no Open button', () => {
    const { container } = render(
      createElement(ProjectFolderDialog, {
        onOpenFolder: vi.fn(),
        onSelectFolder: vi.fn(),
        knownFolders: known,
        canOpenFolder: false,
        onCancel: vi.fn(),
      }),
    )
    expect(container.querySelectorAll('.aui-project-folder-dialog-known-item')).toHaveLength(2)
    expect(container.querySelector('.aui-project-folder-dialog-open')).toBeNull()
    expect(container.querySelector('.aui-project-folder-dialog-none')).toBeNull()
  })

  it('with neither the picker nor a known folder, it says so instead of offering a dead button', () => {
    const { container } = render(
      createElement(ProjectFolderDialog, {
        onOpenFolder: vi.fn(),
        onSelectFolder: vi.fn(),
        knownFolders: [],
        canOpenFolder: false,
        onCancel: vi.fn(),
      }),
    )
    expect(container.querySelector('.aui-project-folder-dialog-open')).toBeNull()
    expect(screen.getByText('No project folders yet. Open one on the desktop first.')).toBeTruthy()
  })

  it('the workspace-fed dialog lists the mirror’s folders, follows its changes, and asks the grant for the picker', () => {
    // No storage and no connection: the store holds what it is told, locally.
    const store = new WorkspaceStore(() => undefined)
    store.addProject('/work/api')
    resetWorkspaceStoreForTests(store)
    const noPicker = { can: (cap: string, act?: string) => !(cap === 'ui' && act === 'pickProjectFolder') }
    const onSelectFolder = vi.fn()
    const { container } = render(
      createElement(
        RuntimeCapabilitiesContext.Provider,
        { value: noPicker },
        createElement(WorkspaceProjectFolderDialog, { onOpenFolder: vi.fn(), onSelectFolder, onCancel: vi.fn() }),
      ),
    )
    expect(container.querySelector('.aui-project-folder-dialog-open')).toBeNull()
    act(() => {
      store.addRecentFolder('/tmp/scratch')
    })
    expect(
      Array.from(container.querySelectorAll('.aui-project-folder-dialog-known-item')).map(el =>
        el.getAttribute('data-path'),
      ),
    ).toEqual(['/work/api', '/tmp/scratch'])
    fireEvent.click(screen.getByTitle('/work/api'))
    expect(onSelectFolder).toHaveBeenCalledWith('/work/api')
  })

  it('a grant limited to some sessions is offered no workspace folder — the runtime refuses each one', () => {
    const store = new WorkspaceStore(() => undefined)
    store.addProject('/work/api')
    store.addRecentFolder('/tmp/scratch')
    resetWorkspaceStoreForTests(store)
    const sessionLimited = { can: () => false, allSessions: () => false }
    const { container } = render(
      createElement(
        RuntimeCapabilitiesContext.Provider,
        { value: sessionLimited },
        createElement(WorkspaceProjectFolderDialog, { onOpenFolder: vi.fn(), onSelectFolder: vi.fn(), onCancel: vi.fn() }),
      ),
    )
    expect(container.querySelectorAll('.aui-project-folder-dialog-known-item')).toHaveLength(0)
    expect(screen.getByText('No project folders yet. Open one on the desktop first.')).toBeTruthy()
  })

  it('without onSelectFolder the list is not offered (the desktop default is unchanged)', () => {
    const { container } = render(
      createElement(ProjectFolderDialog, { onOpenFolder: vi.fn(), knownFolders: known, onCancel: vi.fn() }),
    )
    expect(container.querySelector('.aui-project-folder-dialog-known')).toBeNull()
    expect(container.querySelector('.aui-project-folder-dialog-open')).not.toBeNull()
  })
})
