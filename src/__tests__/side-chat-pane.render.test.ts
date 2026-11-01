// @vitest-environment happy-dom
/**
 * The Side chats pane (F-36): the viewed session's side chats as rows, the
 * selected one's conversation under them, `+` for a new one.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SideChatPane, type SideChatPaneProps } from '@/browser/webview/panes/SideChatPane'
import type { SessionListItem } from '@/browser/webview/SessionRows'

afterEach(cleanup)

function item(partial: Partial<SessionListItem> & { sessionId: string; title: string }): SessionListItem {
  return { previewText: '', updatedAt: 0, sideChat: true, parentSessionId: 'p', ...partial }
}

const waiting = item({ sessionId: 'c2', title: 'Why that name', needsAnswer: true })
const working = item({ sessionId: 'c1', title: 'Try the other path', running: true })
const idle = item({ sessionId: 'c0', title: 'Done aside' })
const starting = item({ sessionId: 'c3', title: 'Just opened', starting: true })

function pane(props: Partial<SideChatPaneProps> = {}, children?: ReactNode): ReactNode {
  return createElement(
    SideChatPane,
    {
      items: [],
      selectedId: null,
      onSelect: vi.fn(),
      onDetach: vi.fn(),
      onArchive: vi.fn(),
      frame: ({ title, actions, body }: { title: ReactNode; actions: ReactNode; body: ReactNode }) =>
        createElement('section', null, createElement('header', null, title, actions), body),
      ...props,
    },
    children,
  )
}

describe('SideChatPane', () => {
  it('with no side chat: the hint, and `+` enabled only when the conversation can be forked', () => {
    render(pane({ onAdd: vi.fn() }))
    expect(screen.getByTestId('side-chat-empty').textContent).toContain('Start a side chat')
    expect((screen.getByTestId('side-chat-add') as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    render(pane())
    expect((screen.getByTestId('side-chat-add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists the side chats in the given order with their state, the selected one marked', () => {
    render(pane({ items: [waiting, working], selectedId: 'c1' }, createElement('p', null, 'THREAD')))
    const rows = screen.getAllByRole('option')
    expect(rows.map(row => row.textContent)).toEqual(['Why that nameWaiting for you', 'Try the other pathWorking'])
    expect(rows.map(row => row.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(rows[0]!.getAttribute('data-needs-answer')).toBe('true')
    expect(rows[1]!.getAttribute('data-running')).toBe('true')
    expect(screen.getByTestId('side-chat-shared-folder').textContent).toContain("main conversation's folder")
    expect(screen.getByTestId('side-chat-thread').textContent).toBe('THREAD')
  })

  it('a row press selects it; its marks detach and archive it; `+` adds one', () => {
    const onSelect = vi.fn()
    const onDetach = vi.fn()
    const onArchive = vi.fn()
    const onAdd = vi.fn()
    render(pane({ items: [idle, waiting], selectedId: null, onSelect, onDetach, onArchive, onAdd }))
    fireEvent.click(screen.getByText('Why that name'))
    expect(onSelect).toHaveBeenCalledWith('c2')
    fireEvent.click(screen.getByTestId('side-chat-detach-c2'))
    expect(onDetach).toHaveBeenCalledWith('c2')
    const archive = screen.getByTestId('side-chat-archive-c0')
    expect(archive.getAttribute('aria-label')).toBe('Archive')
    fireEvent.click(archive)
    expect(onArchive).toHaveBeenCalledWith('c0')
    expect(screen.queryByTestId('side-chat-delete-c0')).toBeNull()
    fireEvent.click(screen.getByTestId('side-chat-add'))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('side-chat-detach-c2').getAttribute('aria-label')).toBe('Move to the sidebar')
  })

  it('closing a side chat archives it, offered only while it neither starts, works nor waits for the person', () => {
    const onArchive = vi.fn()
    render(pane({ items: [waiting, working, starting], selectedId: null, onArchive }))
    for (const id of ['c2', 'c1', 'c3']) {
      const archive = screen.getByTestId(`side-chat-archive-${id}`) as HTMLButtonElement
      expect(archive.disabled).toBe(true)
      expect(archive.getAttribute('aria-label')).toBe('Archive once it stops working or waiting for you')
      fireEvent.click(archive)
    }
    expect(onArchive).not.toHaveBeenCalled()
  })
})
