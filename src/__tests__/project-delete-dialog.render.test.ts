// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListItem } from '../browser/webview/Sidebar'
import { ProjectDeleteConfirm, projectDeletionPlan } from '../browser/webview/ProjectDeleteDialog'

// A project's delete: which sessions go and in what order, one at a time
// behind the progress cover, the screen moved off a doomed session first,
// and the shell mounting it over the awaited delete handler. (F-17)

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

const A = 'D:/work/api'
const NOW = Date.now()
function item(sessionId: string, extra: Partial<SessionListItem> = {}, age = 1000): SessionListItem {
  return { sessionId, title: sessionId, previewText: '', updatedAt: NOW - age, ...extra }
}

describe('projectDeletionPlan', () => {
  it('takes every session filed under the folder, whatever the path spelling, the shown one last', () => {
    const sessions = [
      { sessionId: 'a1', projectRoot: 'D:/work/api' },
      { sessionId: 'b1', projectRoot: 'D:/work/web' },
      { sessionId: 'a2', projectRoot: 'd:\\work\\api\\' },
      { sessionId: 'free' },
      { sessionId: 'a3', projectRoot: 'D:/work/api' },
    ]
    expect(projectDeletionPlan(sessions, A, 'a1')).toEqual({
      order: ['a2', 'a3', 'a1'],
      gone: ['a1', 'a2', 'a3'],
      anchor: 'a1',
    })
    expect(projectDeletionPlan(sessions, A, 'b1').order).toEqual(['a1', 'a2', 'a3'])
  })

  it('leaves a teammate to its lead, counts it as gone, and anchors a shown teammate on its lead', () => {
    const sessions = [
      { sessionId: 'lead', projectRoot: A },
      { sessionId: 'mate', projectRoot: A, spawnerSessionId: 'lead' },
      { sessionId: 'away', projectRoot: 'D:/elsewhere', spawnerSessionId: 'lead' },
      { sessionId: 'solo', projectRoot: A },
      { sessionId: 'stray', projectRoot: A, spawnerSessionId: 'elsewhere' },
    ]
    expect(projectDeletionPlan(sessions, A, 'none')).toEqual({
      order: ['lead', 'solo', 'stray'],
      gone: ['lead', 'solo', 'stray', 'mate', 'away'],
      anchor: 'none',
    })
    const shownMate = projectDeletionPlan(sessions, A, 'mate')
    expect(shownMate.order).toEqual(['solo', 'stray', 'lead'])
    expect(shownMate.anchor).toBe('lead')
  })

  it('is empty for a folder no session is filed under', () => {
    expect(projectDeletionPlan([{ sessionId: 'x', projectRoot: 'D:/other' }], A, 'x')).toEqual({
      order: [],
      gone: [],
      anchor: 'x',
    })
  })
})

/** A delete that settles only when the test says so. */
function manualDeletes() {
  const pending = new Map<string, () => void>()
  const calls: string[] = []
  const onDelete = vi.fn(
    (sessionId: string) =>
      new Promise<void>(resolve => {
        calls.push(sessionId)
        pending.set(sessionId, resolve)
      }),
  )
  const settle = async (sessionId: string) => {
    await act(async () => {
      pending.get(sessionId)!()
      await Promise.resolve()
    })
  }
  return { onDelete, calls, settle }
}

const listed = [
  item('keep', {}, 100),
  item('a1', { projectRoot: A }, 200),
  item('a2', { projectRoot: A }, 300),
  item('a3', { projectRoot: A }, 400),
]

function mount(props: Partial<Parameters<typeof ProjectDeleteConfirm<SessionListItem>>[0]> = {}) {
  const handlers = {
    onShow: vi.fn(),
    onDeleted: vi.fn(),
    onCancel: vi.fn(),
  }
  render(
    createElement(ProjectDeleteConfirm<SessionListItem>, {
      target: { path: A },
      sessions: listed,
      listed,
      activeSessionId: 'a1',
      onDelete: vi.fn(),
      ...handlers,
      ...props,
    }),
  )
  return handlers
}

describe('ProjectDeleteConfirm', () => {
  it('deletes one session at a time behind the cover, then drops the project', async () => {
    const { onDelete, calls, settle } = manualDeletes()
    const { onDeleted } = mount({ onDelete })
    fireEvent.click(screen.getByTestId('project-delete-confirm'))

    expect(screen.queryByTestId('project-delete-dialog')).toBeNull()
    const cover = screen.getByTestId('session-delete-progress')
    expect(cover.getAttribute('data-total')).toBe('3')
    await waitFor(() => expect(calls).toEqual(['a2']))
    expect(cover.textContent).toContain('0 of 3 deleted')

    await settle('a2')
    await waitFor(() => expect(calls).toEqual(['a2', 'a3']))
    expect(screen.getByTestId('session-delete-progress').textContent).toContain('1 of 3 deleted')
    expect(onDeleted).not.toHaveBeenCalled()

    await settle('a3')
    await waitFor(() => expect(calls).toEqual(['a2', 'a3', 'a1']))
    await settle('a1')
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(A))
    expect(screen.queryByTestId('session-delete-progress')).toBeNull()
  })

  it('moves the screen to a surviving session before the first delete', async () => {
    const order: string[] = []
    const onShow = vi.fn((id: string) => void order.push(`show:${id}`))
    const onDelete = vi.fn((id: string) => void order.push(`delete:${id}`))
    const { onDeleted } = mount({ onShow, onDelete })
    fireEvent.click(screen.getByTestId('project-delete-confirm'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(order).toEqual(['show:keep', 'delete:a2', 'delete:a3', 'delete:a1'])
  })

  it('leaves the screen alone when the shown session survives', async () => {
    const onShow = vi.fn()
    const onDelete = vi.fn()
    const { onDeleted } = mount({ onShow, onDelete, activeSessionId: 'keep' })
    fireEvent.click(screen.getByTestId('project-delete-confirm'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(onShow).not.toHaveBeenCalled()
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['a1', 'a2', 'a3'])
  })

  it('goes on past a failed delete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onDelete = vi.fn((id: string) => (id === 'a2' ? Promise.reject(new Error('locked')) : undefined))
    const { onDeleted } = mount({ onDelete })
    fireEvent.click(screen.getByTestId('project-delete-confirm'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(A))
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['a2', 'a3', 'a1'])
  })

  it('moves the screen off a shown teammate before its lead, deleted last, takes it', async () => {
    const order: string[] = []
    const onShow = vi.fn((id: string) => void order.push(`show:${id}`))
    const onDelete = vi.fn((id: string) => void order.push(`delete:${id}`))
    const sessions = [...listed, item('mate', { projectRoot: A, spawnerSessionId: 'a2' })]
    const { onDeleted } = mount({ sessions, onShow, onDelete, activeSessionId: 'mate' })
    fireEvent.click(screen.getByTestId('project-delete-confirm'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(order).toEqual(['show:keep', 'delete:a1', 'delete:a3', 'delete:a2'])
  })

  it('names in the dialog exactly the sessions the cover counts, unlisted ones included', async () => {
    const { onDelete, calls, settle } = manualDeletes()
    const sessions = [
      ...listed,
      item('a4', { projectRoot: A, archived: true }),
      item('mate', { projectRoot: A, spawnerSessionId: 'a2' }),
    ]
    mount({ sessions, onDelete, activeSessionId: 'keep' })
    expect(screen.getByTestId('project-delete-dialog').textContent).toContain('Delete the 4 thread(s)')
    fireEvent.click(screen.getByTestId('project-delete-confirm'))
    expect(screen.getByTestId('session-delete-progress').getAttribute('data-total')).toBe('4')
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      await waitFor(() => expect(calls).toContain(id))
      await settle(id)
    }
  })

  it('un-lists a project with no sessions at once, with no cover', () => {
    const onDelete = vi.fn()
    const { onDeleted } = mount({ target: { path: 'D:/work/empty' }, onDelete })
    expect(screen.getByTestId('project-delete-dialog').textContent).toContain('The folder on disk is not touched')
    fireEvent.click(screen.getByTestId('project-delete-confirm'))
    expect(onDeleted).toHaveBeenCalledWith('D:/work/empty')
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByTestId('session-delete-progress')).toBeNull()
  })

  it('Cancel deletes nothing', () => {
    const onDelete = vi.fn()
    const { onCancel, onDeleted } = mount({ onDelete })
    fireEvent.click(screen.getByTestId('project-delete-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('shows nothing without a target', () => {
    mount({ target: null })
    expect(screen.queryByTestId('project-delete-dialog')).toBeNull()
  })
})

// The source half: the shell mounts the confirmation as rendered above.
const shellSource = readFileSync(join(__dirname, '..', 'browser', 'webview', 'MultiSessionShell.tsx'), 'utf8')
const shellFile = ts.createSourceFile('MultiSessionShell.tsx', shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** Each JSX element named `tag`, with its attributes' source text by name. */
function jsxElements(tag: string): Map<string, string>[] {
  const found: Map<string, string>[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(shellFile) === tag) {
      const attrs = new Map<string, string>()
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)) {
          attrs.set(attr.name.getText(shellFile), attr.initializer.expression?.getText(shellFile) ?? '')
        }
      }
      found.push(attrs)
    }
    ts.forEachChild(node, visit)
  }
  visit(shellFile)
  return found
}

describe('MultiSessionShell project delete wiring', () => {
  it('mounts the confirmation over the awaited delete, the sidebar rows and the stored sessions', () => {
    const confirms = jsxElements('ProjectDeleteConfirm')
    expect(confirms).toHaveLength(1)
    const attrs = confirms[0]!
    expect(attrs.get('target')).toBe('projectDeleteTarget')
    expect(attrs.get('sessions')).toBe('sessions')
    expect(attrs.get('listed')).toBe(jsxElements('Sidebar')[0]!.get('sessions'))
    expect(attrs.get('activeSessionId')).toBe('activeSessionId')
    expect(attrs.get('onShow')).toBe('focusSession')
    expect(attrs.get('onDelete')).toBe('deleteAndAwaitRemoval')
    expect(attrs.get('onDeleted')).toMatch(/removeProject\(path\)[\s\S]*setProjectDeleteTarget\(null\)/)
    expect(attrs.get('onCancel')).toMatch(/setProjectDeleteTarget\(null\)/)
  })

  it('opens the confirmation from the sidebar, never deleting from it', () => {
    expect(jsxElements('Sidebar')[0]!.get('onDeleteProject')).toMatch(/setProjectDeleteTarget\(\{ path \}\)/)
    expect(jsxElements('ProjectDeleteDialog')).toHaveLength(0)
  })
})
