import { afterEach, describe, expect, it } from 'vitest'
import { runProgramInWorker } from '../browser/runJs/runJsWorkerCore'
import { runProgram } from '../browser/runJs/runProgram'
import { resetRunJsBrokerForTests, RunJsFailure, setRunJsControlPort } from '../browser/runJs/RunJsBroker'
import type { RunJsScriptInit } from '../browser/runJs/runJsProtocol'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  if (!predicate()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

type Msg = {
  type: string
  result?: string | null
  message?: string
  name?: string
  callId?: string
  noun?: string
  op?: string
  payload?: { args?: unknown[] }
  line?: number
  parseFailed?: boolean
  level?: string
  text?: string
}

type Answer = (msg: Msg) => { ok: true; data: unknown } | { ok: false; error: { name: string; message: string } }

/** Drive `runProgramInWorker` over a real MessageChannel; `answer` serves
 *  every `k.call` the script makes. */
function runInWorker(init: Omit<RunJsScriptInit, 'mode'>, answer?: Answer): { got: Msg[]; settled: () => Msg | undefined } {
  const channel = new MessageChannel()
  const got: Msg[] = []
  channel.port2.onmessage = (e: MessageEvent) => {
    const msg = e.data as Msg
    got.push(msg)
    if (msg.type === 'k.call') {
      const reply = answer ? answer(msg) : { ok: true as const, data: null }
      channel.port2.postMessage({ type: 'k.callResult', callId: msg.callId, ...reply })
    }
  }
  channel.port2.start()
  runProgramInWorker({ ...init, mode: 'program' }, channel.port1)
  return { got, settled: () => got.find(m => m.type === 'k.done' || m.type === 'k.error') }
}

async function settle(run: ReturnType<typeof runInWorker>): Promise<Msg> {
  await waitFor(() => run.settled() !== undefined)
  return run.settled()!
}

describe('runProgramInWorker', () => {
  it('binds each noun as a frozen object whose methods round-trip their arguments', async () => {
    const run = runInWorker(
      {
        code: 'return { sum: await calc.add(2, 3), frozen: Object.isFrozen(calc) && Object.isFrozen(calc.add) }',
        programNouns: { calc: ['add'] },
      },
      msg => ({ ok: true, data: (msg.payload!.args as number[]).reduce((a, b) => a + b, 0) }),
    )
    const done = await settle(run)
    expect(done.type).toBe('k.done')
    expect(JSON.parse(done.result!)).toEqual({ sum: 5, frozen: true })
    expect(run.got.find(m => m.type === 'k.call')).toMatchObject({ noun: 'calc', op: 'add', payload: { args: [2, 3] } })
  })

  it('has no surface beyond console, inputs and the named nouns', async () => {
    const run = runInWorker({
      code: 'return [typeof workspace, typeof bash, typeof readTextFile, typeof tools, typeof calc, inputs.x]',
      programNouns: { calc: ['add'] },
      inputs: { x: 7 },
    })
    const done = await settle(run)
    expect(JSON.parse(done.result!)).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'object', 7])
  })

  it('rethrows a refused call with the handler error name', async () => {
    const run = runInWorker(
      { code: 'try { await calc.add(1) } catch (e) { return e.name + ": " + e.message }', programNouns: { calc: ['add'] } },
      () => ({ ok: false, error: { name: 'DeniedError', message: 'not today' } }),
    )
    const done = await settle(run)
    expect(JSON.parse(done.result!)).toBe('DeniedError: not today')
  })

  it('returns JSON text: null for undefined, a quoted string for a string', async () => {
    expect((await settle(runInWorker({ code: 'return undefined', programNouns: {} }))).result).toBeNull()
    expect((await settle(runInWorker({ code: 'return "x"', programNouns: {} }))).result).toBe('"x"')
  })

  it('refuses a return value JSON cannot hold', async () => {
    const error = await settle(runInWorker({ code: 'return 1n', programNouns: {} }))
    expect(error).toMatchObject({ type: 'k.error', name: 'TypeError' })
    expect(error.message).toMatch(/not plain data/)
  })

  it('refuses a noun name the run binds itself, or one that is not an identifier', async () => {
    const reserved = await settle(runInWorker({ code: 'return 1', programNouns: { inputs: ['x'] } }))
    expect(reserved).toMatchObject({ type: 'k.error', name: 'TypeError' })
    const bad = await settle(runInWorker({ code: 'return 1', programNouns: { 'a-b': ['x'] } }))
    expect(bad.message).toMatch(/not an identifier/)
  })

  it('binds each export of the prelude as one more parameter, with the nouns in its scope', async () => {
    const run = runInWorker(
      {
        prelude: 'const twice = async n => (await calc.add(n, n)); return { twice, label: inputs.label }',
        code: 'return [await twice(4), label]',
        programNouns: { calc: ['add'] },
        inputs: { label: 'L' },
      },
      msg => ({ ok: true, data: (msg.payload!.args as number[]).reduce((a, b) => a + b, 0) }),
    )
    expect(JSON.parse((await settle(run)).result!)).toEqual([8, 'L'])
  })

  it('reports script-relative line numbers when a prelude is in front', async () => {
    const run = runInWorker({
      prelude: 'const a = 1\nconst b = 2\nconst c = 3\nreturn { helper: () => a + b + c }',
      code: 'const x = helper()\n\nthrow new Error("third line")',
      programNouns: {},
    })
    expect(await settle(run)).toMatchObject({ type: 'k.error', message: 'third line', line: 3 })
  })

  it('refuses a prelude export that shadows a bound name', async () => {
    const error = await settle(runInWorker({ prelude: 'return { inputs: 1 }', code: 'return 1', programNouns: {} }))
    expect(error.type).toBe('k.error')
    expect(error.message).toMatch(/program prelude failed: .*"inputs"/)
  })

  it('deterministic: the clock and the random source throw; dates from arguments still work', async () => {
    const probe = (expr: string): string =>
      `try { ${expr}; return "ran" } catch (e) { return e.name }`
    for (const expr of ['Date.now()', 'Math.random()', 'new Date()', 'Date()']) {
      const done = await settle(runInWorker({ code: probe(expr), programNouns: {}, deterministic: true }))
      expect([expr, JSON.parse(done.result!)]).toEqual([expr, 'NotSupportedError'])
    }
    const done = await settle(
      runInWorker({
        code: 'const d = new Date(0); return [d instanceof Date, d.toISOString(), Math.floor(2.5), Date.UTC(1970, 0, 1)]',
        programNouns: {},
        deterministic: true,
      }),
    )
    expect(JSON.parse(done.result!)).toEqual([true, '1970-01-01T00:00:00.000Z', 2, 0])
  })

  it('deterministic covers the prelude too, and is off unless asked for', async () => {
    const inPrelude = await settle(
      runInWorker({ prelude: 'const t = Date.now(); return {}', code: 'return 1', programNouns: {}, deterministic: true }),
    )
    expect(inPrelude).toMatchObject({ type: 'k.error', name: 'NotSupportedError' })
    const off = await settle(runInWorker({ code: 'return typeof Date.now()', programNouns: {} }))
    expect(JSON.parse(off.result!)).toBe('number')
  })
})

// ── through the broker: the real kernel, the worker core run in-process ──

function attachInProcessWindow(): void {
  const control = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    start() {},
    postMessage(message: { type: string; init?: RunJsScriptInit }, transfer: unknown[] = []) {
      if (message.type === 'worker.spawn') runProgramInWorker(message.init!, transfer[0] as MessagePort)
    },
  }
  setRunJsControlPort(control as unknown as MessagePort)
}

afterEach(() => resetRunJsBrokerForTests())

describe('runProgram', () => {
  it('serves the script from the caller handlers and parses the value back', async () => {
    attachInProcessWindow()
    const seen: unknown[][] = []
    const run = await runProgram({
      code: 'console.log("go"); return { got: await store.get("k") }',
      nouns: { store: { methods: ['get'], handler: async (_method, args) => (seen.push(args), 'v') } },
      timeoutMs: 1_000,
    })
    expect(run.value).toEqual({ got: 'v' })
    expect(run.logs).toEqual([{ level: 'log', text: 'go' }])
    expect(seen).toEqual([['k']])
  })

  it('builds only the listed methods, and the broker refuses any other before its handler runs', async () => {
    attachInProcessWindow()
    let called = false
    const nouns = { store: { methods: ['get'], handler: async () => ((called = true), null) } }
    expect((await runProgram({ code: 'return typeof store.put', nouns, timeoutMs: 1_000 })).value).toBe('undefined')

    // A worker that sends a call for an unlisted method anyway.
    let remote: MessagePort | undefined
    setRunJsControlPort({
      onmessage: null,
      start() {},
      postMessage(message: { type: string }, transfer: unknown[] = []) {
        if (message.type === 'worker.spawn') remote = transfer[0] as MessagePort
      },
    } as unknown as MessagePort)
    const pending = runProgram({ code: 'x', nouns, timeoutMs: 1_000 })
    await waitFor(() => remote !== undefined)
    const replies: Array<{ type: string; ok?: boolean; error?: { name: string } }> = []
    remote!.onmessage = e => replies.push(e.data)
    remote!.start()
    remote!.postMessage({ type: 'k.call', callId: 'store-1', noun: 'store', op: 'put', payload: { args: [] } })
    await waitFor(() => replies.length > 0)
    expect(replies[0]).toMatchObject({ type: 'k.callResult', ok: false, error: { name: 'NotSupportedError' } })
    expect(called).toBe(false)
    remote!.postMessage({ type: 'k.done', result: null })
    await expect(pending).resolves.toMatchObject({ value: null })
    remote!.close()
  })

  it('refuses a bad noun name before a worker is spent', async () => {
    attachInProcessWindow()
    await expect(
      runProgram({ code: 'return 1', nouns: { Math: { methods: ['x'], handler: async () => null } }, timeoutMs: 1_000 }),
    ).rejects.toThrow(/binds itself/)
  })

  it('a queue kept in the prelude spends none of the clock while calls are in flight', async () => {
    attachInProcessWindow()
    let inFlight = 0
    let peak = 0
    const prelude = [
      'let running = 0; const waiting = []',
      'const acquire = () => running < inputs.limit ? (running++, Promise.resolve()) : new Promise(r => waiting.push(r))',
      'const release = () => { const next = waiting.shift(); next ? next() : running-- }',
      'const work = async n => { await acquire(); try { return await jobs.run(n) } finally { release() } }',
      'return { work }',
    ].join('\n')
    const run = await runProgram({
      prelude,
      code: 'return (await Promise.all(Array.from({ length: 12 }, (_, i) => work(i)))).length',
      inputs: { limit: 3 },
      nouns: {
        jobs: {
          methods: ['run'],
          handler: async () => {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            await new Promise(r => setTimeout(r, 40))
            inFlight -= 1
            return true
          },
        },
      },
      // Four rounds of 40 ms is far past this; only the waits are long.
      timeoutMs: 60,
    })
    expect(run.value).toBe(12)
    expect(peak).toBe(3)
  })

  it('a script throw rejects as RunJsFailure with the script-relative line', async () => {
    attachInProcessWindow()
    const failure = await runProgram({ code: '\nthrow new TypeError("nope")', nouns: {}, timeoutMs: 1_000 }).catch(e => e)
    expect(failure).toBeInstanceOf(RunJsFailure)
    expect(failure).toMatchObject({ message: 'nope', scriptErrorName: 'TypeError', location: { line: 2 } })
  })
})
