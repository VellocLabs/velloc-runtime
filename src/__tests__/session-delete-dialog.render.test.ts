// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  SessionDeleteDialog,
  sessionDeleteInfoFor,
  sessionDeletionOrder,
} from '../browser/webview/SessionDeleteDialog'
import type { TreeableSession } from '../browser/webview/sessionTree'

// Deleting a session from the sidebar asks first. A session with sessions
// nested under it offers to take them along, off by default; the confirm
// reports the choice and the deletion runs the active session last. (F-36)

afterEach(() => {
  cleanup()
})

function mount(childCount: number) {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  render(
    createElement(SessionDeleteDialog, {
      title: 'Refactor plan',
      childCount,
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

  it('offers an unticked checkbox counting the sessions under a parent', () => {
    const { onConfirm } = mount(3)
    const box = screen.getByTestId<HTMLInputElement>('session-delete-children')
    expect(box.checked).toBe(false)
    expect(box.closest('label')!.textContent).toBe('Also delete the 3 session(s) under it')
    fireEvent.click(screen.getByTestId('session-delete-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(false)
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

type Row = TreeableSession & { sideChat?: boolean }
const row = (sessionId: string, extra: Partial<Row> = {}): Row => ({ sessionId, ...extra })
const under = (parentSessionId: string): Partial<Row> => ({ parentSessionId, lineageKind: 'side_session' })

const rows = [
  row('p'),
  row('c1', under('p')),
  row('c2', under('p')),
  row('g1', under('c1')),
  row('q'),
]

describe('sessionDeleteInfoFor', () => {
  const titled = rows.map(r => ({ ...r, title: `T ${r.sessionId}` }))

  it('names the row and counts every session under it', () => {
    expect(sessionDeleteInfoFor(titled, 'p')).toEqual({ sessionId: 'p', title: 'T p', childCount: 3 })
    expect(sessionDeleteInfoFor(titled, 'q')).toEqual({ sessionId: 'q', title: 'T q', childCount: 0 })
  })

  it('is nothing without a target, or for a row no longer listed', () => {
    expect(sessionDeleteInfoFor(titled, null)).toBeNull()
    expect(sessionDeleteInfoFor(titled, 'gone')).toBeNull()
  })
})

describe('sessionDeletionOrder', () => {

  it('deletes the session alone when the children are not asked for', () => {
    expect(sessionDeletionOrder(rows, 'p', false, 'q')).toEqual(['p'])
  })

  it('takes every session under it when asked', () => {
    expect(sessionDeletionOrder(rows, 'p', true, 'q')).toEqual(['p', 'c1', 'c2', 'g1'])
  })

  it('puts the active session last, whether it is the parent or a child', () => {
    expect(sessionDeletionOrder(rows, 'p', true, 'p')).toEqual(['c1', 'c2', 'g1', 'p'])
    expect(sessionDeletionOrder(rows, 'p', true, 'c1')).toEqual(['p', 'c2', 'g1', 'c1'])
  })
})
