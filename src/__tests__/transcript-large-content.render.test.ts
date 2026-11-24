// @vitest-environment happy-dom
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { StaticMarkdown } from '../components/assistant-ui/static-markdown'
import { MarkdownText } from '../components/assistant-ui/markdown-text'
import { headLines, toNumberedLines } from '../components/assistant-ui/file-content-view'
import { READ_CARD_MOUNTED_LINES, ReadToolView } from '../components/assistant-ui/read-tool-view'
import { RightPanelContentContext } from '../components/assistant-ui/right-panel-content-context'
import { I18nProvider } from '../browser/webview/i18n'
import { writeMarkdownClipboard } from '../browser/webview/richClipboard'
import { HEAVY_TEXT_LIMITS } from '../utils/textHeaviness'

/**
 * Text over a heavy-text limit (F-9) in the conversation: Markdown surfaces
 * show it as plain text with a notice instead of parsing it, the Read card
 * mounts only its first lines, and a message copy skips the HTML flavour.
 */

const NOTICE = 'This text is too large to format, so it is shown as plain text.'

function table(rows: number): string {
  const body = Array.from({ length: rows }, (_, i) => `| ${i} | cell ${i} |`)
  return ['| n | v |', '|---|---|', ...body].join('\n')
}
const HEAVY_TABLE = table(HEAVY_TEXT_LIMITS.tableRows + 10)
const LIGHT_TABLE = table(5)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StaticMarkdown', () => {
  it('renders light Markdown as Markdown', () => {
    const { container } = render(createElement(StaticMarkdown, { content: LIGHT_TABLE }))
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.textContent).not.toContain(NOTICE)
  })

  it('shows heavy text as plain text in a bounded pre, with a notice, never as a table', () => {
    const { container } = render(createElement(StaticMarkdown, { content: HEAVY_TABLE }))
    expect(container.querySelector('table')).toBeNull()
    const block = container.querySelector('[data-slot="heavy-text"]')!
    expect(block.querySelector('[role="note"]')!.textContent).toBe(NOTICE)
    const pre = block.querySelector('pre')!
    expect(pre.textContent).toBe(HEAVY_TABLE)
    expect(pre.className).toContain('max-h-')
    expect(pre.className).toContain('overflow-auto')
  })
})

function Thread({ text }: { text: string }) {
  const AssistantMessage: FC = () =>
    createElement(MessagePrimitive.Parts, { components: { Text: MarkdownText } })
  const UserMessage: FC = () => null
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text }] }],
    convertMessage: (m) => m,
    isRunning: false,
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

describe('assistant reply text', () => {
  it('parses a light reply as Markdown', () => {
    const { container } = render(createElement(Thread, { text: LIGHT_TABLE }))
    expect(container.querySelector('table')).not.toBeNull()
  })

  it('shows a heavy reply as plain text with the notice', () => {
    const { container } = render(createElement(Thread, { text: HEAVY_TABLE }))
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('.aui-md')).toBeNull()
    const pre = container.querySelector('[data-slot="heavy-text"] pre')!
    expect(pre.textContent).toBe(HEAVY_TABLE)
    expect(container.textContent).toContain(NOTICE)
  })
})

describe('headLines', () => {
  it('cuts after `max` lines and counts what follows like toNumberedLines', () => {
    for (const text of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', 'a\nb\nc', 'a\nb\nc\n', 'a\nb\nc\nd\n\n']) {
      for (const max of [0, 1, 2, 3, 10]) {
        const { head, more } = headLines(text, max)
        const total = toNumberedLines(text, { numbered: false }).length
        const shown = toNumberedLines(head, { numbered: false }).length
        expect(text.startsWith(head)).toBe(true)
        expect(shown).toBe(Math.min(total, max))
        expect(shown + more).toBe(total)
      }
    }
  })
})

describe('Read card', () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n') + '\n'

  it('mounts the first lines and offers the rest in Files', () => {
    const openFile = vi.fn()
    const total = READ_CARD_MOUNTED_LINES + 800
    const { container } = render(
      createElement(
        RightPanelContentContext.Provider,
        { value: { openFile } },
        createElement(ReadToolView, { args: { file_path: '/repo/big.ts' }, result: lines(total) }),
      ),
    )
    const rows = container.querySelectorAll('.aui-file-content-code')
    expect(rows).toHaveLength(READ_CARD_MOUNTED_LINES)
    expect(rows[rows.length - 1]!.textContent).toBe(`line ${READ_CARD_MOUNTED_LINES}`)
    const more = container.querySelector('button[data-slot="read-more-lines"]')!
    expect(more.textContent).toBe('800 more lines — open in Files')
    fireEvent.click(more)
    expect(openFile).toHaveBeenCalledWith({ path: '/repo/big.ts' })
  })

  it('says "line" for one remaining line, as text without the Files action when Files cannot open', () => {
    const { container } = render(
      createElement(ReadToolView, {
        args: { file_path: '/repo/a.ts' },
        result: lines(READ_CARD_MOUNTED_LINES + 1),
      }),
    )
    const more = container.querySelector('[data-slot="read-more-lines"]')!
    expect(more.tagName).toBe('P')
    expect(more.textContent).toBe('1 more line not shown')
  })

  it('formats the remaining count in the app locale', () => {
    const { container } = render(
      createElement(
        I18nProvider,
        { locale: 'de' },
        createElement(
          RightPanelContentContext.Provider,
          { value: { openFile: vi.fn() } },
          createElement(ReadToolView, {
            args: { file_path: '/repo/big.ts' },
            result: lines(READ_CARD_MOUNTED_LINES + 1300),
          }),
        ),
      ),
    )
    const more = container.querySelector('button[data-slot="read-more-lines"]')!
    expect(more.textContent).toBe('1.300 weitere Zeilen – in Dateien öffnen')
  })

  it('shows a file within the limit whole, with no remainder row', () => {
    const { container } = render(
      createElement(ReadToolView, { args: { file_path: '/repo/a.ts' }, result: lines(30) }),
    )
    expect(container.querySelectorAll('.aui-file-content-code')).toHaveLength(30)
    expect(container.querySelector('[data-slot="read-more-lines"]')).toBeNull()
  })
})

describe('message copy', () => {
  function stubClipboard() {
    const write = vi.fn(async (_items: unknown[]) => {})
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly types: Record<string, unknown>) {}
    })
    vi.stubGlobal('navigator', { clipboard: { write, writeText } })
    return { write, writeText }
  }

  it('copies light Markdown as text and HTML', async () => {
    const { write, writeText } = stubClipboard()
    expect(await writeMarkdownClipboard(LIGHT_TABLE)).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copies heavy Markdown as plain text only', async () => {
    const { write, writeText } = stubClipboard()
    expect(await writeMarkdownClipboard(HEAVY_TABLE)).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(HEAVY_TABLE)
  })
})
