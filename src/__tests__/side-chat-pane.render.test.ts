// @vitest-environment happy-dom
/**
 * The Side chats pane (F-36): the viewed session's side chats as tabs in the
 * header, the selected one's conversation under them, `+` for a new one, a
 * detach action for the shown one.
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
  it('with no side chat: the pane name in the header, the hint, `+` enabled only when the conversation can be forked, no detach', () => {
    render(pane({ onAdd: vi.fn() }))
    expect(screen.getByTestId('side-chat-pane-name').textContent).toBe('Side chats')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryAllByRole('tab')).toEqual([])
    expect(screen.getByTestId('side-chat-empty').textContent).toContain('Start a side chat')
    expect((screen.getByTestId('side-chat-add') as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('[data-testid^="side-chat-detach-"]')).toBeNull()
    cleanup()
    render(pane())
    expect((screen.getByTestId('side-chat-add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the header lists the side chats as tabs in the given order with their state, the selected one marked, `+` after them', () => {
    render(pane({ items: [waiting, working], selectedId: 'c1' }, createElement('p', null, 'THREAD')))
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['Why that nameWaiting for you', 'Try the other pathWorking'])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(screen.getByTestId('side-chat-row-c2').getAttribute('data-needs-answer')).toBe('true')
    expect(screen.getByTestId('side-chat-row-c1').getAttribute('data-running')).toBe('true')
    // Each tab closes from its own `×`; `+` follows the strip, inside the header.
    const header = screen.getByRole('tablist').parentElement!
    expect(header.tagName).toBe('HEADER')
    expect(screen.getByTestId('side-chat-row-c2').contains(screen.getByTestId('side-chat-archive-c2'))).toBe(true)
    expect(screen.getByRole('tablist').compareDocumentPosition(screen.getByTestId('side-chat-add')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('side-chat-shared-folder').textContent).toContain("main conversation's folder")
    expect(screen.getByTestId('side-chat-thread').textContent).toBe('THREAD')
  })

  it('a tab press selects it; its `×` archives it; the header action detaches the shown one; `+` adds one', () => {
    const onSelect = vi.fn()
    const onDetach = vi.fn()
    const onArchive = vi.fn()
    const onAdd = vi.fn()
    render(pane({ items: [idle, waiting], selectedId: 'c2', onSelect, onDetach, onArchive, onAdd }))
    fireEvent.click(screen.getByText('Done aside'))
    expect(onSelect).toHaveBeenCalledWith('c0')
    expect(onSelect).toHaveBeenCalledTimes(1)
    // The pill's own edge selects it as well.
    fireEvent.click(screen.getByTestId('side-chat-row-c0'))
    expect(onSelect).toHaveBeenCalledTimes(2)
    // Detach is one control, bound to the shown side chat.
    expect(screen.queryByTestId('side-chat-detach-c0')).toBeNull()
    const detach = screen.getByTestId('side-chat-detach-c2')
    expect(detach.getAttribute('aria-label')).toBe('Move to the sidebar')
    fireEvent.click(detach)
    expect(onDetach).toHaveBeenCalledWith('c2')
    const archive = screen.getByTestId('side-chat-archive-c0')
    expect(archive.getAttribute('aria-label')).toBe('Archive')
    fireEvent.click(archive)
    expect(onArchive).toHaveBeenCalledWith('c0')
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('side-chat-delete-c0')).toBeNull()
    fireEvent.click(screen.getByTestId('side-chat-add'))
    expect(onAdd).toHaveBeenCalledTimes(1)
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

  it('follows the tabs pattern: one Tab stop, arrow / Home / End focus moves, Delete closes, a labelled panel', () => {
    const onArchive = vi.fn()
    render(pane({ items: [idle, waiting, working], selectedId: 'c2', onArchive }, createElement('p', null, 'THREAD')))
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0, -1])
    for (const id of ['c0', 'c2', 'c1']) {
      expect(screen.getByTestId(`side-chat-archive-${id}`).tabIndex).toBe(-1)
      expect(screen.getByTestId(`side-chat-row-${id}`).getAttribute('role')).toBe('presentation')
    }
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1]!.id)
    expect(tabs[1]!.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.contains(screen.getByTestId('side-chat-shared-folder'))).toBe(true)
    expect(panel.textContent).toContain('THREAD')

    tabs[1]!.focus()
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[0])
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(tabs[2]!, { key: 'Home' })
    expect(document.activeElement).toBe(tabs[0])
    fireEvent.keyDown(tabs[0]!, { key: 'End' })
    expect(document.activeElement).toBe(tabs[2])
    // Delete closes only a side chat whose close is offered.
    fireEvent.keyDown(tabs[2]!, { key: 'Delete' })
    expect(onArchive).not.toHaveBeenCalled()
    fireEvent.keyDown(tabs[0]!, { key: 'Delete' })
    expect(onArchive).toHaveBeenCalledWith('c0')
  })

  it('the tab and its close show a keyboard focus ring', () => {
    render(pane({ items: [idle], selectedId: 'c0' }))
    expect(screen.getByTestId('side-chat-tab-c0').className).toContain('focus-visible:ring')
    expect(screen.getByTestId('side-chat-archive-c0').className).toContain('focus-visible:ring')
  })

  it('with many side chats the strip scrolls instead of clipping: pills keep a readable width, every one selects and archives, the selected one is brought into view', () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ sessionId: `m${i}`, title: `Side ${i}` }))
    const scrolled: string[] = []
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset.testid ?? '')
    }
    try {
      const onSelect = vi.fn()
      const onArchive = vi.fn()
      const view = render(pane({ items: many, selectedId: 'm0', onSelect, onArchive }))
      const strip = screen.getByRole('tablist')
      expect(strip.className).toContain('overflow-x-auto')
      expect(strip.className).not.toContain('overflow-hidden')
      for (const entry of many) {
        const row = screen.getByTestId(`side-chat-row-${entry.sessionId}`)
        expect(row.className).toContain('shrink-0')
        expect(row.className).not.toContain('min-w-0')
        expect(screen.getByTestId(`side-chat-tab-${entry.sessionId}`).className).toContain('min-w-[6rem]')
        fireEvent.click(screen.getByTestId(`side-chat-tab-${entry.sessionId}`))
        fireEvent.click(screen.getByTestId(`side-chat-archive-${entry.sessionId}`))
      }
      expect(onSelect.mock.calls.map(call => call[0])).toEqual(many.map(entry => entry.sessionId))
      expect(onArchive.mock.calls.map(call => call[0])).toEqual(many.map(entry => entry.sessionId))
      expect(scrolled).toEqual(['side-chat-tab-m0'])
      view.rerender(pane({ items: many, selectedId: 'm9', onSelect, onArchive }))
      expect(scrolled).toEqual(['side-chat-tab-m0', 'side-chat-tab-m9'])
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })
})
