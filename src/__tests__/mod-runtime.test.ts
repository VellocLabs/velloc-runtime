/**
 * One session slot's mod runtime, with REAL module text: each "worker" is
 * `ModWorkerHost` on one end of a MessageChannel, and it loads the module the
 * way a real worker does — by importing its text as a `data:` module.
 *
 * What a real worker adds on top (the sandboxed frame, its CSP) is e2e's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { implementedNouns } from '../mods/modNouns'
import { MODS_ABI, RAISED_EVENTS } from '../mods/modAdmission'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const open: MessagePort[] = []
afterEach(() => {
  for (const port of open.splice(0)) port.close()
})

type Worker = ModWorkerHandle & { crash(message: string): void; closedCalls: number }

function world(
  sources: Record<string, string>,
  options: { startTimeoutMs?: number; budgetMs?: number; failSpawn?: string[]; onDisposed?: () => void } = {},
) {
  const reports: string[] = []
  const workers: Record<string, Worker> = {}
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({
    plugin: path.split('/')[0]!,
    path,
  }))
  const runtime = new ModRuntime({
    modules,
    readModule: async path => {
      const source = sources[path]
      if (source === undefined || source === '<unreadable>') throw new Error('ENOENT')
      return source
    },
    openWorker: async plugin => {
      if (options.failSpawn?.includes(plugin)) {
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
          settle({ reason: 'crashed', message })
        },
      }
      workers[plugin] = worker
      return worker
    },
    session: { id: () => 'session-1', cwd: () => '/work/project' },
    report: line => reports.push(line),
    ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
    ...(options.onDisposed !== undefined ? { onDisposed: options.onDisposed } : {}),
  })
  return { runtime, reports, workers }
}

describe('ModRuntime — loading', () => {
  it('loads a plain JS module, seats its hooks and reports what it hooks', async () => {
    const { runtime, reports } = world({
      'tagger/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' [tagged]' }))
        }
      `,
    })
    await runtime.ready
    expect(runtime.status()).toEqual([
      {
        plugin: 'tagger',
        path: 'tagger/hooks/register.js',
        state: 'loaded',
        events: ['prompt.submit'],
        generation: 1,
        // What it uses: the registrations' events; no scan in this
        // world, so no calls are known.
        uses: { events: ['prompt.submit'], calls: [] },
      },
    ])
    expect(reports).toEqual([])
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(true)
  })

  it('refuses a TypeScript module by name, without spawning a worker', async () => {
    const { runtime, reports, workers } = world({
      'typed/hooks/register.tsx': `export const register = (on) => {}`,
    })
    await runtime.ready
    expect(runtime.status()[0]).toMatchObject({ state: 'refused' })
    expect(reports).toEqual([
      `typed: the hooks module was refused — this module needs the TypeScript / JSX compiler (a .tsx module, or one that imports), which this runtime was not given (${MODS_ABI})`,
    ])
    expect(workers.typed).toBeUndefined()
  })

  it.each([
    ['a relative import', `import { helper } from './helper.js'\nexport function register(on) {}`],
    ['a bare import', `import { update } from "claude-code"\nexport function register(on) {}`],
    ['a side-effect import', `import './setup.js'\nexport function register(on) {}`],
    ['a re-export', `export { register } from './impl.js'`],
    ['a dynamic import', `export async function register(on) { await import('https://example.com/x.js') }`],
  ])('refuses a module with %s', async (_name, source) => {
    const { runtime, reports, workers } = world({ 'acme/hooks/register.js': source })
    await runtime.ready
    expect(runtime.status()[0]!.state).toBe('refused')
    expect(reports[0]).toMatch(/needs the TypeScript \/ JSX compiler \(a \.js module, or one that imports\)/)
    expect(workers.acme).toBeUndefined()
  })

  it('does not mistake an identifier or a property for an import', async () => {
    const { runtime, reports } = world({
      'acme/hooks/register.js': `
        const important = { import_count: 1 }
        export function register(on) {
          on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + important.import_count }))
        }
      `,
    })
    await runtime.ready
    expect(reports).toEqual([])
    expect(runtime.status()[0]!.state).toBe('loaded')
  })

  it('refuses a module that hooks an event this engine does not raise — and closes its worker', async () => {
    const { runtime, reports, workers } = world({
      'guard/hooks/register.js': `
        export function register(on) {
          on('ui.message', ($, e, next) => next(e))
          on('prompt.submit', ($, e, next) => next(e))
        }
      `,
    })
    await runtime.ready
    expect(runtime.status()[0]!.state).toBe('refused')
    expect(reports[0]).toBe(
      'guard: the hooks module was refused — it hooks an event this engine does not raise yet: ui.message',
    )
    // None of its hooks joined — not even the one on an event that IS raised.
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(false)
    expect(workers.guard!.closedCalls).toBe(1)
  })

  it('admits globs and negations; refuses a namespace this engine raises nothing under', async () => {
    const ok = world({
      'wide/hooks/register.js': `
        export function register(on) {
          on('*', ($, e, next) => next(e))
          on('session.*', ($, e, next) => next(e))
          on('!prompt.submit', ($, e, next) => next(e))
        }
      `,
    })
    await ok.runtime.ready
    expect(ok.runtime.status()[0]!.state).toBe('loaded')
    const dead = world({
      'dead/hooks/register.js': `export function register(on) { on('attribution.*', ($, e, next) => next(e)) }`,
    })
    await dead.runtime.ready
    expect(dead.reports[0]).toMatch(/it hooks an event this engine does not raise yet: attribution\.\*/)
  })

  it('refuses a hook in the wrong form by name: a plain function on turn.step, a generator elsewhere', async () => {
    const plain = world({
      'plain/hooks/register.js': `export function register(on) { on('turn.step', ($, e, next) => next(e)) }`,
    })
    await plain.runtime.ready
    expect(plain.runtime.status()[0]!.state).toBe('refused')
    expect(plain.reports[0]).toBe(
      'plain: the hooks module was refused — its hook on turn.step is not an async generator — ' +
        'the one form that loads there (async function* ($, e, next))',
    )
    const gen = world({
      'gen/hooks/register.js': `export function register(on) {
        on('prompt.submit', async function* ($, e, next) { return yield* next(e) })
      }`,
    })
    await gen.runtime.ready
    expect(gen.reports[0]).toBe(
      'gen: the hooks module was refused — its hook on prompt.submit is an async generator, ' +
        'which loads only on a streaming event',
    )
    // Under a glob each form selects its own kind: a generator under a
    // namespace with no streaming event in it is dead.
    const deadGlob = world({
      'glob/hooks/register.js': `export function register(on) {
        on('session.*', async function* ($, e, next) { return yield* next(e) })
      }`,
    })
    await deadGlob.runtime.ready
    expect(deadGlob.reports[0]).toMatch(/does not raise yet: session\.\* \(as a generator\)/)
    const ok = world({
      'ok/hooks/register.js': `export function register(on) {
        on('turn.step', async function* ($, e, next) { return yield* next(e) })
        on('turn.*', async function* ($, e, next) { return yield* next(e) })
        on('*', async function* ($, e, next) { return yield* next(e) })
      }`,
    })
    await ok.runtime.ready
    expect(ok.runtime.status()[0]!.state).toBe('loaded')
    expect(ok.runtime.dispatcher.hasHooksFor('turn.step')).toBe(true)
    expect(ok.runtime.dispatcher.hasHooksFor('turn.start')).toBe(false)
  })

  it('one module failing does not stop the others, and each failure says why', async () => {
    const { runtime, reports } = world(
      {
        'missing/hooks/register.js': '<unreadable>',
        'throws/hooks/register.js': `export function register() { throw new Error('bad config') }`,
        'noexport/hooks/register.js': `export const nothing = 1`,
        'syntax/hooks/register.js': `export function register(on) { on('prompt.submit', `,
        'nospawn/hooks/register.js': `export function register(on) {}`,
        'good/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }`,
      },
      { failSpawn: ['nospawn'] },
    )
    await runtime.ready
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['missing', 'failed'],
      ['throws', 'failed'],
      ['noexport', 'failed'],
      ['syntax', 'failed'],
      // Not the module's fault: it is tried again (mod-lifecycle.test.ts).
      ['nospawn', 'crashed'],
      ['good', 'loaded'],
    ])
    expect(reports[0]).toBe(
      'missing: the hooks module was not loaded — missing/hooks/register.js could not be read (ENOENT)',
    )
    expect(reports[1]).toBe('throws: the hooks module was not loaded — throws: bad config')
    expect(reports[2]).toBe(
      'noexport: the hooks module was not loaded — noexport: the hooks module does not export register(on, options)',
    )
    expect(reports[3]).toMatch(/^syntax: the hooks module was not loaded — syntax: /)
    expect(reports[4]).toMatch(
      /^nospawn: the hooks module stopped — its worker could not be started \(mod nospawn could not start.*restarting it in 1000ms$/,
    )
    expect(reports).toHaveLength(5)
  })

  it('seats modules in list order, whichever worker would have answered first', async () => {
    const { runtime } = world({
      'slow/hooks/register.js': `
        export async function register(on) {
          await new Promise(r => setTimeout(r, 60))
          on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' slow' }))
        }
      `,
      'fast/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' fast' }))
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'hi slow fast' })
  })
})

describe('ModRuntime — session.start', () => {
  it('fires once, after every module loaded, and is awaited by ready', async () => {
    const { runtime, reports } = world({
      'a/hooks/register.js': `
        export function register(on) {
          on('session.start', async ($, e, next) => {
            await $.ui.log('start ' + JSON.stringify(e))
            return next(e)
          })
        }
      `,
      'b/hooks/register.js': `
        export function register(on) {
          on('session.start', async ($, e, next) => {
            await new Promise(r => setTimeout(r, 40))
            await $.ui.log('b saw ' + (await $.session.id()))
            return next(e)
          })
        }
      `,
    })
    await runtime.ready
    expect(reports).toEqual([
      'a: start {"cwd":"/work/project","surface":"desktop","isInteractive":true,"locale":"en"}',
      'b: b saw session-1',
    ])
  })

  it('a module that hangs there cannot hold the first prompt past the cap', async () => {
    const { runtime, reports } = world(
      {
        'hang/hooks/register.js': `
          export function register(on) {
            on('session.start', ($, e, next) => next(e).then(() => new Promise(() => {})))
          }
        `,
      },
      { startTimeoutMs: 60, budgetMs: 10_000 },
    )
    const started = Date.now()
    await runtime.ready
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(reports).toEqual([
      'mods: session.start did not finish within 60ms; the session goes on without waiting',
    ])
  })

  it('does not fire when nothing loaded', async () => {
    const { runtime, reports } = world({ 'typed/hooks/register.ts': `export const register = () => {}` })
    await runtime.ready
    expect(reports).toHaveLength(1) // the refusal, and no session.start report
  })
})

describe('ModRuntime — $', () => {
  it('serves the implemented nouns', async () => {
    const { runtime, reports } = world({
      'probe/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const before = await $.clock.now()
            await $.clock.sleep(20)
            const elapsed = (await $.clock.now()) - before
            await $.ui.log([await $.session.id(), await $.session.cwd(), elapsed >= 15].join(' | '))
            return next(e)
          })
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['probe: session-1 | /work/project | true'])
  })

  it('refuses what is not implemented, by name, at the call', async () => {
    const { runtime, reports } = world({
      'probe/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const refused = await $.session.authorize({ scope: 'x' }).catch(err => err.name + ': ' + err.message)
            await $.ui.log(refused)
            return next(e)
          })
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ entered: true, text: 'hi' })
    expect(reports).toEqual([
      'probe: NotSupportedError: $.session.authorize is not implemented by this engine',
    ])
  })

  it('a $ call is an event: another mod may hook it, and sees who raised it', async () => {
    const { runtime, reports } = world({
      'relocate/hooks/register.js': `
        export function register(on) {
          on('session.cwd', async ($, e, next) => {
            const real = await next(e)
            return next.origin.plugin === 'asker' ? { value: '/sandbox' + real.value } : real
          })
        }
      `,
      'asker/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.session.cwd())
            return next(e)
          })
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['asker: /sandbox/work/project'])
  })

  it('every noun served is listed as a raised event', () => {
    // `$.ui.ask` raises no `ui.ask` event: the ask is raised as a `tool.call`
    // of AskUserQuestion instead (modUi.ts).
    const NOT_RAISED = ['ui.ask']
    for (const noun of implementedNouns()) {
      if (NOT_RAISED.includes(noun)) expect(RAISED_EVENTS, noun).not.toContain(noun)
      else expect(RAISED_EVENTS, noun).toContain(noun)
    }
    expect(implementedNouns()).toEqual([
      'agent.list',
      'agent.register',
      'agent.spawn',
      'audio.play',
      'audio.speak',
      'clock.after',
      'clock.every',
      'clock.now',
      'clock.sleep',
      'command.list',
      'command.register',
      'command.run',
      'config.list',
      'config.set',
      'env.get',
      'env.set',
      'fs.ancestors',
      'fs.exists',
      'fs.list',
      'fs.read',
      'fs.stat',
      'fs.write',
      'http.fetch',
      'mcp.call',
      'mcp.connect',
      'model.classify',
      'model.complete',
      'model.fork',
      'process.run',
      'process.spawn',
      'prompt.compose',
      'prompt.fill',
      'prompt.read',
      'prompt.submit',
      'prompt.suggest',
      'session.append',
      'session.compact',
      'session.cwd',
      'session.id',
      'session.messages',
      'session.model',
      'session.repo',
      'session.root',
      'session.send',
      'session.surface',
      'session.surfaces',
      'session.turns',
      'session.usage',
      'session.version',
      'settings.read',
      'state.get',
      'state.set',
      'store.delete',
      'store.get',
      'store.keys',
      'store.set',
      'telemetry.log',
      'telemetry.mark',
      'tool.call',
      'tool.check',
      'tool.list',
      'tool.register',
      'turn.abort',
      'ui.ask',
      'ui.blit',
      'ui.close',
      'ui.copy',
      'ui.focus',
      'ui.invalidate',
      'ui.log',
      'ui.notice',
      'ui.open',
      'ui.panes',
      'ui.scroll',
      'ui.status',
      'ui.toast',
    ])
  })
})

describe('ModRuntime — prompt.submit', () => {
  it('enters the prompt as typed when no mod hooks it — without a dispatch', async () => {
    const { runtime } = world({
      'quiet/hooks/register.js': `export function register(on) { on('session.start', ($, e, next) => next(e)) }`,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hello')).resolves.toEqual({ entered: true, text: 'hello', context: [] })
  })

  it('a hook rewrites the text and attaches context on the way down', async () => {
    const { runtime } = world({
      'tagger/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', ($, e, next) =>
            next({ ...e, text: e.text.toUpperCase(), context: [...(e.context ?? []), 'Reply in French.'] }))
        }
      `,
      'second/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', ($, e, next) => next({ ...e, context: [...(e.context ?? []), 'Be brief.', ''] }))
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hello')).resolves.toEqual({
      entered: true,
      text: 'HELLO',
      // In chain order; an empty block is not a block.
      context: ['Reply in French.', 'Be brief.'],
    })
  })

  it('hands the hook the event as the engine raises it', async () => {
    const { runtime, reports } = world({
      'probe/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(JSON.stringify([e, next.origin]))
            return next(e)
          })
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(JSON.parse(reports[0]!.slice('probe: '.length))).toEqual([
      { text: 'hi', wait: false, origin: { kind: 'composer' } },
      { plugin: 'engine', tier: 'core' },
    ])
  })

  it('{ drop } stops the prompt, with the reason', async () => {
    const { runtime } = world({
      'gate/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', ($, e, next) => /secret/.test(e.text) ? { drop: 'That looks like a secret.' } : next(e))
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('my secret is 123')).resolves.toEqual({
      entered: false,
      reason: 'That looks like a secret.',
    })
    await expect(runtime.promptSubmit('hello')).resolves.toMatchObject({ entered: true, text: 'hello' })
  })

  it('a hook answering without next enters nothing', async () => {
    const { runtime } = world({
      'eater/hooks/register.js': `
        export function register(on) { on('prompt.submit', ($, e) => ({ text: e.text })) }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hello')).resolves.toEqual({ entered: false })
  })

  it('what ENTERED is what reached core: context added after next is not attached', async () => {
    const { runtime } = world({
      'late/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const entered = await next(e)
            return { ...entered, text: 'changed too late', context: ['too late'] }
          })
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hello')).resolves.toEqual({ entered: true, text: 'hello', context: [] })
  })

  it('a broken plugin never blocks a prompt', async () => {
    const { runtime, reports } = world({
      'broken/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', () => { throw new Error('kaboom') })
        }
      `,
      'wrong/hooks/register.js': `
        export function register(on) { on('prompt.submit', () => 'not an object') }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hello')).resolves.toEqual({ entered: true, text: 'hello', context: [] })
    expect(reports).toEqual([
      'broken: prompt.submit hook failed: kaboom (skipped)',
      'wrong: prompt.submit hook failed: the hook returned a result this event does not take (skipped)',
    ])
  })
})

describe('ModRuntime — the slot', () => {
  // What happens next — the restart — is `mod-lifecycle.test.ts`.
  it('a worker that crashes takes its hooks out of the chain and is reported', async () => {
    const { runtime, reports, workers } = world({
      'fragile/hooks/register.js': `
        export function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + '!' })) }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'hi!' })
    workers.fragile!.crash('Uncaught RangeError')
    await sleep(10)
    expect(runtime.status()[0]).toMatchObject({ state: 'crashed', reason: 'its worker is gone (Uncaught RangeError)' })
    expect(reports).toEqual([
      'fragile: the hooks module stopped — its worker is gone (Uncaught RangeError); restarting it in 1000ms',
    ])
    // The next prompt does not wait on a worker that is not there, nor goes
    // past its hook: it is refused until the worker is back.
    await expect(runtime.promptSubmit('hi')).resolves.toEqual({
      entered: false,
      reason: "fragile's hook on prompt.submit could not answer (its hooks worker is restarting)",
    })
  })

  it('a worker that crashes before its module answered load is seen at once — not after the load timeout', async () => {
    const { runtime, reports, workers } = world({
      // The module never finishes evaluating: only the crash can end the load.
      'stuck/hooks/register.js': `
        await new Promise(() => {})
        export function register(on) {}
      `,
    })
    while (!workers.stuck) await sleep(1)
    await sleep(10)
    workers.stuck.crash('the window that hosted it went away')
    await sleep(10)
    expect(runtime.status()[0]).toMatchObject({
      state: 'crashed',
      reason: 'its worker is gone (the window that hosted it went away)',
    })
    expect(reports).toEqual([
      'stuck: the hooks module stopped — its worker is gone (the window that hosted it went away); restarting it in 1000ms',
    ])
    expect(workers.stuck.closedCalls).toBe(1)
    runtime.dispose()
  })

  it('dispose leaves the chain and closes every worker, once', async () => {
    const { runtime, workers } = world({
      'a/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }`,
      'b/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }`,
    })
    await runtime.ready
    runtime.dispose()
    runtime.dispose()
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(false)
    expect([workers.a!.closedCalls, workers.b!.closedCalls]).toEqual([1, 1])
    await expect(runtime.promptSubmit('hi')).resolves.toEqual({ entered: true, text: 'hi', context: [] })
  })

  it('tells onDisposed once, whichever way the runtime goes — the registry entry goes with it', async () => {
    let told = 0
    const { runtime } = world(
      { 'a/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` },
      { onDisposed: () => void (told += 1) },
    )
    await runtime.ready
    await runtime.end('other')
    runtime.dispose()
    expect(told).toBe(1)
    const throwing = world(
      { 'b/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }` },
      { onDisposed: () => { throw new Error('registry down') } },
    )
    await throwing.runtime.ready
    expect(() => throwing.runtime.dispose()).not.toThrow()
  })

  it('a slot disposed while still loading seats nothing', async () => {
    const { runtime, workers } = world({
      'slow/hooks/register.js': `
        export async function register(on) {
          await new Promise(r => setTimeout(r, 60))
          on('prompt.submit', ($, e, next) => next(e))
        }
      `,
    })
    await sleep(15)
    runtime.dispose()
    await runtime.ready
    expect(runtime.dispatcher.hasHooksFor('prompt.submit')).toBe(false)
    expect(workers.slow!.closedCalls).toBe(1)
  })

  it("a plugin's second module gets its own seat", async () => {
    const reports: string[] = []
    const sources: Record<string, string> = {
      'p/one.js': `export function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + '1' })) }`,
      'p/two.js': `export function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + '2' })) }`,
    }
    const runtime = new ModRuntime({
      modules: [
        { plugin: 'p', path: 'p/one.js' },
        { plugin: 'p', path: 'p/two.js' },
      ],
      readModule: async path => sources[path]!,
      openWorker: async () => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        return { port: channel.port1, closed: new Promise(() => {}), close() {} }
      },
      session: { id: () => 's', cwd: () => '/' },
      report: line => reports.push(line),
    })
    await runtime.ready
    await expect(runtime.promptSubmit('x')).resolves.toMatchObject({ text: 'x12' })
    expect(reports).toEqual([])
  })
})
