import { afterEach, describe, expect, it, vi } from 'vitest'

import { BridgeFsConversationStorageBackend } from '../browser/storage/BridgeFsSessionStorage'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { isMessageLike, normalizeConversationState } from '../sessions/sessionStore'

const SID = 'S'
const runtimeConfig = { createUUID: () => 'u', createTimestamp: () => '', now: () => 1 } as unknown as RuntimeConfig

function backendFor(text: string) {
  const transport = {
    async request(request: { id: string; route: { action: string } }) {
      return request.route.action === 'readFile'
        ? { id: request.id, ok: true, result: new TextEncoder().encode(text) }
        : { id: request.id, ok: true, result: null }
    },
  }
  return new BridgeFsConversationStorageBackend({ transport: transport as never, basePath: '/p' })
}

/** The loader's JSONL loop before the skip — the reference. */
function referenceEntries(text: string): unknown[] | null {
  const entries: unknown[] = []
  text.split('\n').forEach((line, physicalLine) => {
    if (line.trim().length === 0) return
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const type = parsed?.type
      const kept =
        isMessageLike(parsed)
        || ((type === '__session_meta' || type === 'custom-title' || type === 'ai-title')
          && typeof parsed.sessionId === 'string')
      if (kept) {
        parsed.transcriptLine = physicalLine
        entries.push(parsed)
      }
    } catch {
      // malformed
    }
  })
  return entries.length > 0 ? entries : null
}

const meta = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: '__session_meta', sessionId: SID, updatedAt: n, metadata: { previewText: `p${n}`, messageCount: n }, ...extra })
const aiTitle = (n: number) => JSON.stringify({ type: 'ai-title', sessionId: SID, aiTitle: `title ${n}`, updatedAt: n })
const customTitle = (n: number, title: string) => JSON.stringify({ type: 'custom-title', sessionId: SID, customTitle: title, updatedAt: n })
const user = (n: number) => JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: `2026-09-0${(n % 9) + 1}T00:00:00.000Z`, message: { role: 'user', content: [{ type: 'text', text: `hi ${n}` }] } })

async function expectSameAsReference(text: string): Promise<void> {
  const actual = await backendFor(text).load(SID)
  const expected = referenceEntries(text)
  expect(actual === null).toBe(expected === null)
  expect(normalizeConversationState(SID, actual, runtimeConfig)).toStrictEqual(
    normalizeConversationState(SID, expected as never, runtimeConfig),
  )
  const lines = (entries: unknown) =>
    Object.fromEntries(((entries as Array<{ uuid?: string; transcriptLine?: number }>) ?? [])
      .filter(e => e.uuid).map(e => [e.uuid, e.transcriptLine]))
  expect(lines(actual)).toEqual(lines(expected))
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
}

afterEach(() => vi.restoreAllMocks())

describe('transcript load — superseded legacy meta / ai-title lines are not parsed', () => {
  it('normalizes exactly as the parse-everything loader over a fuzz corpus', async () => {
    const next = rng(0x1e9a)
    for (let i = 0; i < 400; i++) {
      const lines: string[] = []
      const n = Math.floor(next() * 30)
      for (let j = 0; j < n; j++) {
        const r = next()
        lines.push(
          r < 0.3 ? meta(j)
            : r < 0.4 ? meta(j, { updatedAt: 'not a number' }) // loader keeps it, normalizer ignores it
            : r < 0.45 ? '{"type":"__session_meta","sessionId":"S","upd' // torn
            : r < 0.6 ? aiTitle(j)
            : r < 0.65 ? JSON.stringify({ type: 'ai-title', sessionId: SID, aiTitle: 5 })
            : r < 0.7 ? customTitle(j, next() < 0.3 ? '' : `name ${j}`)
            : r < 0.75 ? ''
            : user(j),
        )
      }
      await expectSameAsReference(lines.join('\n') + (next() < 0.8 ? '\n' : ''))
    }
  })

  it('handles the edges: only invalid metas, the valid one first, a single line', async () => {
    await expectSameAsReference([meta(1), meta(2, { updatedAt: 'x' }), meta(3, { sessionId: 7 })].join('\n') + '\n')
    await expectSameAsReference([meta(2, { updatedAt: 'x' }), meta(3, { updatedAt: 'y' })].join('\n') + '\n')
    await expectSameAsReference(meta(1) + '\n')
    await expectSameAsReference([aiTitle(1), user(1), aiTitle(2), customTitle(3, 'a'), customTitle(2, 'b')].join('\n') + '\n')
  })

  it('parses only the last valid record of each kind, not every one', async () => {
    const lines = [user(0)]
    for (let i = 1; i <= 200; i++) lines.push(meta(i), aiTitle(i))
    lines.push(user(1))
    const parse = vi.spyOn(JSON, 'parse')
    await backendFor(lines.join('\n') + '\n').load(SID)
    // 2 messages + 1 meta + 1 ai-title — not 402.
    expect(parse.mock.calls.length).toBeLessThanOrEqual(4)
  })
})
