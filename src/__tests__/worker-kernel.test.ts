/**
 * The isolated-worker kernel without the run_js profile: a run's noun table is closed, a failure carries its detail,
 * the worker client is sugar over one `call` primitive. run_js behaviour: run-js-broker / run-js-worker-core tests.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  KernelRunFailure,
  isKernelAvailable,
  resetKernelForTests,
  runOnce,
  setKernelControlPort,
  type KernelRunOptions,
} from '../browser/workerKernel/IsolatedWorkerKernel'
import { createKernelWorkerClient } from '../browser/workerKernel/kernelWorkerClient'

/** Poll until `predicate` holds — MessageChannel delivery is a macrotask. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  if (!predicate()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

type ControlPost = {
  message: { type: string; key?: string; kind?: string; init?: unknown }
  transfer: unknown[]
}

/**
 * Stand-in for the window's end of the control channel (the same stub
 * `run-js-broker.test.ts` uses): capturing `postMessage` keeps the transferred
 * data port live and usable in the test as the WORKER side, sidestepping
 * node-vs-browser `event.ports` transfer differences.
 */
function makeStubControlPort() {
  return {
    onmessage: null as ((e: MessageEvent) => void) | null,
    posts: [] as ControlPost[],
    start() {},
    postMessage(message: unknown, transfer: unknown[] = []) {
      this.posts.push({ message: message as ControlPost['message'], transfer })
    },
  }
}

async function start(
  opts: Partial<KernelRunOptions> = {},
): Promise<{
  control: ReturnType<typeof makeStubControlPort>
  run: Promise<unknown>
  spawn: ControlPost
  worker: MessagePort
}> {
  const control = makeStubControlPort()
  setKernelControlPort(control as unknown as MessagePort)
  const run = runOnce({
    kind: 'probe',
    init: { hello: 'world' },
    timeoutMs: 5_000,
    label: 'probe_run',
    nouns: {},
    ...opts,
  })
  // A rejection is asserted by the test that expects one; never unhandled.
  run.catch(() => {})
  await waitFor(() => control.posts.some(p => p.message.type === 'worker.spawn'))
  const spawn = control.posts.find(p => p.message.type === 'worker.spawn')!
  return { control, run, spawn, worker: spawn.transfer[0] as MessagePort }
}

/** Collect everything the kernel sends the worker. */
function listen(worker: MessagePort): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = []
  worker.onmessage = e => received.push(e.data as Record<string, unknown>)
  worker.start()
  return received
}

afterEach(() => resetKernelForTests())

describe('IsolatedWorkerKernel', () => {
  it('is unavailable until a control port is attached, and says so under the run label', async () => {
    expect(isKernelAvailable()).toBe(false)
    await expect(
      runOnce({ kind: 'probe', init: null, timeoutMs: 1_000, label: 'probe_run', nouns: {} }),
    ).rejects.toThrow(/^probe_run is unavailable/)
  })

  it('spawns the profile kind with its init verbatim, keyed by kind', async () => {
    const { spawn, worker, run } = await start({ init: { code: 'x', n: [1, 2] } })
    expect(spawn.message.kind).toBe('probe')
    expect(spawn.message.init).toEqual({ code: 'x', n: [1, 2] })
    expect(spawn.message.key).toMatch(/^probe-\d+-\d+$/)
    worker.postMessage({ type: 'k.done', result: null })
    await expect(run).resolves.toEqual({ result: null, logs: [] })
  })

  it('routes a call to the noun its run granted', async () => {
    const calls: Array<[string, unknown]> = []
    const { worker, run } = await start({
      nouns: {
        math: async (op, payload) => {
          calls.push([op, payload])
          return (payload.a as number) + (payload.b as number)
        },
      },
    })
    const received = listen(worker)
    worker.postMessage({ type: 'k.call', callId: 'c1', noun: 'math', op: 'add', payload: { a: 2, b: 3 } })
    await waitFor(() => received.length === 1)
    expect(received[0]).toEqual({ type: 'k.callResult', callId: 'c1', ok: true, data: 5 })
    expect(calls).toEqual([['add', { a: 2, b: 3 }]])
    worker.postMessage({ type: 'k.done', result: 'ok' })
    await run
  })

  it('refuses a noun the run did not grant — the table is closed', async () => {
    let served = 0
    const { worker, run } = await start({
      nouns: { math: async () => ++served },
    })
    const received = listen(worker)
    worker.postMessage({ type: 'k.call', callId: 'c1', noun: 'fs', op: 'readFile', payload: {} })
    await waitFor(() => received.length === 1)
    expect(received[0]).toEqual({
      type: 'k.callResult',
      callId: 'c1',
      ok: false,
      error: { name: 'NotSupportedError', message: 'fs is not available in this run.' },
    })
    expect(served).toBe(0)
    worker.postMessage({ type: 'k.done', result: null })
    await run
  })

  it('refuses a noun present in the table but given no handler, with the profile message', async () => {
    const { worker, run } = await start({
      nouns: { shell: undefined },
      unavailable: noun => `no ${noun} here`,
    })
    const received = listen(worker)
    worker.postMessage({ type: 'k.call', callId: 'c1', noun: 'shell', op: 'run', payload: {} })
    await waitFor(() => received.length === 1)
    expect(received[0]).toMatchObject({
      ok: false,
      error: { name: 'NotSupportedError', message: 'no shell here' },
    })
    worker.postMessage({ type: 'k.done', result: null })
    await run
  })

  it('never resolves a noun through the prototype chain', async () => {
    // `nouns` is a plain object: without the own-property check `constructor`
    // would resolve to `Object` and `toString` to a function, and the kernel
    // would CALL them with worker-supplied arguments.
    const { worker, run } = await start({ nouns: { math: async () => 1 } })
    const received = listen(worker)
    for (const [i, noun] of ['constructor', 'toString', '__proto__', 'hasOwnProperty'].entries()) {
      worker.postMessage({ type: 'k.call', callId: `c${i}`, noun, op: 'x', payload: {} })
    }
    await waitFor(() => received.length === 4)
    for (const reply of received) {
      expect(reply).toMatchObject({ ok: false, error: { name: 'NotSupportedError' } })
    }
    worker.postMessage({ type: 'k.done', result: null })
    await run
  })

  it("carries a handler rejection's name and message back to the worker", async () => {
    const { worker, run } = await start({
      nouns: {
        fs: async () => {
          const err = new Error('nope')
          err.name = 'NotAllowedError'
          throw err
        },
      },
    })
    const received = listen(worker)
    worker.postMessage({ type: 'k.call', callId: 'c1', noun: 'fs', op: 'writeFile', payload: {} })
    await waitFor(() => received.length === 1)
    expect(received[0]).toEqual({
      type: 'k.callResult',
      callId: 'c1',
      ok: false,
      error: { name: 'NotAllowedError', message: 'nope' },
    })
    worker.postMessage({ type: 'k.done', result: null })
    await run
  })

  it('rejects a worker throw as a KernelRunFailure carrying its detail and the logs so far', async () => {
    const { worker, run } = await start()
    worker.postMessage({ type: 'k.log', level: 'log', text: 'step 1' })
    worker.postMessage({
      type: 'k.error',
      message: 'boom',
      name: 'TypeError',
      parseFailed: true,
      stack: 'TypeError: boom\n    at <anonymous>:3:7',
      line: 3,
      column: 7,
    })
    const err = (await run.then(
      () => null,
      e => e,
    )) as KernelRunFailure
    expect(err).toBeInstanceOf(KernelRunFailure)
    expect(err.message).toBe('boom')
    expect(err.errorName).toBe('TypeError')
    expect(err.parseFailed).toBe(true)
    expect(err.location).toEqual({ line: 3, column: 7 })
    expect(err.remoteStack).toContain('<anonymous>:3:7')
    expect(err.logs).toEqual([{ level: 'log', text: 'step 1' }])
  })

  it('names the run by its label when it times out, and asks the window to terminate by key', async () => {
    const { control, worker, run, spawn } = await start({ timeoutMs: 20 })
    worker.postMessage({ type: 'k.started' })
    await expect(run).rejects.toThrow('probe_run timed out after 20ms.')
    const terminate = control.posts.find(p => p.message.type === 'worker.terminate')
    expect(terminate?.message.key).toBe(spawn.message.key)
  })

  it('fails fast on a worker.error the window reports for THIS key only', async () => {
    const { control, run, spawn } = await start()
    control.onmessage?.({
      data: { type: 'worker.error', key: 'probe-999-0', message: 'someone else' },
    } as MessageEvent)
    control.onmessage?.({
      data: { type: 'worker.error', key: spawn.message.key, message: 'chunk failed to load' },
    } as MessageEvent)
    await expect(run).rejects.toThrow('probe_run worker error: chunk failed to load')
  })
})

describe('createKernelWorkerClient', () => {
  /** The client on port1; the test plays the kernel on port2. */
  function wire() {
    const channel = new MessageChannel()
    const sent: Array<Record<string, unknown>> = []
    channel.port2.onmessage = e => sent.push(e.data as Record<string, unknown>)
    channel.port2.start()
    return { client: createKernelWorkerClient(channel.port1), kernel: channel.port2, sent }
  }

  it('numbers call ids per noun and resolves each with its own result', async () => {
    const { client, kernel, sent } = wire()
    const a = client.call('fs', 'stat', { path: 'a' })
    const b = client.call('shell', 'run', { command: 'ls' })
    const c = client.call('fs', 'readFile', { path: 'b' })
    await waitFor(() => sent.length === 3)
    expect(sent.map(m => [m.type, m.callId, m.noun, m.op])).toEqual([
      ['k.call', 'fs-1', 'fs', 'stat'],
      ['k.call', 'shell-1', 'shell', 'run'],
      ['k.call', 'fs-2', 'fs', 'readFile'],
    ])
    kernel.postMessage({ type: 'k.callResult', callId: 'fs-2', ok: true, data: 'C' })
    kernel.postMessage({ type: 'k.callResult', callId: 'shell-1', ok: true, data: 'B' })
    kernel.postMessage({ type: 'k.callResult', callId: 'fs-1', ok: true, data: 'A' })
    await expect(Promise.all([a, b, c])).resolves.toEqual(['A', 'B', 'C'])
  })

  it('shapes a failure with the profile mapper, and with a named Error by default', async () => {
    const { client, kernel, sent } = wire()
    class Shaped extends Error {}
    const mapped = client.call('fs', 'stat', {}, e => new Shaped(`${e.name}:${e.message}`))
    const plain = client.call('shell', 'run', {})
    const bare = client.call('shell', 'stop', {})
    mapped.catch(() => {})
    plain.catch(() => {})
    bare.catch(() => {})
    await waitFor(() => sent.length === 3)
    kernel.postMessage({
      type: 'k.callResult',
      callId: 'fs-1',
      ok: false,
      error: { name: 'NotFoundError', message: 'gone' },
    })
    kernel.postMessage({
      type: 'k.callResult',
      callId: 'shell-1',
      ok: false,
      error: { name: 'AbortError', message: 'stopped' },
    })
    kernel.postMessage({ type: 'k.callResult', callId: 'shell-2', ok: false })
    await expect(mapped).rejects.toBeInstanceOf(Shaped)
    await expect(mapped).rejects.toThrow('NotFoundError:gone')
    await expect(plain).rejects.toMatchObject({ name: 'AbortError', message: 'stopped' })
    await expect(bare).rejects.toMatchObject({ name: 'Error', message: 'shell call failed' })
  })

  it('reports through started / log / done / error frames', async () => {
    const { client, sent } = wire()
    client.started()
    client.log('warn', 'careful')
    client.done('42')
    client.error({ message: 'boom', name: 'TypeError', line: 2, column: 5 })
    await waitFor(() => sent.length === 4)
    expect(sent).toEqual([
      { type: 'k.started' },
      { type: 'k.log', level: 'warn', text: 'careful' },
      { type: 'k.done', result: '42' },
      { type: 'k.error', message: 'boom', name: 'TypeError', line: 2, column: 5 },
    ])
  })

  it('drain waits for a helper CHAIN, not just the calls in flight when it was asked', async () => {
    const { client, kernel, sent } = wire()
    // Answer every call a turn later, like the kernel does.
    kernel.onmessage = e => {
      const msg = e.data as { type: string; callId: string }
      sent.push(msg)
      if (msg.type === 'k.call') {
        setTimeout(() => kernel.postMessage({ type: 'k.callResult', callId: msg.callId, ok: true, data: null }), 5)
      }
    }
    // An un-awaited read-then-write: the write is only issued once the read lands.
    void client.call('fs', 'readFile', {}).then(() => client.call('fs', 'writeFile', {}))
    const atCall = await client.drain()
    expect(atCall).toBe(1)
    expect(sent.filter(m => m.type === 'k.call').map(m => m.op)).toEqual(['readFile', 'writeFile'])
    // Nothing outstanding any more: a second drain is immediate and counts zero.
    await expect(client.drain()).resolves.toBe(0)
  })

  it('rejectPending rejects what is still pending, per noun, and ignores a late result', async () => {
    const { client, kernel, sent } = wire()
    const fs = client.call('fs', 'stat', {})
    const shell = client.call('shell', 'run', {})
    fs.catch(() => {})
    shell.catch(() => {})
    await waitFor(() => sent.length === 2)
    client.rejectPending(noun => new Error(`finished before ${noun}`))
    await expect(fs).rejects.toThrow('finished before fs')
    await expect(shell).rejects.toThrow('finished before shell')
    // A result for a call that was already rejected reaches nobody.
    kernel.postMessage({ type: 'k.callResult', callId: 'fs-1', ok: true, data: 'late' })
    await new Promise(r => setTimeout(r, 20))
  })
})

describe('kernel ⇄ worker client, end to end', () => {
  it('runs a profile-less worker: nested call, log, result', async () => {
    const { worker, run } = await start({
      nouns: { kv: async (op, payload) => `${op}:${String(payload.key)}` },
    })
    // The transferred port IS the worker's peer.
    const client = createKernelWorkerClient(worker)
    client.started()
    const value = await client.call('kv', 'get', { key: 'a' })
    client.log('log', `got ${String(value)}`)
    await expect(client.call('nope', 'x', {})).rejects.toMatchObject({ name: 'NotSupportedError' })
    client.done(String(value))
    await expect(run).resolves.toEqual({
      result: 'get:a',
      logs: [{ level: 'log', text: 'got get:a' }],
    })
  })
})
