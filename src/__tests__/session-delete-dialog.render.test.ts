// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  SessionDeleteDialog,
  sessionDeleteInfoFor,
  sessionDeletionOrder,
} from '../browser/webview/SessionDeleteDialog'
import { sidebarSessionTree } from '../browser/webview/sessionPinning'
import { DEFAULT_SESSION_LIST_VIEW } from '../browser/webview/sessionListView'
import { SESSION_TREE_MAX_DEPTH, type TreeableSession } from '../browser/webview/sessionTree'
import { de } from '../browser/webview/i18n/messages/de'
import { en } from '../browser/webview/i18n/messages/en'
import { es } from '../browser/webview/i18n/messages/es'
import { fr } from '../browser/webview/i18n/messages/fr'
import { ja } from '../browser/webview/i18n/messages/ja'
import { ko } from '../browser/webview/i18n/messages/ko'
import { zh } from '../browser/webview/i18n/messages/zh'

// Deleting a session from the sidebar asks first. A session with sessions
// nested under it offers to take them along, off by default; the confirm
// reports the choice and the deletion runs the active session last. (F-36)

afterEach(() => {
  cleanup()
})

function mount(childCount: number, busyChildCount = 0) {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  render(
    createElement(SessionDeleteDialog, {
      title: 'Refactor plan',
      childCount,
      busyChildCount,
      onCancel,
      onConfirm,
    }),
  )
  return { onCancel, onConfirm }
}

describe('SessionDeleteDialog', () => {
  it('names the session, and offers no checkbox for one without children', () => {
    mount(0)
    const dialog = screen.getByTestId('session-delete-dialog')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(screen.getByText('Delete thread?')).toBeTruthy()
    expect(
      screen.getByText('"Refactor plan" will be removed from this computer. This cannot be undone.'),
    ).toBeTruthy()
    expect(screen.queryByTestId('session-delete-children')).toBeNull()
    expect(screen.getByTestId('session-delete-confirm').textContent).toBe('Delete')
    expect(screen.getByTestId('session-delete-cancel').textContent).toBe('Cancel')
  })

  it('confirms the session alone', () => {
    const { onConfirm, onCancel } = mount(0)
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(false)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('offers an unticked checkbox counting the threads under a parent', () => {
    const { onConfirm } = mount(3)
    const box = screen.getByTestId<HTMLInputElement>('session-delete-children')
    expect(box.checked).toBe(false)
    expect(box.closest('label')!.textContent).toBe('Also delete the 3 threads nested under it')
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('uses the singular form for one thread under it', () => {
    mount(1)
    expect(screen.getByTestId('session-delete-children').closest('label')!.textContent).toBe(
      'Also delete the 1 thread nested under it',
    )
  })

  it('says busy children will be stopped, only while the box is ticked', () => {
    mount(3, 2)
    expect(screen.queryByTestId('session-delete-busy')).toBeNull()
    fireEvent.click(screen.getByTestId('session-delete-children'))
    expect(screen.getByTestId('session-delete-busy').textContent).toBe(
      '2 threads are still working and will be stopped.',
    )
    fireEvent.click(screen.getByTestId('session-delete-children'))
    expect(screen.queryByTestId('session-delete-busy')).toBeNull()
  })

  it('uses the singular busy line for one, and none when no child is busy', () => {
    mount(2, 1)
    fireEvent.click(screen.getByTestId('session-delete-children'))
    expect(screen.getByTestId('session-delete-busy').textContent).toBe(
      '1 thread is still working and will be stopped.',
    )
    cleanup()
    mount(2, 0)
    fireEvent.click(screen.getByTestId('session-delete-children'))
    expect(screen.queryByTestId('session-delete-busy')).toBeNull()
  })

  it('reports a ticked checkbox on confirm', () => {
    const { onConfirm } = mount(2)
    fireEvent.click(screen.getByTestId('session-delete-children'))
    expect(screen.getByTestId<HTMLInputElement>('session-delete-children').checked).toBe(true)
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('cancels on the Cancel button, the backdrop and Escape, deleting nothing', () => {
    const { onCancel, onConfirm } = mount(1)
    fireEvent.click(screen.getByTestId('session-delete-cancel'))
    fireEvent.click(screen.getByTestId('session-delete-dialog'))
    fireEvent.keyDown(screen.getByTestId('session-delete-confirm'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(3)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not cancel on a click inside the panel', () => {
    const { onCancel } = mount(1)
    fireEvent.click(screen.getByText('Delete thread?'))
    expect(onCancel).not.toHaveBeenCalled()
  })
})

type Row = TreeableSession & { title: string; updatedAt: number; starting?: boolean }
const row = (sessionId: string, extra: Partial<Row> = {}): Row => ({
  sessionId,
  title: `T ${sessionId}`,
  updatedAt: 1,
  ...extra,
})
const under = (parentSessionId: string): Partial<Row> => ({ parentSessionId, lineageKind: 'side_session' })
const treeOf = (sessions: readonly Row[]) => sidebarSessionTree(sessions, DEFAULT_SESSION_LIST_VIEW)

const rows = [
  row('p'),
  row('c1', under('p')),
  row('c2', under('p')),
  row('g1', under('c1')),
  row('q'),
]

describe('sessionDeleteInfoFor', () => {
  it('names the row and counts every session under it', () => {
    const tree = treeOf(rows)
    expect(sessionDeleteInfoFor(rows, tree, 'p')).toEqual({
      sessionId: 'p',
      title: 'T p',
      childCount: 3,
      busyChildCount: 0,
    })
    expect(sessionDeleteInfoFor(rows, tree, 'q')).toMatchObject({ childCount: 0 })
  })

  it('is nothing without a target, or for a row no longer listed', () => {
    const tree = treeOf(rows)
    expect(sessionDeleteInfoFor(rows, tree, null)).toBeNull()
    expect(sessionDeleteInfoFor(rows, tree, 'gone')).toBeNull()
  })

  it('counts the children that are running, starting or waiting on the person', () => {
    const busy = [
      row('p', { running: true }),
      row('a', { ...under('p'), running: true }),
      row('b', { ...under('p'), starting: true }),
      row('c', { ...under('a'), needsAnswer: true }),
      row('d', under('p')),
    ]
    expect(sessionDeleteInfoFor(busy, treeOf(busy), 'p')).toMatchObject({
      childCount: 4,
      busyChildCount: 3,
    })
  })

  it('counts exactly what the sidebar nests: not the live children of an archived parent', () => {
    const listed = [
      row('p', { archived: true }),
      row('c', under('p')),
      row('g', under('c')),
    ]
    const tree = treeOf(listed)
    expect(sessionDeleteInfoFor(listed, tree, 'p')).toMatchObject({ childCount: 0 })
    expect(sessionDeleteInfoFor(listed, tree, 'c')).toMatchObject({ childCount: 1 })
  })

  it('does not count a row a cycle drew at the top level', () => {
    const cyclic = [row('x', under('y')), row('y', under('x'))]
    const tree = treeOf(cyclic)
    const flat = tree.roots.map(r => r.sessionId)
    expect(flat).toHaveLength(1)
    const nested = flat[0] === 'x' ? 'y' : 'x'
    expect(sessionDeleteInfoFor(cyclic, tree, nested)).toMatchObject({ childCount: 0 })
  })

  it('does not count the rows past the depth cap, which the sidebar draws flat', () => {
    const chain = [row('n0')]
    for (let i = 1; i <= SESSION_TREE_MAX_DEPTH + 2; i++) chain.push(row(`n${i}`, under(`n${i - 1}`)))
    const tree = treeOf(chain)
    expect(sessionDeleteInfoFor(chain, tree, 'n0')).toMatchObject({ childCount: SESSION_TREE_MAX_DEPTH })
  })
})

describe('sessionDeletionOrder', () => {
  const { childrenOf } = treeOf(rows)

  it('deletes the session alone when the children are not asked for', () => {
    expect(sessionDeletionOrder(childrenOf, 'p', false, 'q')).toEqual(['p'])
  })

  it('takes every session under it when asked', () => {
    expect(sessionDeletionOrder(childrenOf, 'p', true, 'q')).toEqual(['p', 'c1', 'c2', 'g1'])
  })

  it('puts the active session last, whether it is the parent or a child', () => {
    expect(sessionDeletionOrder(childrenOf, 'p', true, 'p')).toEqual(['c1', 'c2', 'g1', 'p'])
    expect(sessionDeletionOrder(childrenOf, 'p', true, 'c1')).toEqual(['p', 'c2', 'g1', 'c1'])
  })
})

describe('session delete catalog', () => {
  const catalogs = { en, de, es, fr, ja, ko, zh } as Record<string, Record<string, string>>
  const pairs = [
    ['sidebar.sessionDeleteChildrenOne', 'sidebar.sessionDeleteChildren'],
    ['sidebar.sessionDeleteBusyOne', 'sidebar.sessionDeleteBusy'],
  ] as const

  it('has a singular and a plural form in every locale, the same for ja, ko and zh', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [one, many] of pairs) {
        expect(catalog[one], `${locale} ${one}`).toContain('{count}')
        expect(catalog[many], `${locale} ${many}`).toContain('{count}')
        if (['ja', 'ko', 'zh'].includes(locale)) expect(catalog[one]).toBe(catalog[many])
        else expect(catalog[one]).not.toBe(catalog[many])
      }
      expect(JSON.stringify(catalog['sidebar.sessionDeleteChildren'])).not.toMatch(/\(/)
    }
  })
})
