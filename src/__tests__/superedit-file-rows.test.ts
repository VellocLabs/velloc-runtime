import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverlayFs, PRISTINE_FILE_MAX_BYTES, PRISTINE_TOTAL_MAX_BYTES } from '../browser/runJs/overlayFs'
import type { RunJsFsOp } from '../browser/runJs/runJsProtocol'
import type { FileOpRow } from '../models/usage/requestLogStore'
import type { Message } from '../runtime/RuntimeTypes'
import { fileActivityIdle } from '../toolkit/builtin/host/fileActivity'
import { commitOverlay, handleScriptFsOp } from '../toolkit/builtin/superEdit'
import { LINE_COUNT_BUDGET_MS, LINE_COUNT_MAX_BYTES } from '../toolkit/builtin/superEditFileRows'
import * as hunks from '../utils/fileChangeHunks'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const batches = vi.hoisted(() => [] as FileOpRow[][])
vi.mock('../models/usage/requestLogWriter', () => ({
  recordFileOps: (rows: readonly FileOpRow[]) => {
    batches.push([...rows])
  },
}))
vi.mock('../utils/fileChangeHunks', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/fileChangeHunks')>()
  return { ...actual, hunksBetween: vi.fn(actual.hunksBetween) }
})

const enc = (text: string) => new TextEncoder().encode(text)
const notFound = () => new Error('FS_ERROR: ENOENT: no such file or directory')

/** An in-memory disk under `/proj` (a repository), counting the reads of each file. */
function makeDisk(files: Record<string, string | Uint8Array>, extraDirs: string[] = []) {
  const bytes = new Map(Object.entries(files).map(([path, value]) => [path, typeof value === 'string' ? enc(value) : value]))
  const dirs = new Set(['/proj', '/proj/.git', ...extraDirs])
  const reads = new Map<string, number>()
  const failWrite = new Set<string>()
  const stat = async (path: string) => {
    if (dirs.has(path)) return { isDirectory: () => true, isFile: () => false, size: 0, mtimeMs: 1 }
    const file = bytes.get(path)
    if (!file) throw notFound()
    return { isDirectory: () => false, isFile: () => true, size: file.length, mtimeMs: 1 }
  }
  const readFileBytes = async (path: string) => {
    reads.set(path, (reads.get(path) ?? 0) + 1)
    const file = bytes.get(path)
    if (!file) throw notFound()
    return file
  }
  const fs = {
    stat,
    readFileBytes,
    readFile: async (path: string) => new TextDecoder().decode(await readFileBytes(path)),
    readdir: async () => [],
    writeFile: async (path: string, data: Uint8Array) => {
      if (failWrite.has(path)) throw new Error('EACCES: permission denied')
      bytes.set(path, data)
    },
    mkdir: async (path: string) => {
      dirs.add(path)
    },
    unlink: async (path: string) => {
      bytes.delete(path)
    },
    rm: async (path: string) => {
      dirs.delete(path)
      for (const key of [...bytes.keys()]) if (key.startsWith(`${path}/`)) bytes.delete(key)
    },
    rename: async (from: string, to: string) => {
      bytes.set(to, bytes.get(from)!)
      bytes.delete(from)
    },
  } as unknown as RuntimeFs
  return { fs, reads, failWrite }
}

function context(fs: RuntimeFs, rules: Record<string, unknown> = {}): ToolCallContext {
  return {
    options: { tools: [], cwd: '/proj', sessionId: 's1', fsOperations: fs },
    cancelSource: new AbortController(),
    readAppState: () => ({ permissionRules: { mode: 'default', extraWorkspaceRoots: new Map(), ...rules } }),
    toolRunSeams: {
      nested: {
        preHooks: async () => ({ blocked: false, message: '' }),
        postHooks: async () => '',
        headlessDecision: async () => ({ behavior: 'deny', message: 'headless' }),
      },
    },
  } as unknown as ToolCallContext
}

const invokingRow = {} as unknown as Message

async function run(fs: RuntimeFs, ops: Array<[RunJsFsOp, Record<string, unknown>]>, ctx = context(fs)) {
  const overlay = new OverlayFs({ stat: p => fs.stat(p), readFileBytes: p => fs.readFileBytes(p), readdir: p => fs.readdir(p) })
  for (const [op, payload] of ops) await handleScriptFsOp(overlay, op, payload, ctx, invokingRow)
  const outcome = await commitOverlay(overlay, ctx, invokingRow)
  await fileActivityIdle()
  return outcome
}

beforeEach(() => {
  batches.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('file rows from a SuperEdit commit', () => {
  it('records every file a commit changed as one batch, and no row for a new directory', async () => {
    const { fs } = makeDisk({ '/proj/old.txt': 'a\nb\n', '/proj/gone.txt': 'x\ny\nz\n' })
    const outcome = await run(fs, [
      ['mkdir', { path: 'lib' }],
      ['writeFile', { path: 'lib/new.txt', bytes: enc('one\ntwo\n') }],
      ['writeFile', { path: 'old.txt', bytes: enc('a\nB\nc\n') }],
      ['remove', { path: 'gone.txt' }],
    ])
    expect(outcome.status).toBe('ok')
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual([
      expect.objectContaining({ sessionId: 's1', repo: '/proj', path: 'lib/new.txt', tool: 'SuperEdit', op: 'write', bytes: 8, added: 2, removed: 0, created: true, outcome: 'ok' }),
      expect.objectContaining({ path: 'old.txt', op: 'write', bytes: 6, added: 2, removed: 1, outcome: 'ok' }),
      expect.objectContaining({ path: 'gone.txt', op: 'remove', removed: 3, outcome: 'ok' }),
    ])
    expect(batches[0]![1]).not.toHaveProperty('created')
  })

  it('records a move with its source, and counts no lines for it', async () => {
    const { fs } = makeDisk({ '/proj/a.txt': 'a\n' })
    await run(fs, [['move', { path: 'a.txt', newPath: 'b.txt' }]])
    expect(batches[0]).toEqual([expect.objectContaining({ path: 'b.txt', fromPath: 'a.txt', op: 'move', outcome: 'ok' })])
    expect(batches[0]![0]).not.toHaveProperty('added')
  })

  it('counts no lines for a binary file, nor for one over the line-count size', async () => {
    const big = 'x\n'.repeat(LINE_COUNT_MAX_BYTES / 2 + 1)
    const { fs } = makeDisk({ '/proj/img.bin': new Uint8Array([1, 0, 2]), '/proj/big.txt': big })
    await run(fs, [
      ['writeFile', { path: 'img.bin', bytes: new Uint8Array([3, 0, 4, 5]) }],
      ['writeFile', { path: 'big.txt', bytes: enc('small\n') }],
    ])
    expect(batches[0]).toEqual([
      expect.objectContaining({ path: 'img.bin', bytes: 4, added: 0, removed: 0 }),
      expect.objectContaining({ path: 'big.txt', bytes: 6, added: 0, removed: 0 }),
    ])
  })

  it('a write to the destination of an earlier move counts against what the move placed there', async () => {
    const { fs } = makeDisk({ '/proj/a.txt': 'x\ny\n' })
    await run(fs, [
      ['move', { path: 'a.txt', newPath: 'b.txt' }],
      ['writeFile', { path: 'b.txt', bytes: enc('x\ny\nz\n') }],
    ])
    expect(batches[0]).toEqual([
      expect.objectContaining({ path: 'b.txt', fromPath: 'a.txt', op: 'move' }),
      expect.objectContaining({ path: 'b.txt', op: 'write', added: 1, removed: 0 }),
    ])
    expect(batches[0]![1]).not.toHaveProperty('created')
  })

  it('a write under a directory the commit removed is a creation, not an edit of what the script read there', async () => {
    const { fs } = makeDisk({ '/proj/d/x.txt': 'a\n' }, ['/proj/d'])
    await run(fs, [
      ['readFile', { path: 'd/x.txt' }],
      ['remove', { path: 'd' }],
      ['writeFile', { path: 'd/x.txt', bytes: enc('b\n') }],
    ])
    expect(batches[0]).toEqual([
      expect.objectContaining({ path: 'd', op: 'remove', removed: 0 }),
      expect.objectContaining({ path: 'd/x.txt', op: 'write', added: 1, removed: 0, created: true }),
    ])
  })

  it('records the source of a move out of its working tree as an absolute path', async () => {
    const { fs } = makeDisk({ '/proj/a.txt': 'a\n' }, ['/proj/sub', '/proj/sub/.git'])
    await run(fs, [
      ['move', { path: 'a.txt', newPath: 'sub/b.txt' }],
      ['move', { path: 'sub/b.txt', newPath: 'sub/c.txt' }],
    ])
    expect(batches[0]).toEqual([
      expect.objectContaining({ repo: '/proj/sub', path: 'b.txt', fromPath: '/proj/a.txt' }),
      expect.objectContaining({ repo: '/proj/sub', path: 'c.txt', fromPath: 'b.txt' }),
    ])
  })

  it('stops counting the lines of edits once the commit has spent its diff budget, and still counts creations', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const between = vi.mocked(hunks.hunksBetween)
    between.mockImplementationOnce(() => {
      now += LINE_COUNT_BUDGET_MS + 1
      return [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
    })
    const { fs } = makeDisk({ '/proj/a.txt': 'a\n', '/proj/b.txt': 'a\n' })
    await run(fs, [
      ['writeFile', { path: 'a.txt', bytes: enc('b\n') }],
      ['writeFile', { path: 'b.txt', bytes: enc('b\n') }],
      ['writeFile', { path: 'c.txt', bytes: enc('c\n') }],
    ])
    expect(between.mock.calls.filter(call => call[0] === '/proj/a.txt').map(call => call[3])).toEqual([LINE_COUNT_BUDGET_MS])
    expect(batches[0]!.map(row => [row.path, row.added, row.removed])).toEqual([
      ['a.txt', 1, 1],
      ['b.txt', 0, 0],
      ['c.txt', 1, 0],
    ])
  })

  it('counts no lines for a written side over the line-count size, nor for a binary one, against a text file', async () => {
    const { fs } = makeDisk({ '/proj/a.txt': 'a\n', '/proj/b.txt': 'b\n' })
    await run(fs, [
      ['writeFile', { path: 'a.txt', bytes: enc('x\n'.repeat(LINE_COUNT_MAX_BYTES / 2 + 1)) }],
      ['writeFile', { path: 'b.txt', bytes: new Uint8Array([98, 0, 10]) }],
    ])
    expect(batches[0]).toEqual([
      expect.objectContaining({ path: 'a.txt', added: 0, removed: 0 }),
      expect.objectContaining({ path: 'b.txt', added: 0, removed: 0 }),
    ])
  })

  it('a disk read that fails before an op counts no lines and leaves the commit ok', async () => {
    const { fs } = makeDisk({ '/proj/a.txt': 'a\n' })
    ;(fs as unknown as { readFileBytes: unknown }).readFileBytes = async () => {
      throw new Error('EACCES: permission denied')
    }
    expect((await run(fs, [['writeFile', { path: 'a.txt', bytes: enc('b\n') }]])).status).toBe('ok')
    expect(batches[0]).toEqual([expect.objectContaining({ path: 'a.txt', added: 0, removed: 0 })])
    expect(batches[0]![0]).not.toHaveProperty('created')
  })

  it('a log hand-off that throws leaves the commit outcome alone', async () => {
    const { fs } = makeDisk({})
    const ctx = context(fs)
    Object.defineProperty(ctx.options, 'spawnerSessionId', {
      get() {
        throw new Error('boom')
      },
    })
    const outcome = await run(fs, [['writeFile', { path: 'a.txt', bytes: enc('a\n') }]], ctx)
    expect(outcome.status).toBe('ok')
    expect(batches).toEqual([])
  })

  it('the overlay keeps a read only within its per-file and total sizes', async () => {
    const per = PRISTINE_FILE_MAX_BYTES
    const count = PRISTINE_TOTAL_MAX_BYTES / per
    const files: Record<string, Uint8Array> = { '/proj/over.bin': new Uint8Array(per + 1) }
    for (let i = 0; i <= count; i++) files[`/proj/f${i}.bin`] = new Uint8Array(per)
    const { fs } = makeDisk(files)
    const overlay = new OverlayFs({ stat: p => fs.stat(p), readFileBytes: p => fs.readFileBytes(p), readdir: p => fs.readdir(p) })
    const ctx = context(fs)
    await handleScriptFsOp(overlay, 'readFile', { path: 'over.bin' }, ctx, invokingRow)
    for (let i = 0; i <= count; i++) await handleScriptFsOp(overlay, 'readFile', { path: `f${i}.bin` }, ctx, invokingRow)
    expect(overlay.pristineBytesOf('/proj/over.bin')).toBeUndefined()
    expect(overlay.pristineBytesOf(`/proj/f${count - 1}.bin`)).toBeDefined()
    expect(overlay.pristineBytesOf(`/proj/f${count}.bin`)).toBeUndefined()
  })

  it('reads a file the script already read no second time, and diffs against the bytes it read', async () => {
    const { fs, reads } = makeDisk({ '/proj/read.txt': 'one\n', '/proj/unread.txt': 'two\n' })
    await run(fs, [
      ['readFile', { path: 'read.txt' }],
      ['writeFile', { path: 'read.txt', bytes: enc('one\nmore\n') }],
      ['writeFile', { path: 'unread.txt', bytes: enc('2\n') }],
    ])
    expect(reads.get('/proj/read.txt')).toBe(1)
    expect(reads.get('/proj/unread.txt')).toBe(1)
    expect(batches[0]).toEqual([
      expect.objectContaining({ path: 'read.txt', added: 1, removed: 0 }),
      expect.objectContaining({ path: 'unread.txt', added: 1, removed: 1 }),
    ])
  })

  it('keeps no copy of a read over the size it keeps: such a file is not counted', async () => {
    const big = 'x\n'.repeat(PRISTINE_FILE_MAX_BYTES / 2 + 1)
    const { fs, reads } = makeDisk({ '/proj/big.txt': big })
    await run(fs, [
      ['readFile', { path: 'big.txt' }],
      ['writeFile', { path: 'big.txt', bytes: enc('x\n') }],
    ])
    expect(reads.get('/proj/big.txt')).toBe(1)
    expect(batches[0]).toEqual([expect.objectContaining({ path: 'big.txt', added: 0, removed: 0 })])
  })

  it("diffs a second write to a path against the commit's own first write", async () => {
    const { fs, reads } = makeDisk({})
    await run(fs, [
      ['writeFile', { path: 'n.txt', bytes: enc('a\n') }],
      ['writeFile', { path: 'n.txt', bytes: enc('a\nb\n') }],
    ])
    expect(reads.get('/proj/n.txt')).toBeUndefined()
    expect(batches[0]!.map(row => [row.added, row.removed, row.created])).toEqual([
      [1, 0, true],
      [1, 0, undefined],
    ])
  })

  it('records only the ops that landed when a commit stops part way', async () => {
    const { fs, failWrite } = makeDisk({})
    failWrite.add('/proj/b.txt')
    const outcome = await run(fs, [
      ['writeFile', { path: 'a.txt', bytes: enc('a\n') }],
      ['writeFile', { path: 'b.txt', bytes: enc('b\n') }],
      ['writeFile', { path: 'c.txt', bytes: enc('c\n') }],
    ])
    expect(outcome.status).toBe('partial')
    expect(batches).toEqual([[expect.objectContaining({ path: 'a.txt', outcome: 'ok' })]])
  })

  it('writes no rows for a commit that wrote nothing: denied, or a script with no changes', async () => {
    const { fs } = makeDisk({})
    expect((await run(fs, [['writeFile', { path: 'a.txt', bytes: enc('a') }]], context(fs, { denyRuleBook: { session: ['Write'] } }))).status).toBe('denied')
    expect((await run(fs, [])).status).toBe('noop')
    expect(batches).toEqual([])
  })

  it('never changes the outcome of a commit: an earlier read that answers no bytes counts no lines', async () => {
    const { fs } = makeDisk({ '/proj/a.txt': 'a\n' })
    ;(fs as unknown as { readFileBytes: unknown }).readFileBytes = async () => 'not bytes'
    expect((await run(fs, [['writeFile', { path: 'a.txt', bytes: enc('b\n') }]])).status).toBe('ok')
    expect(batches[0]).toEqual([expect.objectContaining({ path: 'a.txt', added: 0, removed: 0, outcome: 'ok' })])
  })

  it('holds no file content or script arguments', async () => {
    const { fs } = makeDisk({ '/proj/s.txt': 'old secret\n' })
    await run(fs, [['writeFile', { path: 's.txt', bytes: enc('new secret\n') }]])
    expect(JSON.stringify(batches)).not.toMatch(/secret/)
  })
})
