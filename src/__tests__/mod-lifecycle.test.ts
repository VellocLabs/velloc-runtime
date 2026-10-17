/**
 * A mod's life in a session slot: `session.end`, and what happens when its
 * worker dies or stops answering.
 *
 * Real module text, loaded by `ModWorkerHost` on a MessageChannel, as in
 * `mod-runtime.test.ts`. A "crash" is the kernel's `closed` promise settling
 * `crashed`; a stuck worker is a hook that never answers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import {
  MOD_RESPAWN_BACKOFF_MS,
  MOD_SESSION_END_TIMEOUT_MS,
  ModRuntime,
  type ModModuleRef,
  type ModWorkerHandle,
} from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

type Worker = ModWorkerHandle & { crash(message?: string): void; closedCalls: number }

function world(
  sources: Record<string, string>,
  options: {
    budgetMs?: number
    lingerMs?: number
    endTimeoutMs?: number
    respawnBackoffMs?: readonly number[]
    /** Replaces a module's text from its nth load on (1-based). */
    sourceAt?: (path: string, load: number) => string | undefined
    /** How many times a plugin's worker cannot be opened before it can. */
    failOpen?: Record<string, number>
    /** Holds a module's nth read (1-based) until the returned promise settles. */
    holdRead?: (path: string, load: number) => Promise<void> | undefined
    /** Whether a plugin's nth worker (1-based) dies as soon as it is opened. */
    crashAtOpen?: (plugin: string, spawn: number) => boolean
  } = {},
) {
  const reports: string[] = []
  /** Every worker a plugin was given, oldest first. */
  const workers: Record<string, Worker[]> = {}
  const loads: Record<string, number> = {}
  const session = { id: 'session-1' }
  const failOpen = { ...(options.failOpen ?? {}) }
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({
    plugin: path.split('/')[0]!,
    path,
  }))
  const runtime = new ModRuntime({
    modules,
    readModule: async path => {
      loads[path] = (loads[path] ?? 0) + 1
      await options.holdRead?.(path, loads[path]!)
      const source = options.sourceAt?.(path, loads[path]!) ?? sources[path]!
      // A real worker is a new realm per spawn. Here every "worker" imports
      // its `data:` module into THIS realm, where identical text is one cached
      // module — so each load gets text of its own.
      return `${source}
// load ${++uniqueLoad}`
    },
    openWorker: async plugin => {
      const left = failOpen[plugin] ?? 0
      if (left > 0) {
        failOpen[plugin] = left - 1
        throw new Error(`mod ${plugin} could not start: the execution window did not respond`)
      }
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed'; message?: string }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed'; message?: string }>(resolve => {
        settle = resolve
      })
      const worker: Worker = {
        port: channel.port1,
        closed,
        closedCalls: 0,
        close() {
          worker.closedCalls += 1
          settle({ reason: 'closed' })
        },
        crash(message) {
          settle({ reason: 'crashed', ...(message ? { message } : {}) })
        },
      }
      ;(workers[plugin] ??= []).push(worker)
      if (options.crashAtOpen?.(plugin, workers[plugin]!.length)) worker.crash('gone at open')
      return worker
    },
    session: { id: () => session.id, cwd: () => '/work/project' },
    report: line => reports.push(line),
    respawnBackoffMs: options.respawnBackoffMs ?? [10],
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
    ...(options.lingerMs !== undefined ? { lingerMs: options.lingerMs } : {}),
    ...(options.endTimeoutMs !== undefined ? { endTimeoutMs: options.endTimeoutMs } : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports, workers, session }
}

/** A module that counts, in a variable of its own, how often each event
 *  reached it — and reports the counts in the prompt it passes on. */
const COUNTER = `
  let starts = 0
  let prompts = 0
  export function register(on) {
    on('session.start', ($, e, next) => { starts += 1; return next(e) })
    on('prompt.submit', ($, e, next) => {
      prompts += 1
      return next({ ...e, text: e.text + ' starts=' + starts + ' prompts=' + prompts })
    })
  }
`

describe('the constants are the declaration\'s', () => {
  it('session.end shares one 1.5 s bound; restarts back off 1 s, 5 s, 30 s', () => {
    expect(MOD_SESSION_END_TIMEOUT_MS).toBe(1_500)
    expect(MOD_RESPAWN_BACKOFF_MS).toEqual([1_000, 5_000, 30_000])
    expect(RAISED_EVENTS).toContain('session.end')
  })
})

describe('session.end', () => {
  it('a hook sees the reason, the ending session\'s id and how to resume it; core echoes the id', async () => {
    const { runtime, reports } = world({
      'log/hooks/register.js': `
        export function register(on) {
          on('session.end', async ($, e, next) => {
            const ended = await next(e)
            await $.ui.log('end ' + JSON.stringify(e) + ' -> ' + JSON.stringify(ended))
            return ended
          })
        }
      `,
    })
    await runtime.ready
    await runtime.sessionEnd('clear')
    expect(reports).toEqual([
      'log: end {"reason":"clear","sessionId":"session-1","resume":{"id":"session-1"}} -> {"sessionId":"session-1"}',
    ])
  })

  it('a /clear keeps the module: its variables go on, and no session.start fires for it', async () => {
    const { runtime, workers } = world({ 'count/hooks/register.js': COUNTER })
    await runtime.ready
    await expect(runtime.promptSubmit('a')).resolves.toMatchObject({ text: 'a starts=1 prompts=1' })
    await runtime.sessionEnd('clear')
    await expect(runtime.promptSubmit('b')).resolves.toMatchObject({ text: 'b starts=1 prompts=2' })
    expect(workers.count).toHaveLength(1)
    expect(workers.count![0]!.closedCalls).toBe(0)
  })

  it('is one short wall-clock bound for the whole chain: a hook that hangs does not hold the exit', async () => {
    const { runtime, reports } = world(
      {
        'hang/hooks/register.js': `
          export function register(on) { on('session.end', () => new Promise(() => {})) }
        `,
      },
      { endTimeoutMs: 60 },
    )
    await runtime.ready
    const began = Date.now()
    await runtime.sessionEnd('other')
    expect(Date.now() - began).toBeLessThan(1_000)
    expect(reports).toEqual([
      'mods: session.end did not finish within 60ms; the session ends without waiting',
    ])
  })

  it('next.budget at session.end reads the shared bound, not the ordinary budget', async () => {
    const { runtime, reports } = world(
      {
        'reads/hooks/register.js': `
          export function register(on) {
            on('session.end', async ($, e, next) => {
              await $.ui.log('budget ' + next.budget.ms)
              return next(e)
            })
          }
        `,
      },
      { endTimeoutMs: 60 },
    )
    await runtime.ready
    await runtime.sessionEnd('other')
    expect(reports).toContain('reads: budget 60')
  })

  it('a hook that throws there is skipped and the session still ends', async () => {
    const { runtime } = world({
      'bad/hooks/register.js': `
        export function register(on) { on('session.end', () => { throw new Error('no') }) }
      `,
    })
    await runtime.ready
    await expect(runtime.sessionEnd('other')).resolves.toBeUndefined()
  })

  it('costs nothing when no hook is on it', async () => {
    const { runtime, reports } = world({ 'count/hooks/register.js': COUNTER })
    await runtime.ready
    await runtime.sessionEnd('clear')
    expect(reports).toEqual([])
  })

  it('end(): session.end first, then the workers are closed — once', async () => {
    const { runtime, reports, workers } = world({
      'log/hooks/register.js': `
        export function register(on) {
          on('session.end', async ($, e, next) => { await $.ui.log('bye ' + e.reason); return next(e) })
        }
      `,
    })
    await runtime.ready
    await runtime.end()
    await runtime.end('clear')
    expect(reports).toEqual(['log: bye other'])
    expect(workers.log![0]!.closedCalls).toBe(1)
    expect(runtime.dispatcher.hasHooksFor('session.end')).toBe(false)
  })
})

describe('a worker that dies is restarted', () => {
  it('at the next generation, with session.start for it again and its variables started over', async () => {
    const { runtime, reports, workers } = world({ 'count/hooks/register.js': COUNTER })
    await runtime.ready
    await runtime.promptSubmit('a')
    await expect(runtime.promptSubmit('b')).resolves.toMatchObject({ text: 'b starts=1 prompts=2' })

    workers.count![0]!.crash('Uncaught RangeError')
    await until(() => runtime.status()[0]!.state === 'crashed')
    expect(runtime.status()[0]).toMatchObject({
      state: 'crashed',
      reason: 'its worker is gone (Uncaught RangeError)',
      generation: 1,
    })
    // Meanwhile a prompt does not wait on a worker that is not there; its
    // hook cannot be handed it, so it is refused.
    await expect(runtime.promptSubmit('c')).resolves.toEqual({
      entered: false,
      reason: "count's hook on prompt.submit could not answer (its hooks worker is restarting)",
      unreachable: 'count',
    })

    await until(() => runtime.status()[0]!.state === 'loaded')
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', generation: 2 })
    expect(workers.count).toHaveLength(2)
    // The dead worker was closed; the new one is a different worker.
    expect(workers.count![0]!.closedCalls).toBe(1)
    await until(() => reports.some(line => line.includes('was restarted')))
    // A fresh module: session.start reached it again, its counters are new.
    await expect(runtime.promptSubmit('d')).resolves.toMatchObject({ text: 'd starts=1 prompts=1' })
    expect(reports).toEqual([
      'count: the hooks module stopped — its worker is gone (Uncaught RangeError); restarting it in 10ms',
      'count: the hooks module was restarted (generation 2)',
    ])
  })

  it('session.start after a restart runs the restarted module\'s hooks alone', async () => {
    const { runtime, workers } = world({
      'count/hooks/register.js': COUNTER,
      'fragile/hooks/register.js': `
        export function register(on) { on('session.start', ($, e, next) => next(e)) }
      `,
    })
    await runtime.ready
    workers.fragile![0]!.crash()
    await until(() => workers.fragile!.length === 2 && runtime.status()[1]!.state === 'loaded')
    await sleep(30)
    // `count` saw exactly one session.start: the slot's own.
    await expect(runtime.promptSubmit('a')).resolves.toMatchObject({ text: 'a starts=1 prompts=1' })
  })

  it('comes back in the seat it had: the chain order does not change', async () => {
    const tag = (name: string) => `
      export function register(on) {
        on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + '${name}' }))
      }
    `
    const { runtime, workers } = world({
      'a/hooks/register.js': tag('A'),
      'b/hooks/register.js': tag('B'),
      'c/hooks/register.js': tag('C'),
    })
    await runtime.ready
    await expect(runtime.promptSubmit('>')).resolves.toMatchObject({ text: '>ABC' })
    workers.a![0]!.crash()
    await until(() => runtime.status()[0]!.state === 'crashed')
    // Its seat holds: the prompt stops there, refused, until it is back.
    await expect(runtime.promptSubmit('>')).resolves.toMatchObject({ entered: false })
    await until(() => runtime.status()[0]!.state === 'loaded')
    // Outermost again, not appended after C.
    await expect(runtime.promptSubmit('>')).resolves.toMatchObject({ text: '>ABC' })
  })

  it('a module hooking every event comes back: its own seat does not judge its restart at plugin.register', async () => {
    const { runtime, reports, workers } = world({
      'logger/hooks/register.js': `
        export function register(on) { on('*', ($, e, next) => next(e)) }
      `,
      'count/hooks/register.js': COUNTER,
    })
    await runtime.ready
    workers.logger![0]!.crash()
    await until(() => runtime.status()[0]!.state === 'crashed')
    await until(() => runtime.status()[0]!.state !== 'crashed')
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', generation: 2 })
    expect(reports.filter(line => line.includes('refused'))).toEqual([])
  })

  it('a restart whose new worker dies while loading keeps the seat refusing until it is back', async () => {
    const { runtime, workers } = world(
      { 'count/hooks/register.js': COUNTER },
      { respawnBackoffMs: [10, 2_000], crashAtOpen: (_plugin, spawn) => spawn === 2 },
    )
    await runtime.ready
    workers.count![0]!.crash()
    await until(() => workers.count!.length === 2)
    await sleep(30)
    expect(runtime.status()[0]!.state).not.toBe('loaded')
    // The seat's stand-ins outlive the failed load: the prompt is refused,
    // not let past the hook.
    await expect(runtime.promptSubmit('a')).resolves.toMatchObject({ entered: false, unreachable: 'count' })
  })

  it('reads the module again: a restart loads what is on disk now', async () => {
    const { runtime, workers } = world(
      {
        'm/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: 'v1' })) }`,
      },
      {
        sourceAt: (_path, load) =>
          load >= 2
            ? `export function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: 'v2' })) }`
            : undefined,
      },
    )
    await runtime.ready
    workers.m![0]!.crash()
    await until(() => runtime.status()[0]!.generation === 2 && runtime.status()[0]!.state === 'loaded')
    await expect(runtime.promptSubmit('x')).resolves.toMatchObject({ text: 'v2' })
  })

  it('a module that no longer loads at its restart is reported and stays off', async () => {
    const { runtime, reports, workers } = world(
      { 'm/hooks/register.js': COUNTER },
      { sourceAt: (_path, load) => (load >= 2 ? `export const nothing = 1` : undefined) },
    )
    await runtime.ready
    workers.m![0]!.crash()
    await until(() => runtime.status()[0]!.state === 'failed')
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(false)
    expect(reports.at(-1)).toMatch(/^m: the hooks module was not loaded — /)
    await sleep(40)
    expect(workers.m).toHaveLength(2)
  })

  it('a plugin switched off while its restart is loading stays off, its new worker closed', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let restartReading = false
    const { runtime, workers } = world(
      { 'count/hooks/register.js': COUNTER },
      {
        holdRead: (_path, load) => {
          if (load !== 2) return undefined
          restartReading = true
          return held
        },
      },
    )
    await runtime.ready
    workers.count![0]!.crash()
    await until(() => restartReading)
    await runtime.reconcile([])
    release()
    await sleep(40)
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(false)
    expect(runtime.status()).toEqual([])
    expect(workers.count!.every(worker => worker.closedCalls > 0)).toBe(true)
    await expect(runtime.promptSubmit('x')).resolves.toMatchObject({ text: 'x' })
  })

  it('a reload while its restart is loading leaves one live worker, the reload\'s', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let restartReading = false
    const { runtime, workers } = world(
      { 'count/hooks/register.js': COUNTER },
      {
        holdRead: (_path, load) => {
          if (load !== 2) return undefined
          restartReading = true
          return held
        },
      },
    )
    await runtime.ready
    workers.count![0]!.crash()
    await until(() => restartReading)
    // The reload reads the file afresh (load 3) and loads it.
    const reloading = runtime.reload()
    await until(() => (workers.count?.length ?? 0) >= 2)
    release()
    await reloading
    await sleep(40)
    const live = workers.count!.filter(worker => worker.closedCalls === 0)
    expect(live).toHaveLength(1)
    await expect(runtime.promptSubmit('a')).resolves.toMatchObject({ text: 'a starts=1 prompts=1' })
  })

  it('a worker lost while its restart\'s session.start runs is reported once, as the loss', async () => {
    const { runtime, reports, workers } = world(
      { 'count/hooks/register.js': COUNTER },
      {
        // From the restart on, session.start is still running when the worker goes.
        sourceAt: (_path, load) =>
          load < 2 ? undefined : `export function register(on) { on('session.start', () => new Promise(() => {})) }`,
      },
    )
    await runtime.ready
    workers.count![0]!.crash()
    await until(() => runtime.status()[0]!.state === 'loaded' && runtime.status()[0]!.generation === 2)
    await sleep(20)
    workers.count![1]!.crash('mid-start')
    await until(() => runtime.status()[0]!.state === 'crashed')
    await sleep(20)
    expect(reports.slice(0, 3)).toEqual([
      'count: the hooks module stopped — its worker is gone; restarting it in 10ms',
      'count: the hooks module was restarted (generation 2)',
      'count: the hooks module stopped — its worker is gone (mid-start); restarting it in 10ms',
    ])
    expect(reports.filter(line => line.includes('session.start'))).toEqual([])
  })

  it('gives up after three restarts within a minute, and says so once', async () => {
    const { runtime, reports, workers } = world({ 'count/hooks/register.js': COUNTER })
    await runtime.ready
    for (let generation = 1; generation <= 3; generation++) {
      await until(
        () => runtime.status()[0]!.state === 'loaded' && runtime.status()[0]!.generation === generation,
      )
      workers.count![generation - 1]!.crash()
      await until(() => runtime.status()[0]!.state === 'crashed')
    }
    await until(() => runtime.status()[0]!.state === 'loaded' && runtime.status()[0]!.generation === 4)
    // The fourth death inside the minute is the last.
    workers.count![3]!.crash('again')
    await until(() => runtime.status()[0]!.state === 'dead')
    await sleep(40)
    expect(workers.count).toHaveLength(4)
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(false)
    expect(reports.at(-1)).toBe(
      'count: the hooks module stopped — its worker is gone (again). It was restarted 3 times within a minute and stays off until the session is reloaded',
    )
    await expect(runtime.promptSubmit('x')).resolves.toEqual({ entered: true, text: 'x', context: [] })
  })

  it('waits longer before each restart', async () => {
    const { runtime, reports, workers } = world(
      { 'count/hooks/register.js': COUNTER },
      { respawnBackoffMs: [5, 40] },
    )
    await runtime.ready
    workers.count![0]!.crash()
    await until(() => runtime.status()[0]!.generation === 2 && runtime.status()[0]!.state === 'loaded')
    workers.count![1]!.crash()
    await until(() => runtime.status()[0]!.state === 'crashed')
    await sleep(15)
    // Still waiting out the second, longer delay.
    expect(workers.count).toHaveLength(2)
    await until(() => runtime.status()[0]!.generation === 3 && runtime.status()[0]!.state === 'loaded')
    expect(reports.filter(line => line.includes('restarting it in'))).toEqual([
      'count: the hooks module stopped — its worker is gone; restarting it in 5ms',
      'count: the hooks module stopped — its worker is gone; restarting it in 40ms',
    ])
  })

  it('dispose cancels a pending restart', async () => {
    const { runtime, workers } = world(
      { 'count/hooks/register.js': COUNTER },
      { respawnBackoffMs: [30] },
    )
    await runtime.ready
    workers.count![0]!.crash()
    await until(() => runtime.status()[0]!.state === 'crashed')
    runtime.dispose()
    await sleep(60)
    expect(workers.count).toHaveLength(1)
  })

  it('a worker the runtime closed itself is not restarted', async () => {
    const { runtime, workers } = world({ 'count/hooks/register.js': COUNTER })
    await runtime.ready
    runtime.dispose()
    await sleep(40)
    expect(workers.count).toHaveLength(1)
  })
})

describe('a worker that stops answering is restarted', () => {
  /** Hangs every prompt after the first `good` ones. */
  const stuckAfter = (good: number) => `
    let seen = 0
    export function register(on) {
      on('prompt.submit', ($, e, next) => {
        seen += 1
        return seen > ${good} ? new Promise(() => {}) : next({ ...e, text: e.text + '!' })
      })
    }
  `

  it('three hooks in a row out of time: the worker is terminated and the module loaded again', async () => {
    const { runtime, reports, workers } = world(
      { 'stuck/hooks/register.js': stuckAfter(0) },
      { budgetMs: 30 },
    )
    await runtime.ready
    // Each prompt still enters — a hook out of time is skipped.
    await expect(runtime.promptSubmit('1')).resolves.toMatchObject({ entered: true, text: '1' })
    await expect(runtime.promptSubmit('2')).resolves.toMatchObject({ entered: true, text: '2' })
    expect(workers.stuck![0]!.closedCalls).toBe(0)
    await expect(runtime.promptSubmit('3')).resolves.toMatchObject({ entered: true, text: '3' })
    expect(workers.stuck![0]!.closedCalls).toBe(1)
    expect(reports.at(-1)).toBe(
      'stuck: the hooks module stopped — it stopped answering (3 hooks in a row ran out of time); restarting it in 10ms',
    )
    await until(() => runtime.status()[0]!.state === 'loaded' && runtime.status()[0]!.generation === 2)
    expect(workers.stuck).toHaveLength(2)
  })

  it('a hook still running past the linger bound after its dispatch went on is reported and dropped', async () => {
    const { runtime, reports } = world(
      { 'stuck/hooks/register.js': stuckAfter(0) },
      { budgetMs: 30, lingerMs: 30 },
    )
    await runtime.ready
    await expect(runtime.promptSubmit('1')).resolves.toMatchObject({ entered: true, text: '1' })
    await until(() => reports.some(line => line.includes('after the dispatch went on without it')))
    expect(reports.filter(line => line.includes('after the dispatch went on without it'))).toEqual([
      'stuck: its hook on prompt.submit was still running 30ms after the dispatch went on without it; it is dropped',
    ])
  })

  it('a $ call made after its hook returned keeps the hook\'s frame: it does not raise the hook again', async () => {
    const { runtime, reports } = world({
      'echo/hooks/register.js': `
        let runs = 0
        export function register(on) {
          on('ui.log', ($, e, next) => {
            runs += 1
            if (runs < 50) setTimeout(() => void $.ui.log('again ' + runs).catch(() => {}), 5)
            return next(e)
          })
          on('prompt.submit', async ($, e, next) => {
            if (e.text === 'go') await $.ui.log('start')
            return next({ ...e, text: String(runs) })
          })
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    await sleep(120)
    await expect(runtime.promptSubmit('read')).resolves.toMatchObject({ text: '1' })
    expect(reports).toEqual(['echo: start', 'echo: again 1'])
  })

  it('a hook that answers in between starts the count over', async () => {
    const source = `
      export function register(on) {
        on('prompt.submit', ($, e, next) =>
          e.text === 'slow' ? new Promise(() => {}) : next({ ...e, text: e.text + '!' }))
      }
    `
    const { runtime, workers } = world({ 'm/hooks/register.js': source }, { budgetMs: 30 })
    await runtime.ready
    await runtime.promptSubmit('slow')
    await runtime.promptSubmit('slow')
    await expect(runtime.promptSubmit('fine')).resolves.toMatchObject({ text: 'fine!' })
    await runtime.promptSubmit('slow')
    await runtime.promptSubmit('slow')
    expect(workers.m).toHaveLength(1)
    expect(workers.m![0]!.closedCalls).toBe(0)
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', generation: 1 })
  })

  it('a hook that throws is not a worker that stopped answering', async () => {
    const { runtime, workers } = world(
      {
        'm/hooks/register.js': `export function register(on) { on('prompt.submit', () => { throw new Error('x') }) }`,
      },
      { budgetMs: 30 },
    )
    await runtime.ready
    for (const text of ['1', '2', '3', '4']) await runtime.promptSubmit(text)
    expect(workers.m).toHaveLength(1)
    expect(workers.m![0]!.closedCalls).toBe(0)
  })
})

describe('a worker that could not be started is tried again', () => {
  const tag = (name: string) => `
    export function register(on) {
      on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + '${name}' }))
    }
  `

  it('the module loads at a later attempt — in the seat the list gave it', async () => {
    const { runtime, reports } = world(
      {
        'a/hooks/register.js': tag('A'),
        'b/hooks/register.js': tag('B'),
        'c/hooks/register.js': tag('C'),
      },
      { failOpen: { b: 1 } },
    )
    await runtime.ready
    // The session does not wait for it: the others are in.
    expect(runtime.status().map(state => state.state)).toEqual(['loaded', 'crashed', 'loaded'])
    await expect(runtime.promptSubmit('>')).resolves.toMatchObject({ text: '>AC' })
    await until(() => runtime.status()[1]!.state === 'loaded')
    expect(runtime.status()[1]).toMatchObject({ generation: 2 })
    // Between A and C, where the list put it — not appended after C.
    await expect(runtime.promptSubmit('>')).resolves.toMatchObject({ text: '>ABC' })
    expect(reports[0]).toBe(
      'b: the hooks module stopped — its worker could not be started (mod b could not start: the execution window did not respond); restarting it in 10ms',
    )
  })

  it('a worker that never starts is given up on like any other', async () => {
    const { runtime, reports } = world(
      { 'a/hooks/register.js': tag('A') },
      { failOpen: { a: 99 } },
    )
    await runtime.ready
    await until(() => runtime.status()[0]!.state === 'dead')
    expect(reports.at(-1)).toMatch(/It was restarted 3 times within a minute and stays off/)
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(false)
  })
})
