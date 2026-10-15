import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isRunJsAvailable,
  resetRunJsBrokerForTests,
  runJs,
  RunJsFailure,
  RUN_JS_MAX_LOG_CHARS,
  RUN_JS_MAX_LOG_LINES,
  setRunJsControlPort,
  SPAWN_ACK_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
} from '../browser/runJs/RunJsBroker'

/** Poll until `predicate` holds — MessageChannel delivery is a macrotask. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  if (!predicate()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

type Spawn = {
  message: {
    type: string
    key: string
    kind: string
    init: { code: string; mode?: string; inputs?: Record<string, unknown>; workspaceName?: string }
  }
  transfer: unknown[]
}

/**
 * Stand-in for the guest window's end of the control channel. `setRunJsControlPort`
 * only sets `onmessage`/`start` and calls `postMessage` — capturing those (rather
 * than using a real transferred port) keeps `remote` (port2) live and usable in
 * the test as the "worker" side, sidestepping node-vs-browser `event.ports`
 * transfer differences.
 */
function makeStubControlPort() {
  return {
    onmessage: null as ((e: MessageEvent) => void) | null,
    started: false,
    posts: [] as { message: { type: string; key?: string }; transfer: unknown[] }[],
    start() {
      this.started = true
    },
    postMessage(message: unknown, transfer: unknown[] = []) {
      this.posts.push({ message: message as { type: string }, transfer })
    },
  }
}

async function captureSpawn(control: ReturnType<typeof makeStubControlPort>): Promise<Spawn> {
  await waitFor(() => control.posts.some(p => p.message.type === 'worker.spawn'))
  const spawn = control.posts.find(p => p.message.type === 'worker.spawn')!
  return { message: spawn.message as Spawn['message'], transfer: spawn.transfer }
}

afterEach(() => resetRunJsBrokerForTests())

describe('RunJsBroker', () => {
  it('is unavailable and rejects until a control port is attached', async () => {
    expect(isRunJsAvailable()).toBe(false)
    await expect(
      runJs({ code: 'x', timeoutMs: 1_000 }),
    ).rejects.toThrow(/unavailable/)
  })

  it('runs code and resolves with the worker-reported result, then terminates', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    expect(isRunJsAvailable()).toBe(true)

    const promise = runJs({ code: 'return 1', timeoutMs: 1_000 })
    const spawn = await captureSpawn(control)
    expect(spawn.message.init.code).toBe('return 1')

    const remote = spawn.transfer[0] as MessagePort
    // Logs arrive only as streamed k.log lines; the broker accumulates
    // them into the result (done carries no duplicate copy).
    remote.postMessage({ type: 'k.log', level: 'log', text: 'hi' })
    remote.postMessage({ type: 'k.done', result: '1' })

    await expect(promise).resolves.toEqual({
      result: '1',
      logs: [{ level: 'log', text: 'hi' }],
    })
    await waitFor(() => control.posts.some(p => p.message.type === 'worker.terminate'))
    remote.close()
  })

  it('PAUSES the execution timeout while a filesystem call is in flight', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    // An fs call that takes LONGER than the run timeout — simulates a user
    // still answering a workspace-write permission prompt. Without the pause,
    // the 50ms timeout would terminate the worker before the 200ms handler
    // returns; with it, the clock is frozen for the call's duration.
    const onFsCall = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 200))
      return { kind: 'file', size: 1 }
    })

    const promise = runJs({ code: 'x', timeoutMs: 50, onFsCall })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    const received: Array<{ type: string; ok?: boolean }> = []
    remote.onmessage = e => received.push(e.data)
    remote.start()

    remote.postMessage({ type: 'k.call', noun: 'fs', callId: 'f1', op: 'stat', payload: { path: 'a' } })
    // The result arrives at ~200ms — well past the 50ms timeout — proving it did
    // NOT fire during the call.
    await waitFor(() => received.some(m => m.type === 'k.callResult'), 2_000)
    expect(received.find(m => m.type === 'k.callResult')).toMatchObject({
      ok: true,
    })

    // The script then completes normally (the resumed clock had time left).
    remote.postMessage({ type: 'k.done', result: 'ok' })
    await expect(promise).resolves.toMatchObject({ result: 'ok' })
    remote.close()
  })

  it('waits for an in-flight fs handler to land before settling on `done` (missing await)', async () => {
    // The worker posts `done` the moment the script function RETURNS — a
    // `writeTextFile('a.ts', x); return 'ok'` that forgot its await still has
    // the write in flight here. Settling immediately let SuperEdit commit the
    // overlay before the write reached it, silently losing the edit.
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const written: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>(r => {
      release = r
    })
    const onFsCall = vi.fn(async (_op: string, payload: Record<string, unknown>) => {
      await gate
      written.push(String(payload.path))
      return null
    })
    const promise = runJs({ code: 'x', timeoutMs: 1_000, onFsCall })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    const received: Array<{ type: string }> = []
    remote.onmessage = e => received.push(e.data)
    remote.start()

    remote.postMessage({ type: 'k.call', noun: 'fs', callId: 'f1', op: 'writeFile', payload: { path: 'a.ts' } })
    await waitFor(() => onFsCall.mock.calls.length === 1)
    // The script returns while the write is still being serviced.
    remote.postMessage({ type: 'k.done', result: 'ok' })

    let settled = false
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise(r => setTimeout(r, 60))
    expect(settled).toBe(false)
    expect(written).toEqual([])
    expect(control.posts.some(p => p.message.type === 'worker.terminate')).toBe(false)

    release()
    const result = await promise
    // The write landed BEFORE the run settled, and the run says so.
    expect(written).toEqual(['a.ts'])
    expect(result.result).toBe('ok')
    expect(result.logs).toEqual([
      expect.objectContaining({
        level: 'warn',
        text: expect.stringMatching(/1 nested call\(s\) .* were still in flight/),
      }),
    ])
    await waitFor(() => received.some(m => m.type === 'k.callResult'))
    await waitFor(() => control.posts.some(p => p.message.type === 'worker.terminate'))
    remote.close()
  })

  it('also drains in-flight handlers before settling on a script `error`', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const written: string[] = []
    const onFsCall = vi.fn(async (_op: string, payload: Record<string, unknown>) => {
      await new Promise(r => setTimeout(r, 80))
      written.push(String(payload.path))
      return null
    })
    const promise = runJs({ code: 'x', timeoutMs: 1_000, onFsCall })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({ type: 'k.call', noun: 'fs', callId: 'f1', op: 'writeFile', payload: { path: 'b.ts' } })
    await waitFor(() => onFsCall.mock.calls.length === 1)
    remote.postMessage({ type: 'k.error', message: 'boom' })
    const err = await promise.then(
      () => null,
      e => e as RunJsFailure,
    )
    expect(err?.message).toBe('boom')
    expect(written).toEqual(['b.ts'])
    remote.close()
  })

  it('a timeout/abort still wins over a drain that never ends', async () => {
    // Draining must not turn a hung handler into a hung run: the clock is
    // paused during the handler (as always), but an abort settles immediately.
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const ac = new AbortController()
    const onFsCall = vi.fn(() => new Promise<unknown>(() => {}))
    const promise = runJs({ code: 'x', timeoutMs: 1_000, onFsCall, signal: ac.signal })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({ type: 'k.call', noun: 'fs', callId: 'f1', op: 'writeFile', payload: { path: 'c.ts' } })
    await waitFor(() => onFsCall.mock.calls.length === 1)
    remote.postMessage({ type: 'k.done', result: 'ok' })
    await new Promise(r => setTimeout(r, 30))
    ac.abort()
    await expect(promise).rejects.toThrow(/interrupted/)
    remote.close()
  })

  it('caps retained logs by LINE count and appends one "dropped" marker', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const streamed: unknown[] = []
    const promise = runJs({ code: 'x', timeoutMs: 5_000, onLog: l => streamed.push(l) })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    const extra = 5
    for (let i = 0; i < RUN_JS_MAX_LOG_LINES + extra; i += 1) {
      remote.postMessage({ type: 'k.log', level: 'log', text: `line ${i}` })
    }
    remote.postMessage({ type: 'k.done', result: null })
    const { logs } = await promise
    expect(logs).toHaveLength(RUN_JS_MAX_LOG_LINES + 1)
    expect(logs[RUN_JS_MAX_LOG_LINES - 1]).toEqual({
      level: 'log',
      text: `line ${RUN_JS_MAX_LOG_LINES - 1}`,
    })
    const marker = logs[RUN_JS_MAX_LOG_LINES]!
    expect(marker.level).toBe('warn')
    expect(marker.text).toMatch(new RegExp(`${extra} more lines dropped`))
    // Exactly ONE marker, and the streamed view matches the retained one.
    expect(logs.filter(l => /more lines dropped/.test(l.text))).toHaveLength(1)
    expect(streamed).toHaveLength(RUN_JS_MAX_LOG_LINES + 1)
    remote.close()
  })

  it('caps retained logs by total TEXT size too', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 5_000 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    const half = 'x'.repeat(Math.ceil(RUN_JS_MAX_LOG_CHARS / 2))
    remote.postMessage({ type: 'k.log', level: 'log', text: half })
    remote.postMessage({ type: 'k.log', level: 'log', text: half })
    remote.postMessage({ type: 'k.log', level: 'log', text: half })
    remote.postMessage({ type: 'k.done', result: null })
    const { logs } = await promise
    // Two halves fit (≤ budget); the third is over and is dropped.
    expect(logs).toHaveLength(3)
    expect(logs[0]!.text).toBe(half)
    expect(logs[1]!.text).toBe(half)
    expect(logs[2]!.text).toMatch(/1 more line dropped/)
    remote.close()
  })

  it('rejects on timeout and asks the window to terminate', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 20 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    // The clock only runs once the script does.
    remote.postMessage({ type: 'k.started' })
    await expect(promise).rejects.toThrow(/timed out/)
    await waitFor(() => control.posts.some(p => p.message.type === 'worker.terminate'))
    remote.close()
  })

  it('does NOT spend the script timeout on worker startup', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    // A 60ms script budget against a worker that takes 250ms to come up —
    // spawn, module load and realm hardening all land BEFORE `k.started`.
    // Counting them against the script is the bug this pins: a SuperEdit with
    // a short `timeoutSec` died on a loaded machine before its script ever ran,
    // so the commit permission prompt never appeared.
    const promise = runJs({ code: 'x', timeoutMs: 60 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    await new Promise(r => setTimeout(r, 250))
    remote.postMessage({ type: 'k.started' })
    remote.postMessage({ type: 'k.done', result: 'ran anyway' })
    await expect(promise).resolves.toMatchObject({ result: 'ran anyway' })
    remote.close()
  })

  it('fails a worker that is spawned but never begins running', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 30 })
    const spawn = await captureSpawn(control)
    // The window acknowledges the spawn, so the spawn-ack deadline is cleared —
    // but the worker never reports `k.started` (a module hanging on load).
    // The startup deadline is what ends the run; the script clock cannot,
    // because it has not started.
    control.onmessage?.({
      data: { type: 'worker.spawned', key: spawn.message.key },
    } as MessageEvent)
    let settled = false
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    // Well past both the 30ms script budget and the 5s spawn ack would have
    // been — and still waiting, because only the startup deadline governs here.
    await new Promise(r => setTimeout(r, 120))
    expect(settled).toBe(false)
    expect(STARTUP_TIMEOUT_MS).toBeGreaterThan(SPAWN_ACK_TIMEOUT_MS)
    // Settle it so the startup timer is cleared rather than left pending.
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({ type: 'k.started' })
    remote.postMessage({ type: 'k.done', result: 'late' })
    await expect(promise).resolves.toMatchObject({ result: 'late' })
    remote.close()
  })

  it('rejects when the abort signal fires', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const ac = new AbortController()
    const promise = runJs({
      code: 'x',
      timeoutMs: 5_000,
      signal: ac.signal,
    })
    await captureSpawn(control)
    ac.abort()
    await expect(promise).rejects.toThrow(/interrupted/)
  })

  it('rejects fast on a worker error reported by the window', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 5_000 })
    const spawn = await captureSpawn(control)
    control.onmessage?.({
      data: { type: 'worker.error', key: spawn.message.key, message: 'boom' },
    } as MessageEvent)
    await expect(promise).rejects.toThrow(/worker error: boom/)
  })

  it('routes k.call (fs) to onFsCall and carries DOMException names back', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const onFsCall = vi.fn(async (op: string) => {
      if (op === 'stat') return { kind: 'file', size: 1 }
      const err = new Error('nope')
      err.name = 'NotAllowedError'
      throw err
    })
    const promise = runJs({
      code: 'x',
      timeoutMs: 1_000,
      onFsCall,
    })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    const received: Array<{
      type: string
      callId?: string
      ok?: boolean
      data?: unknown
      error?: { name: string }
    }> = []
    remote.onmessage = e => received.push(e.data)
    remote.start()

    remote.postMessage({ type: 'k.call', noun: 'fs', callId: 'f1', op: 'stat', payload: { path: 'a' } })
    remote.postMessage({ type: 'k.call', noun: 'fs', callId: 'f2', op: 'writeFile', payload: { path: 'a' } })
    await waitFor(
      () => received.filter(m => m.type === 'k.callResult').length === 2,
    )
    expect(received.find(m => m.callId === 'f1')).toMatchObject({
      ok: true,
      data: { kind: 'file', size: 1 },
    })
    expect(received.find(m => m.callId === 'f2')).toMatchObject({
      ok: false,
      error: { name: 'NotAllowedError' },
    })

    remote.postMessage({ type: 'k.done', result: null })
    await promise
    remote.close()
  })

  it('forwards mode in the spawn and routes k.call (shell) to onShellCall with the clock paused', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    // A command that takes longer than the script timeout: the clock must be
    // paused while it runs, exactly as for a filesystem call.
    const onShellCall = vi.fn(async (op: string) => {
      if (op === 'stop') {
        const err = new Error('no such task')
        err.name = 'NotFoundError'
        throw err
      }
      await new Promise(r => setTimeout(r, 200))
      return { stdout: 'ok\n', stderr: '', exitCode: 0 }
    })
    const promise = runJs({ code: 'x', timeoutMs: 50, mode: 'shell', onShellCall })
    const spawn = await captureSpawn(control)
    expect(spawn.message.init.mode).toBe('shell')
    const remote = spawn.transfer[0] as MessagePort
    const received: Array<{ type: string; callId?: string; ok?: boolean; data?: unknown; error?: { name: string } }> = []
    remote.onmessage = e => received.push(e.data)
    remote.start()

    remote.postMessage({ type: 'k.call', noun: 'shell', callId: 's1', op: 'run', payload: { command: 'make' } })
    remote.postMessage({ type: 'k.call', noun: 'shell', callId: 's2', op: 'stop', payload: { taskId: 'b1' } })
    await waitFor(() => received.filter(m => m.type === 'k.callResult').length === 2, 2_000)
    expect(onShellCall).toHaveBeenCalledWith('run', { command: 'make' })
    expect(received.find(m => m.callId === 's1')).toMatchObject({
      ok: true,
      data: { stdout: 'ok\n', stderr: '', exitCode: 0 },
    })
    expect(received.find(m => m.callId === 's2')).toMatchObject({
      ok: false,
      error: { name: 'NotFoundError' },
    })
    remote.postMessage({ type: 'k.done', result: 'done' })
    await expect(promise).resolves.toMatchObject({ result: 'done' })
    remote.close()
  })

  it('omits mode from the spawn when the caller did not set it (SuperEdit)', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 1_000 })
    const spawn = await captureSpawn(control)
    expect('mode' in spawn.message.init).toBe(false)
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({ type: 'k.done', result: null })
    await promise
    remote.close()
  })

  it('reports commands unavailable when no onShellCall is provided', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 1_000 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    const received: Array<{ type: string; ok?: boolean; error?: { name: string } }> = []
    remote.onmessage = e => received.push(e.data)
    remote.start()
    remote.postMessage({ type: 'k.call', noun: 'shell', callId: 's1', op: 'run', payload: { command: 'ls' } })
    await waitFor(() => received.some(m => m.type === 'k.callResult'))
    expect(received.find(m => m.type === 'k.callResult')).toMatchObject({
      ok: false,
      error: { name: 'NotSupportedError' },
    })
    remote.postMessage({ type: 'k.done', result: null })
    await promise
    remote.close()
  })

  it('reports workspace unavailable when no onFsCall is provided', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 1_000 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    const received: Array<{ type: string; ok?: boolean; error?: { name: string } }> = []
    remote.onmessage = e => received.push(e.data)
    remote.start()

    remote.postMessage({ type: 'k.call', noun: 'fs', callId: 'f1', op: 'stat', payload: { path: 'a' } })
    await waitFor(() => received.some(m => m.type === 'k.callResult'))
    expect(received.find(m => m.type === 'k.callResult')).toMatchObject({
      ok: false,
      error: { name: 'NotSupportedError' },
    })
    remote.postMessage({ type: 'k.done', result: null })
    await promise
    remote.close()
  })

  it('attaches streamed logs to a script-error rejection', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 1_000 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({ type: 'k.log', level: 'log', text: 'step 1' })
    remote.postMessage({ type: 'k.error', message: 'boom' })

    const err = await promise.then(
      () => null,
      e => e as RunJsFailure,
    )
    expect(err).toBeInstanceOf(RunJsFailure)
    expect(err?.message).toBe('boom')
    expect(err?.logs).toEqual([{ level: 'log', text: 'step 1' }])
    remote.close()
  })

  it('carries the script error name onto the rejection as `scriptErrorName`', async () => {
    // `RunJsFailure.name` is this class's own name, so the SCRIPT error's name
    // needs a field of its own or it is lost exactly where SuperEdit reads it.
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 1_000 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({
      type: 'k.error',
      message: 'Invalid or unexpected token',
      name: 'SyntaxError',
      parseFailed: true,
    })

    const err = await promise.then(
      () => null,
      e => e as RunJsFailure,
    )
    expect(err?.scriptErrorName).toBe('SyntaxError')
    expect(err?.scriptParseFailed).toBe(true)
    // The two names stay separate — the class's own is untouched.
    expect(err?.name).toBe('RunJsFailure')
    remote.close()
  })

  it('leaves `scriptErrorName` undefined when the worker sent no name', async () => {
    // Additive + optional on the protocol: an older worker must read as
    // unclassified, not as a parse failure.
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const promise = runJs({ code: 'x', timeoutMs: 1_000 })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({ type: 'k.error', message: 'boom' })

    const err = await promise.then(
      () => null,
      e => e as RunJsFailure,
    )
    expect(err?.scriptErrorName).toBeUndefined()
    expect(err?.scriptParseFailed).toBe(false)
    remote.close()
  })

  it('attaches the logs streamed so far to a timeout rejection', async () => {
    const control = makeStubControlPort()
    setRunJsControlPort(control as unknown as MessagePort)
    const seen: unknown[] = []
    const promise = runJs({
      code: 'x',
      timeoutMs: 300,
      onLog: line => seen.push(line),
    })
    const spawn = await captureSpawn(control)
    const remote = spawn.transfer[0] as MessagePort
    remote.postMessage({ type: 'k.log', level: 'log', text: 'made it here' })
    // Ensure the line is delivered before the timeout fires, then never finish.
    await waitFor(() => seen.length === 1)
    const err = await promise.then(
      () => null,
      e => e as RunJsFailure,
    )
    expect(err?.message).toMatch(/timed out/)
    expect(err?.logs).toEqual([{ level: 'log', text: 'made it here' }])
    remote.close()
  })

  it('fails fast when the spawn is never acknowledged (dead control port)', async () => {
    vi.useFakeTimers()
    try {
      const control = makeStubControlPort()
      setRunJsControlPort(control as unknown as MessagePort)
      // Stub postMessage is synchronous, so the spawn is posted before runJs
      // returns — no waitFor needed (waitFor would stall under fake timers).
      const promise = runJs({ code: 'x', timeoutMs: 600_000 })
      expect(control.posts.some(p => p.message.type === 'worker.spawn')).toBe(true)
      vi.advanceTimersByTime(SPAWN_ACK_TIMEOUT_MS + 1)
      await expect(promise).rejects.toThrow(/did not respond/)
      // The failed run still asks the window to reclaim the worker slot.
      expect(control.posts.some(p => p.message.type === 'worker.terminate')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spawn ack clears the fast-fail deadline and the run completes', async () => {
    vi.useFakeTimers()
    let remote: MessagePort | null = null
    try {
      const control = makeStubControlPort()
      setRunJsControlPort(control as unknown as MessagePort)
      const promise = runJs({ code: 'x', timeoutMs: 600_000 })
      const spawn = control.posts.find(p => p.message.type === 'worker.spawn')!
      const key = (spawn.message as { key: string }).key
      control.onmessage?.({
        data: { type: 'worker.spawned', key },
      } as MessageEvent)
      vi.advanceTimersByTime(SPAWN_ACK_TIMEOUT_MS + 1)
      // Had the deadline fired, the later done would be ignored and this await
      // would reject.
      vi.useRealTimers()
      remote = spawn.transfer[0] as MessagePort
      remote.postMessage({ type: 'k.done', result: 'ok' })
      await expect(promise).resolves.toMatchObject({ result: 'ok' })
    } finally {
      vi.useRealTimers()
      remote?.close()
    }
  })
})
