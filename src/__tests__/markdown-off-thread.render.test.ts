// @vitest-environment happy-dom
import { createElement, useState, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import type { Root } from 'hast'

import { TooltipProvider } from '@/components/ui/tooltip'
import { MarkdownText } from '../components/assistant-ui/markdown-text'
import { AssistantText } from '../components/assistant-ui/assistant-text'
import { markdownToHast } from '../components/assistant-ui/markdown-hast'
import {
  MarkdownParseClient,
  setMarkdownParseClient,
  type MarkdownParser,
} from '../components/assistant-ui/off-thread-markdown'
import { OFF_THREAD_PARSE_LIMITS } from '../utils/textHeaviness'

/**
 * A large conversation part that is still streaming is parsed off the main
 * thread (F-9): updates never re-parse it in the render, the newest text shows
 * as it arrives, the drawn Markdown is the same document the inline path
 * draws, and small parts keep the inline path.
 */

function table(rows: number): string {
  const body = Array.from({ length: rows }, (_, i) => `| ${i} | r${i} |`)
  return ['reply', '', '| n | v |', '|---|---|', ...body].join('\n')
}
const LARGE = OFF_THREAD_PARSE_LIMITS.tableRows + 20

/** A parser whose parses finish only when the test says so. */
class HeldParser implements MarkdownParser {
  readonly sent: string[] = []
  private readonly waiting: Array<() => void> = []
  parse(text: string): Promise<Root> {
    this.sent.push(text)
    return new Promise((resolve) => this.waiting.push(() => resolve(markdownToHast(text))))
  }
  async finishAll(): Promise<void> {
    await act(async () => {
      while (this.waiting.length) this.waiting.shift()!()
    })
  }
}

let setText: (text: string) => void = () => {}
let setRunning: (running: boolean) => void = () => {}

const AssistantMessage: FC = () =>
  createElement(MessagePrimitive.Parts, { components: { Text: TextPart } })
const UserMessage: FC = () => null

let TextPart: FC = MarkdownText

function Thread({ initial, running: startRunning }: { initial: string; running: boolean }) {
  const [text, set] = useState(initial)
  const [running, setR] = useState(startRunning)
  setText = set
  setRunning = setR
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
    TooltipProvider,
    null,
    createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        ThreadPrimitive.Root,
        null,
        createElement(ThreadPrimitive.Messages, { components: { AssistantMessage, UserMessage } }),
      ),
    ),
  )
}

const markdownRows = (root: HTMLElement) => root.querySelectorAll('.aui-md tbody tr').length
const unparsed = (root: HTMLElement) =>
  root.querySelector('[data-slot="markdown-unparsed"]')?.textContent ?? ''

afterEach(() => {
  TextPart = MarkdownText
  cleanup()
  setMarkdownParseClient(null)
  vi.restoreAllMocks()
})

describe('a large streaming part', () => {
  it('is never parsed in the render: updates queue behind one parse and show as text', async () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(LARGE), running: true }))

    // Before the first parse returns, the text shows as it arrived.
    expect(markdownRows(container)).toBe(0)
    expect(unparsed(container)).toContain(`| ${LARGE - 1} | r${LARGE - 1} |`)

    for (let rows = LARGE + 1; rows <= LARGE + 200; rows++) {
      await act(async () => setText(table(rows)))
    }
    // 200 updates, one parse in flight, none of them parsed in a render.
    expect(parser.sent).toEqual([table(LARGE)])
    expect(markdownRows(container)).toBe(0)
    expect(unparsed(container)).toContain(`| ${LARGE + 199} | r${LARGE + 199} |`)

    // The first tree lands; only the newest text is sent next.
    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE)
    expect(parser.sent).toEqual([table(LARGE), table(LARGE + 200)])
    // Rows that arrived after the drawn parse stay visible as text.
    expect(unparsed(container)).toContain(`| ${LARGE + 199} | r${LARGE + 199} |`)

    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE + 200)
    expect(unparsed(container)).toBe('')
  })

  it('settles to the whole reply as Markdown once the last parse lands', async () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(LARGE), running: true }))
    await act(async () => setText(table(LARGE + 5)))
    await act(async () => setRunning(false))
    await parser.finishAll()
    await parser.finishAll()
    expect(parser.sent.at(-1)).toBe(table(LARGE + 5))
    expect(markdownRows(container)).toBe(LARGE + 5)
    expect(unparsed(container)).toBe('')
    expect(container.querySelector('.aui-md')!.getAttribute('data-status')).toBe('complete')
  })

  it('draws as running while it streams, so the reveal dot shows', async () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(LARGE), running: true }))
    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE)
    expect(container.querySelector('.aui-md')!.getAttribute('data-status')).toBe('running')
  })

  it('stays on the off-thread path after it settles, and redraws from the last tree', async () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(LARGE), running: true }))
    await parser.finishAll()
    await act(async () => setRunning(false))
    await act(async () => setText(table(LARGE + 1)))
    expect(markdownRows(container)).toBe(LARGE)
    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE + 1)
  })
})

describe('a large reply in the conversation row', () => {
  it('keeps its off-thread tree when it remounts as the reply settles', async () => {
    TextPart = AssistantText
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(LARGE), running: true }))
    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE)
    await act(async () => setText(table(LARGE + 3)))
    await act(async () => setRunning(false))
    // Settled, the row draws through the mod site: a new MarkdownText that
    // still draws the last tree and waits for the final one, never inline.
    expect(markdownRows(container)).toBe(LARGE)
    expect(unparsed(container)).toContain(`| ${LARGE + 2} | r${LARGE + 2} |`)
    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE + 3)
    expect(parser.sent.map((s) => s.split('\n').length)).toEqual([table(LARGE), table(LARGE + 3)].map((s) => s.split('\n').length))
  })
})

describe('a reply that grows past the off-thread limits', () => {
  it('keeps the formatting it had until the first tree lands', async () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const small = table(OFF_THREAD_PARSE_LIMITS.tableRows - 5)
    const { container } = render(createElement(Thread, { initial: small, running: true }))
    await act(async () => setText(table(LARGE)))
    expect(markdownRows(container)).toBe(OFF_THREAD_PARSE_LIMITS.tableRows - 5)
    expect(unparsed(container)).toContain(`| ${LARGE - 1} | r${LARGE - 1} |`)
    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE)
  })

  it('shows the current text, not a stale tree, when the text is replaced', async () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(LARGE), running: true }))
    await parser.finishAll()
    const replaced = 'replaced\n\n' + table(LARGE)
    await act(async () => setText(replaced))
    expect(markdownRows(container)).toBe(0)
    expect(unparsed(container)).toBe(replaced)
    await parser.finishAll()
    expect(markdownRows(container)).toBe(LARGE)
    expect(container.textContent).toContain('replaced')
  })
})

describe('a large settled part loaded from the transcript', () => {
  it('renders inline once, with nothing sent off the main thread', () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(LARGE), running: false }))
    expect(parser.sent).toEqual([])
    expect(markdownRows(container)).toBe(LARGE)
  })
})

describe('a small part', () => {
  it('keeps the inline path and sends nothing off the main thread', async () => {
    const parser = new HeldParser()
    setMarkdownParseClient(parser)
    const { container } = render(createElement(Thread, { initial: table(5), running: false }))
    await act(async () => setText(table(6)))
    expect(parser.sent).toEqual([])
    expect(markdownRows(container)).toBe(6)
    expect(container.querySelector('[data-slot="markdown-unparsed"]')).toBeNull()
  })
})

const DOCUMENT = [
  '# Heading',
  '',
  'Some **bold** and _em_ text, `inline code`, a [link](https://example.com) and src/app/main.ts:12 to open.',
  '',
  '- one',
  '- two with src/lib/util.ts',
  '  1. nested',
  '',
  '> quoted',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  'Footnote[^1] and ~~struck~~.',
  '',
  '[^1]: The note.',
  '',
  table(LARGE),
].join('\n')

describe('the off-thread tree', () => {
  it('draws the same document as the inline parse', async () => {
    const inline = render(createElement(Thread, { initial: DOCUMENT, running: false }))
    const expected = inline.container.querySelector('.aui-md')!.innerHTML
    expect(expected).toContain('<table')
    inline.unmount()

    setMarkdownParseClient(new MarkdownParseClient(() => {
      throw new ReferenceError('Worker is not defined')
    }))
    const streamed = render(createElement(Thread, { initial: DOCUMENT, running: true }))
    await waitFor(() => expect(streamed.container.querySelector('.aui-md table')).not.toBeNull())
    await act(async () => setRunning(false))
    expect(streamed.container.querySelector('.aui-md')!.innerHTML).toBe(expected)
  })
})
