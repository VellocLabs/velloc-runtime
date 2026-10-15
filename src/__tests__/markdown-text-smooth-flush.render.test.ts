// @vitest-environment happy-dom
import { createElement, type FC } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { MarkdownText } from '../components/assistant-ui/markdown-text'
import { TURN_SETTLED_KEY } from '../browser/webview/turnSettled'

/**
 * Smooth typing must never hold back a finished reply. assistant-ui reveals
 * streamed text one animation frame at a time and does not flush when the
 * turn ends, so with rAF starved (load) or stopped (hidden / occluded window)
 * the thread read idle while the final text was still blank. Here rAF never fires at all: text may lag only while the turn
 * runs in a visible page, and must be whole the moment it stops.
 */

const FINAL = 'The config file could not be read.'

// assistant-ui derives `thread.isRunning` from the last message's status, and
// the composer must not read idle before the reply is shown, so the adapter
// leaves the live message `running` after the turn ends and stamps
// `turnSettled` on it instead (the id stays the same, so a status change alone
// would not flush the reveal).
const live = (settled: boolean): ThreadMessageLike => ({
  id: 'live-1',
  role: 'assistant',
  content: [{ type: 'text', text: FINAL }],
  status: { type: 'running' },
  ...(settled ? { metadata: { custom: { [TURN_SETTLED_KEY]: true } } } : {}),
})

function Harness({ settled }: { settled: boolean }) {
  const AssistantMessage: FC = () =>
    createElement(MessagePrimitive.Parts, { components: { Text: MarkdownText } })
  const UserMessage: FC = () => null
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [live(settled)],
    convertMessage: (m) => m,
    isRunning: true,
    onNew: async () => {},
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      ThreadPrimitive.Root,
      null,
      createElement(ThreadPrimitive.Messages, {
        components: { AssistantMessage, UserMessage },
      }),
    ),
  )
}

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const shown = (container: HTMLElement) =>
  container.querySelector('.aui-md')?.textContent ?? ''

describe('MarkdownText smooth typing', () => {
  it('animates while a turn runs in a visible page (the reveal waits on rAF)', () => {
    const { container } = render(createElement(Harness, { settled: false }))
    expect(shown(container)).not.toContain(FINAL)
  })

  it('shows the whole reply the moment the turn settles — the thread still reading running — with rAF never firing', async () => {
    const { container, rerender } = render(createElement(Harness, { settled: false }))
    rerender(createElement(Harness, { settled: true }))
    await waitFor(() => expect(shown(container)).toContain(FINAL))
  })

  it('shows the whole reply while running when the page is hidden', () => {
    const { container } = render(createElement(Harness, { settled: false }))
    act(() => {
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(shown(container)).toContain(FINAL)
  })
})
