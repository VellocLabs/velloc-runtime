// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, Fragment, useState } from 'react'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar, type SessionListItem } from '../browser/webview/Sidebar'
import { SessionDeleteConfirm } from '../browser/webview/SessionDeleteDialog'

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
}: {
  sessions: SessionListItem[]
  activeSessionId: string
  onDelete: (sessionId: string) => void
}) {
  const [target, setTarget] = useState<string | null>(null)
  return createElement(
    Fragment,
    null,
    createElement(Sidebar, {
      title: 'Conversation',
      sessionId: activeSessionId,
      activeSessionId,
      sessions,
      onDeleteThread: setTarget,
    }),
    createElement(SessionDeleteConfirm, {
      targetId: target,
      sessions,
      activeSessionId,
      onDelete,
      onClose: () => setTarget(null),
    }),
  )
}

async function clickRowDelete(sessionId: string) {
  const row = screen.getAllByTestId(`sidebar-row-${sessionId}`)[0]!
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

  it('confirms the parent alone when the box is left unticked', async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'other', onDelete }))
    await clickRowDelete('p')
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onDelete.mock.calls).toEqual([['p']])
    expect(screen.queryByTestId('session-delete-dialog')).toBeNull()
  })

  it('ticked, deletes the nested rows with the active one last, sparing a teammate and a detached row', async () => {
    const onDelete = vi.fn()
    render(createElement(ShellDelete, { sessions: family, activeSessionId: 'c', onDelete }))
    await clickRowDelete('p')
    expect(screen.getByTestId('session-delete-children').closest('label')!.textContent).toBe(
      'Also delete the 2 threads nested under it',
    )
    fireEvent.click(screen.getByTestId('session-delete-children'))
    expect(screen.getByTestId('session-delete-busy').textContent).toBe(
      '1 thread is still working and will be stopped.',
    )
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onDelete.mock.calls.map(call => call[0])).toEqual(['p', 'g', 'c'])
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

/** Each JSX element named `tag`, with its attributes' source text by name. */
function jsxElements(tag: string): Map<string, string>[] {
  const found: Map<string, string>[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(shellFile) === tag
    ) {
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

describe('MultiSessionShell wiring', () => {
  it("routes the sidebar's Delete to the confirmation target", () => {
    const sidebars = jsxElements('Sidebar')
    expect(sidebars).toHaveLength(1)
    expect(sidebars[0]!.get('onDeleteThread')).toBe('setSessionDeleteTarget')
  })

  it('mounts the confirmation over the same list, deleting through the shell handler', () => {
    const confirms = jsxElements('SessionDeleteConfirm')
    expect(confirms).toHaveLength(1)
    const attrs = confirms[0]!
    expect(attrs.get('targetId')).toBe('sessionDeleteTarget')
    expect(attrs.get('sessions')).toBe(jsxElements('Sidebar')[0]!.get('sessions'))
    expect(attrs.get('activeSessionId')).toBe('activeSessionId')
    expect(attrs.get('onDelete')).toBe('handleDeleteThread')
    expect(attrs.get('onClose')).toBeTruthy()
  })

  it("keeps the folder picker's cancel deleting at once, without the dialog", () => {
    const threads = jsxElements('AssistantUiThread')
    expect(threads.length).toBeGreaterThan(0)
    for (const attrs of threads) {
      if (attrs.has('onDeleteThread')) expect(attrs.get('onDeleteThread')).toBe('handleDeleteThread')
    }
  })
})
