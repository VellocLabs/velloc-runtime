/**
 * `prompt.mention` (F-25): one file a submitted prompt names after `@`,
 * raised before it is read. The shapes and pins; the chain through a real
 * `ModRuntime` (deny by a path matcher, context added, another path read, one
 * read per mention, a broken answer passed over); and the prompt's attachment
 * step routing each file mention through it, with no `tool.call` for the read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  droppedContextProblem,
  isPromptMentionResult,
  mentionInputProblem,
  type PromptMentionCore,
  type PromptMentionInput,
  type PromptMentionSettlement,
} from '../mods/promptMentionEvent'
import { collectPromptAttachments } from '../messages/contextAttachments'
import { unconfiguredFs, installProcessFs, resetProcessFs, type RuntimeFs, type RuntimeFsStat } from '../utils/fs/runtimeFs'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { ToolCallContext } from '../toolkit/toolCallContext'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  resetProcessFs()
})

let uniq = 0

function world(sources: Record<string, string>) {
  const reports: string[] = []
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({ plugin: path.split('/')[0]!, path }))
  const runtime = new ModRuntime({
    modules,
    readModule: async path => `${sources[path]!}\n// load ${++uniq}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 'session-1', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

const ENV: PromptMentionInput = { mention: '.env', path: '/work/project/.env' }
const NOTES: PromptMentionInput = { mention: 'notes.md#L2-4', path: '/work/project/notes.md', offset: 2, limit: 3 }

function recordingCore(answer: (path: string) => Awaited<ReturnType<PromptMentionCore>> = () => ({ type: 'file' })) {
  const reads: Array<{ path: string; offset?: number; limit?: number }> = []
  const core: PromptMentionCore = async e => {
    reads.push(e)
    return answer(e.path)
  }
  return { core, reads }
}

describe('the shapes', () => {
  it('answers, pins and the context a next gave', () => {
    expect(isPromptMentionResult({ type: 'file' })).toBe(true)
    expect(isPromptMentionResult({ type: null, context: ['x'] })).toBe(true)
    expect(isPromptMentionResult({ type: 'already_read_file' })).toBe(true)
    expect(isPromptMentionResult({ deny: 'a secret' })).toBe(true)
    expect(isPromptMentionResult({ deny: '' })).toBe(false)
    expect(isPromptMentionResult({ type: 'image' })).toBe(false)
    expect(isPromptMentionResult({ type: 'file', context: [''] })).toBe(false)
    expect(isPromptMentionResult(undefined)).toBe(false)

    expect(mentionInputProblem(NOTES, { ...NOTES, path: '/other', offset: 1, limit: 9 })).toBeNull()
    expect(mentionInputProblem(NOTES, { path: '/other' })).toBeNull()
    expect(mentionInputProblem(NOTES, { ...NOTES, mention: 'x' })).toBe('mention is pinned')
    expect(mentionInputProblem(NOTES, { ...NOTES, agentId: 'a' })).toBe('agentId is pinned')
    expect(mentionInputProblem(NOTES, { ...NOTES, path: '' })).toBe('path is not a non-empty string')
    expect(mentionInputProblem(NOTES, { ...NOTES, offset: 0 })).toBe('offset is not a whole number from 1')
    expect(mentionInputProblem(NOTES, { ...NOTES, limit: 1.5 })).toBe('limit is not a whole number from 1')

    expect(droppedContextProblem({ type: 'file' }, { type: 'file', context: ['a'] })).toBe('an answer drops context its next gave')
    expect(droppedContextProblem({ type: 'file', context: ['b', 'a'] }, { type: 'file', context: ['a'] })).toBeNull()
    expect(droppedContextProblem({ deny: 'no' }, { type: 'file', context: ['a'] })).toBeNull()
    expect(droppedContextProblem({ type: 'file' }, undefined)).toBeNull()
  })
})

describe('prompt.mention through the runtime', () => {
  it('a path matcher denies a secret without a read; another file reads with the hook context added', async () => {
    const { runtime, reports } = world({
      'guard/hooks/register.js': `
        export function register(on) {
          on('prompt.mention', { path: /\\.env$/ }, () => ({ deny: 'a secret' }));
          on('prompt.mention', async ($, e, next) => {
            const read = await next(e);
            return { ...read, context: [...(read.context ?? []), 'mentioned: ' + e.mention] };
          });
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasPromptMentionHooks()).toBe(true)
    const env = recordingCore()
    expect(await runtime.promptMention(ENV, env.core)).toEqual({ deny: 'a secret' })
    expect(env.reads).toEqual([])
    const notes = recordingCore()
    expect(await runtime.promptMention(NOTES, notes.core)).toEqual({ type: 'file', context: ['mentioned: notes.md#L2-4'] })
    expect(notes.reads).toEqual([{ path: '/work/project/notes.md', offset: 2, limit: 3 }])
    expect(reports).toEqual(['mods: prompt.mention (.env) denied: a secret'])
  })

  it('next({ ...e, path }) reads another file once; a second next settles with the first read', async () => {
    const { runtime } = world({
      'swap/hooks/register.js': `
        export function register(on) {
          on('prompt.mention', async ($, e, next) => {
            const first = await next({ ...e, path: '/work/project/notes.public.md', offset: undefined, limit: undefined });
            const second = await next(e);
            return second.type === first.type ? first : { deny: 'reads differ' };
          });
        }
      `,
    })
    await runtime.ready
    const { core, reads } = recordingCore(path => ({ type: path.endsWith('.public.md') ? 'file' : null }))
    expect(await runtime.promptMention(NOTES, core)).toEqual({ type: 'file', context: [] })
    expect(reads).toEqual([{ path: '/work/project/notes.public.md' }])
  })

  it('an answer without next reads nothing; one dropping its next context, or moving a pin, is passed over', async () => {
    const { runtime, reports } = world({
      'quiet/hooks/register.js': `
        export function register(on) {
          on('prompt.mention', { path: /skip/ }, () => ({ type: null }));
          on('prompt.mention', { path: /drop/ }, async ($, e, next) => { const r = await next(e); return { type: r.type } });
          on('prompt.mention', { path: /drop/ }, async ($, e, next) => ({ ...(await next(e)), context: ['inner'] }));
          on('prompt.mention', { path: /pin/ }, ($, e, next) => next({ ...e, mention: 'other' }));
        }
      `,
    })
    await runtime.ready
    const skip = recordingCore()
    expect(await runtime.promptMention({ mention: 'skip', path: '/w/skip' }, skip.core)).toEqual({ type: null, context: [] })
    expect(skip.reads).toEqual([])

    const drop = recordingCore()
    const dropped = await runtime.promptMention({ mention: 'drop', path: '/w/drop' }, drop.core)
    expect(dropped).toEqual({ type: 'file', context: ['inner'] })
    expect(drop.reads).toHaveLength(1)

    const pin = recordingCore()
    expect(await runtime.promptMention({ mention: 'pin', path: '/w/pin' }, pin.core)).toEqual({ type: 'file', context: [] })
    expect(pin.reads).toEqual([{ path: '/w/pin' }])
    expect(reports.some(line => line.includes('mention is pinned'))).toBe(true)
  })

  it('no hook: the read runs as the core, nothing raised', async () => {
    const { runtime } = world({ 'q/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` })
    await runtime.ready
    expect(runtime.hasPromptMentionHooks()).toBe(false)
    const { core, reads } = recordingCore()
    expect(await runtime.promptMention(NOTES, core)).toEqual({ type: 'file', context: [] })
    expect(reads).toHaveLength(1)
  })
})

// --- the prompt's attachment step ------------------------------------------

type FakeFile = { text: string } | { dir: string[] }

function fakeFs(files: Record<string, FakeFile>): RuntimeFs {
  return {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      const file = files[path]
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const isDir = 'dir' in file
      return {
        size: isDir ? 0 : file.text.length,
        mtimeMs: 1,
        isFile: () => !isDir,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
      } as RuntimeFsStat
    },
    async readdir(path: string) {
      const file = files[path]
      if (!file || !('dir' in file)) throw new Error('ENOTDIR')
      return file.dir.map(name => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }))
    },
  } as RuntimeFs
}

type FakeMods = {
  ready: Promise<void>
  hasToolCallHooks: () => boolean
  toolCall: ReturnType<typeof vi.fn>
  hasPromptMentionHooks: () => boolean
  promptMention: (input: PromptMentionInput, core: PromptMentionCore) => Promise<PromptMentionSettlement>
}

function contextWith(
  mods: FakeMods,
  readTool: { name: string; call: (input: Record<string, unknown>) => Promise<{ data: unknown }> },
  permissionRules: Record<string, unknown> = { mode: 'default' },
) {
  let appState: Record<string, unknown> = { permissionRules, attachmentState: {} }
  return {
    options: {
      cwd: '/workspace',
      projectRoot: '/workspace',
      sessionId: 'session-1',
      commands: [],
      tools: [readTool],
      mainLoopModel: 'inherit',
      mods,
    },
    messages: [],
    fileReadLedger: new Map(),
    cancelSource: new AbortController(),
    platformCapabilities: { supportsLlmDocumentParts: () => true },
    readAppState: () => appState,
    writeAppState: (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    },
  } as unknown as ToolCallContext
}

describe('the attachment step raises prompt.mention per file mention', () => {
  it('a file is read through the chain (no tool.call), context reaches the model; a directory and a deny raise nothing', async () => {
    installProcessFs(
      fakeFs({
        '/workspace/a.ts': { text: 'alpha' },
        '/workspace/b.ts': { text: 'beta' },
        '/workspace/.env': { text: 'SECRET=1' },
        '/workspace/src': { dir: ['x.ts'] },
      }),
    )
    const reads: string[] = []
    const readTool = {
      name: 'Read',
      async call(input: Record<string, unknown>) {
        reads.push(String(input.file_path))
        return { data: `     1\t${String(input.file_path)}` }
      },
    }
    const raised: PromptMentionInput[] = []
    const mods: FakeMods = {
      ready: Promise.resolve(),
      hasToolCallHooks: () => true,
      toolCall: vi.fn(),
      hasPromptMentionHooks: () => true,
      promptMention: async (input, core) => {
        raised.push(input)
        if (input.path.endsWith('.env')) return { deny: 'a secret' }
        if (input.path.endsWith('a.ts')) {
          const read = await core({ path: '/workspace/b.ts' })
          return 'deny' in read ? read : { type: read.type, context: ['swapped a for b'] }
        }
        const read = await core(input)
        return 'deny' in read ? read : { type: read.type, context: [] }
      },
    }
    const context = contextWith(mods, readTool)
    const { rows, mentionContext } = await collectPromptAttachments({
      input: 'look at @a.ts and @.env and @src and @b.ts#L1-2',
      context,
      runtimeConfig: new BrowserRuntimeConfig(),
      hostBridge: {} as never,
    })
    expect(raised.map(e => e.mention)).toEqual(['a.ts', '.env', 'b.ts#L1-2'])
    expect(raised[2]).toEqual({ mention: 'b.ts#L1-2', path: '/workspace/b.ts', offset: 1, limit: 2 })
    expect(reads).toEqual(['/workspace/b.ts', '/workspace/b.ts'])
    expect(mods.toolCall).not.toHaveBeenCalled()
    const mentioned = rows
      .map(row => row.attachment)
      .filter(a => a.type === 'file' || a.type === 'directory')
      .map(a => (a.type === 'file' ? a.filename : a.path))
    expect(mentioned).toEqual(['/workspace/b.ts', '/workspace/src', '/workspace/b.ts'])
    expect(mentionContext).toEqual(['swapped a for b'])
  })

  it('a hook\'s path is read only where a read is allowed outright: an ask rule or a UNC path is refused', async () => {
    installProcessFs(
      fakeFs({
        '/workspace/a.ts': { text: 'alpha' },
        '/home/u/.ssh/id_rsa': { text: 'KEY' },
      }),
    )
    const reads: string[] = []
    const readTool = {
      name: 'Read',
      async call(input: Record<string, unknown>) {
        reads.push(String(input.file_path))
        return { data: `     1\t${String(input.file_path)}` }
      },
    }
    const answers: unknown[] = []
    const swapTo = (path: string): FakeMods => ({
      ready: Promise.resolve(),
      hasToolCallHooks: () => false,
      toolCall: vi.fn(),
      hasPromptMentionHooks: () => true,
      promptMention: async (_input, core) => {
        const read = await core({ path })
        answers.push(read)
        return 'deny' in read ? read : { type: read.type, context: [] }
      },
    })
    const rules = { mode: 'default', ruleLists: { allow: [], deny: [], ask: ['Read(//home/u/.ssh/**)'] } }
    for (const path of ['/home/u/.ssh/id_rsa', '\\\\host\\share\\x']) {
      const { rows } = await collectPromptAttachments({
        input: 'look at @a.ts',
        context: contextWith(swapTo(path), readTool, rules),
        runtimeConfig: new BrowserRuntimeConfig(),
        hostBridge: {} as never,
      })
      expect(rows.some(row => row.attachment.type === 'file')).toBe(false)
    }
    expect(reads).toEqual([])
    expect(answers.every(a => typeof a === 'object' && a !== null && 'deny' in a)).toBe(true)
  })
})
