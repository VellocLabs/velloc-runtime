// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, Fragment, useState } from 'react'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import { SessionDeleteConfirm, type SessionDeleteTarget } from '../browser/webview/SessionDeleteDialog'

// How the shell wires the delete confirmation: a sidebar row's Delete opens
// the dialog instead of deleting; confirm deletes through the shell's delete
// handler (with the nested rows when ticked, the active session last); Cancel
// and Escape delete nothing; the folder picker's cancel still deletes at once.
// The render half mounts the Sidebar and the confirmation as the shell does;
// the source half pins that the shell mounts them that way. (F-36)

const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

afterEach(() => {
  cleanup()
  memoryStorage.clear()
})

const NOW = Date.now()
function item(sessionId: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return { sessionId, title: sessionId, previewText: '', updatedAt: NOW - 1000, ...extra }
}
const under = (parentSessionId: string, lineageKind: SessionListItem['lineageKind'] = 'side_session') => ({
  parentSessionId,
  lineageKind,
})

/** The shell's two pieces, wired as the shell wires them. */
function ShellDelete({
  sessions,
  activeSessionId,
  onDelete,
  onShow = () => {},
}: {
  sessions: SessionListItem[]
  activeSessionId: string
  onDelete: (sessionId: string) => void | Promise<void>
  onShow?: (sessionId: string) => void
}) {
  const [target, setTarget] = useState<SessionDeleteTarget | null>(null)
  const projectPaths = [...new Set(sessions.flatMap(s => (s.projectRoot ? [s.projectRoot] : [])))]
  return createElement(
    Fragment,
    null,
    createElement(Sidebar, {
      title: 'Conversation',
      sessionId: activeSessionId,
      activeSessionId,
      sessions,
      addedProjectPaths: projectPaths,
      addedProjectOrder: new Map(projectPaths.map((path, i) => [path, i] as const)),
      onDeleteThread: (sessionId, origin) => setTarget({ ...origin, sessionId }),
    }),
    createElement(SessionDeleteConfirm, {
      target,
      sessions,
      activeSessionId,
      onShow,
      onDelete,
      onClose: () => setTarget(null),
    }),
  )
}

/** Opens the row's menu and presses Delete; `scope` picks one list's copy of the row. */
async function clickRowDelete(sessionId: string, scope: HTMLElement = document.body) {
  const row = Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="sidebar-row-${sessionId}"]`)).find(
    el => scope !== document.body || !el.closest('[data-testid="sidebar-project-child"]'),
  )!
  const trigger = row.parentElement!.querySelector<HTMLElement>('[data-testid="sidebar-row-actions"]')!
  fireEvent.pointerDown(trigger)
  fireEvent.click(trigger)
  await screen.findByRole('menu')
  fireEvent.click(screen.getByTestId('sidebar-delete-thread'))
}

const family = [
  item('p'),
  item('c', under('p')),
  item('g', { ...under('c'), running: true }),
  item('t', under('p', 'team')),
  item('d', { ...under('p'), detached: true }),
  item('other'),
]

describe('the sidebar delete, wired as the shell wires it', () => {
  it('opens the dialog and deletes nothing yet', async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'other', onDelete }))
    await clickRowDelete('p')
    expect(screen.getByTestId('session-delete-dialog')).toBeTruthy()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('Delete this session deletes the parent alone', async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'other', onDelete }))
    await clickRowDelete('p')
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onDelete.mock.calls).toEqual([['p']])
    expect(screen.queryByTestId('session-delete-dialog')).toBeNull()
  })

  it('Delete all deletes the nested rows with the active one last, sparing a teammate and a detached row', async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'c', onDelete }))
    await clickRowDelete('p')
    expect(screen.getByTestId('session-delete-all').textContent).toBe('Delete all 3 sessions')
    expect(screen.getByTestId('session-delete-busy').textContent).toBe(
      '1 of the nested sessions is still working; deleting all stops it.',
    )
    fireEvent.click(screen.getByTestId('session-delete-all'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['p', 'g', 'c'])
  })

  it('covers the page while it runs, starting each delete only after the previous one settled', async () => {
    const settle: Array<() => void> = []
    const onDelete = vi.fn((_id: string) => new Promise<void>(resolve => settle.push(resolve)))
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'c', onDelete }))
    await clickRowDelete('p')
    fireEvent.click(screen.getByTestId('session-delete-all'))
    const cover = await screen.findByTestId('session-delete-progress')
    expect(screen.queryByTestId('session-delete-dialog')).toBeNull()
    expect(cover.dataset.total).toBe('3')
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['p'])
    settle.shift()!()
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('session-delete-progress').dataset.done).toBe('1')
    settle.shift()!()
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(3))
    settle.shift()!()
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['p', 'g', 'c'])
  })

  it('before the first delete, moves the screen to the surviving top-level row when the shown session goes', async () => {
    const calls: string[] = []
    const onShow = vi.fn((id: string) => calls.push(`show ${id}`))
    const onDelete = vi.fn((id: string) => {
      calls.push(`delete ${id}`)
    })
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'g', onDelete, onShow }))
    await clickRowDelete('c')
    fireEvent.click(screen.getByTestId('session-delete-all'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    // `c` is nested under `p`, which survives: that top-level row is shown.
    expect(calls).toEqual(['show p', 'delete c', 'delete g'])
  })

  it('moves to the next top-level row when the shown top-level session itself goes', async () => {
    const onShow = vi.fn()
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'c', onDelete, onShow }))
    await clickRowDelete('p')
    fireEvent.click(screen.getByTestId('session-delete-all'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onShow.mock.calls).toEqual([['other']])
    expect(onShow.mock.invocationCallOrder[0]!).toBeLessThan(onDelete.mock.invocationCallOrder[0]!)
  })

  it('never moves the screen to a session this channel hides', async () => {
    const sessions = [
      item('p', { updatedAt: NOW }),
      item('unlisted', { updatedAt: NOW - 500, templateType: 'no-such-launcher-type' }),
      item('kept', { updatedAt: NOW - 2000 }),
    ]
    const onShow = vi.fn()
    render(createElement(ShellDelete, { sessions, activeSessionId: 'p', onDelete: vi.fn(), onShow }))
    await clickRowDelete('p')
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onShow.mock.calls).toEqual([['kept']])
  })

  it('leaves the screen alone when the shown session survives', async () => {
    const onShow = vi.fn()
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'c', onDelete, onShow }))
    await clickRowDelete('p')
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onDelete.mock.calls).toEqual([['p']])
    expect(onShow).not.toHaveBeenCalled()
  })

  it('Cancel and Escape close the dialog and delete nothing', async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'other', onDelete }))
    await clickRowDelete('p')
    fireEvent.click(screen.getByTestId('session-delete-cancel'))
    expect(screen.queryByTestId('session-delete-dialog')).toBeNull()
    await clickRowDelete('p')
    fireEvent.keyDown(screen.getByTestId('session-delete-confirm'), { key: 'Escape' })
    expect(screen.queryByTestId('session-delete-dialog')).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })

  // P sits in folder A, with one child in A and one in B. Folder A's list nests
  // only the A child under P; Recents nests both.
  const A = 'D:\\work\\alpha'
  const B = 'D:\\work\\beta'
  const split = [
    item('P', { projectRoot: A }),
    item('cA', { ...under('P'), projectRoot: A }),
    item('cB', { ...under('P'), projectRoot: B, running: true }),
  ]

  function openFolder(path: string): HTMLElement {
    if (!screen.queryAllByTestId('sidebar-project-row').length) {
      fireEvent.click(screen.getByTestId('sidebar-projects-toggle'))
    }
    const folderRow = screen.getAllByTestId('sidebar-project-row').find(el => el.dataset.projectPath === path)!
    fireEvent.click(folderRow)
    return screen.getAllByTestId('sidebar-project-child').find(el => el.dataset.projectPath === path)!
  }

  it("from a Projects row, counts and deletes only that folder's nested rows", async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: split, activeSessionId: 'none', onDelete }))
    const folderA = openFolder(A)
    expect(within(folderA).queryByTestId('sidebar-row-cB')).toBeNull()
    await clickRowDelete('P', folderA)
    expect(screen.getByTestId('session-delete-all').textContent).toBe('Delete all 2 sessions')
    expect(screen.queryByTestId('session-delete-busy')).toBeNull()
    fireEvent.click(screen.getByTestId('session-delete-all'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['P', 'cA'])
  })

  it('from the Recents row, the same parent still takes every child it nests there', async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: split, activeSessionId: 'none', onDelete }))
    openFolder(A)
    await clickRowDelete('P')
    expect(screen.getByTestId('session-delete-all').textContent).toBe('Delete all 3 sessions')
    expect(screen.getByTestId('session-delete-busy').textContent).toBe(
      '1 of the nested sessions is still working; deleting all stops it.',
    )
    fireEvent.click(screen.getByTestId('session-delete-all'))
    await waitFor(() => expect(screen.queryByTestId('session-delete-progress')).toBeNull())
    expect(onDelete.mock.calls.map(call => call[0]).sort()).toEqual(['P', 'cA', 'cB'])
  })

  it('closes when the target row is no longer listed', async () => {
    const onDelete = vi.fn()
    const view = render(createElement(ShellDelete, { sessions: family, activeSessionId: 'other', onDelete }))
    await clickRowDelete('other')
    expect(screen.getByTestId('session-delete-dialog')).toBeTruthy()
    view.rerender(
      createElement(ShellDelete, {
        sessions: family.filter(s => s.sessionId !== 'other'),
        activeSessionId: 'p',
        onDelete,
      }),
    )
    expect(screen.queryByTestId('session-delete-dialog')).toBeNull()
  })
})

// The source half: the shell must mount the pieces as rendered above.
const shellSource = readFileSync(join(__dirname, '..', 'browser', 'webview', 'MultiSessionShell.tsx'), 'utf8')
const shellFile = ts.createSourceFile('MultiSessionShell.tsx', shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const threadSource = readFileSync(join(__dirname, '..', 'browser', 'webview', 'shellSessionThread.tsx'), 'utf8')
const threadFile = ts.createSourceFile('shellSessionThread.tsx', threadSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** Each JSX element named `tag` in `file`, with its attributes' source text by name. */
function jsxElements(tag: string, file: ts.SourceFile = shellFile): Map<string, string>[] {
  const found: Map<string, string>[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(file) === tag
    ) {
      const attrs = new Map<string, string>()
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)) {
          attrs.set(attr.name.getText(file), attr.initializer.expression?.getText(file) ?? '')
        }
      }
      found.push(attrs)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('MultiSessionShell wiring', () => {
  it("routes the sidebar's Delete to the confirmation target", () => {
    const sidebars = jsxElements('Sidebar')
    expect(sidebars).toHaveLength(1)
    expect(sidebars[0]!.get('onDeleteThread')).toBe('requestSessionDelete')
  })

  it("keeps the Delete's Projects folder on the confirmation target", () => {
    expect(shellSource).toMatch(/const requestSessionDelete = useMemo\(\s*\(\) => createShellRequestSessionDelete\(setSessionDeleteTarget\)/)
    const threadActions = readFileSync(join(__dirname, '..', 'browser', 'webview', 'shellThreadActions.ts'), 'utf8')
    const body = /function createShellRequestSessionDelete\(([\s\S]*?)\n\}\n/.exec(threadActions)?.[1] ?? ''
    expect(body).toMatch(/\(sessionId: string, origin\?: SessionDeleteOrigin\)/)
    expect(body).toMatch(/setSessionDeleteTarget\(\{ \.\.\.origin, sessionId \}\)/)
  })

  it('mounts the confirmation over the same list, deleting through the awaited shell handler', () => {
    const confirms = jsxElements('SessionDeleteConfirm')
    expect(confirms).toHaveLength(1)
    const attrs = confirms[0]!
    expect(attrs.get('target')).toBe('sessionDeleteTarget')
    expect(attrs.get('sessions')).toBe(jsxElements('Sidebar')[0]!.get('sessions'))
    expect(attrs.get('activeSessionId')).toBe('activeSessionId')
    expect(attrs.get('onShow')).toBe('focusSession')
    expect(attrs.get('onDelete')).toBe('deleteAndAwaitRemoval')
    expect(attrs.get('onClose')).toBeTruthy()
    expect(shellSource).toMatch(
      /const deleteAndAwaitRemoval = useMemo\(\s*\(\) => createShellDeleteAndAwaitRemoval\(handleDeleteThread, sessionRemovalWaitersRef\)/,
    )
  })

  it("settles a delete as removed on the runtime's removal of that session", () => {
    const removed = /if \(data\.type === 'session\.removed'\) \{([\s\S]*?)\n {6}\}/.exec(shellSource)?.[1] ?? ''
    expect(removed).toMatch(/sessionRemovalWaitersRef\.current\.get\(payload\.sessionId\)\?\.\(true\)/)
  })

  it("keeps the folder picker's cancel deleting at once, without the dialog", () => {
    const threads = jsxElements('AssistantUiThread', threadFile)
    expect(threads.length).toBeGreaterThan(0)
    for (const attrs of threads) {
      if (attrs.has('onDeleteThread')) expect(attrs.get('onDeleteThread')).toBe('handleDeleteThread')
    }
  })
})
