import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelReplyRow } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import { declareTool } from '../toolkit/toolContract'
import { executeToolCall } from '../toolkit/run/executeToolCall'
import { shrinkToolResultImage } from '../utils/images/inlineImage'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

function createLargeObservePayload() {
  const fillerElements: Array<Record<string, unknown>> = Array.from(
    { length: 160 },
    (_value, index) => ({
      id: index + 1,
      type: 'container',
      text: `container-${index}-${'x'.repeat(120)}`,
      box: [0, 0, 20, 20],
    }),
  )

  fillerElements.push({
    id: 999,
    type: 'form_control',
    clickable: true,
    focusable: true,
    text: 'Baidu search field',
    label: 'Search',
    box: [100, 100, 400, 40],
    form: {
      type: 'textarea',
      placeholder: 'Search Baidu',
      value: '',
    },
  })

  return {
    ok: true,
    result: 'OK',
    windows: [
      {
        id: 1,
        active_tab: 9,
        is_active: true,
        tabs: [1, 9],
      },
    ],
    pages: [
      {
        tab_id: 9,
        url: 'https://www.baidu.com/',
        title: '百度一下，你就知道',
        document_id: 'DOC123456',
        viewport: {
          x: 0,
          y: 0,
          width: 1200,
          height: 900,
        },
        elements: fillerElements,
        meta: Array.from({ length: 20 }, (_value, index) => ({
          name: `meta-${index}`,
          content: 'y'.repeat(200),
        })),
      },
    ],
    resolved_tab_id: 9,
  }
}

describe('tool result serialization', () => {
  it('does not compact or truncate oversized browser_navigate results', async () => {
    const browserNavigateTool = declareTool({
      name: 'browser_navigate',
      argsSchema: {
        type: 'object' as const,
        properties: {},
      },
      description: async () => 'Navigate the browser page.',
      call: async () => ({
        data: createLargeObservePayload(),
      }),
      readsOnly: () => true,
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [browserNavigateTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'tool-result-serialization',
    })

    const assistantMessage: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-browser-navigate',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'browser-navigate-1',
            toolName: 'browser_navigate',
            args: {},
          },
        ],
      },
    }

    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'browser-navigate-1',
        toolName: 'browser_navigate',
        args: {},
      },
      assistantMessage,
      async () => ({ behavior: 'allow' }),
      toolUseContext,
      {
        uuid: () => 'tool-result-uuid',
      } as QueryRuntimeDeps,
    )) {
      updates.push(update)
    }

    const content = updates
      .map(update => update.message)
      .find(Boolean)?.toolUseResult as string
    const fullPayload = createLargeObservePayload()

    expect(typeof content).toBe('string')
    expect(content.length).toBeGreaterThan(1_000)
    expect(content).toBe(JSON.stringify(fullPayload))
    expect(content).not.toContain('[Result truncated.')
    expect(content).not.toContain('"truncated":true')
    expect(JSON.parse(content)).toEqual(fullPayload)
  })

  it('delivers generic hosted content_parts as multimodal tool-result blocks', async () => {
    const readTool = declareTool({
      name: 'Read',
      argsSchema: {
        type: 'object' as const,
        properties: {},
      },
      description: async () => 'Read a file.',
      call: async () => ({
        data: {
          message: 'Image file read: /tmp/pixel.png',
          content_parts: [
            { type: 'text', text: 'Image file read: /tmp/pixel.png' },
            { type: 'image', image: 'aGVsbG8=', mimeType: 'image/png' },
          ],
        },
      }),
      readsOnly: () => true,
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [readTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'tool-result-content-parts',
    })

    const assistantMessage: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-read-image',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-image-1',
            toolName: 'Read',
            args: {},
          },
        ],
      },
    }

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'read-image-1', toolName: 'Read', args: {} },
      assistantMessage,
      async () => ({ behavior: 'allow' }),
      toolUseContext,
      { uuid: () => 'read-image-result-uuid' } as QueryRuntimeDeps,
    )) {
      updates.push(update)
    }

    const message = updates.map(update => update.message).find(Boolean)!
    const content = (message.message as { content: unknown[] }).content
    const block = content[0] as { result?: unknown }
    expect(Array.isArray(block.result)).toBe(true)
    const parts = block.result as Array<Record<string, unknown>>
    expect(parts).toEqual([
      { type: 'text', text: 'Image file read: /tmp/pixel.png' },
      { type: 'image', image: 'aGVsbG8=', mimeType: 'image/png' },
    ])
    expect(message.toolUseResult).toBe('Image file read: /tmp/pixel.png')
  })
  it('delivers generic hosted document content_parts as multimodal tool-result blocks', async () => {
    const readTool = declareTool({
      name: 'Read',
      argsSchema: {
        type: 'object' as const,
        properties: {},
      },
      description: async () => 'Read a file.',
      call: async () => ({
        data: {
          message: 'PDF file read: /tmp/a.pdf',
          content_parts: [
            { type: 'text', text: 'PDF file read: /tmp/a.pdf' },
            { type: 'document', data: 'JVBERi0=', mimeType: 'application/pdf' },
          ],
        },
      }),
      readsOnly: () => true,
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [readTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'tool-result-document-parts',
    })

    const assistantMessage: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-read-pdf',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-pdf-1',
            toolName: 'Read',
            args: {},
          },
        ],
      },
    }

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'read-pdf-1', toolName: 'Read', args: {} },
      assistantMessage,
      async () => ({ behavior: 'allow' }),
      toolUseContext,
      { uuid: () => 'read-pdf-result-uuid' } as QueryRuntimeDeps,
    )) {
      updates.push(update)
    }

    const message = updates.map(update => update.message).find(Boolean)!
    const content = (message.message as { content: unknown[] }).content
    const block = content[0] as { result?: unknown }
    expect(Array.isArray(block.result)).toBe(true)
    expect(block.result).toEqual([
      { type: 'text', text: 'PDF file read: /tmp/a.pdf' },
      { type: 'document', data: 'JVBERi0=', mimeType: 'application/pdf' },
    ])
    expect(message.toolUseResult).toBe('PDF file read: /tmp/a.pdf')
  })
})

describe('tool result isError flag (prose failures)', () => {
  async function runTool(result: { data: unknown; isError?: boolean }) {
    const tool = declareTool({
      name: 'SuperEdit',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Programmable edit.',
      call: async () => result,
      readsOnly: () => false,
    })
    const toolUseContext = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'tool-result-iserror',
    })
    const assistantMessage: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-super-edit',
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'se-1', toolName: 'SuperEdit', args: {} }],
      },
    }
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'se-1', toolName: 'SuperEdit', args: {} },
      assistantMessage,
      async () => ({ behavior: 'allow' }),
      toolUseContext,
      { uuid: () => 'se-result-uuid' } as QueryRuntimeDeps,
    )) {
      updates.push(update)
    }
    const message = updates.map(update => update.message).find(Boolean)!
    const content = (message.message as { content: Array<Record<string, unknown>> }).content
    return { block: content[0]!, detail: (message as { toolCallDetail?: { isError?: boolean } }).toolCallDetail }
  }

  it('marks a prose result as an error when the tool sets result.isError, keeping the body', async () => {
    // A SuperEdit conflict/denial/throw returns a formatted STRING (not an
    // `ok:false` JSON envelope) but must still count as a failure — the
    // explicit flag is OR'd with the soft-failure detector at the dispatch
    // site, so the canonical block and the detail record both carry isError.
    const { block, detail } = await runTool({
      data: 'SuperEdit did not save: 1 file changed on disk.',
      isError: true,
    })
    expect(block.isError).toBe(true)
    expect(block.result).toContain('did not save')
    expect(detail?.isError).toBe(true)
  })

  it('leaves a normal prose result unflagged', async () => {
    const { block, detail } = await runTool({ data: 'done', isError: false })
    expect(block.isError).toBeUndefined()
    expect(detail?.isError).toBeUndefined()
  })
})

describe('BrowserScreenshot capture retry', () => {
  function screenshotResult(withImage: boolean) {
    return {
      action: 'screenshot',
      ok: true,
      observation: {
        tabs: [
          withImage
            ? {
                tab_id: 1,
                screenshot: { mime: 'image/jpeg', data_base64: 'aGVsbG8=' },
              }
            : { tab_id: 1 },
        ],
      },
    }
  }

  function makeContext(tool: ReturnType<typeof declareTool>) {
    return createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'screenshot-retry',
    })
  }

  function makeAssistant(toolName: string): ModelReplyRow {
    return {
      type: 'assistant',
      uuid: 'assistant-shot',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'shot-1',
            toolName,
            args: {},
          },
        ],
      },
    }
  }

  async function run(tool: ReturnType<typeof declareTool>, toolName: string) {
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'shot-1', toolName, args: {} },
      makeAssistant(toolName),
      async () => ({ behavior: 'allow' }),
      makeContext(tool),
      { uuid: () => 'shot-result-uuid' } as QueryRuntimeDeps,
    )) {
      updates.push(update)
    }
    return updates
  }

  it('retries ONCE when the capture leg returns ok without image bytes, and delivers the retried image', async () => {
    // Regression: the C++ capture leg can transiently fail under
    // compositor contention while the APC leg succeeds — the observation
    // arrives ok:true with NO `screenshot` key. The executor must retry
    // once instead of shipping a blank result to the model.
    let calls = 0
    const tool = declareTool({
      name: 'BrowserScreenshot',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Take a screenshot.',
      call: async () => {
        calls++
        return { data: screenshotResult(calls >= 2) }
      },
      readsOnly: () => true,
    })

    const updates = await run(tool, 'BrowserScreenshot')

    expect(calls).toBe(2)
    const message = updates.map(u => u.message).find(Boolean)!
    const content = (message.message as { content: unknown[] }).content
    // The canonical tool-result block carries the multimodal parts in
    // `result` (see createToolResultMessage) — the retried image must
    // surface there as an image content part.
    const block = content[0] as { result?: unknown }
    expect(Array.isArray(block.result)).toBe(true)
    const parts = block.result as Array<{ type: string }>
    expect(parts.some(part => part.type === 'image')).toBe(true)
  })

  it('does NOT retry when the first capture already carries the image', async () => {
    let calls = 0
    const tool = declareTool({
      name: 'BrowserScreenshot',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Take a screenshot.',
      call: async () => {
        calls++
        return { data: screenshotResult(true) }
      },
      readsOnly: () => true,
    })

    await run(tool, 'BrowserScreenshot')
    expect(calls).toBe(1)
  })

  it('delivers a shaped PNG crop as a png image part and keeps its crop metadata in the text part', async () => {
    // The host shapes BrowserScreenshot (screenshot_shaping.cc): PNG, long
    // edge capped, optionally cropped to one element. The model can only map
    // the cropped image back onto observation coordinates if `crop` / `scale`
    // / `width` / `height` survive into the text part — while the bytes move
    // to the image part and never ride as base64 text.
    const tool = declareTool({
      name: 'BrowserScreenshot',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Take a screenshot.',
      call: async () => ({
        data: {
          action: 'screenshot',
          ok: true,
          observation: {
            tabs: [
              {
                tab_id: 1,
                screenshot: {
                  mime: 'image/png',
                  data_base64: 'aGVsbG8=',
                  width: 82,
                  height: 72,
                  crop: { index: 7, box: [84, 64, 82, 72] },
                },
                elements: [],
              },
            ],
          },
        },
      }),
      readsOnly: () => true,
    })

    const updates = await run(tool, 'BrowserScreenshot')
    const message = updates.map(u => u.message).find(Boolean)!
    const content = (message.message as { content: unknown[] }).content
    const parts = (content[0] as { result?: unknown }).result as Array<{
      type: string
      text?: string
      image?: string
      mimeType?: string
    }>
    expect(Array.isArray(parts)).toBe(true)

    const image = parts.find(part => part.type === 'image')!
    expect(image.mimeType).toBe('image/png')
    expect(image.image).toBe('aGVsbG8=')

    const text = parts.find(part => part.type === 'text')!
    const shot = JSON.parse(text.text!).observation.tabs[0].screenshot
    expect(shot.data_base64).toBeUndefined()
    expect(shot.delivered_as_image).toBe(true)
    expect(shot.crop).toEqual({ index: 7, box: [84, 64, 82, 72] })
    expect(shot.width).toBe(82)
    expect(shot.height).toBe(72)
  })

  it('gives up after two retries and surfaces the blank result loudly', async () => {
    // Three consecutive blank captures = genuine breakage; the executor
    // must stop retrying (3 calls total) and ship the imageless result so
    // the failure stays visible instead of looping forever.
    let calls = 0
    const tool = declareTool({
      name: 'BrowserScreenshot',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Take a screenshot.',
      call: async () => {
        calls++
        return { data: screenshotResult(false) }
      },
      readsOnly: () => true,
    })

    const updates = await run(tool, 'BrowserScreenshot')
    expect(calls).toBe(3)
    const message = updates.map(u => u.message).find(Boolean)!
    const content = (message.message as { content: unknown[] }).content
    const block = content[0] as { result?: unknown }
    // No image part — the blank result ships as plain text.
    expect(typeof block.result).toBe('string')
  })

  it('does NOT retry non-screenshot tools whose results lack images', async () => {
    let calls = 0
    const tool = declareTool({
      name: 'BrowserReadPage',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Read the page.',
      call: async () => {
        calls++
        return { data: { action: 'read_page', ok: true, observation: {} } }
      },
      readsOnly: () => true,
    })

    await run(tool, 'BrowserReadPage')
    expect(calls).toBe(1)
  })
})

// ===========================================================================
// Ingest-time image downscaling (`shrinkToolResultImage` in `buildToolResultContent`), guard paths only: the node
// env has no `createImageBitmap`, so the real shrink is pinned by e2e. Every failure mode keeps the ORIGINAL bytes.
// ===========================================================================

describe('image downscaling at ingest — guard paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the original when the platform cannot decode images', async () => {
    // The node/older-host case. `createImageBitmap` is already absent here;
    // stub it explicitly so the test states its precondition rather than
    // depending on the ambient environment.
    vi.stubGlobal('createImageBitmap', undefined)
    expect(
      await shrinkToolResultImage('A'.repeat(120_000), 'image/jpeg'),
    ).toBeNull()
  })

  it('keeps a small payload without spending a decode on it', async () => {
    let decoded = false
    vi.stubGlobal('createImageBitmap', async () => {
      decoded = true
      return { width: 4000, height: 4000, close: () => {} }
    })
    expect(await shrinkToolResultImage('AAAA', 'image/png')).toBeNull()
    expect(decoded, 'no decode spent on a payload too small to matter').toBe(
      false,
    )
  })

  it('keeps the original when the payload will not decode', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('not an image')
    })
    expect(
      await shrinkToolResultImage('A'.repeat(120_000), 'image/jpeg'),
    ).toBeNull()
  })

  it('keeps an image already inside the tool-result edge cap', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({
      width: 800,
      height: 600,
      close: () => {},
    }))
    expect(
      await shrinkToolResultImage('A'.repeat(120_000), 'image/jpeg'),
    ).toBeNull()
  })

  it('passes an oversized GIF through untouched to preserve animation', async () => {
    // The canvas re-encode draws a SINGLE frame, and its non-PNG branch is
    // the JPEG quality ladder — so downscaling an animated GIF silently
    // returns one still frame with nothing in the result saying the rest were
    // dropped. `encodeImageFile` keeps an in-bounds GIF untouched for the same
    // reason. A large GIF on the wire is the lesser harm.
    let decoded = false
    vi.stubGlobal('createImageBitmap', async () => {
      decoded = true
      return { width: 4000, height: 3000, close: () => {} }
    })
    expect(
      await shrinkToolResultImage('A'.repeat(120_000), 'image/gif'),
    ).toBeNull()
    expect(decoded, 'GIF is not even decoded').toBe(false)
  })

  it('delivers the original image when downscaling declines', async () => {
    // The wiring guarantee: `buildToolResultContent` awaits the downscale and
    // falls back to the untouched part, so a hosted Read image survives a
    // platform that cannot resize it. Without the `?? original` fallback this
    // would deliver undefined and the model would lose the screenshot.
    vi.stubGlobal('createImageBitmap', undefined)
    const original = 'A'.repeat(120_000)

    const readTool = declareTool({
      name: 'Read',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Read a file.',
      call: async () => ({
        data: {
          message: 'Image file read: /tmp/shot.png',
          content_parts: [
            { type: 'text', text: 'Image file read: /tmp/shot.png' },
            { type: 'image', image: original, mimeType: 'image/jpeg' },
          ],
        },
      }),
      readsOnly: () => true,
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [readTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'tool-result-downscale',
    })

    const assistantMessage: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-read-downscale',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-downscale-1',
            toolName: 'Read',
            args: {},
          },
        ],
      },
    }

    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'read-downscale-1',
        toolName: 'Read',
        args: {},
      },
      assistantMessage,
      async () => ({ behavior: 'allow' }),
      toolUseContext,
      { uuid: () => 'read-downscale-result-uuid' } as QueryRuntimeDeps,
    )) {
      updates.push(update)
    }

    const message = updates.map(update => update.message).find(Boolean)!
    const content = (message.message as { content: unknown[] }).content
    const parts = (content[0] as { result: Array<Record<string, unknown>> })
      .result
    expect(parts).toEqual([
      { type: 'text', text: 'Image file read: /tmp/shot.png' },
      { type: 'image', image: original, mimeType: 'image/jpeg' },
    ])
  })
})
