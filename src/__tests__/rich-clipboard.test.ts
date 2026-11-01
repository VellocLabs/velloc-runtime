// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { markdownToClipboardHtml, sanitizeClipboardHtml } from '../browser/webview/richClipboard'
import { writeRichClipboard } from '../utils/clipboard'

/**
 * "Copy message" (F-22): the HTML half keeps formatting and safe links only;
 * the write offers text/plain and text/html, and falls back to plain text
 * when a rich write is unavailable or refused.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sanitize', () => {
  it('drops scripts, handlers, images, frames and unsafe links, keeping the text and formatting', () => {
    const html = sanitizeClipboardHtml(
      '<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script>' +
        '<img src="https://example.com/t.png"><iframe></iframe>' +
        '<a href="javascript:alert(1)">bad</a> <a href="https://ok.example/" target="_blank">ok</a>' +
        '<span style="color:red">kept text</span><button>Copy</button></p>',
    )
    expect(html).toBe(
      '<p>Hi <strong>there</strong><a>bad</a> <a href="https://ok.example/">ok</a>kept text</p>',
    )
  })

  it('renders Markdown with tables and code, and no raw HTML from the source', async () => {
    const html = await markdownToClipboardHtml(
      '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n<img src=x onerror=alert(1)>',
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<pre><code>const x = 1\n</code></pre>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror')
  })
})

describe('write', () => {
  it('writes text/plain and text/html in one item', async () => {
    const write = vi.fn(async (_items: unknown[]) => {})
    class FakeItem {
      constructor(readonly types: Record<string, unknown>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeItem)
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } })
    expect(await writeRichClipboard('**a**', Promise.resolve('<strong>a</strong>'))).toBe(true)
    const item = write.mock.calls[0]?.[0]?.[0] as FakeItem
    expect(Object.keys(item.types).sort()).toEqual(['text/html', 'text/plain'])
  })

  it('falls back to plain text when the rich write is refused', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', {
      clipboard: { write: vi.fn(async () => Promise.reject(new Error('denied'))), writeText },
    })
    expect(await writeRichClipboard('**a**', Promise.resolve('<strong>a</strong>'))).toBe(true)
    expect(writeText).toHaveBeenCalledWith('**a**')
  })

  it('reports a failure when every write fails', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    })
    document.execCommand = vi.fn(() => false)
    expect(await writeRichClipboard('x', Promise.reject(new Error('no html')))).toBe(false)
  })
})
