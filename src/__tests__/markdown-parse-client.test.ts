import { afterEach, describe, expect, it, vi } from 'vitest'

import { markdownToHast } from '../components/assistant-ui/markdown-hast'
import { MarkdownParseClient } from '../components/assistant-ui/off-thread-markdown'
import {
  OFF_THREAD_PARSE_LIMITS,
  measureText,
  parsesOffThread,
} from '../utils/textHeaviness'

/** The window's Markdown parse Worker client and its size gate (F-9). */

type Posted = { id: number; text: string }

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly posted: Posted[] = []
  terminated = false
  postMessage(message: Posted) {
    this.posted.push(message)
  }
  terminate() {
    this.terminated = true
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
}

afterEach(() => vi.restoreAllMocks())

describe('MarkdownParseClient', () => {
  it('parses in the Worker it spawns once, and keeps the newest trees', async () => {
    const worker = new FakeWorker()
    const spawn = vi.fn(() => worker as unknown as Worker)
    const client = new MarkdownParseClient(spawn)

    const first = client.parse('a *b*')
    const second = client.parse('c')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(worker.posted.map((m) => m.text)).toEqual(['a *b*', 'c'])

    worker.reply({ id: worker.posted[1].id, tree: markdownToHast('c') })
    worker.reply({ id: worker.posted[0].id, tree: markdownToHast('a *b*') })
    expect(await first).toEqual(markdownToHast('a *b*'))
    expect(await second).toEqual(markdownToHast('c'))
    expect(client.cached('a *b*')).toEqual(markdownToHast('a *b*'))

    await client.parse('a *b*')
    expect(worker.posted).toHaveLength(2)
  })

  it('rejects a request the Worker answered with an error', async () => {
    const worker = new FakeWorker()
    const client = new MarkdownParseClient(() => worker as unknown as Worker)
    const result = client.parse('x')
    worker.reply({ id: worker.posted[0].id, error: 'boom' })
    await expect(result).rejects.toThrow('boom')
  })

  it('parses inline when no Worker can be made', async () => {
    const spawn = vi.fn(() => {
      throw new ReferenceError('Worker is not defined')
    })
    const client = new MarkdownParseClient(spawn)
    expect(await client.parse('| a |\n|---|\n| 1 |')).toEqual(markdownToHast('| a |\n|---|\n| 1 |'))
    await client.parse('two')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('re-runs in-flight requests inline when the Worker fails, and stops using it', async () => {
    const worker = new FakeWorker()
    const spawn = vi.fn(() => worker as unknown as Worker)
    const client = new MarkdownParseClient(spawn)
    const result = client.parse('**late**')
    worker.onerror?.(new Event('error'))
    expect(worker.terminated).toBe(true)
    expect(await result).toEqual(markdownToHast('**late**'))
    await client.parse('after')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(worker.posted).toHaveLength(1)
  })
})

describe('markdownToHast', () => {
  it('keeps positions only on code elements', () => {
    const tree = markdownToHast('text\n\n```sh\nls\n```\n')
    const json = JSON.stringify(tree)
    const code = (tree.children.find((n) => n.type === 'element' && n.tagName === 'pre') as {
      children: Array<{ tagName?: string; position?: unknown }>
    }).children.find((n) => n.tagName === 'code')!
    expect(code.position).toBeDefined()
    expect(tree.position).toBeUndefined()
    expect(json.match(/"position"/g)).toHaveLength(1)
  })

  it('marks file paths in prose like the inline renderer', () => {
    expect(JSON.stringify(markdownToHast('open src/app/main.ts:12 now'))).toContain('nexus-file-path')
  })
})

describe('parsesOffThread', () => {
  const at = { ...OFF_THREAD_PARSE_LIMITS }
  it('is false exactly at every limit and true one past any', () => {
    expect(parsesOffThread(at)).toBe(false)
    expect(parsesOffThread({ ...at, bytes: at.bytes + 1 })).toBe(true)
    expect(parsesOffThread({ ...at, lines: at.lines + 1 })).toBe(true)
    expect(parsesOffThread({ ...at, tableRows: at.tableRows + 1 })).toBe(true)
  })
  it('leaves a short reply on the inline path', () => {
    expect(parsesOffThread(measureText('A short answer with a `code` span.'))).toBe(false)
  })
})
