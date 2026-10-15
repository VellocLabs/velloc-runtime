import { describe, expect, it } from 'vitest'

import { BridgeFsConversationStorageBackend } from '../browser/storage/BridgeFsSessionStorage'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message } from '../runtime/RuntimeTypes'
import { clonePlain } from '../utils/clonePlain'
import { BrowserConversationStore } from '../sessions/sessionStore'
import {
  getLazyToolCallRefsFromMessage,
  hydrateMessageToolPayloads,
  type BrowserToolCallDetailRecord,
} from '../utils/toolCallDetails'
import { readTranscriptLineCount } from '../utils/transcriptLineCount'

// ── An in-memory filesystem behind the bridge transport ──────────────────

type FakeFsOptions = {
  /** The host has no `fs.readBatch` (an old build). */
  noReadBatch?: boolean
  /** `fs.readBatch`'s per-call byte budget. */
  batchBudgetBytes?: number
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function fakeFs(options: FakeFsOptions = {}) {
  const files = new Map<string, Uint8Array>()
  const calls: Array<{ op: string; path?: string; items?: number }> = []
  /** Paths whose read FAILS (a sharing violation — the file is there). */
  const unreadable = new Set<string>()
  const transport = {
    async request(request: { id: string; route: { capability: string; action: string }; payload: any }) {
      await Promise.resolve()
      const op = `${request.route.capability}.${request.route.action}`
      const payload = request.payload ?? {}
      calls.push({ op, path: payload.path, items: payload.items?.length })
      const ok = (result: unknown) => ({ id: request.id, ok: true, result })
      const fail = (code: string) => ({ id: request.id, ok: false, error: { code, message: code } })
      switch (op) {
        case 'fs.appendFile': {
          const prev = files.get(payload.path) ?? new Uint8Array(0)
          const next = new Uint8Array(prev.length + payload.data.length)
          next.set(prev)
          next.set(payload.data, prev.length)
          files.set(payload.path, next)
          return ok(null)
        }
        case 'fs.writeFile':
          files.set(payload.path, payload.content)
          return ok(null)
        case 'fs.readFile': {
          if (unreadable.has(payload.path)) return fail('FS_ERROR: sharing violation')
          const file = files.get(payload.path)
          return file ? ok(file) : fail('NOT_FOUND')
        }
        case 'fs.readBatch': {
          if (options.noReadBatch) return fail('UNKNOWN_ACTION')
          const budget = options.batchBudgetBytes ?? Infinity
          const parts: Uint8Array[] = []
          let total = 0
          const entries = payload.items.map((item: { path: string }) => {
            if (unreadable.has(item.path)) {
              return { path: item.path, ok: false, byteOffset: 0, byteLength: 0, error: 'sharing violation' }
            }
            const file = files.get(item.path)
            if (!file) return { path: item.path, ok: false, byteOffset: 0, byteLength: 0, error: 'NOT_FOUND' }
            if (total + file.length > budget) {
              return { path: item.path, ok: false, byteOffset: 0, byteLength: 0, error: 'Batch byte budget exhausted' }
            }
            const entry = { path: item.path, ok: true, byteOffset: total, byteLength: file.length }
            parts.push(file)
            total += file.length
            return entry
          })
          const blob = new Uint8Array(total)
          let at = 0
          for (const part of parts) {
            blob.set(part, at)
            at += part.length
          }
          return ok({ entries, totalBytes: total, truncated: entries.some((e: any) => e.error?.startsWith('Batch')), blob })
        }
        default:
          return ok(null)
      }
    },
  }
  const backend = () => new BridgeFsConversationStorageBackend({ transport: transport as never, basePath: '/p' })
  const count = (op: string, pathPart?: string) =>
    calls.filter(c => c.op === op && (pathPart === undefined || c.path?.includes(pathPart))).length
  const transcriptPath = () => [...files.keys()].find(path => path.endsWith('transcript.jsonl'))!
  const detailPath = (toolCallId: string) =>
    [...files.keys()].find(path => path.includes('tool-details') && path.endsWith(`${toolCallId}.json`))!
  return { files, calls, backend, count, transcriptPath, detailPath, unreadable }
}

function runtimeConfig(): RuntimeConfig {
  let uuid = 0
  return {
    createUUID: () => `uuid-${uuid++}`,
    createTimestamp: () => '2026-09-30T00:00:00.000Z',
    now: () => 1_000,
  } as unknown as RuntimeConfig
}

function store(backend: BridgeFsConversationStorageBackend, sessionId = 'S') {
  return new BrowserConversationStore({ runtimeConfig: runtimeConfig(), sessionId, storageBackend: backend })
}

// ── The runtime's message shapes (as recorded live) ──────────────────────

const T0 = '2026-09-30T00:00:00.000Z'

function readTurn(i: number, result = `contents of file ${i}\n`.repeat(4)): Message[] {
  const args = { file_path: `/src/${i}.ts` }
  return [
    {
      type: 'assistant', uuid: `a${i}`, timestamp: T0,
      message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `Reading ${i}` }, { type: 'tool-call', toolCallId: `t${i}`, toolName: 'Read', args }] },
    },
    {
      type: 'user', uuid: `u${i}`, timestamp: T0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: `t${i}`, toolName: 'Read', result }] },
      toolCallDetailRef: { toolCallId: `t${i}`, toolName: 'Read' },
      toolCallDetail: { toolCallId: `t${i}`, toolName: 'Read', args, result },
    },
  ] as unknown as Message[]
}

function bashTurn(i: number): Message[] {
  const args = { command: `ls ${i}` }
  const result = { stdout: `file-${i}\n<b>`, stderr: '', exitCode: 0 }
  return [
    {
      type: 'assistant', uuid: `ba${i}`, timestamp: T0,
      message: { id: `bm${i}`, role: 'assistant', content: [{ type: 'tool-call', toolCallId: `b${i}`, toolName: 'Bash', args }] },
    },
    {
      type: 'user', uuid: `bu${i}`, timestamp: T0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: `b${i}`, toolName: 'Bash', result }] },
      toolCallDetailRef: { toolCallId: `b${i}`, toolName: 'Bash' },
      toolCallDetail: { toolCallId: `b${i}`, toolName: 'Bash', args, result },
    },
  ] as unknown as Message[]
}

const prompt = (text: string): Message =>
  ({ type: 'user', uuid: `p-${text}`, timestamp: T0, message: { role: 'user', content: [{ type: 'text', text }] } }) as unknown as Message

// ── The reference: the whole-conversation hydration the memo replaced ────

async function referenceHydrate(
  messages: readonly Message[],
  getDetail: (id: string) => Promise<BrowserToolCallDetailRecord | null>,
): Promise<Message[]> {
  const ids = [...new Set(messages.flatMap(m => getLazyToolCallRefsFromMessage(m).map(r => r.toolCallId)))]
  if (ids.length === 0) return structuredClone(messages) as Message[]
  const details = new Map<string, BrowserToolCallDetailRecord>()
  for (const id of ids) {
    const detail = await getDetail(id)
    if (detail) {
      const { origin: _origin, ...visible } = detail
      details.set(id, visible)
    }
  }
  if (details.size === 0) return structuredClone(messages) as Message[]
  return messages.map(message => hydrateMessageToolPayloads(message, details))
}

const recorded = (s: BrowserConversationStore) => (s as unknown as { recordedMessages: Message[] }).recordedMessages

/** Hydrate, and require exactly what the reference makes of the same state. */
async function hydrateAndCompare(s: BrowserConversationStore): Promise<readonly Message[]> {
  await s.getRecordedMessages() // loaded
  const before = structuredClone(recorded(s))
  const actual = await s.hydrateMessagesForModel()
  const expected = await referenceHydrate(before, id => s.getToolCallDetail(id))
  expect(actual).toStrictEqual(expected)
  return actual
}

// ── 1. clonePlain ────────────────────────────────────────────────────────

/** A dump that shows structure, prototypes, holes, and which nodes alias. */
function shape(value: unknown, ids = new Map<object, number>()): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && Object.is(value, -0)) return '-0'
    if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
    return typeof value === 'string' ? JSON.stringify(value) : `${typeof value}:${String(value)}`
  }
  if (ids.has(value)) return `#${ids.get(value)}`
  ids.set(value, ids.size)
  const id = ids.get(value)
  if (Array.isArray(value)) {
    const items: string[] = []
    for (let i = 0; i < value.length; i++) items.push(i in value ? shape(value[i], ids) : '<hole>')
    return `@${id}[${items.join(',')}]`
  }
  const proto = Object.getPrototypeOf(value) === Object.prototype ? 'O' : 'other'
  const keys = Object.getOwnPropertyNames(value)
  return `@${id}${proto}{${keys.map(k => `${JSON.stringify(k)}:${shape((value as any)[k], ids)}`).join(',')}}`
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function randomPlain(next: () => number, pool: object[], depth: number): unknown {
  const r = next()
  if (pool.length > 0 && r < 0.08) return pool[Math.floor(next() * pool.length)] // alias
  if (depth > 4 || r < 0.4) {
    const leaves = [null, undefined, true, false, 0, -0, 1.5, NaN, Infinity, 'x', '', 'long '.repeat(20), '\ud800']
    return leaves[Math.floor(next() * leaves.length)]
  }
  if (r < 0.7) {
    const list: unknown[] = []
    const n = Math.floor(next() * 5)
    for (let i = 0; i < n; i++) list.push(randomPlain(next, pool, depth + 1))
    if (next() < 0.15) list.length += 2 // trailing holes
    pool.push(list)
    return list
  }
  const dict: Record<string, unknown> = next() < 0.1 ? Object.create(null) : {}
  const n = Math.floor(next() * 5)
  for (let i = 0; i < n; i++) {
    const key = ['a', 'b', '1', 'type', 'content', '__proto__'][Math.floor(next() * 6)]!
    Object.defineProperty(dict, key, { value: randomPlain(next, pool, depth + 1), enumerable: true, writable: true, configurable: true })
  }
  pool.push(dict)
  return dict
}

describe('clonePlain — structuredClone for plain data, strings shared', () => {
  it('equals structuredClone on a fuzz corpus (structure, holes, -0, NaN, aliasing)', () => {
    const next = rng(0xc10e)
    for (let i = 0; i < 5000; i++) {
      const value = randomPlain(next, [], 1)
      expect(shape(clonePlain(value)), shape(value)).toBe(shape(structuredClone(value)))
    }
  })

  it('reproduces cycles', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    a.list = [a, { back: a }]
    const copy = clonePlain(a) as typeof a
    expect(copy).not.toBe(a)
    expect(copy.self).toBe(copy)
    expect(shape(copy)).toBe(shape(structuredClone(a)))
  })

  it('isolates: mutating the copy never reaches the source', () => {
    const source = { message: { content: [{ type: 'tool-result', result: 'r' }] }, tags: ['a'] }
    const copy = clonePlain(source)
    copy.message.content[0]!.result = 'changed'
    copy.message.content.push({ type: 'x', result: 'y' })
    copy.tags.push('b')
    expect(source).toEqual({ message: { content: [{ type: 'tool-result', result: 'r' }] }, tags: ['a'] })
  })

  it('hands anything non-plain to structuredClone, whole', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    for (const value of [
      { at: new Date(5) }, { m: new Map([[1, 2]]) }, [new Uint8Array([1, 2])], { p: new Point(1) },
      Object.assign([1, 2], {}), new Set([1]),
    ]) {
      expect(shape(clonePlain(value))).toBe(shape(structuredClone(value)))
    }
    expect(() => clonePlain({ f: () => 1 })).toThrow()
    expect(() => structuredClone({ f: () => 1 })).toThrow()
  })
})

// ── 2/3. hydrateMessagesForModel ─────────────────────────────────────────

describe('hydrateMessagesForModel — memoized, equal to whole-conversation hydration', () => {
  it('matches the reference on every turn: new turns, a compaction, a reopen', async () => {
    const fs = fakeFs()
    const live = store(fs.backend())
    const conversation: Message[] = [prompt('go')]
    for (let turn = 0; turn < 4; turn++) {
      conversation.push(...readTurn(turn), ...bashTurn(turn))
      await live.saveTranscriptRows(conversation)
      await hydrateAndCompare(live)
    }
    await hydrateAndCompare(live) // nothing changed
    await live.promoteToolCallDetailToOrigin('t1', '{"compact":true}')
    const afterCompact = await hydrateAndCompare(live)
    expect(JSON.stringify(afterCompact)).toContain('{\\"compact\\":true}')
    conversation.push(...readTurn(9))
    await live.saveTranscriptRows(conversation)
    await hydrateAndCompare(live)

    // A reload: everything comes back from disk.
    const reopened = store(fs.backend())
    await hydrateAndCompare(reopened)
    await hydrateAndCompare(reopened)
  })

  it('matches the reference when a referenced detail is missing on disk, and does not re-read it each turn', async () => {
    const fs = fakeFs()
    const live = store(fs.backend())
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0), ...readTurn(1)])
    const missing = [...fs.files.keys()].find(path => path.includes('tool-details') && path.includes('t1'))!
    fs.files.delete(missing)

    const reopened = store(fs.backend())
    await hydrateAndCompare(reopened)
    const reads = fs.count('fs.readFile', 'tool-details') + fs.count('fs.readBatch')
    await reopened.hydrateMessagesForModel()
    expect(fs.count('fs.readFile', 'tool-details') + fs.count('fs.readBatch')).toBe(reads)
  })

  it('asks again for a detail whose read FAILED, instead of remembering it as missing', async () => {
    // A sharing violation / host hiccup on one of ~1000 reads used to mark the
    // id missing for the rest of the store's life: the model got that tool
    // call with preview-only args and an empty result on every later turn.
    const fs = fakeFs()
    const live = store(fs.backend())
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0), ...readTurn(1)])
    fs.unreadable.add(fs.detailPath('t1'))

    const reopened = store(fs.backend())
    const degraded = await reopened.hydrateMessagesForModel()
    expect(JSON.stringify(degraded)).not.toContain('contents of file 1')

    fs.unreadable.clear()
    const recovered = await reopened.hydrateMessagesForModel()
    expect(JSON.stringify(recovered)).toContain('contents of file 1')
    expect(recovered).toStrictEqual(await referenceHydrate(recorded(reopened), id => reopened.getToolCallDetail(id)))
  })

  it('hands a conversation with no lazy tools over as recorded', async () => {
    const live = store(fakeFs().backend())
    await live.saveTranscriptRows([prompt('a'), prompt('b')])
    await hydrateAndCompare(live)
  })

  it('re-hydrates only what changed: untouched messages are the same objects turn to turn', async () => {
    const live = store(fakeFs().backend())
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0), ...readTurn(1), ...readTurn(2)])
    await live.hydrateMessagesForModel()
    const first = [...recorded(live)]
    await live.hydrateMessagesForModel()
    expect(recorded(live).every((message, index) => message === first[index])).toBe(true)

    // A compaction of t1 re-hydrates the messages that read t1, and only them.
    await live.promoteToolCallDetailToOrigin('t1', 'compacted')
    await live.hydrateMessagesForModel()
    const changed = recorded(live)
      .map((message, index) => (message === first[index] ? null : (message as { uuid: string }).uuid))
      .filter(Boolean)
    expect(changed.sort()).toEqual(['a1', 'u1'])
  })

  it('returns a copy the engine may edit without touching the store', async () => {
    const live = store(fakeFs().backend())
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0)])
    const first = await live.hydrateMessagesForModel()
    const expected = structuredClone(first)
    const edited = first as any[]
    edited[2].message.content[0].result = 'edited by the engine'
    edited[1].message.content.push({ type: 'text', text: 'more' })
    edited.push(prompt('extra'))
    expect(await live.hydrateMessagesForModel()).toStrictEqual(expected)
  })
})

// ── 4. batched detail reads ──────────────────────────────────────────────

async function sessionWith(fs: ReturnType<typeof fakeFs>, turns: number): Promise<void> {
  const live = store(fs.backend())
  const conversation: Message[] = [prompt('go')]
  for (let i = 0; i < turns; i++) conversation.push(...readTurn(i))
  await live.saveTranscriptRows(conversation)
}

describe('reopened session — details come back in batched reads', () => {
  it('reads 100 details in four readBatch calls of at most 32, with no single reads', async () => {
    const fs = fakeFs()
    await sessionWith(fs, 100)
    fs.calls.length = 0
    await hydrateAndCompare(store(fs.backend()))
    const batches = fs.calls.filter(c => c.op === 'fs.readBatch')
    expect(batches.map(b => b.items)).toEqual([32, 32, 32, 4])
    // The reference's own getToolCallDetail calls are served from memory.
    expect(fs.count('fs.readFile', 'tool-details')).toBe(0)
  })

  it('defers items past the byte budget to the next call', async () => {
    const fs = fakeFs({ batchBudgetBytes: 2_000 })
    await sessionWith(fs, 20)
    fs.calls.length = 0
    await hydrateAndCompare(store(fs.backend()))
    expect(fs.count('fs.readBatch')).toBeGreaterThan(1)
    expect(fs.count('fs.readFile', 'tool-details')).toBe(0)
  })

  it('falls back to single reads on a host without readBatch', async () => {
    const fs = fakeFs({ noReadBatch: true })
    await sessionWith(fs, 10)
    fs.calls.length = 0
    await hydrateAndCompare(store(fs.backend()))
    expect(fs.count('fs.readBatch')).toBe(1)
    expect(fs.count('fs.readFile', 'tool-details')).toBe(10)
  })

  it('gives what one loadToolCallDetail per id gives, a missing id absent', async () => {
    const fs = fakeFs({ batchBudgetBytes: 1_500 })
    await sessionWith(fs, 40)
    const backend = fs.backend()
    const ids = [...Array.from({ length: 40 }, (_, i) => `t${i}`), 'nope']
    const batched = await backend.loadToolCallDetails('S', ids)
    for (const id of ids) {
      expect(batched.get(id) ?? null, id).toStrictEqual(await backend.loadToolCallDetail('S', id))
    }
    expect(batched.has('nope')).toBe(false)
  })
})

// ── 5. transcript line map ───────────────────────────────────────────────

/** The line map a fresh store builds by reading the whole file. */
async function linesFromDisk(fs: ReturnType<typeof fakeFs>): Promise<Record<string, number>> {
  return { ...(await store(fs.backend()).getTranscriptLinesByUuid()) }
}

describe('getTranscriptLinesByUuid — counted forward, not re-read per message', () => {
  it('stays equal to a whole-file read across messages and title records, reading the file once', async () => {
    const fs = fakeFs()
    const live = store(fs.backend())
    const conversation: Message[] = [prompt('go'), ...readTurn(0)]
    await live.saveTranscriptRows(conversation)
    await live.getTranscriptLinesByUuid()

    for (let i = 1; i < 6; i++) {
      conversation.push(...readTurn(i))
      const reads = fs.count('fs.readFile', 'transcript.jsonl')
      await live.saveTranscriptRows(conversation)
      if (i === 2) await live.storeUserTitle('renamed')
      if (i === 3) await live.storeAutoTitle('auto title')
      const lines = { ...(await live.getTranscriptLinesByUuid()) }
      // The live store did not read the transcript for it.
      expect(fs.count('fs.readFile', 'transcript.jsonl')).toBe(reads)
      expect(lines).toEqual(await linesFromDisk(fs))
    }
  })

  it('falls back to re-reading after two appends overlap, and is still right', async () => {
    const fs = fakeFs()
    const live = store(fs.backend())
    const conversation: Message[] = [prompt('go'), ...readTurn(0)]
    await live.saveTranscriptRows(conversation)
    await live.getTranscriptLinesByUuid()
    conversation.push(...readTurn(1))
    await Promise.all([live.saveTranscriptRows(conversation), live.storeUserTitle('t')])
    expect({ ...(await live.getTranscriptLinesByUuid()) }).toEqual(await linesFromDisk(fs))
  })

  it('a file without a final newline carries no count, so it is re-read', async () => {
    const fs = fakeFs()
    await store(fs.backend()).saveTranscriptRows([prompt('go'), ...readTurn(0)])
    const path = fs.transcriptPath()
    const text = DECODER.decode(fs.files.get(path)!)
    expect(readTranscriptLineCount(await fs.backend().load('S'))).toBe(text.split('\n').length - 1)
    fs.files.set(path, ENCODER.encode(text + '{"torn":'))
    expect(readTranscriptLineCount(await fs.backend().load('S'))).toBeUndefined()

    const live = store(fs.backend())
    await live.getTranscriptLinesByUuid()
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0), prompt('after')])
    expect({ ...(await live.getTranscriptLinesByUuid()) }).toEqual(await linesFromDisk(fs))
  })
})
