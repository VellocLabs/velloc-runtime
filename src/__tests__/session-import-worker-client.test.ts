import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ImportWorkerRequest,
  ImportWorkerResponse,
} from '../sessionImport/protocol'
import { ImportWorkerClient } from '../sessionImport/workerClient'
import { runImportRequest } from '../sessionImport/inline'

// The client isolates the parser: a Worker that hangs is terminated on
// timeout and respawned on the next call; a host without Worker (or whose
// spawn throws) runs the same code inline.

const lite: ImportWorkerRequest = {
  id: 'r1',
  kind: 'parseLite',
  source: 'claude-code',
  items: [],
}

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<ImportWorkerResponse>) => void) | null = null
  onerror: (() => void) | null = null
  posted: ImportWorkerRequest[] = []
  terminated = false
  constructor(private readonly behaviour: 'echo' | 'hang' | 'throw') {
    FakeWorker.instances.push(this)
  }
  postMessage(request: ImportWorkerRequest): void {
    // A structured-clone / detached-buffer failure surfaces as a synchronous
    // throw out of postMessage — the message never leaves.
    if (this.behaviour === 'throw') throw new Error('post boom')
    this.posted.push(request)
    if (this.behaviour === 'echo') {
      queueMicrotask(() =>
        this.onmessage?.({ data: runImportRequest(request) } as MessageEvent<ImportWorkerResponse>),
      )
    }
  }
  terminate(): void {
    this.terminated = true
  }
}

describe('ImportWorkerClient', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes requests through the spawned Worker and reports worker mode', async () => {
    const client = new ImportWorkerClient({
      spawn: () => new FakeWorker('echo') as unknown as Worker,
    })
    const response = await client.request(lite)
    expect(response).toEqual({ id: 'r1', ok: true, result: [] })
    expect(client.mode).toBe('worker')
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it('terminates a hung Worker on timeout and respawns on the next request', async () => {
    let calls = 0
    const client = new ImportWorkerClient({
      timeoutMs: 1_000,
      spawn: () => new FakeWorker(calls++ === 0 ? 'hang' : 'echo') as unknown as Worker,
    })
    const pending = client.request(lite)
    await vi.advanceTimersByTimeAsync(1_001)
    const response = await pending
    expect(response).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(FakeWorker.instances[0]!.terminated).toBe(true)

    const next = await client.request({ ...lite, id: 'r2' })
    expect(next).toEqual({ id: 'r2', ok: true, result: [] })
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it('terminates an idle Worker and spawns a fresh one later', async () => {
    const client = new ImportWorkerClient({
      idleMs: 500,
      spawn: () => new FakeWorker('echo') as unknown as Worker,
    })
    await client.request(lite)
    await vi.advanceTimersByTimeAsync(600)
    expect(FakeWorker.instances[0]!.terminated).toBe(true)
    await client.request({ ...lite, id: 'r2' })
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it('resolves post_failed when postMessage throws, and clears the request timer', async () => {
    const client = new ImportWorkerClient({
      timeoutMs: 1_000,
      idleMs: 1_000_000,
      spawn: () => new FakeWorker('throw') as unknown as Worker,
    })
    const response = await client.request(lite)
    expect(response).toMatchObject({ id: 'r1', ok: false, error: { code: 'post_failed', message: 'post boom' } })
    // The spawn itself succeeded — the failure was the post, not the Worker.
    expect(client.mode).toBe('worker')
    // The timer was cleared in the catch: advancing past the timeout must not
    // terminate the Worker (which would prove the timer still fired) nor settle
    // the already-resolved promise a second time.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeWorker.instances[0]!.terminated).toBe(false)
  })

  it('recovers a Worker script error inline instead of hard-failing, then stays inline', async () => {
    // A Worker that crashes (an error outside runImportRequest's try/catch — an
    // OOM kill) or never loads its module fires onerror. Rather than reject the
    // in-flight request with `terminated`, the client re-runs it inline and
    // switches to inline mode for good, so the import completes.
    const runInline = vi.fn(async (request: ImportWorkerRequest) => runImportRequest(request))
    const client = new ImportWorkerClient({
      spawn: () => new FakeWorker('hang') as unknown as Worker,
      runInline,
    })
    const pending = client.request(lite)
    FakeWorker.instances[0]!.onerror?.()
    const response = await pending
    expect(response).toEqual({ id: 'r1', ok: true, result: [] })
    expect(FakeWorker.instances[0]!.terminated).toBe(true)
    expect(client.mode).toBe('inline')

    // The next request runs inline directly — no respawn.
    const next = await client.request({ ...lite, id: 'r2' })
    expect(next).toEqual({ id: 'r2', ok: true, result: [] })
    expect(FakeWorker.instances).toHaveLength(1)
    expect(runInline).toHaveBeenCalledTimes(2)
  })

  it('recovers EVERY in-flight request inline on a Worker crash (both fail together otherwise)', async () => {
    // The reported bug: importing two sessions at once shares one Worker; a
    // crash on either used to reject BOTH pending requests with `terminated`.
    // Now both recover inline.
    const runInline = vi.fn(async (request: ImportWorkerRequest) => runImportRequest(request))
    const client = new ImportWorkerClient({
      spawn: () => new FakeWorker('hang') as unknown as Worker,
      runInline,
    })
    const a = client.request({ ...lite, id: 'a1' })
    const b = client.request({ ...lite, id: 'b1' })
    FakeWorker.instances[0]!.onerror?.()
    expect(await a).toEqual({ id: 'a1', ok: true, result: [] })
    expect(await b).toEqual({ id: 'b1', ok: true, result: [] })
    expect(client.mode).toBe('inline')
  })

  it('drops a response that arrives after its request already timed out (no double-resolve)', async () => {
    const client = new ImportWorkerClient({
      timeoutMs: 1_000,
      spawn: () => new FakeWorker('hang') as unknown as Worker,
    })
    const pending = client.request(lite)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } })
    const worker = FakeWorker.instances[0]!
    expect(worker.terminated).toBe(true)
    // The Worker finally answers, too late: settleReply finds no pending
    // entry for the id and drops it. Resolving the settled promise again would
    // otherwise slip a stale result past the timeout.
    worker.onmessage?.({ data: runImportRequest(worker.posted[0]!) } as MessageEvent<ImportWorkerResponse>)
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
  })

  it('falls back to inline execution when the spawn throws, and stays inline', async () => {
    const runInline = vi.fn(async (request: ImportWorkerRequest) => runImportRequest(request))
    const client = new ImportWorkerClient({
      spawn: () => {
        throw new Error('nested workers unsupported')
      },
      runInline,
    })
    expect(await client.request(lite)).toEqual({ id: 'r1', ok: true, result: [] })
    expect(client.mode).toBe('inline')
    await client.request({ ...lite, id: 'r2' })
    expect(runInline).toHaveBeenCalledTimes(2)
  })

  it('forwards the sub-agent inputs of a convert request to the source adapter', async () => {
    // The dispatcher is the only place the request's fields are unpacked; a
    // field it forgets never reaches the converter while every converter
    // test (which calls `convert` directly) stays green.
    const UUID = '3f2a6c1e-9b4d-4e8a-8c1d-0a1b2c3d4e5f'
    const enc = (lines: object[]) =>
      new TextEncoder().encode(lines.map(l => JSON.stringify(l)).join('\n') + '\n').buffer as ArrayBuffer
    const main = enc([
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: UUID, cwd: 'D:\\app', timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: 'go' } },
    ])
    const sub = enc([
      { type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, agentId: 'a1', sessionId: UUID, cwd: 'D:\\app', message: { role: 'user', content: 'sub' } },
    ])
    const response = runImportRequest({
      id: 'c1',
      kind: 'convert',
      source: 'claude-code',
      path: `/p/${UUID}.jsonl`,
      bytes: main,
      now: 1,
      subagents: [{ agentId: 'a1', path: '/p/sub', bytes: sub }],
    })
    expect(response.ok).toBe(true)
    const result = (response as { result: { subAgents: Array<{ sessionId: string }> } }).result
    expect(result.subAgents.map(s => s.sessionId)).toEqual(['subagent-a1'])
  })

  it('answers an unknown source with an error envelope instead of throwing', async () => {
    const client = new ImportWorkerClient({
      spawn: () => new FakeWorker('echo') as unknown as Worker,
    })
    const response = await client.request({
      ...lite,
      source: 'chatgpt' as never,
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'unknown_source' } })
  })
})
