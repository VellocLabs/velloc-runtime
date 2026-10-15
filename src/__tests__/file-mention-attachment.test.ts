import { afterEach, describe, expect, it } from 'vitest'

import { collectInitialAttachmentMessages } from '../messages/contextAttachments'
import { renderAttachmentMessage } from '../messages/renderAttachments'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { ContextRow, UserRow } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'

// An @-mentioned non-PDF file is read by the native Read (`cat -n` text, an image as an image, a notebook as Read
// renders it, never binary decoded as UTF-8), plus the mention path's deny-rule check, 256 KB cap and directory
// listing (src/messages/contextAttachments.ts, renderAttachments.ts).

type FakeFile = { bytes: Uint8Array; mtimeMs?: number } | { dir: string[] }

function makeFs(files: Record<string, FakeFile>): {
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
      const isDir = 'dir' in file
      return {
        size: isDir ? 0 : file.bytes.byteLength,
        mtimeMs: isDir ? 1 : (file.mtimeMs ?? 1),
        isFile: () => !isDir,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        isCharacterDevice: () => false,
        isBlockDevice: () => false,
      } as RuntimeFsStat
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const file = files[path]
      if (!file || !('dir' in file)) {
        throw new Error('ENOTDIR')
      }
      return file.dir.map(name => ({
        name,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      }))
    },
    async readFile(path: string): Promise<string> {
      textReads.push(path)
      const file = files[path]
      return file && 'bytes' in file ? new TextDecoder().decode(file.bytes) : ''
    },
  } as RuntimeFs
  return { fs, textReads }
}

function text(content: string, mtimeMs?: number): FakeFile {
  return { bytes: new TextEncoder().encode(content), mtimeMs }
}

function sized(size: number): FakeFile {
  return { bytes: new Uint8Array(size).fill(0x41) }
}

// A stand-in for the hosted Read: `respond` is what the native tool returns
// (a string for text, `{ content_parts }` for media) or throws.
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

// What the native Read prints for `lines` starting at `start` (cat -n).
function numbered(lines: string[], start = 1): string {
  return lines.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n')
}

function makeContext(
  tools: unknown[],
  permissionRules: Record<string, unknown> = { mode: 'default' },
  readFileState = new Map(),
): ToolCallContext {
  let appState: Record<string, unknown> = {
    permissionRules,
    attachmentState: {},
  }
  return {
    options: {
      cwd: '/workspace',
      projectRoot: '/workspace',
      sessionId: 'session-1',
      commands: [],
      tools,
      mainLoopModel: 'inherit',
    },
    messages: [],
    fileReadLedger: readFileState,
    platformCapabilities: { supportsLlmDocumentParts: () => true },
    readAppState: () => appState,
    writeAppState: (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    },
  } as unknown as ToolCallContext
}

const MENTION_TYPES = ['file', 'file_parts', 'directory', 'pdf_reference', 'pdf_document']

async function mentionAttachments(
  input: string,
  context: ToolCallContext,
): Promise<ContextRow[]> {
  const messages = await collectInitialAttachmentMessages({
    input,
    context,
    runtimeConfig: new BrowserRuntimeConfig(),
    hostBridge: {} as never,
  })
  return messages.filter(m => MENTION_TYPES.includes(m.attachment.type))
}

function renderedTexts(message: ContextRow): Array<string | unknown[]> {
  return renderAttachmentMessage(message).map(
    m => (m as UserRow).message.content as string | unknown[],
  )
}

afterEach(() => {
  resetProcessFs()
})

describe('@-mentioned text file', () => {
  it("is read by the native Read and shown as that Read call, with Read's line numbers", async () => {
    const { fs, textReads } = makeFs({ '/workspace/src/x.ts': text('const a = 1\nconst b = 2') })
    installProcessFs(fs)
    const output = numbered(['const a = 1', 'const b = 2'])
    const read = fakeReadTool(() => output)

    const attachments = await mentionAttachments('@src/x.ts explain', makeContext([read.tool]))

    expect(read.calls).toEqual([{ file_path: '/workspace/src/x.ts' }])
    expect(textReads).toEqual([])
    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({
        type: 'file',
        filename: '/workspace/src/x.ts',
        displayPath: 'src/x.ts',
        content: expect.objectContaining({
          file: expect.objectContaining({ content: output, startLine: 1, numLines: 2 }),
        }),
      }),
    ])
    expect(renderedTexts(attachments[0]!)).toEqual([
      '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/workspace/src/x.ts"}\n</system-reminder>',
      `<system-reminder>\nResult of calling the Read tool:\n${output}\n</system-reminder>`,
    ])
    expect(output).toContain('     1\tconst a = 1')
  })

  it('turns a #L range into Read offset and limit', async () => {
    const { fs } = makeFs({ '/workspace/a.ts': text('x\n'.repeat(20)) })
    installProcessFs(fs)
    const read = fakeReadTool(() => numbered(['x', 'x', 'x', 'x'], 5))

    const attachments = await mentionAttachments('@a.ts#L5-8', makeContext([read.tool]))

    expect(read.calls).toEqual([{ file_path: '/workspace/a.ts', offset: 5, limit: 4 }])
    expect(attachments[0]!.attachment).toMatchObject({
      type: 'file',
      content: { file: { startLine: 5 } },
    })
  })

  it('keeps a # in a folder name as part of the path (a C# project, an upload under it)', async () => {
    // Only a trailing `#L…` range is split off: cutting the mention at its
    // first '#' would look up every file under a folder like `C#` as
    // `/workspace/C` and drop it.
    const { fs } = makeFs({
      '/workspace/C#/app/a.ts': text('x\n'.repeat(20)),
      '/workspace/C#/.velloc/uploads/s1/1a2b3c4d-notes.md': text('hello'),
    })
    installProcessFs(fs)
    const read = fakeReadTool(() => numbered(['x', 'x'], 2))

    const attachments = await mentionAttachments(
      '@"/workspace/C#/.velloc/uploads/s1/1a2b3c4d-notes.md" @"/workspace/C#/app/a.ts#L2-3" look',
      makeContext([read.tool]),
    )

    expect(read.calls).toEqual([
      { file_path: '/workspace/C#/.velloc/uploads/s1/1a2b3c4d-notes.md' },
      { file_path: '/workspace/C#/app/a.ts', offset: 2, limit: 2 },
    ])
    expect(attachments.map(a => a.attachment.type)).toEqual(['file', 'file'])
  })

  // A mention over 256 KB is read from its head (one bounded Read) with a
  // truncation note rather than dropped: dropping it would give the model
  // nothing for a file the user pointed at — a large paste included, which rides this path as an uploaded pasted-text-<n>.txt.
  it('reads the head of a file over 256 KB, with the truncation note', async () => {
    const { fs, textReads } = makeFs({ '/workspace/big.log': sized(300 * 1024) })
    installProcessFs(fs)
    const read = fakeReadTool(() => numbered(['first', 'second']))

    const attachments = await mentionAttachments('@big.log', makeContext([read.tool]))

    // One bounded Read — never the whole file, and never a second reader.
    expect(read.calls).toEqual([{ file_path: '/workspace/big.log', offset: 1, limit: 2000 }])
    expect(textReads).toEqual([])
    expect(attachments[0]!.attachment).toMatchObject({ type: 'file', truncated: true })
    const rendered = renderedTexts(attachments[0]!)
    expect(rendered).toHaveLength(3)
    expect(rendered[1]).toContain('first')
    expect(rendered[2]).toContain(
      'Note: The file /workspace/big.log was too large and has been truncated to the first 2000 lines.',
    )
  })

  it('reaches the model for a pasted-text upload over 256 KB', async () => {
    const path = '/workspace/.velloc/uploads/s1/1a2b3c4d-pasted-text-1.txt'
    const { fs } = makeFs({ [path]: sized(400 * 1024) })
    installProcessFs(fs)
    const read = fakeReadTool(() => numbered(['pasted']))

    const attachments = await mentionAttachments(`@"${path}" summarise`, makeContext([read.tool]))

    expect(attachments.map(a => a.attachment)).toEqual([
      expect.objectContaining({ type: 'file', filename: path, truncated: true }),
    ])
  })

  it('keeps an explicit #L range on a file over 256 KB, untruncated', async () => {
    const { fs } = makeFs({ '/workspace/big.log': sized(300 * 1024) })
    installProcessFs(fs)
    const read = fakeReadTool(() => numbered(['x', 'y'], 10))

    const attachments = await mentionAttachments('@big.log#L10-11', makeContext([read.tool]))

    expect(read.calls).toEqual([{ file_path: '/workspace/big.log', offset: 10, limit: 2 }])
    expect(attachments[0]!.attachment).not.toHaveProperty('truncated')
  })

  it('reads the first 2000 lines when the whole file is over Read\'s token budget, and says so', async () => {
    const { fs } = makeFs({ '/workspace/huge.ts': sized(200 * 1024) })
    installProcessFs(fs)
    const read = fakeReadTool(input => {
      if (input.limit === undefined) {
        throw new Error(
          'max_file_read_token_exceeded: File content (60000 tokens) exceeds maximum allowed tokens (25000).',
        )
      }
      return numbered(['A'])
    })

    const attachments = await mentionAttachments('@huge.ts', makeContext([read.tool]))

    expect(read.calls).toEqual([
      { file_path: '/workspace/huge.ts' },
      { file_path: '/workspace/huge.ts', offset: 1, limit: 2000 },
    ])
    expect(attachments[0]!.attachment).toMatchObject({ type: 'file', truncated: true })
    const rendered = renderedTexts(attachments[0]!)
    expect(rendered).toHaveLength(3)
    expect(rendered[2]).toContain(
      'Note: The file /workspace/huge.ts was too large and has been truncated to the first 2000 lines.',
    )
  })

  it('drops the mention when a read deny rule matches, without reading', async () => {
    const { fs } = makeFs({ '/workspace/secrets/key.txt': text('hunter2') })
    installProcessFs(fs)
    const read = fakeReadTool(() => numbered(['hunter2']))

    const attachments = await mentionAttachments(
      '@secrets/key.txt',
      makeContext([read.tool], {
        mode: 'default',
        ruleLists: { allow: [], deny: ['Read(secrets/**)'], ask: [] },
      }),
    )

    expect(attachments).toEqual([])
    expect(read.calls).toEqual([])
  })

  it('sends nothing when Read answers that this exact read is already in the conversation', async () => {
    const { fs } = makeFs({ '/workspace/a.ts': text('x') })
    installProcessFs(fs)
    const read = fakeReadTool(
      () =>
        'This file has not changed since you last read it; the earlier Read result in this conversation is still accurate, so use that.',
    )

    expect(await mentionAttachments('@a.ts', makeContext([read.tool]))).toEqual([])
  })

  it('skips a file whose recorded state (a Write/Edit mtime) still matches, without reading', async () => {
    const { fs } = makeFs({ '/workspace/a.ts': text('x', 42) })
    installProcessFs(fs)
    const read = fakeReadTool(() => numbered(['x']))
    const readFileState = new Map([['/workspace/a.ts', { content: 'x', timestamp: 42 }]])

    const attachments = await mentionAttachments(
      '@a.ts',
      makeContext([read.tool], { mode: 'default' }, readFileState),
    )

    expect(attachments).toEqual([])
    expect(read.calls).toEqual([])
  })

  it('has no second reader: without a Read tool nothing is decoded', async () => {
    const { fs, textReads } = makeFs({ '/workspace/a.ts': text('x') })
    installProcessFs(fs)

    expect(await mentionAttachments('@a.ts', makeContext([]))).toEqual([])
    expect(textReads).toEqual([])
  })

  it('drops the mention when Read rejects the file (a binary it cannot read)', async () => {
    const { fs } = makeFs({ '/workspace/app.exe': sized(1024) })
    installProcessFs(fs)
    const read = fakeReadTool(() => {
      throw new Error('unsupported_binary_file: File appears to be binary.')
    })

    expect(await mentionAttachments('@app.exe', makeContext([read.tool]))).toEqual([])
  })
})

describe('@-mentioned image and notebook', () => {
  const imageResult = {
    content_parts: [
      { type: 'text', text: 'Image file read: /workspace/shot.png (800x600)' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ],
  }

  it('sends an image as an image block, never as UTF-8 text', async () => {
    const { fs, textReads } = makeFs({ '/workspace/shot.png': sized(10 * 1024) })
    installProcessFs(fs)
    const read = fakeReadTool(() => imageResult)

    const attachments = await mentionAttachments('@"shot.png" what is this?', makeContext([read.tool]))

    expect(read.calls).toEqual([{ file_path: '/workspace/shot.png' }])
    expect(textReads).toEqual([])
    expect(attachments.map(a => a.attachment)).toEqual([
      {
        type: 'file_parts',
        filename: '/workspace/shot.png',
        displayPath: 'shot.png',
        parts: [
          { type: 'text', text: 'Image file read: /workspace/shot.png (800x600)' },
          { type: 'image', image: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      },
    ])
    const rendered = renderedTexts(attachments[0]!)
    expect(rendered[0]).toContain(
      'Called the Read tool with the following input: {"file_path":"/workspace/shot.png"}',
    )
    expect(rendered[1]).toEqual([
      {
        type: 'text',
        text: '<system-reminder>\nImage file read: /workspace/shot.png (800x600)\n</system-reminder>',
      },
      { type: 'image', image: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
  })

  it('reads an image over 256 KB (Read downsamples it)', async () => {
    const { fs } = makeFs({ '/workspace/shot.png': sized(900 * 1024) })
    installProcessFs(fs)
    const read = fakeReadTool(() => imageResult)

    const attachments = await mentionAttachments('@shot.png', makeContext([read.tool]))

    expect(attachments.map(a => a.attachment.type)).toEqual(['file_parts'])
  })

  it('shows a notebook without images as one text result', async () => {
    const { fs } = makeFs({ '/workspace/nb.ipynb': sized(2 * 1024) })
    installProcessFs(fs)
    const read = fakeReadTool(() => ({
      content_parts: [
        { type: 'text', text: 'Notebook read: /workspace/nb.ipynb (2 cells)' },
        { type: 'text', text: '<cell id="cell-0">print(1)</cell>' },
      ],
    }))

    const attachments = await mentionAttachments('@nb.ipynb', makeContext([read.tool]))

    expect(renderedTexts(attachments[0]!)[1]).toBe(
      '<system-reminder>\nResult of calling the Read tool:\n' +
        'Notebook read: /workspace/nb.ipynb (2 cells)\n<cell id="cell-0">print(1)</cell>\n' +
        '</system-reminder>',
    )
  })
})

describe('@-mentioned directory', () => {
  it('lists its entries, shown as the ls that lists them', async () => {
    const { fs } = makeFs({ '/workspace/src': { dir: ['a.ts', 'b.ts'] } })
    installProcessFs(fs)
    const read = fakeReadTool(() => 'unreachable')

    const attachments = await mentionAttachments('@src', makeContext([read.tool]))

    expect(read.calls).toEqual([])
    expect(attachments.map(a => a.attachment)).toEqual([
      { type: 'directory', path: '/workspace/src', displayPath: 'src', content: 'a.ts\nb.ts' },
    ])
    expect(renderedTexts(attachments[0]!)).toEqual([
      '<system-reminder>\nCalled the Bash tool with the following input: {"command":"ls /workspace/src","description":"Lists files in /workspace/src"}\n</system-reminder>',
      '<system-reminder>\nResult of calling the Bash tool:\na.ts\nb.ts\n</system-reminder>',
    ])
  })

  // A child on an untrusted provider may read only under its root. A file
  // mention goes through Read (the hosted dispatch enforces the boundary); a
  // directory is listed here, and was listed from anywhere on the disk.
  describe('under the untrusted read boundary', () => {
    const untrusted = (tools: unknown[]) => {
      const context = makeContext(tools)
      ;(context.options as { untrustedReadRoot?: string }).untrustedReadRoot = '/workspace/project'
      return context
    }

    it('refuses a directory outside the root, listing nothing', async () => {
      const { fs } = makeFs({ '/workspace/secrets': { dir: ['id_rsa', 'tokens.json'] } })
      installProcessFs(fs)

      const attachments = await mentionAttachments('@secrets', untrusted([]))

      expect(attachments.map(a => a.attachment)).toEqual([
        {
          type: 'directory',
          path: '/workspace/secrets',
          displayPath: 'secrets',
          content:
            "Denied: the path is outside this session's allowed root (/workspace/project). " +
            'This session may only access files under /workspace/project.',
        },
      ])
      expect(JSON.stringify(attachments)).not.toContain('id_rsa')
    })

    it('refuses a directory inside the root that links out of it', async () => {
      const { fs } = makeFs({ '/workspace/project/link': { dir: ['id_rsa'] } })
      fs.realpath = async (path: string) =>
        path === '/workspace/project/link' ? '/elsewhere/keys' : path
      installProcessFs(fs)

      const attachments = await mentionAttachments('@project/link', untrusted([]))

      expect((attachments[0]!.attachment as { content: string }).content).toMatch(/^Denied: /)
    })

    it('still lists a directory inside the root', async () => {
      const { fs } = makeFs({ '/workspace/project/src': { dir: ['a.ts'] } })
      installProcessFs(fs)

      const attachments = await mentionAttachments('@project/src', untrusted([]))

      expect(attachments.map(a => a.attachment)).toEqual([
        { type: 'directory', path: '/workspace/project/src', displayPath: 'project/src', content: 'a.ts' },
      ])
    })
  })

  it('caps the listing at 1000 entries', async () => {
    const names = Array.from({ length: 1003 }, (_, i) => `f${i}`)
    const { fs } = makeFs({ '/workspace/many': { dir: names } })
    installProcessFs(fs)

    const attachments = await mentionAttachments('@many', makeContext([]))

    const content = (attachments[0]!.attachment as { content: string }).content
    expect(content.split('\n')).toHaveLength(1001)
    expect(content.endsWith('… and 3 more entries')).toBe(true)
  })
})
