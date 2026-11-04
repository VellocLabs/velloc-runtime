// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  runSessionDeletion,
  SessionDeleteDialog,
  SessionDeleteProgress,
  sessionDeleteInfoFor,
  sessionDeletionOrder,
} from '../browser/webview/SessionDeleteDialog'
import { projectSessionTree, sidebarSessionTree } from '../browser/webview/sessionPinning'
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
// nested under it offers Delete this session or Delete all; the deletion runs
// one session at a time, the active session last, behind a progress cover. (F-36)

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
  it('names the session and offers Cancel and Delete for one without children', () => {
    mount(0)
    const dialog = screen.getByTestId('session-delete-dialog')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(screen.getByText('Delete session?')).toBeTruthy()
    expect(screen.getByTestId('session-delete-body').textContent).toBe(
      '"Refactor plan" will be removed from this computer. This cannot be undone.',
    )
    expect(screen.queryByTestId('session-delete-all')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByTestId('session-delete-confirm').textContent).toBe('Delete')
    expect(screen.getByTestId('session-delete-cancel').textContent).toBe('Cancel')
  })

  it('confirms the session alone', () => {
    const { onConfirm, onCancel } = mount(0)
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(false)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('offers this session only or all of them for a parent, with no checkbox', () => {
    mount(3)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByTestId('session-delete-body').textContent).toBe(
      '"Refactor plan" has 3 sessions nested under it. If you delete only this one, they move to the top level.' +
        ' Deleted sessions are removed from this computer and cannot be restored.',
    )
    expect(screen.getByTestId('session-delete-all').textContent).toBe('Delete all 4 sessions')
    expect(screen.getByTestId('session-delete-confirm').textContent).toBe('Delete this session')
  })

  it('deletes only this session from Delete this session', () => {
    const { onConfirm } = mount(3)
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onConfirm.mock.calls).toEqual([[false]])
  })

  it('deletes the session and its children from Delete all', () => {
    const { onConfirm } = mount(3)
    fireEvent.click(screen.getByTestId('session-delete-all'))
    expect(onConfirm.mock.calls).toEqual([[true]])
  })

  it('uses the singular form for one session under it', () => {
    mount(1)
    expect(screen.getByTestId('session-delete-body').textContent).toContain(
      'has 1 session nested under it. If you delete only this one, it moves to the top level.',
    )
    expect(screen.getByTestId('session-delete-all').textContent).toBe('Delete all 2 sessions')
  })

  it('says how many children are still working, singular for one, nothing when none', () => {
    mount(3, 2)
    expect(screen.getByTestId('session-delete-busy').textContent).toBe(
      '2 of the nested sessions are still working; deleting all stops them.',
    )
    cleanup()
    mount(2, 1)
    expect(screen.getByTestId('session-delete-busy').textContent).toBe(
      '1 of the nested sessions is still working; deleting all stops it.',
    )
    cleanup()
    mount(2, 0)
    expect(screen.queryByTestId('session-delete-busy')).toBeNull()
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
    fireEvent.click(screen.getByText('Delete session?'))
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('SessionDeleteProgress', () => {
  it('covers the window with the count deleted so far', () => {
    render(createElement(SessionDeleteProgress, { done: 3, total: 64 }))
    const cover = screen.getByTestId('session-delete-progress')
    expect(cover.getAttribute('role')).toBe('alertdialog')
    expect(cover.getAttribute('aria-busy')).toBe('true')
    expect(cover.className).toContain('fixed inset-0')
    expect(screen.getByText('Deleting sessions…')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('64')
    expect(screen.getByRole('status').textContent).toBe('3 of 64 deleted')
  })

  it('keeps keys and clicks from reaching the page beneath', () => {
    const onKey = vi.fn()
    const onClick = vi.fn()
    render(
      createElement(
        'div',
        { onKeyDown: onKey, onClick },
        createElement(SessionDeleteProgress, { done: 0, total: 2 }),
      ),
    )
    const cover = screen.getByTestId('session-delete-progress')
    expect(document.activeElement).toBe(cover)
    fireEvent.keyDown(cover, { key: 'Escape' })
    fireEvent.click(cover)
    expect(onKey).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps a shortcut the page listens for on document from firing while it is up', () => {
    const shortcut = vi.fn()
    document.addEventListener('keydown', shortcut, true)
    try {
      const { unmount } = render(createElement(SessionDeleteProgress, { done: 0, total: 2 }))
      fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true })
      expect(shortcut).not.toHaveBeenCalled()
      unmount()
      fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true })
      expect(shortcut).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', shortcut, true)
    }
  })
})

describe('runSessionDeletion', () => {
  it('deletes one at a time, each after the previous settled, reporting progress', async () => {
    const events: string[] = []
    const settle: Array<() => void> = []
    const run = runSessionDeletion(
      ['a', 'b', 'c'],
      id =>
        new Promise<void>(resolve => {
          events.push(`start ${id}`)
          settle.push(() => {
            events.push(`end ${id}`)
            resolve()
          })
        }),
      (done, total) => events.push(`${done}/${total}`),
    )
    await Promise.resolve()
    expect(events).toEqual(['0/3', 'start a'])
    settle.shift()!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(['0/3', 'start a', 'end a', '1/3', 'start b'])
    settle.shift()!()
    await new Promise(resolve => setTimeout(resolve, 0))
    settle.shift()!()
    await run
    expect(events).toEqual([
      '0/3', 'start a', 'end a', '1/3', 'start b', 'end b', '2/3', 'start c', 'end c', '3/3',
    ])
  })

  it('stops waiting once a removal goes unconfirmed, and sends the rest straight away', async () => {
    const events: string[] = []
    const settle = new Map<string, (removed: boolean) => void>()
    const run = runSessionDeletion(
      ['a', 'b', 'c', 'd'],
      id =>
        new Promise<boolean>(resolve => {
          events.push(`send ${id}`)
          settle.set(id, resolve)
        }),
      (done, total) => events.push(`${done}/${total}`),
    )
    await Promise.resolve()
    settle.get('a')!(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(['0/4', 'send a', '1/4', 'send b'])
    settle.get('b')!(false)
    await run
    expect(events).toEqual(['0/4', 'send a', '1/4', 'send b', '2/4', 'send c', '3/4', 'send d', '4/4'])
  })

  it('goes on past a failed delete and never rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    await runSessionDeletion(
      ['a', 'b'],
      async id => {
        seen.push(id)
        if (id === 'a') throw new Error('gone wrong')
      },
      () => {},
    )
    expect(seen).toEqual(['a', 'b'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

type Row = TreeableSession & { title: string; updatedAt: number; starting?: boolean; projectRoot?: string }
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

describe('a delete from a Projects folder', () => {
  const A = 'D:\\work\\alpha'
  const B = 'D:\\work\\beta'
  const split = [
    row('p', { projectRoot: A }),
    row('a', { ...under('p'), projectRoot: A }),
    row('b', { ...under('p'), projectRoot: B }),
    row('bb', { ...under('b'), projectRoot: B }),
  ]

  it("counts and deletes only the rows that folder nests: none from another folder", () => {
    const folderA = projectSessionTree(split, DEFAULT_SESSION_LIST_VIEW, A)
    expect(sessionDeleteInfoFor(split, folderA, 'p')).toMatchObject({ childCount: 1 })
    expect(sessionDeletionOrder(folderA.childrenOf, 'p', true, 'none')).toEqual(['p', 'a'])
  })

  it("nests a child whose parent sits in another folder at the top of its own folder", () => {
    const folderB = projectSessionTree(split, DEFAULT_SESSION_LIST_VIEW, B)
    expect(folderB.roots.map(r => r.sessionId)).toEqual(['b'])
    expect(sessionDeleteInfoFor(split, folderB, 'b')).toMatchObject({ childCount: 1 })
  })

  it('the Recents tree still nests every child under the parent', () => {
    expect(sessionDeleteInfoFor(split, treeOf(split), 'p')).toMatchObject({ childCount: 3 })
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
    ['sidebar.sessionDeleteNestedBodyOne', 'sidebar.sessionDeleteNestedBody'],
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
      expect(catalog['sidebar.sessionDeleteNestedBody'], `${locale} nested`).not.toMatch(/\(s\)/)
      expect(catalog['sidebar.sessionDeleteAll'], `${locale} all`).toContain('{count}')
      expect(catalog['sidebar.sessionDeleteProgress'], `${locale} progress`).toContain('{done}')
      expect(catalog['sidebar.sessionDeleteProgress'], `${locale} progress`).toContain('{total}')
    }
  })
})
