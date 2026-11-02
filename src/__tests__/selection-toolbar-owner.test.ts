// @vitest-environment happy-dom
/**
 * The selection toolbar (F-22, F-36): every mounted thread renders one, and
 * only the thread whose message list holds both ends of the selection shows
 * it. Another mounted thread's toolbar stays hidden for that selection.
 */
import { createElement, useRef, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'

import { I18nProvider } from '@/browser/webview/i18n'
import { MessageActionsContext } from '@/components/assistant-ui/message-actions-context'
import { ReplySelectionToolbar, selectionInside } from '@/components/assistant-ui/thread'

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  cleanup()
})

const Thread: FC<{ id: string; rowId: string; text: string }> = ({ id, rowId, text }) => {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [
      { id: `${rowId}-prompt`, role: 'user', content: 'ask' },
      { id: rowId, role: 'assistant', content: text, status: { type: 'complete', reason: 'stop' } },
    ],
    convertMessage: m => m,
    isRunning: false,
    onNew: async () => {},
  })
  const listRef = useRef<HTMLDivElement | null>(null)
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      MessageActionsContext.Provider,
      { value: { onStartSideChat: vi.fn() } },
      createElement(
        'div',
        { id, ref: listRef, 'data-slot': 'message-list' },
        createElement('div', { 'data-message-id': rowId }, createElement('p', null, text)),
      ),
      createElement(ReplySelectionToolbar, { listRef }),
    ),
  )
}

function renderTwoThreads() {
  render(
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      createElement(Thread, { id: 'visible', rowId: 'a-1', text: 'the selected reply' }),
      createElement(Thread, { id: 'hidden', rowId: 'b-1', text: 'another session' }),
    ),
  )
}

function select(node: Text, from: number, to: number): Selection {
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

const textOf = (id: string) => document.querySelector(`#${id} p`)!.firstChild as Text

/** The toolbars a person can see: rendered and not hidden from them. */
const shownToolbars = () =>
  screen.queryAllByTestId('selection-toolbar').filter(el => el.getAttribute('aria-hidden') !== 'true')

/** A person's selection: the selection changes, then the mouse comes up a frame later. */
async function selectAndRelease(id: string, from: number, to: number) {
  await act(async () => {
    select(textOf(id), from, to)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
  })
}

describe('one selection toolbar, in the thread holding the selection', () => {
  it('a selection in one thread opens exactly one toolbar, with an enabled side chat', async () => {
    renderTwoThreads()
    await selectAndRelease('visible', 4, 12)
    const shown = shownToolbars()
    expect(shown).toHaveLength(1)
    const sideChat = shown[0]!.querySelectorAll('[data-testid="selection-side-chat"]')
    expect(sideChat).toHaveLength(1)
    expect(sideChat[0]!.getAttribute('aria-disabled')).toBeNull()
  })

  it('moving the selection to the other thread moves the toolbar with it', async () => {
    renderTwoThreads()
    await selectAndRelease('visible', 4, 12)
    await selectAndRelease('hidden', 0, 7)
    expect(shownToolbars()).toHaveLength(1)
  })

  it('a collapsed selection leaves no toolbar in either thread', async () => {
    renderTwoThreads()
    await selectAndRelease('visible', 4, 12)
    await selectAndRelease('visible', 3, 3)
    expect(shownToolbars()).toHaveLength(0)
  })
})

describe('which list owns a selection', () => {
  it('is the list holding both ends; a collapsed selection or a missing list owns nothing', () => {
    document.body.innerHTML = '<div id="l"><p>alpha beta</p></div><div id="o"><p>other</p></div>'
    const list = document.getElementById('l')!
    const other = document.getElementById('o')!
    const text = list.querySelector('p')!.firstChild as Text
    expect(selectionInside(list, select(text, 0, 5))).toBe(true)
    expect(selectionInside(other, select(text, 0, 5))).toBe(false)
    expect(selectionInside(list, select(text, 3, 3))).toBe(false)
    expect(selectionInside(null, select(text, 0, 5))).toBe(false)
    expect(selectionInside(list, null)).toBe(false)
    document.body.innerHTML = ''
  })
})
