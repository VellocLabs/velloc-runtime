// @vitest-environment happy-dom
import { createElement, useState, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { MarkdownText } from '../components/assistant-ui/markdown-text'
import { HEAVY_TEXT_LIMITS } from '../utils/textHeaviness'

// The enclosing check reads the part through one subscription and the Markdown
// primitive through another; this stands for a render in which the check has
// not seen the newest text yet.
vi.mock('../components/assistant-ui/heavy-text-block', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/assistant-ui/heavy-text-block')>()
  const { measureText } = await import('../utils/textHeaviness')
  return { ...actual, useTextMeasure: () => measureText('') }
})

/**
 * The Markdown parser never receives a part's text once it is over a
 * heavy-text limit (F-9), whichever render hands it over: a reply that
 * crosses the limit in one late update mounts no Markdown table.
 */

function table(rows: number): string {
  const body = Array.from({ length: rows }, (_, i) => `| ${i} | r${i} |`)
  return ['reply', '', '| n | v |', '|---|---|', ...body].join('\n')
}

let setText: (text: string) => void = () => {}

function Thread({ running }: { running: boolean }) {
  const [text, set] = useState(table(20))
  setText = set
  const AssistantMessage: FC = () =>
    createElement(MessagePrimitive.Parts, { components: { Text: MarkdownText } })
  const UserMessage: FC = () => null
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text }],
        status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
      },
    ],
    convertMessage: (m) => m,
    isRunning: running,
    onNew: async () => {},
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      ThreadPrimitive.Root,
      null,
      createElement(ThreadPrimitive.Messages, { components: { AssistantMessage, UserMessage } }),
    ),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const markdownRows = (container: HTMLElement) => container.querySelectorAll('.aui-md tr').length

describe('Markdown parser input', () => {
  it.each([
    ['a streaming reply', true],
    ['a settled reply', false],
  ])('%s that crosses the row limit in one late update mounts no Markdown table', async (_, running) => {
    // The smooth reveal paces itself by Date.now(); each frame jumps a minute.
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const flushFrames = async () => {
      for (let i = 0; i < 4; i++) {
        const due = frames
        frames = []
        now += 60_000
        await act(async () => due.forEach((cb) => cb(now)))
      }
    }
    const { container } = render(createElement(Thread, { running }))
    await flushFrames()
    expect(markdownRows(container)).toBeGreaterThan(0)

    await act(async () => setText(table(HEAVY_TEXT_LIMITS.tableRows + 500)))
    await flushFrames()
    expect(markdownRows(container)).toBe(0)
  })
})
