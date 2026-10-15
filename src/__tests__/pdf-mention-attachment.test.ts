import { afterEach, describe, expect, it } from 'vitest'

import {
  collectInitialAttachmentMessages,
  estimatePdfPageCount,
} from '../messages/contextAttachments'
import { renderAttachmentMessage } from '../messages/renderAttachments'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import { layerFilePath } from '../settings/settingsStore'
import { wipeSettingsMemos } from '../settings/storeCache'
import type { ContextRow } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'

// An @-mentioned PDF: more than 10 pages → a `pdf_reference` note; 10 or fewer → the PDF inlined as a document in
// the same turn, never the UTF-8 text path. Source of truth: src/messages/contextAttachments.ts
// (createPdfAttachment) and src/messages/renderAttachments.ts (pdf_reference / pdf_document).

const PDF_PATH = '/workspace/.velloc/uploads/s1/claim.pdf'

// A PDF-shaped byte buffer whose leading bytes carry `formFeeds` 0x0C bytes,
// as compressed streams do.
function pdfBytes(size: number, formFeeds: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x41)
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'))
  for (let i = 0; i < formFeeds; i++) {
    bytes[100 + i * 50] = 0x0c
  }
  return bytes
}

function makeFs(files: Record<string, Uint8Array>): {
  fs: RuntimeFs
  textReads: string[]
} {
  const textReads: string[] = []
  const fs: RuntimeFs = {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      const file = files[path]
      if (!file) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return {
        size: file.byteLength,
        mtimeMs: 1,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        isCharacterDevice: () => false,
        isBlockDevice: () => false,
      } as RuntimeFsStat
    },
    async readFile(path: string): Promise<string> {
      textReads.push(path)
      return new TextDecoder().decode(files[path])
    },
    async readFileBytes(path: string, maxBytes?: number): Promise<Uint8Array> {
      const file = files[path]!
      return maxBytes === undefined ? file : file.slice(0, maxBytes)
    },
  } as RuntimeFs
  return { fs, textReads }
}

// A stand-in for the hosted Read: `respond` is what the native media service
// would return (content parts) or throw for a whole-document read.
function fakeReadTool(respond: (input: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    tool: {
      name: 'Read',
      async call(input: Record<string, unknown>) {
        calls.push(input)
        return { data: respond(input) }
      },
    },
  }
}

function wholeDocumentResult(path: string, pages: number) {
  return {
    content_parts: [
      { type: 'text', text: `PDF file read: ${path} (${pages} page(s))` },
      { type: 'document', mimeType: 'application/pdf', data: 'JVBERi0xLjc=' },
    ],
    message: `Media file read: ${path}`,
  }
}

// A paged Read of `pages` ("A" or "A-B") on a `total`-page PDF, as
// pdf_processor.cc answers it: the range is clamped to the last page and the
// header names the real total.
function pagedResult(path: string, pages: string, total: number, imageChars = 16) {
  const [first, last = first] = pages.split('-').map(Number) as [number, number?]
  const end = Math.min(last!, total)
  const parts: Array<Record<string, unknown>> = [
    { type: 'text', text: `PDF file read: ${path} (pages ${first}-${end} of ${total})` },
  ]
  for (let page = first; page <= end; page++) {
    parts.push({ type: 'text', text: `
<page number="${page}">` })
    parts.push({ type: 'image', mimeType: 'image/jpeg', data: 'J'.repeat(imageChars) + page })
    parts.push({ type: 'text', text: '</page>' })
  }
  return { content_parts: parts, message: `Media file read: ${path}` }
}

const TOO_MANY_PAGES = (pages: number) =>
  new Error(
    `pdf_too_many_pages: This PDF has ${pages} pages, which is too many to read at once. ` +
      'Use the pages parameter to read specific page ranges (maximum 20 pages per request).',
  )

// The native Read for a `total`-page PDF: the document without `pages` (or
// the too-many-pages error past 10), the page images with them.
function pdfRead(total: number) {
  return fakeReadTool(input => {
    if (input.pages === undefined) {
      if (total > 10) throw TOO_MANY_PAGES(total)
      return wholeDocumentResult(PDF_PATH, total)
    }
    return pagedResult(PDF_PATH, input.pages as string, total)
  })
}

function twoPageRead() {
  return pdfRead(2)
}

type SessionModel = { providerId?: string; modelId: string; homeDir?: string }

// `documentParts`: whether the host advertises `llmDocumentParts` (a binary
// whose LLM bridge takes a top-level document part). `model`: the session's
// provider/model, which decides how a PDF is inlined (documentInput).
function makeContext(
  tools: unknown[] = [],
  documentParts = true,
  model?: SessionModel,
): ToolCallContext {
  let appState: Record<string, unknown> = {
    permissionRules: { mode: 'default' },
    attachmentState: {},
  }
  return {
    options: {
      cwd: '/workspace',
      sessionId: 'session-1',
      commands: [],
      tools,
      mainLoopModel: model?.modelId ?? 'inherit',
      ...(model?.providerId ? { mainLoopProviderId: model.providerId } : {}),
      ...(model?.homeDir ? { homeDir: model.homeDir } : {}),
    },
    messages: [],
    fileReadLedger: new Map(),
    platformCapabilities: { supportsLlmDocumentParts: () => documentParts },
    readAppState: () => appState,
    writeAppState: (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    },
  } as unknown as ToolCallContext
}

async function mentionAttachments(
  input: string,
  tools: unknown[] = [],
  documentParts = true,
  model?: SessionModel,
): Promise<ContextRow[]> {
  const messages = await collectInitialAttachmentMessages({
    input,
    context: makeContext(tools, documentParts, model),
    runtimeConfig: new BrowserRuntimeConfig(),
    hostBridge: {} as never,
  })
  return messages.filter(m =>
    ['pdf_reference', 'pdf_document', 'file', 'file_parts'].includes(m.attachment.type),
  )
}

afterEach(() => {
  resetProcessFs()
  wipeSettingsMemos()
})

describe('@-mentioned PDF', () => {
  it('estimates pages from size alone, ~100 KB per page', () => {
    expect(estimatePdfPageCount(62_490)).toBe(1)
    expect(estimatePdfPageCount(0)).toBe(1)
    expect(estimatePdfPageCount(1_500_000)).toBe(15)
  })

  it('inlines a small PDF as a document in the same turn, whatever its form-feed bytes say', async () => {
    const { fs, textReads } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 14) })
    installProcessFs(fs)
    const read = fakeReadTool(() => wholeDocumentResult(PDF_PATH, 2))

    const attachments = await mentionAttachments(
      `@"${PDF_PATH}" what was paid?`,
      [read.tool],
    )

    // One whole-document Read — no `pages`, since the count is not guessed.
    expect(read.calls).toEqual([{ file_path: PDF_PATH }])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({
        type: 'pdf_document',
        filename: PDF_PATH,
        summary: `PDF file read: ${PDF_PATH} (2 page(s))`,
        data: 'JVBERi0xLjc=',
        mimeType: 'application/pdf',
      }),
    ])
    // Never decoded as a text file.
    expect(textReads).toEqual([])

    // The model sees the synthetic Read line and the document part.
    const rendered = renderAttachmentMessage(attachments[0]!)
    expect(rendered).toHaveLength(1)
    const content = (rendered[0]!.message as { content: unknown })
      .content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'text' })
    expect(content[0]!.text).toContain(
      `Called the Read tool with the following input: {"file_path":"${PDF_PATH}"}`,
    )
    expect(content[0]!.text).toContain(`PDF file read: ${PDF_PATH} (2 page(s))`)
    expect(content[1]).toEqual({
      type: 'document',
      data: 'JVBERi0xLjc=',
      mimeType: 'application/pdf',
    })
  })

  it('on an older binary without top-level document parts, references the PDF with its real count instead', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 14) })
    installProcessFs(fs)
    const read = twoPageRead()

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], false)

    // Counted from a one-page Read: the document is never shipped for a count.
    expect(read.calls).toEqual([{ file_path: PDF_PATH, pages: '1' }])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'pdf_reference', pageCount: 2 }),
    ])
  })

  it('takes the real page count from the native Read when the PDF is too large to inline', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 2) })
    installProcessFs(fs)
    const read = fakeReadTool(() => {
      throw new Error(
        'pdf_too_many_pages: This PDF has 12 pages, which is too many to read at once. ' +
          'Use the pages parameter to read specific page ranges (maximum 20 pages per request).',
      )
    })

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool])

    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'pdf_reference', pageCount: 12, fileSize: 62_490 }),
    ])
    expect(attachments[0]!.attachment).not.toHaveProperty('unreadable')
    const text = (renderAttachmentMessage(attachments[0]!)[0]!.message as { content: unknown })
      .content as string
    expect(text).toContain(`PDF file: ${PDF_PATH} (12 pages, 62490 bytes).`)
    expect(text).toContain('This PDF is too large to read all at once.')
    expect(text).toContain('Maximum 20 pages per request.')
  })

  it("reads through the session's own fs, not the realm-global slot", async () => {
    // The global slot belongs to whichever runtime scope wrote it last; once
    // that scope is disposed every call through it throws, and the mention
    // was silently dropped.
    installProcessFs({
      ...unconfiguredFs,
      async stat() {
        throw new Error('Runtime scope was disposed.')
      },
    } as RuntimeFs)
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    const context = makeContext([fakeReadTool(() => wholeDocumentResult(PDF_PATH, 2)).tool])
    ;(context.options as { fsOperations?: RuntimeFs }).fsOperations = fs

    const messages = await collectInitialAttachmentMessages({
      input: `@"${PDF_PATH}"`,
      context,
      runtimeConfig: new BrowserRuntimeConfig(),
      hostBridge: {} as never,
    })

    expect(messages.map(m => m.attachment.type)).toContain('pdf_document')
  })

  it('falls back to the size estimate with a > 10 threshold when Read cannot run', async () => {
    const { fs, textReads } = makeFs({
      '/workspace/small.pdf': pdfBytes(62_490, 14),
      // Exactly 10 estimated pages: inlined, so no reference.
      '/workspace/ten.pdf': pdfBytes(1_000 * 1024, 3),
      '/workspace/book.pdf': pdfBytes(1_500_000, 3),
    })
    installProcessFs(fs)

    const attachments = await mentionAttachments(
      '@"/workspace/small.pdf" @"/workspace/ten.pdf" @"/workspace/book.pdf"',
    )

    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({
        type: 'pdf_reference',
        filename: '/workspace/book.pdf',
        pageCount: 15,
      }),
    ])
    expect(textReads).toEqual([])
  })
})

// (F-12):
// a provider with no document part gets the PDF as the page images a paged
// Read returns, in the same turn -- not a "cannot be shown" marker the model
// has to answer with a Read of its own.
describe('@-mentioned PDF by document input mode', () => {
  const kimi: SessionModel = { providerId: 'kimi', modelId: 'k3' }

  it('sends page images on a rasterize provider, from a second, paged Read', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = twoPageRead()

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, kimi)

    // A one-page Read counts the pages; the paged one renders them. The
    // whole document never crosses the bridge.
    expect(read.calls).toEqual([
      { file_path: PDF_PATH, pages: '1' },
      { file_path: PDF_PATH, pages: '1-2' },
    ])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'file_parts', filename: PDF_PATH, pages: '1-2' }),
    ])

    // The model sees the paged Read call and its result: two JPEGs, no
    // document part.
    const rendered = renderAttachmentMessage(attachments[0]!)
    expect(rendered).toHaveLength(2)
    expect((rendered[0]!.message as { content: unknown }).content).toContain(
      `Called the Read tool with the following input: {"file_path":"${PDF_PATH}","pages":"1-2"}`,
    )
    const content = (rendered[1]!.message as { content: unknown }).content as Array<
      Record<string, unknown>
    >
    expect(content.filter(block => block.type === 'image')).toEqual([
      { type: 'image', image: `${'J'.repeat(16)}1`, mimeType: 'image/jpeg' },
      { type: 'image', image: `${'J'.repeat(16)}2`, mimeType: 'image/jpeg' },
    ])
    expect(content.some(block => block.type === 'document')).toBe(false)
    expect(JSON.stringify(content)).toContain(`PDF file read: ${PDF_PATH} (pages 1-2 of 2)`)
  })

  it('rasterizes on a binary without top-level document parts too', async () => {
    // Page images are ordinary image parts; only `native` needs the bridge's
    // document part.
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [twoPageRead().tool], false, kimi)

    expect(attachments.map(a => a.attachment.type)).toEqual(['file_parts'])
  })

  it('keeps the document on a native provider, with one Read', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = twoPageRead()

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, {
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
    })

    expect(read.calls).toEqual([{ file_path: PDF_PATH }])
    expect(attachments.map(a => a.attachment.type)).toEqual(['pdf_document'])
  })

  it('references the PDF on a text-only model (none), from a one-page count', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = twoPageRead()

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    })

    expect(read.calls).toEqual([{ file_path: PDF_PATH, pages: '1' }])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({
        type: 'pdf_reference',
        pageCount: 2,
        unreadable: 'text-only-model',
      }),
    ])
    // No "read it in page ranges" note: a paged Read returns images,
    // which a text-only model cannot take either.
    const text = (renderAttachmentMessage(attachments[0]!)[0]!.message as { content: unknown })
      .content as string
    expect(text).toContain(`PDF file: ${PDF_PATH} (2 pages, 62490 bytes).`)
    expect(text).toContain('The current model cannot take images or documents')
    expect(text).toContain('Do NOT try to read it with Read.')
    expect(text).not.toContain('too large to read all at once')
    expect(text).not.toContain('pages parameter')
  })

  it('tells a text-only model a long PDF is unreadable too, not to page through it', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = pdfRead(12)

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    })

    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({
        type: 'pdf_reference',
        pageCount: 12,
        unreadable: 'text-only-model',
      }),
    ])
  })

  it('references the PDF when the page images are over the 8 MB inline cap', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = fakeReadTool(input =>
      pagedResult(PDF_PATH, input.pages as string, 2, input.pages === '1' ? 16 : 4 * 1024 * 1024 + 1),
    )

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, kimi)

    expect(read.calls).toHaveLength(2)
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'pdf_reference', pageCount: 2 }),
    ])
  })

  it('references the PDF when the paged Read fails', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = fakeReadTool(input => {
      if (input.pages === '1') return pagedResult(PDF_PATH, '1', 2)
      throw new Error('pdf_render_failed: failed to render PDF page')
    })

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, kimi)

    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'pdf_reference', pageCount: 2 }),
    ])
  })

  it("takes the settings' active provider when the session names none", async () => {
    const homeDir = '/home/user'
    const settingsPath = layerFilePath('userSettings', { homeDir })
    const { fs } = makeFs({
      [PDF_PATH]: pdfBytes(62_490, 0),
      [settingsPath]: new TextEncoder().encode(
        JSON.stringify({ version: 1, providers: { activeProviderId: 'kimi', configs: {} } }),
      ),
    })
    installProcessFs(fs)

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [twoPageRead().tool], true, {
      modelId: 'k3',
      homeDir,
    })

    expect(attachments.map(a => a.attachment.type)).toEqual(['file_parts'])
  })
})

// Only "too many pages" carries a count. Every other Read failure used to
// be swallowed into the size estimate — for a small file, no attachment at
// all; for a large one, a pdf_reference with a made-up page count pointing the
// model at page reads that fail the same way.
describe('@-mentioned PDF that Read cannot read', () => {
  const kimi: SessionModel = { providerId: 'kimi', modelId: 'k3' }
  const failing = (message: string) =>
    fakeReadTool(() => {
      throw new Error(message)
    })

  it.each([
    'invalid_pdf: File is not a valid PDF (missing %PDF- header).',
    'invalid_pdf: PDF file is corrupted or invalid.',
    'read_failed: failed to read PDF file',
    'file_too_large: PDF file exceeds maximum allowed size for Read.',
  ])('shows the model the Read error, not a guessed count: %s', async message => {
    // 1.5 MB: the size estimate alone would say 15 pages.
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(1_500_000, 0) })
    installProcessFs(fs)

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [failing(message).tool])

    expect(attachments.map(a => a.attachment)).toEqual([
      {
        type: 'file_parts',
        filename: PDF_PATH,
        displayPath: PDF_PATH.replace('/workspace/', ''),
        parts: [{ type: 'text', text: `Error: ${message}` }],
      },
    ])
    const rendered = renderAttachmentMessage(attachments[0]!).map(
      m => (m.message as { content: unknown }).content,
    )
    expect(rendered[0]).toContain(`Called the Read tool with the following input: {"file_path":"${PDF_PATH}"}`)
    expect(rendered[1]).toContain(`Error: ${message}`)
  })

  it('shows the error from the count read on a rasterize provider too', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = failing('invalid_pdf: PDF file is corrupted or invalid.')

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, kimi)

    expect(read.calls).toEqual([{ file_path: PDF_PATH, pages: '1' }])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({
        type: 'file_parts',
        parts: [{ type: 'text', text: 'Error: invalid_pdf: PDF file is corrupted or invalid.' }],
      }),
    ])
  })

  it("passes on Read's own refusal (the untrusted read boundary) as the result", async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const denied =
      "Denied: the path is outside this session's allowed root (/root). " +
      'This session may only access files under /root.'
    const read = fakeReadTool(() => denied)

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool])

    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'file_parts', parts: [{ type: 'text', text: denied }] }),
    ])
  })
})

// H11: a rasterize provider never sends the document, so it is never read
// whole — the count comes from a one-page Read, which for a one-page PDF is
// already the whole answer.
describe('@-mentioned PDF page count on providers without a document part', () => {
  it('reuses the count read as the page images of a one-page PDF', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = pdfRead(1)

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, {
      providerId: 'kimi',
      modelId: 'k3',
    })

    expect(read.calls).toEqual([{ file_path: PDF_PATH, pages: '1' }])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'file_parts', pages: '1-1' }),
    ])
  })

  it('references a long PDF from the one-page count, rendering nothing more', async () => {
    const { fs } = makeFs({ [PDF_PATH]: pdfBytes(62_490, 0) })
    installProcessFs(fs)
    const read = pdfRead(40)

    const attachments = await mentionAttachments(`@"${PDF_PATH}"`, [read.tool], true, {
      providerId: 'kimi',
      modelId: 'k3',
    })

    expect(read.calls).toEqual([{ file_path: PDF_PATH, pages: '1' }])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'pdf_reference', pageCount: 40 }),
    ])
  })
})
