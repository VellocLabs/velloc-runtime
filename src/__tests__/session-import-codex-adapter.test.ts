import { describe, expect, it, vi } from 'vitest'

import {
  handleSessionImportBridgeRequest,
  type SessionImportAdapterContext,
  type SessionImportWriter,
} from '../browser/bridge/adapter/sessionImportBridgeAdapter'
import type {
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../browser/bridge/protocol/core'
import { createBridgeRoute } from '../browser/bridge/protocol/core'
import { runImportRequest } from '../sessionImport/inline'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

// The Codex I/O path: `detect` sees `~/.codex/sessions`, `listSessions`
// enumerates threads from `~/.codex/state_5.sqlite` via the native `sqlite`
// capability (NOT a directory scan), lite-reads each rollout head, and
// `readSession` reads a whole rollout after the path-allow check. Everything
// downstream of "produce a SessionFile[]" is the shared, provider-neutral flow.

const HOME = 'C:\\Users\\me'
const SESSIONS = `${HOME}\\.codex\\sessions`
const DB = `${HOME}\\.codex\\state_5.sqlite`
const UUID1 = '019ad758-0000-7000-8000-000000000001'
const UUID2 = '019ad758-0000-7000-8000-000000000002'
const PATH1 = `${SESSIONS}\\2026\\01\\01\\rollout-2026-01-01T00-00-00-${UUID1}.jsonl`
const PATH2 = `${SESSIONS}\\2026\\01\\02\\rollout-2026-01-02T00-00-00-${UUID2}.jsonl`

function rollout(id: string, cwd: string, prompt: string): string {
  const line = (type: string, payload: unknown) =>
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type, payload })
  return (
    [
      line('session_meta', { id, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      }),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }],
      }),
    ].join('\n') + '\n'
  )
}

function makeWorld(opts: { stored?: string[] } = {}) {
  const encoder = new TextEncoder()
  const files = new Map<string, Uint8Array>([
    [PATH1, encoder.encode(rollout(UUID1, 'D:\\project\\one', 'First prompt'))],
    [PATH2, encoder.encode(rollout(UUID2, 'D:\\project\\two', 'Second prompt'))],
  ])

  const fs = {
    stat: vi.fn(async (path: string) => {
      if (path === SESSIONS) return { isDirectory: () => true, isFile: () => false, size: 0 }
      if (path === DB) return { isDirectory: () => false, isFile: () => true, size: 100 }
      const data = files.get(path)
      if (!data) throw new Error('ENOENT')
      return { isDirectory: () => false, isFile: () => true, size: data.byteLength }
    }),
  } as unknown as RuntimeFs

  const directBridge = {
    request: vi.fn(async (request: BrowserBridgeRequest) => {
      const action = request.route.action as string
      const payload = request.payload as Record<string, unknown>
      const ok = (result: unknown) => ({ id: request.id, route: request.route, ok: true, result })

      if (action === 'query') {
        // The `threads` index, unsorted; a `\\?\` prefix on one path exercises
        // normalization. Columns match the adapter's SELECT order.
        return ok({
          rows: [
            [UUID1, `\\\\?\\${PATH1}`, 1000],
            [UUID2, PATH2, 2000],
          ],
          rowCount: 2,
          truncated: false,
        })
      }
      if (action === 'readBatch') {
        const items = payload.items as Array<{ path: string; offset?: number; length?: number }>
        const parts: Uint8Array[] = []
        const entries = items.map(item => {
          const data = files.get(item.path)
          const byteOffset = parts.reduce((n, p) => n + p.byteLength, 0)
          if (!data) return { path: item.path, ok: false, byteOffset, byteLength: 0, error: 'ENOENT' }
          const slice = data.subarray(item.offset ?? 0, (item.offset ?? 0) + (item.length || data.byteLength))
          parts.push(slice)
          return { path: item.path, ok: true, byteOffset, byteLength: slice.byteLength }
        })
        const blob = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
        let at = 0
        for (const p of parts) { blob.set(p, at); at += p.byteLength }
        return ok({ entries, totalBytes: blob.byteLength, truncated: false, blob })
      }
      if (action === 'readRange') {
        const data = files.get(payload.path as string)!
        const offset = payload.offset as number
        const slice = data.subarray(offset, offset + (payload.length as number))
        return ok({ data: slice, bytesRead: slice.byteLength })
      }
      return { id: request.id, route: request.route, ok: false, error: { code: 'nope', message: action } }
    }),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport

  const stored = new Set(opts.stored ?? [])
  const writer: SessionImportWriter = {
    writeSessionBundle: vi.fn(async args => { stored.add(args.sessionId) }),
    listStoredSessionIds: vi.fn(async () => new Set(stored)),
    hasStoredSession: vi.fn(async id => stored.has(id)),
    writeSubAgentBundle: vi.fn(async () => {}),
  }
  const ctx: SessionImportAdapterContext = {
    homeDir: HOME,
    fs,
    directBridge,
    writer,
    runInline: async request => runImportRequest(request),
  }
  return { ctx, directBridge }
}

async function call(
  ctx: SessionImportAdapterContext,
  action: 'detect' | 'listSessions' | 'readSession',
  payload: Record<string, unknown>,
) {
  return handleSessionImportBridgeRequest(
    { id: `req-${action}`, route: createBridgeRoute('sessionImport', action), payload } as BrowserBridgeRequest,
    ctx,
  )
}

describe('sessionImport adapter — codex', () => {
  it('detects codex from its sessions directory', async () => {
    const { ctx } = makeWorld()
    const res = await call(ctx, 'detect', {})
    expect(res).toMatchObject({
      ok: true,
      result: { sources: [{ source: 'codex', rootPath: SESSIONS }] },
    })
  })

  it('enumerates threads from state_5.sqlite, newest-first, and titles each rollout', async () => {
    const { ctx, directBridge } = makeWorld({ stored: [UUID1] })
    const res = await call(ctx, 'listSessions', { source: 'codex', page: 0 })
    expect(res.ok).toBe(true)
    const result = (res as { result: { total: number; rows: Array<Record<string, unknown>> } }).result
    expect(result.total).toBe(2)
    // Sorted by updated_at_ms DESC → UUID2 (2000) before UUID1 (1000).
    expect(result.rows[0]).toMatchObject({
      sessionId: UUID2,
      title: 'Second prompt',
      projectPath: 'D:\\project\\two',
      importable: true,
      alreadyImported: false,
    })
    expect(result.rows[1]).toMatchObject({
      sessionId: UUID1, // its `\\?\` path prefix was normalized
      title: 'First prompt',
      alreadyImported: true, // it is in the store
    })
    // The list read the SQLite index, not a directory tree.
    const requestMock = directBridge.request as unknown as {
      mock: { calls: Array<[BrowserBridgeRequest]> }
    }
    const actions = requestMock.mock.calls.map(c => c[0].route.action)
    expect(actions).toContain('query')
    expect(actions).not.toContain('readdirTree')
  })

  it('reads a whole rollout for import after the path-allow check', async () => {
    const { ctx } = makeWorld()
    const res = await call(ctx, 'readSession', { source: 'codex', path: PATH2 })
    expect(res.ok).toBe(true)
    const result = (res as { result: { sessionId: string; skipped: boolean; bytes?: ArrayBuffer } }).result
    expect(result.sessionId).toBe(UUID2)
    expect(result.skipped).toBe(false)
    expect(new TextDecoder().decode(result.bytes!)).toContain('Second prompt')
  })

  it('rejects a path outside the codex sessions root', async () => {
    const { ctx } = makeWorld()
    const res = await call(ctx, 'readSession', {
      source: 'codex',
      path: `${HOME}\\.ssh\\id_rsa`,
    })
    expect(res.ok).toBe(false)
  })
})
