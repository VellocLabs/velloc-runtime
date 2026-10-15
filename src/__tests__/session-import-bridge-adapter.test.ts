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
import { convert } from '../sessionImport/sources/claude-code/convert'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

// The adapter is the I/O half of import: it scans the source root, lite-reads
// one page, marks already-imported ids, hands a file's bytes up for the
// window's Worker, and writes a converted bundle through the manager's bundle
// path — answering `skipped` for an id that is already on disk before reading
// a byte (readSession) and before writing one (writeSession).

const HOME = 'C:\\Users\\me'
const ROOT = 'C:\\Users\\me\\.claude\\projects'
const ids = Array.from({ length: 120 }, (_, i) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
)
const pathOf = (id: string) => `${ROOT}\\D--project-app\\${id}.jsonl`

function transcript(id: string, title: string): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: id,
      cwd: 'D:\\project\\app',
      timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: title }] },
    }) +
    '\n' +
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    }) +
    '\n'
  )
}

/** `<session dir>/<uuid>/subagents` of the first fixture, with one nested
 *  (workflow-subdir) transcript + meta sidecar and one flat transcript. */
const SUBAGENTS_DIR = `${ROOT}\\D--project-app\\${ids[0]}\\subagents`
const SUBAGENT_FILES: Record<string, string> = {
  [`${SUBAGENTS_DIR}\\agent-a111.jsonl`]: JSON.stringify({
    type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, agentId: 'a111',
    sessionId: ids[0], cwd: 'D:\\project\\app', message: { role: 'user', content: 'sub prompt' },
  }) + '\n',
  [`${SUBAGENTS_DIR}\\agent-a111.meta.json`]: JSON.stringify({ agentType: 'Explore', description: 'Look around' }),
  [`${SUBAGENTS_DIR}\\workflows\\run1\\agent-a222.jsonl`]: JSON.stringify({
    type: 'user', uuid: 's2', parentUuid: null, isSidechain: true, agentId: 'a222',
    sessionId: ids[0], cwd: 'D:\\project\\app', message: { role: 'user', content: 'nested prompt' },
  }) + '\n',
}

function makeWorld(
  opts: {
    stored?: string[]
    missingRoot?: boolean
    /** Extra `agent-*.jsonl` files (flat under SUBAGENTS_DIR) the first
     *  fixture's sub-agent scan should also see. */
    extraSubagents?: Array<{ file: string; content: string }>
  } = {},
) {
  const encoder = new TextEncoder()
  const files = new Map<string, Uint8Array>()
  ids.forEach((id, i) => {
    files.set(pathOf(id), encoder.encode(transcript(id, `Session ${i}`)))
  })
  for (const [path, text] of Object.entries(SUBAGENT_FILES)) {
    files.set(path, encoder.encode(text))
  }
  for (const extra of opts.extraSubagents ?? []) {
    files.set(`${SUBAGENTS_DIR}\\${extra.file}`, encoder.encode(extra.content))
  }
  const fs = {
    stat: vi.fn(async (path: string) => {
      if (path === ROOT) {
        if (opts.missingRoot) throw new Error('ENOENT')
        return { isDirectory: () => true, isFile: () => false, size: 0 }
      }
      if (path === SUBAGENTS_DIR) {
        return { isDirectory: () => true, isFile: () => false, size: 0 }
      }
      const data = files.get(path)
      if (!data) throw new Error('ENOENT')
      return { isDirectory: () => false, isFile: () => true, size: data.byteLength }
    }),
  } as unknown as RuntimeFs

  const directBridge = {
    request: vi.fn(async (request: BrowserBridgeRequest) => {
      const action = request.route.action as string
      const payload = request.payload as Record<string, unknown>
      if (action === 'readdirTree' && payload.path === SUBAGENTS_DIR) {
        return {
          id: request.id,
          route: request.route,
          ok: true,
          result: {
            root: SUBAGENTS_DIR,
            truncated: false,
            entries: [
              { path: 'agent-a111.jsonl', isDirectory: false, size: 10, mtimeMs: 1 },
              { path: 'agent-a111.meta.json', isDirectory: false, size: 10, mtimeMs: 1 },
              { path: 'workflows', isDirectory: true, size: 0 },
              { path: 'workflows/run1', isDirectory: true, size: 0 },
              { path: 'workflows/run1/agent-a222.jsonl', isDirectory: false, size: 10, mtimeMs: 1 },
              { path: 'agent-empty.jsonl', isDirectory: false, size: 0 },
              { path: 'subagent-native-dir', isDirectory: true, size: 0 },
              ...(opts.extraSubagents ?? []).map(e => ({
                path: e.file,
                isDirectory: false,
                size: 64,
                mtimeMs: 1,
              })),
            ],
          },
        }
      }
      if (action === 'readdirTree') {
        return {
          id: request.id,
          route: request.route,
          ok: true,
          result: {
            root: ROOT,
            truncated: false,
            entries: [
              { path: 'D--project-app', isDirectory: true, size: 0 },
              { path: 'D--project-app/notes.txt', isDirectory: false, size: 3, mtimeMs: 1 },
              { path: 'D--project-app/empty-0000-4000-8000-000000000999.jsonl', isDirectory: false, size: 0 },
              ...ids.map((id, i) => ({
                path: `D--project-app/${id}.jsonl`,
                isDirectory: false,
                size: files.get(pathOf(id))!.byteLength,
                mtimeMs: 1_000 + i,
              })),
            ],
          },
        }
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
        for (const p of parts) {
          blob.set(p, at)
          at += p.byteLength
        }
        return { id: request.id, route: request.route, ok: true, result: { entries, totalBytes: blob.byteLength, truncated: false, blob } }
      }
      if (action === 'readRange') {
        const data = files.get(payload.path as string)!
        const offset = payload.offset as number
        const slice = data.subarray(offset, offset + (payload.length as number))
        return { id: request.id, route: request.route, ok: true, result: { data: slice, bytesRead: slice.byteLength } }
      }
      return { id: request.id, route: request.route, ok: false, error: { code: 'nope', message: action } }
    }),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport

  const stored = new Set(opts.stored ?? [])
  const writer: SessionImportWriter = {
    writeSessionBundle: vi.fn(async args => {
      stored.add(args.sessionId)
    }),
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
  return { ctx, writer, directBridge, files }
}

type Action = 'detect' | 'listSessions' | 'readSession' | 'writeSession'

async function call(ctx: SessionImportAdapterContext, action: Action, payload: Record<string, unknown>) {
  return handleSessionImportBridgeRequest(
    { id: `req-${action}`, route: createBridgeRoute('sessionImport', action), payload } as BrowserBridgeRequest,
    ctx,
  )
}

describe('sessionImport adapter — detect', () => {
  it('lists a source whose root directory exists, none otherwise', async () => {
    const { ctx } = makeWorld()
    expect(await call(ctx, 'detect', {})).toMatchObject({
      ok: true,
      result: { sources: [{ source: 'claude-code', rootPath: ROOT }] },
    })
    const missing = makeWorld({ missingRoot: true })
    expect(await call(missing.ctx, 'detect', {})).toMatchObject({ ok: true, result: { sources: [] } })
  })
})

describe('sessionImport adapter — listSessions', () => {
  it('pages newest-first over session files only, lite-reading just the requested page', async () => {
    const { ctx, directBridge } = makeWorld({ stored: [ids[119]!] })
    const page0 = await call(ctx, 'listSessions', { source: 'claude-code', page: 0 })
    expect(page0.ok).toBe(true)
    const result = (page0 as { result: { total: number; page: number; pageSize: number; rows: Array<Record<string, unknown>> } }).result
    expect(result).toMatchObject({ total: 120, page: 0, pageSize: 50 })
    expect(result.rows).toHaveLength(50)
    // Newest (highest mtime) first; the filename id is authoritative.
    expect(result.rows[0]).toMatchObject({
      sessionId: ids[119],
      title: 'Session 119',
      projectPath: 'D:\\project\\app',
      importable: true,
      alreadyImported: true,
    })
    expect(result.rows[1]).toMatchObject({ sessionId: ids[118], alreadyImported: false })
    const batch = (directBridge.request as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as BrowserBridgeRequest)
      .filter(r => r.route.action === 'readBatch')
    expect(batch).toHaveLength(1)
    expect((batch[0]!.payload as { items: unknown[] }).items).toHaveLength(50)

    const page2 = await call(ctx, 'listSessions', { source: 'claude-code', page: 2 })
    expect((page2 as { result: { rows: unknown[]; page: number } }).result).toMatchObject({ page: 2 })
    expect((page2 as { result: { rows: unknown[] } }).result.rows).toHaveLength(20)
    // An out-of-range page clamps to the last one.
    const page9 = await call(ctx, 'listSessions', { source: 'claude-code', page: 9 })
    expect((page9 as { result: { page: number } }).result.page).toBe(2)
  })

  it('refuses an unknown source and a missing bridge', async () => {
    const { ctx } = makeWorld()
    expect(await call(ctx, 'listSessions', { source: 'chatgpt', page: 0 })).toMatchObject({
      ok: false,
      error: { code: 'unknown_source' },
    })
    expect(await call({ ...ctx, directBridge: null }, 'listSessions', { source: 'claude-code', page: 0 })).toMatchObject({
      ok: false,
      error: { code: 'import_unavailable' },
    })
  })
})

describe('sessionImport adapter — readSession', () => {
  it('returns the whole file as bytes, keyed by the filename id', async () => {
    const { ctx, files } = makeWorld()
    const response = await call(ctx, 'readSession', { source: 'claude-code', path: pathOf(ids[3]!) })
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: false } })
    const bytes = (response as { result: { bytes: Uint8Array } }).result.bytes
    expect(new TextDecoder().decode(bytes)).toBe(new TextDecoder().decode(files.get(pathOf(ids[3]!))))
  })

  it('returns the session\'s sub-agent transcripts (any depth) with their meta sidecars', async () => {
    const { ctx } = makeWorld()
    const response = await call(ctx, 'readSession', { source: 'claude-code', path: pathOf(ids[0]!) })
    const subagents = (response as { result: { subagents: Array<Record<string, unknown>> } }).result.subagents
    expect(subagents.map(s => s.agentId).sort()).toEqual(['a111', 'a222'])
    const a111 = subagents.find(s => s.agentId === 'a111')!
    expect(a111.meta).toEqual({ agentType: 'Explore', description: 'Look around' })
    expect(new TextDecoder().decode(a111.bytes as Uint8Array)).toContain('sub prompt')
    const a222 = subagents.find(s => s.agentId === 'a222')!
    expect(a222.path).toContain('workflows')
    expect(a222.meta).toBeUndefined()
    // A session with no subagents dir → empty list, no error.
    const plain = await call(ctx, 'readSession', { source: 'claude-code', path: pathOf(ids[5]!) })
    expect((plain as { result: { subagents: unknown[] } }).result.subagents).toEqual([])
  })

  it('is idempotent: an id already on disk is skipped without reading the file', async () => {
    const { ctx, directBridge } = makeWorld({ stored: [ids[3]!] })
    const response = await call(ctx, 'readSession', { source: 'claude-code', path: pathOf(ids[3]!) })
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: true } })
    expect((response as { result: Record<string, unknown> }).result).not.toHaveProperty('bytes')
    expect(
      (directBridge.request as ReturnType<typeof vi.fn>).mock.calls.some(
        c => (c[0] as BrowserBridgeRequest).route.action === 'readRange',
      ),
    ).toBe(false)
  })

  it('rejects paths outside the source root and non-session files', async () => {
    const { ctx } = makeWorld()
    expect(await call(ctx, 'readSession', { source: 'claude-code', path: 'C:\\Windows\\system.ini' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    })
    expect(await call(ctx, 'readSession', { source: 'claude-code', path: `${ROOT}\\D--project-app\\notes.txt` })).toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    })
    expect(await call({ ...ctx, writer: null }, 'readSession', { source: 'claude-code', path: pathOf(ids[1]!) })).toMatchObject({
      ok: false,
      error: { code: 'import_unavailable' },
    })
  })

  it('rejects path-traversal vectors, even ones ending in a real session id', async () => {
    const { ctx } = makeWorld()
    // Each of these has a *valid* `<uuid>.jsonl` tail, so it clears the
    // session-file gate — only the under-root check can stop it.
    const vectors = [
      // `..` segments that climb out of the root before diving back in.
      `${ROOT}\\..\\..\\other\\${ids[0]}.jsonl`,
      // Sibling directory sharing the root's prefix (`projects` vs
      // `projects-evil`) — the `${root}/` boundary, not a bare `startsWith`,
      // is what rejects this.
      `C:\\Users\\me\\.claude\\projects-evil\\${ids[0]}.jsonl`,
    ]
    for (const path of vectors) {
      expect(await call(ctx, 'readSession', { source: 'claude-code', path }), path).toMatchObject({
        ok: false,
        error: { code: 'invalid_path' },
      })
    }
    // A trailing `/..` slips past the `/../` substring check but has no session
    // id in its tail segment — the second gate (Not a session file) stops it.
    expect(
      await call(ctx, 'readSession', {
        source: 'claude-code',
        path: `${ROOT}\\D--project-app\\${ids[0]}.jsonl\\..`,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_path' } })
  })

  it('keeps a sub-agent read under the parent dir even when a filename yields a traversal-token agentId', async () => {
    // The scan builds each read path from the host-listed tree entry, never by
    // re-joining the regex-captured agentId. A file literally named
    // `agent-...jsonl` captures the agentId `..`; were that token used to build
    // a path it would name the parent dir, so pin that it stays a label only.
    const malformed =
      JSON.stringify({
        type: 'user', uuid: 'sx', parentUuid: null, isSidechain: true, agentId: '..',
        sessionId: ids[0], cwd: 'D:\\project\\app', message: { role: 'user', content: 'escape attempt' },
      }) + '\n'
    const { ctx } = makeWorld({ extraSubagents: [{ file: 'agent-...jsonl', content: malformed }] })
    const response = await call(ctx, 'readSession', { source: 'claude-code', path: pathOf(ids[0]!) })
    const subagents = (
      response as { result: { subagents: Array<{ agentId: string; path: string; bytes: Uint8Array }> } }
    ).result.subagents
    const escaped = subagents.find(s => s.agentId === '..')
    expect(escaped, 'the traversal-token file is still scanned').toBeTruthy()
    // The read path is the tree file under subagents/, not the parent dir the
    // `..` token names — and it carries no separator-bounded `..` segment.
    expect(escaped!.path).toBe(`${SUBAGENTS_DIR}\\agent-...jsonl`)
    expect(escaped!.path.startsWith(`${SUBAGENTS_DIR}\\`)).toBe(true)
    expect(/[\\/]\.\.[\\/]/.test(escaped!.path)).toBe(false)
    expect(new TextDecoder().decode(escaped!.bytes)).toContain('escape attempt')
  })
})

describe('sessionImport adapter — writeSession', () => {
  const bundleFor = (id: string) =>
    convert({ path: pathOf(id), bytes: new TextEncoder().encode(transcript(id, 'T')).buffer as ArrayBuffer, now: 1_700_000_000_000 })

  // A parent that delegates to one sub-agent (separate transcript file), so the
  // converted bundle carries a real `parentToolCallId` for the ack round-trip.
  const AGENT_ID = 'a1b2c3d4e5f60718'
  const agentTranscript = (id: string) =>
    [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd: 'D:\\project\\app', timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'delegate it' }] } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Explore', prompt: 'find', subagent_type: 'Explore' } }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: 'the summary' }] }] }, toolUseResult: { agentId: AGENT_ID, status: 'completed' } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n'
  const subagentBytes = () =>
    new TextEncoder().encode(
      [
        { type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, agentId: AGENT_ID, sessionId: 'x', cwd: 'D:\\project\\app', timestamp: '2026-08-01T10:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'find' }] } },
        { type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, agentId: AGENT_ID, timestamp: '2026-08-01T10:06:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'found' }] } },
      ].map(r => JSON.stringify(r)).join('\n') + '\n',
    ).buffer as ArrayBuffer
  const agentBundleFor = (id: string) =>
    convert({
      path: pathOf(id),
      bytes: new TextEncoder().encode(agentTranscript(id)).buffer as ArrayBuffer,
      now: 1_700_000_000_000,
      subagents: [{ agentId: AGENT_ID, path: 'sub', bytes: subagentBytes() }],
    })
  /** The text of the parent's Agent tool-result row in the entries a
   *  writeSessionBundle call was handed. */
  const agentResultText = (writer: SessionImportWriter): string => {
    const args = (writer.writeSessionBundle as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    const row = (args.entries as Array<Record<string, unknown>>).find(e => e.uuid === 'u2')!
    const part = (row.message as { content: Array<Record<string, unknown>> }).content[0]!
    const result = part.result
    return typeof result === 'string'
      ? result
      : (result as Array<{ text: string }>).map(b => b.text).join('')
  }

  it('writes a converted bundle through the bundle path, keeping the source id', async () => {
    const { ctx, writer } = makeWorld()
    const response = await call(ctx, 'writeSession', { source: 'claude-code', result: bundleFor(ids[3]!) })
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: false } })
    expect(writer.writeSessionBundle).toHaveBeenCalledTimes(1)
    const args = (writer.writeSessionBundle as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(args).toMatchObject({ sessionId: ids[3], projectRoot: 'D:\\project\\app', templateType: 'code' })
    expect(args.meta.updatedAt).toBe(1_700_000_000_000)
    // user + assistant + the pinned custom-title record (firstPrompt fallback).
    expect(args.entries.length).toBe(3)
  })

  it('writes each valid sub-agent bundle before the parent, skipping malformed ones', async () => {
    const { ctx, writer } = makeWorld()
    const base = bundleFor(ids[3]!)
    const good = {
      agentId: 'a111', taskId: 'a0000001', sessionId: 'subagent-a111',
      entries: [], meta: { schemaVersion: 1, sessionId: 'subagent-a111', updatedAt: 1, metadata: {} },
      toolDetails: [], task: { schemaVersion: 1, taskId: 'a0000001' },
    }
    const bad = { ...good, sessionId: 'not-a-subagent', meta: { ...good.meta, sessionId: 'not-a-subagent' } }
    const response = await call(ctx, 'writeSession', { source: 'claude-code', result: { ...base, subAgents: [good, bad] } })
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: false } })
    expect(writer.writeSubAgentBundle).toHaveBeenCalledTimes(1)
    expect(writer.writeSubAgentBundle).toHaveBeenCalledWith(ids[3], good)
    // Sub-agents are written BEFORE the parent transcript, so a failed sub-agent
    // write never leaves a dead task-id ack in the append-only parent.
    const parentOrder = (writer.writeSessionBundle as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    expect((writer.writeSubAgentBundle as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(parentOrder)
  })

  it('stamps the task-id ack on the parent Agent result for a sub-agent that lands', async () => {
    const { ctx, writer } = makeWorld()
    const bundle = agentBundleFor(ids[3]!)
    expect(bundle.subAgents).toHaveLength(1)
    const taskId = bundle.subAgents[0]!.taskId
    const response = await call(ctx, 'writeSession', { source: 'claude-code', result: bundle })
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: false } })
    expect(writer.writeSubAgentBundle).toHaveBeenCalledTimes(1)
    // The landed sub-agent's ack is now on the parent's persisted result.
    expect(agentResultText(writer)).toBe(`the summary\n\n(task id ${taskId})`)
  })

  it('leaves NO task-id ack in the parent when the sub-agent write fails', async () => {
    const { ctx, writer } = makeWorld()
    // Force the (only) sub-agent write to fail — a transient grouped-store error.
    writer.writeSubAgentBundle = vi.fn(async () => {
      throw new Error('disk full')
    })
    const bundle = agentBundleFor(ids[3]!)
    const taskId = bundle.subAgents[0]!.taskId
    const response = await call(ctx, 'writeSession', { source: 'claude-code', result: bundle })
    // The parent still imports (one bad sub-agent never sinks the import)...
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: false } })
    expect(writer.writeSessionBundle).toHaveBeenCalledTimes(1)
    // ...but its Agent result carries NO dead ack: no task.json landed, so the
    // "Open in Background Tasks" jump would resolve to nothing.
    const text = agentResultText(writer)
    expect(text).toBe('the summary')
    expect(text).not.toContain('task id')
    expect(text).not.toContain(taskId)
  })

  it('routes each interleaved sub-agent’s task-id ack to its own parent Agent result', async () => {
    // Two Agent calls in ONE parent, each delegating to a distinct sub-agent.
    // The converter emits ack-free parent results + a per-bundle `parentToolCallId`
    // (call_a / call_b); the write path stamps every LANDED sub-agent's ack onto the
    // result its `parentToolCallId` names. This pins that the routing keys on the
    // link — A's ack on call_a's result, B's on call_b's, never crossed — the
    // interleaved end-to-end round-trip the converter no longer covers.
    const { ctx, writer } = makeWorld()
    const A = 'a1a1a1a1a1a1a1a1'
    const B = 'b2b2b2b2b2b2b2b2'
    const id = ids[3]!
    const subBytes = (agentId: string, done: string) =>
      new TextEncoder().encode(
        [
          { type: 'user', uuid: `${agentId}-s1`, parentUuid: null, isSidechain: true, agentId, sessionId: 'x', cwd: 'D:\\project\\app', timestamp: '2026-08-01T10:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
          { type: 'assistant', uuid: `${agentId}-s2`, parentUuid: `${agentId}-s1`, isSidechain: true, agentId, timestamp: '2026-08-01T10:06:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: done }] } },
        ].map(r => JSON.stringify(r)).join('\n') + '\n',
      ).buffer as ArrayBuffer
    const parent =
      [
        { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd: 'D:\\project\\app', timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'delegate both' }] } },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'Agent', input: { description: 'A', prompt: 'pa', subagent_type: 'Explore' } }] } },
        { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'text', text: 'the A summary' }] }] }, toolUseResult: { agentId: A, status: 'completed' } },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_b', name: 'Agent', input: { description: 'B', prompt: 'pb', subagent_type: 'Plan' } }] } },
        { type: 'user', uuid: 'u3', parentUuid: 'a2', sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b', content: [{ type: 'text', text: 'the B summary' }] }] }, toolUseResult: { agentId: B, status: 'completed' } },
      ].map(r => JSON.stringify(r)).join('\n') + '\n'
    const bundle = convert({
      path: pathOf(id),
      bytes: new TextEncoder().encode(parent).buffer as ArrayBuffer,
      now: 1_700_000_000_000,
      subagents: [
        { agentId: A, path: 'subA', bytes: subBytes(A, 'A done') },
        { agentId: B, path: 'subB', bytes: subBytes(B, 'B done') },
      ],
    })
    expect(bundle.subAgents).toHaveLength(2)
    const taskIdOf = (agentId: string) => bundle.subAgents.find(b => b.agentId === agentId)!.taskId

    const response = await call(ctx, 'writeSession', { source: 'claude-code', result: bundle })
    expect(response).toMatchObject({ ok: true, result: { sessionId: id, skipped: false } })
    expect(writer.writeSubAgentBundle).toHaveBeenCalledTimes(2)

    const resultText = (uuid: string): string => {
      const args = (writer.writeSessionBundle as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      const row = (args.entries as Array<Record<string, unknown>>).find(e => e.uuid === uuid)!
      const part = (row.message as { content: Array<Record<string, unknown>> }).content[0]!
      const result = part.result
      return typeof result === 'string' ? result : (result as Array<{ text: string }>).map(b => b.text).join('')
    }
    // Each parent result carries ITS OWN agent's ack — and not the other's.
    expect(resultText('u2')).toBe(`the A summary\n\n(task id ${taskIdOf(A)})`)
    expect(resultText('u3')).toBe(`the B summary\n\n(task id ${taskIdOf(B)})`)
    expect(resultText('u2')).not.toContain(taskIdOf(B))
    expect(resultText('u3')).not.toContain(taskIdOf(A))
  })

  it('rejects a bundle whose entries are not well-formed records', async () => {
    const { ctx, writer } = makeWorld()
    // A structurally valid envelope (entries IS an array) can still carry junk
    // entries; without a per-entry check they would be appended verbatim as
    // JSONL, producing a transcript the loader chokes on.
    const junk = { ...bundleFor(ids[3]!), entries: [1, 2, 3] }
    expect(await call(ctx, 'writeSession', { source: 'claude-code', result: junk })).toMatchObject({
      ok: false,
      error: { code: 'invalid_result' },
    })
    expect(writer.writeSessionBundle).not.toHaveBeenCalled()
  })

  it('skips a sub-agent whose toolDetails is not an array, without a half-write', async () => {
    const { ctx, writer } = makeWorld()
    const base = bundleFor(ids[3]!)
    const good = {
      agentId: 'a111', taskId: 'a0000001', sessionId: 'subagent-a111',
      entries: [], meta: { schemaVersion: 1, sessionId: 'subagent-a111', updatedAt: 1, metadata: {} },
      toolDetails: [], task: { schemaVersion: 1, taskId: 'a0000001' },
    }
    // A non-array toolDetails would throw inside `writeSessionBundle` AFTER the
    // entries + meta.json were appended, leaving a half-written dir with no
    // task.json. The guard skips the bundle before a single byte is written.
    const badTools = {
      ...good, sessionId: 'subagent-a222', taskId: 'a0000002',
      meta: { ...good.meta, sessionId: 'subagent-a222' }, toolDetails: 'nope',
    }
    const response = await call(ctx, 'writeSession', { source: 'claude-code', result: { ...base, subAgents: [good, badTools] } })
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: false } })
    expect(writer.writeSubAgentBundle).toHaveBeenCalledTimes(1)
    expect(writer.writeSubAgentBundle).toHaveBeenCalledWith(ids[3], good)
  })

  it('skips a sub-agent whose id would escape the subagents dir', async () => {
    const { ctx, writer } = makeWorld()
    const base = bundleFor(ids[3]!)
    // `subagent-../x` passes startsWith('subagent-') and the meta match, but its
    // `../x` suffix (an agentId that in the legacy inline form comes from
    // transcript content) would redirect the write out of the subagents dir.
    const evil = {
      agentId: '../x', taskId: 'a0000003', sessionId: 'subagent-../x',
      entries: [], meta: { schemaVersion: 1, sessionId: 'subagent-../x', updatedAt: 1, metadata: {} },
      toolDetails: [], task: { schemaVersion: 1, taskId: 'a0000003' },
    }
    const response = await call(ctx, 'writeSession', { source: 'claude-code', result: { ...base, subAgents: [evil] } })
    expect(response).toMatchObject({ ok: true, result: { sessionId: ids[3], skipped: false } })
    expect(writer.writeSubAgentBundle).not.toHaveBeenCalled()
  })

  it('is idempotent and validates the bundle', async () => {
    const { ctx, writer } = makeWorld({ stored: [ids[3]!] })
    expect(await call(ctx, 'writeSession', { source: 'claude-code', result: bundleFor(ids[3]!) })).toMatchObject({
      ok: true,
      result: { sessionId: ids[3], skipped: true },
    })
    expect(writer.writeSessionBundle).not.toHaveBeenCalled()
    expect(await call(ctx, 'writeSession', { source: 'claude-code', result: { source: 'claude-code', sessionId: 'x' } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_result' },
    })
    const foreign = { ...bundleFor(ids[4]!), sessionId: 'not-a-uuid', meta: { ...bundleFor(ids[4]!).meta, sessionId: 'not-a-uuid' } }
    expect(await call(ctx, 'writeSession', { source: 'claude-code', result: foreign })).toMatchObject({
      ok: false,
      error: { code: 'invalid_result' },
    })
  })

  it('answers an unknown action', async () => {
    const { ctx } = makeWorld()
    const response = await handleSessionImportBridgeRequest(
      { id: 'x', route: { namespace: 'nexus', capability: 'sessionImport', action: 'nope' }, payload: {} } as unknown as BrowserBridgeRequest,
      ctx,
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'unknown_action' } })
  })
})
