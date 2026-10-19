/**
 * `plugin.register`, `engine.create` and the scan at load (F-25), through a real `ModRuntime` whose "workers" are `ModWorkerHost` on
 * MessageChannels, with the scan over the TypeScript parser as the product
 * wires it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type * as TS from 'typescript'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { MOD_SERVE_TIMEOUT_MS } from '../mods/ModInstance'
import { loadTypeScript } from '../mods/modCompiler'
import { scanModuleUses } from '../mods/modScan'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let tsModule: typeof TS | undefined
let uniq = 0

type Worker = ModWorkerHandle & { crash(message: string): void }

function world(
  sources: Record<string, string>,
  options: { scan?: boolean; respawnBackoffMs?: readonly number[]; serveTimeoutMs?: number } = {},
) {
  const reports: string[] = []
  const workers: Record<string, Worker[]> = {}
  const texts = { ...sources }
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({
    plugin: path.split('/')[0]!,
    path,
    root: `/plugins/${path.split('/')[0]!}`,
    version: '1.2.3',
  }))
  const runtime = new ModRuntime({
    modules,
    // Each load gets text of its own: identical `data:` text is one cached
    // module in this realm.
    readModule: async path => {
      const source = texts[path]
      if (source === undefined) throw new Error('ENOENT')
      return source
    },
    compile: async (_ref, source) => ({ source: `${source}\n// load ${++uniq}`, files: [] }),
    ...(options.scan === false
      ? {}
      : {
          scan: async (ref, source) => {
            tsModule ??= await loadTypeScript()
            return scanModuleUses(tsModule, [{ path: ref.path, text: source }])
          },
        }),
    openWorker: async plugin => {
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
        close: () => settle({ reason: 'closed' }),
        crash: message => settle({ reason: 'crashed', message }),
      }
      ;(workers[plugin] ??= []).push(worker)
      return worker
    },
    session: { id: () => 'session-1', cwd: () => '/work/project' },
    report: line => reports.push(line),
    respawnBackoffMs: options.respawnBackoffMs ?? [10],
    ...(options.serveTimeoutMs !== undefined ? { serveTimeoutMs: options.serveTimeoutMs } : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports, workers, texts, modules }
}

/** A module whose `engine.create` step adds `$.voice.say`, which records
 *  what it was told and answers it back, tagged. */
const VOICE = `
  let said = []
  export function register(on) {
    on('engine.create', async ($, e, next) => {
      const built = await next(e)
      return { ...built, voice: { say: (text) => { said.push(text); return 'voice:' + text }, list: () => said } }
    })
  }
`

describe('the scan at load', () => {
  it('a module calling an engine noun this engine does not implement is refused at load, naming the call, with no worker', async () => {
    const { runtime, reports, workers } = world({
      'writer/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => { await $.session.authorize({ scope: 'x' }); return next(e) })
        }
      `,
    })
    await runtime.ready
    expect(runtime.status()[0]).toMatchObject({ state: 'refused' })
    // The call it makes, not every call the engine has.
    expect(reports[0]).toBe(
      'writer: the hooks module was refused — it calls $.session.authorize, which this engine does not implement',
    )
    expect(workers.writer).toBeUndefined()
  })

  it('without a scan the same module loads, and the call is refused at the call (the fallback)', async () => {
    const { runtime, reports } = world(
      {
        'writer/hooks/register.js': `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => { await $.session.authorize({ scope: 'x' }); return next(e) })
          }
        `,
      },
      { scan: false },
    )
    await runtime.ready
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', uses: { events: ['prompt.submit'], calls: [] } })
    await runtime.promptSubmit('hi')
    expect(reports.some(line => /prompt\.submit hook failed: \$\.session\.authorize is not implemented/.test(line))).toBe(true)
  })

  it('the state row carries what the module uses: the registrations\' events, the scan\'s calls', async () => {
    const { runtime } = world({
      'reader/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => { await $.env.get('HOME'); return next(e) })
          on('session.start', ($) => $.ui.status('up'))
          on('prompt.submit', ($, e, next) => next(e))
        }
      `,
    })
    await runtime.ready
    expect(runtime.status()[0]).toMatchObject({
      state: 'loaded',
      events: ['prompt.submit', 'session.start'],
      uses: { events: ['prompt.submit', 'session.start'], calls: ['env.get', 'ui.status'], env: { reads: ['HOME'], writes: [] } },
    })
  })
})

describe('plugin.register', () => {
  const JUDGE = `
    export function register(on) {
      on('plugin.register', ($, e, next) => {
        if (e.uses.calls.includes('env.set')) return { refuse: 'no writes to the environment from ' + e.name }
        return next(e)
      })
    }
  `

  it('a plugin loaded earlier refuses a later one by what it uses; the refusal names the judge; nothing of the refused joins', async () => {
    const { runtime, reports, workers } = world({
      'judge/hooks/register.js': JUDGE,
      'setter/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => { await $.env.set('X', '1'); return next({ ...e, text: 'rewritten' }) })
        }
      `,
      'getter/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => { await $.env.get('X'); return next({ ...e, text: e.text + ' [got]' }) })
        }
      `,
    })
    await runtime.ready
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['judge', 'loaded'],
      ['setter', 'refused'],
      ['getter', 'loaded'],
    ])
    expect(runtime.status()[1]!.reason).toBe('judge refused it at plugin.register — no writes to the environment from setter')
    expect(reports).toContain(
      'setter: the hooks module was refused — judge refused it at plugin.register — no writes to the environment from setter',
    )
    // Its worker was closed; its hooks never joined.
    expect(workers.setter).toHaveLength(1)
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ entered: true, text: 'hi [got]' })
  })

  it('the event carries the manifest\'s word and the host\'s reading, and core allows', async () => {
    const { runtime } = world({
      'judge/hooks/register.js': `
        let seen
        export function register(on) {
          on('plugin.register', async ($, e, next) => { seen = { e, result: await next(e) }; return seen.result })
          on('prompt.submit', ($, e, next) => next({ ...e, text: JSON.stringify(seen) }))
        }
      `,
      'other/hooks/register.ts': `
        export const register = (on) => {
          on('tool.call', async ($, e, next) => { await $.ui.toast('x'); return next(e) })
          on('session.start', async ($) => { await $.state.get({ plugin: 'other', key: 'k' }) })
        }
      `,
    })
    await runtime.ready
    const outcome = await runtime.promptSubmit('hi')
    expect(outcome.entered).toBe(true)
    expect(JSON.parse((outcome as { text: string }).text)).toEqual({
      e: {
        name: 'other',
        tier: 'user',
        root: '/plugins/other',
        version: '1.2.3',
        provenance: 'other@inline',
        uses: {
          events: ['tool.call', 'session.start'],
          calls: ['state.get', 'ui.toast'],
          state: { reads: [{ plugin: 'other', key: 'k' }], writes: [] },
        },
      },
      result: { allow: true },
    })
  })

  it('a judge is never asked about itself, and a judge that throws is skipped: the module loads', async () => {
    const { runtime, reports } = world({
      'broken/hooks/register.js': `
        export function register(on) {
          on('plugin.register', () => { throw new Error('judge down') })
          on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' [judge]' }))
        }
      `,
      'plain/hooks/register.js': `
        export function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' [plain]' })) }
      `,
    })
    await runtime.ready
    expect(runtime.status().map(s => s.state)).toEqual(['loaded', 'loaded'])
    expect(reports.filter(line => /plugin\.register hook failed: judge down/.test(line))).toHaveLength(1)
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'hi [judge] [plain]' })
  })

  it('a module enabled later is judged by the plugins already loaded', async () => {
    const { runtime, modules, texts } = world({ 'judge/hooks/register.js': JUDGE })
    await runtime.ready
    texts['late/hooks/register.js'] = `export function register(on) { on('session.start', ($) => $.env.set('X', '1')) }`
    const outcome = await runtime.reconcile([...modules, { plugin: 'late', path: 'late/hooks/register.js' }])
    expect(outcome.added).toEqual(['late/hooks/register.js'])
    expect(runtime.status()[1]).toMatchObject({ plugin: 'late', state: 'refused', reason: /^judge refused it at plugin\.register/ })
  })
})

describe('engine.create', () => {
  it('a step adds a noun; another plugin calls it; the method runs in the provider\'s worker and its value crosses back', async () => {
    const { runtime, reports } = world({
      'voice/hooks/register.js': VOICE,
      'caller/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const answer = await $.voice.say(e.text)
            const all = await $.voice.list()
            return next({ ...e, text: answer + ' ' + JSON.stringify(all) })
          })
        }
      `,
    })
    await runtime.ready
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['voice', 'loaded'],
      ['caller', 'loaded'],
    ])
    expect(runtime.status()[0]).toMatchObject({ nouns: ['voice'] })
    expect(runtime.status()[1]).toMatchObject({ uses: { calls: ['voice.list', 'voice.say'] } })
    expect(reports).toContain('voice: added $.voice at engine.create')
    // The module variable `said` fills in voice's worker, call after call.
    await expect(runtime.promptSubmit('hello')).resolves.toMatchObject({ entered: true, text: 'voice:hello ["hello"]' })
    await expect(runtime.promptSubmit('again')).resolves.toMatchObject({ entered: true, text: 'voice:again ["hello","again"]' })
  })

  it('the whole set folds once at load, first outermost; e.plugins lists it; $ at the step is empty', async () => {
    const { runtime } = world({
      'a/hooks/register.js': `
        let seen
        export function register(on) {
          on('engine.create', async ($, e, next) => {
            seen = { plugins: e.plugins, dollar: Object.keys($), session: $.session === undefined }
            const built = await next(e)
            seen.builtNouns = Object.keys(built)
            return { ...built, a: { one: () => 1 } }
          })
          on('prompt.submit', ($, e, next) => next({ ...e, text: JSON.stringify(seen) }))
        }
      `,
      'b/hooks/register.js': `
        export function register(on) {
          on('engine.create', async ($, e, next) => ({ ...(await next(e)), b: { two: () => 2 } }))
        }
      `,
      'c/hooks/register.js': `export function register(on) { on('session.start', () => {}) }`,
    })
    await runtime.ready
    const outcome = (await runtime.promptSubmit('x')) as { text: string }
    const seen = JSON.parse(outcome.text)
    expect(seen.plugins).toEqual(['a', 'b', 'c'])
    expect(seen.dollar).toEqual([])
    expect(seen.session).toBe(true)
    // `a` is outermost: what it built on already held `b`'s noun and the engine's.
    expect(seen.builtNouns).toContain('b')
    expect(seen.builtNouns).toContain('session')
    expect(seen.builtNouns).toContain('plugin')
    expect(seen.builtNouns).not.toContain('a')
    expect(runtime.status()[0]).toMatchObject({ nouns: ['a'] })
    expect(runtime.status()[1]).toMatchObject({ nouns: ['b'] })
  })

  it('a plugin noun call is an event: a later plugin hooks it by name, sees who raised it, and may deny it', async () => {
    const { runtime, reports } = world({
      'voice/hooks/register.js': VOICE,
      'caller/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            try { return next({ ...e, text: await $.voice.say(e.text) }) }
            catch (error) { return next({ ...e, text: error.name + ': ' + error.message }) }
          })
        }
      `,
      'censor/hooks/register.js': `
        export function register(on) {
          on('voice.say', ($, e, next) => /rude/.test(e) ? { deny: 'not that, ' + next.origin.plugin } : next(e))
        }
      `,
    })
    await runtime.ready
    expect(reports.filter(line => /refused/.test(line))).toEqual([])
    expect(runtime.status().map(s => s.state)).toEqual(['loaded', 'loaded', 'loaded'])
    await expect(runtime.promptSubmit('nice')).resolves.toMatchObject({ text: 'voice:nice' })
    await expect(runtime.promptSubmit('rude')).resolves.toMatchObject({ text: 'DeniedError: not that, caller' })
  })

  it('a hook by name on a noun no step adds is refused once the fold ran; so is a call of one', async () => {
    const { runtime, reports } = world({
      'hopeful/hooks/register.js': `export function register(on) { on('voice.say', ($, e, next) => next(e)) }`,
      'caller/hooks/register.js': `export function register(on) { on('session.start', ($) => $.voice.say('x')) }`,
      'plain/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + '!' })) }`,
    })
    await runtime.ready
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['hopeful', 'refused'],
      ['caller', 'refused'],
      ['plain', 'loaded'],
    ])
    expect(runtime.status()[0]!.reason).toBe(
      "it hooks an event this engine does not raise yet: voice.say (no loaded plugin's engine.create step adds the noun)",
    )
    expect(runtime.status()[1]!.reason).toBe("it calls $.voice.say, which no loaded plugin's engine.create step provides")
    expect(reports.filter(line => /refused/.test(line))).toHaveLength(2)
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'hi!' })
  })

  it('a method the provider does not have, and a provider whose worker is gone, are refused by name', async () => {
    const { runtime, workers } = world({
      'voice/hooks/register.js': VOICE,
      'caller/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            try { return next({ ...e, text: String(await $.voice[e.text]('x')) }) }
            catch (error) { return next({ ...e, text: error.name + ': ' + error.message }) }
          })
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('shout')).resolves.toMatchObject({
      text: 'NotSupportedError: $.voice.shout is not a method voice provides (it provides: voice.say, voice.list)',
    })
    workers.voice![0]!.crash('boom')
    await until(() => runtime.status()[0]!.state === 'crashed')
    await expect(runtime.promptSubmit('say')).resolves.toMatchObject({
      text: 'Error: $.voice.say: voice, which provides it, is not loaded',
    })
    // Back after the restart: its step ran again, alone, and the noun serves.
    await until(() => runtime.status()[0]!.state === 'loaded' && runtime.status()[0]!.generation === 2)
    await expect(runtime.promptSubmit('say')).resolves.toMatchObject({ text: 'voice:x' })
  })

  it('a step that replaces another plugin\'s noun fails and unloads its plugin; the fold runs again without it', async () => {
    // Post-order: the inner (later) step's noun is on what the outer builds
    // on, so it is the OUTER step that replaces — and fails.
    const { runtime, reports } = world({
      'usurper/hooks/register.js': `
        export function register(on) {
          on('engine.create', async ($, e, next) => ({ ...(await next(e)), voice: { say: () => 'mine' } }))
          on('prompt.submit', ($, e, next) => next({ ...e, text: 'usurped' }))
        }
      `,
      'voice/hooks/register.js': VOICE,
      'caller/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => next({ ...e, text: await $.voice.say(e.text) }))
        }
      `,
    })
    await runtime.ready
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['usurper', 'failed'],
      ['voice', 'loaded'],
      ['caller', 'loaded'],
    ])
    expect(reports).toContain(
      "usurper: engine.create hook failed: usurper's engine.create step replaced $.voice, which voice added: a step may add nouns and withhold nouns, not replace one (kept)",
    )
    expect(runtime.status()[0]!.reason).toMatch(/^its engine\.create step failed/)
    // Its hooks are gone with it; voice's noun stands.
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'voice:hi' })
  })

  it('a step that returns something other than the table fails the same way', async () => {
    const { runtime, reports } = world({
      'odd/hooks/register.js': `
        export function register(on) {
          on('engine.create', async ($, e, next) => { await next(e); return 42 })
        }
      `,
      'empty/hooks/register.js': `
        export function register(on) {
          on('engine.create', async ($, e, next) => ({ ...(await next(e)), thing: { notAFunction: 1 } }))
        }
      `,
    })
    await runtime.ready
    expect(runtime.status().map(s => s.state)).toEqual(['failed', 'failed'])
    expect(reports.some(line => /odd: engine\.create hook failed: an engine\.create step returns \$ as built so far/.test(line))).toBe(true)
    expect(reports.some(line => /empty: engine\.create hook failed: \$\.thing, as empty's engine\.create step returned it, holds no method/.test(line))).toBe(true)
  })

  it('a step withholds a noun: the host refuses an op on it, naming who withheld it', async () => {
    const { runtime, reports } = world({
      'org/hooks/register.js': `
        export function register(on) {
          on('engine.create', async ($, e, next) => { const { env, ...rest } = await next(e); return rest })
        }
      `,
      'reader/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            try { return next({ ...e, text: String(await $.env.get('HOME')) }) }
            catch (error) { return next({ ...e, text: error.name + ': ' + error.message }) }
          })
        }
      `,
    })
    await runtime.ready
    expect(reports).toContain('org: $.env is withheld at engine.create')
    await expect(runtime.promptSubmit('x')).resolves.toMatchObject({
      text: 'NotSupportedError: $.env.get was withheld by org at engine.create',
    })
    // The withholding plugin gone, the noun is back.
    await runtime.reconcile([{ plugin: 'reader', path: 'reader/hooks/register.js' }])
    await expect(runtime.promptSubmit('x')).resolves.toMatchObject({ text: 'undefined' })
  })

  it('a reload of the provider runs its step alone, with e.plugins naming it; the noun keeps serving, new text', async () => {
    const { runtime, texts, reports } = world({
      'voice/hooks/register.js': VOICE,
      'caller/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => next({ ...e, text: await $.voice.say(e.text) }))
        }
      `,
    })
    await runtime.ready
    texts['voice/hooks/register.js'] = `
      export function register(on) {
        on('engine.create', async ($, e, next) => ({ ...(await next(e)), voice: { say: (t) => 'v2:' + t + ':' + e.plugins.join('+') } }))
      }
    `
    const outcome = await runtime.reload()
    expect(outcome.reloaded).toEqual(['voice/hooks/register.js'])
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded', generation: 2, nouns: ['voice'] })
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'v2:hi:voice' })
    expect(reports.filter(line => line === 'voice: added $.voice at engine.create')).toHaveLength(2)
  })

  it('a step reads next.trace after next(e) as on any other event: the steps beneath', async () => {
    const { runtime } = world({
      'a/hooks/register.js': `
        let beneath
        export function register(on) {
          on('engine.create', async ($, e, next) => {
            const built = await next(e)
            beneath = next.trace.map(entry => entry.plugin)
            return built
          })
          on('prompt.submit', ($, e, next) => next({ ...e, text: JSON.stringify(beneath) }))
        }
      `,
      'b/hooks/register.js': `
        export function register(on) {
          on('engine.create', async ($, e, next) => ({ ...(await next(e)), b: { two: () => 2 } }))
        }
      `,
    })
    await runtime.ready
    const outcome = (await runtime.promptSubmit('x')) as { text: string }
    expect(JSON.parse(outcome.text)).toContain('b')
  })

  it('the bound on a method is one minute of its own time: the $ calls it waits on, a model call among them, do not count', () => {
    expect(MOD_SERVE_TIMEOUT_MS).toBe(60_000)
  })

  it('a method that never answers is refused at its bound; three in a row restart its provider', async () => {
    const { runtime, reports, workers } = world(
      {
        'voice/hooks/register.js': `
          export function register(on) {
            on('engine.create', async ($, e, next) => ({ ...(await next(e)), voice: { say: () => new Promise(() => {}) } }))
          }
        `,
        'caller/hooks/register.js': `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              try { return next({ ...e, text: await $.voice.say(e.text) }) }
              catch (error) { return next({ ...e, text: error.name }) }
            })
          }
        `,
      },
      { serveTimeoutMs: 30, respawnBackoffMs: [60_000] },
    )
    await runtime.ready
    for (let n = 0; n < 3; n++) {
      await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'TimeoutError' })
    }
    expect(runtime.status()[0]).toMatchObject({ plugin: 'voice', state: 'crashed' })
    expect(workers.voice).toHaveLength(1)
    expect(reports.some(line => line.startsWith('voice: the hooks module stopped — it stopped answering'))).toBe(true)
  })

  it("a method's bound counts its own time: the $ calls it waits on stop it", async () => {
    const { runtime } = world(
      {
        // Listed before slow, so voice's step's `next(e)` holds `slow`.
        'voice/hooks/register.js': `
          export function register(on) {
            on('engine.create', async ($, e, next) => {
              const built = await next(e)
              return { ...built, voice: { say: async (text) => {
                for (let n = 0; n < 3; n++) await built.slow.wait()
                return 'voice:' + text
              } } }
            })
          }
        `,
        'slow/hooks/register.js': `
          export function register(on) {
            on('engine.create', async ($, e, next) => ({
              ...(await next(e)),
              slow: { wait: () => new Promise(resolve => setTimeout(resolve, 60)) },
            }))
          }
        `,
        'caller/hooks/register.js': `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              try { return next({ ...e, text: await $.voice.say(e.text) }) }
              catch (error) { return next({ ...e, text: error.name }) }
            })
          }
        `,
      },
      { serveTimeoutMs: 100, respawnBackoffMs: [60_000] },
    )
    await runtime.ready
    // ~180 ms on the wall, nearly all of it waiting on $.slow.
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'voice:hi' })
  })

  it("a $ wait begun before a method ran does not stop that method's bound", async () => {
    const { runtime } = world(
      {
        // kick's wait is caught: 90 ms plus the hops may run past slow's own bound.
        'voice/hooks/register.js': `
          export function register(on) {
            on('engine.create', async ($, e, next) => {
              const built = await next(e)
              return { ...built, voice: {
                kick: () => { built.slow.wait().catch(() => {}); return 'kicked' },
                idle: () => new Promise(resolve => setTimeout(() => resolve('done'), 160)),
              } }
            })
          }
        `,
        'slow/hooks/register.js': `
          export function register(on) {
            on('engine.create', async ($, e, next) => ({
              ...(await next(e)),
              slow: { wait: () => new Promise(resolve => setTimeout(resolve, 90)) },
            }))
          }
        `,
        'caller/hooks/register.js': `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              await $.voice.kick()
              try { return next({ ...e, text: await $.voice.idle() }) }
              catch (error) { return next({ ...e, text: error.name }) }
            })
          }
        `,
      },
      { serveTimeoutMs: 100, respawnBackoffMs: [60_000] },
    )
    await runtime.ready
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'TimeoutError' })
  })

  it('a reload of a plugin with no step runs no other plugin\'s step; their nouns keep serving', async () => {
    const caller = (tag: string) => `
      export function register(on) {
        on('prompt.submit', async ($, e, next) => next({ ...e, text: await $.voice.say(e.text) + '${tag}' }))
      }
    `
    const { runtime, reports, texts } = world({
      'voice/hooks/register.js': VOICE,
      'caller/hooks/register.js': caller(''),
    })
    await runtime.ready
    texts['caller/hooks/register.js'] = caller('')
    texts['caller/hooks/register.js'] += '\n// edited'
    const outcome = await runtime.reload(new Set(['caller/hooks/register.js']))
    expect(outcome.reloaded).toEqual(['caller/hooks/register.js'])
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['voice', 'loaded'],
      ['caller', 'loaded'],
    ])
    expect(reports.filter(line => /engine\.create step|failed/.test(line))).toEqual([])
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'voice:hi' })
  })

  /** Adds `$.voice.say` and hooks `voice.say` itself. */
  const SELF_HOOKED_VOICE = `
    export function register(on) {
      on('engine.create', async ($, e, next) => ({ ...(await next(e)), voice: { say: (text) => 'voice:' + text } }))
      on('voice.say', ($, e, next) => next(e + '?'))
    }
  `

  it('a plugin that hooks its own noun by name loads when switched on mid-session, as at the start', async () => {
    const { runtime, modules, texts } = world({
      'plain/hooks/register.js': `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => next({ ...e, text: await $.voice.say(e.text) }))
        }
      `,
      'voice/hooks/register.js': SELF_HOOKED_VOICE,
    })
    await runtime.ready
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'voice:hi?' })
    // Switched off, then on again: loaded alone this time.
    await runtime.reconcile(modules.slice(0, 1))
    texts['voice/hooks/register.js'] = SELF_HOOKED_VOICE
    await runtime.reconcile(modules)
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['plain', 'loaded'],
      ['voice', 'loaded'],
    ])
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'voice:hi?' })
  })

  it('plugins switched on together fold together: a caller listed before its provider loads', async () => {
    const { runtime, modules, texts } = world({
      'plain/hooks/register.js': `export function register(on) { on('session.start', () => {}) }`,
    })
    await runtime.ready
    texts['caller/hooks/register.js'] = `
      export function register(on) {
        on('prompt.submit', async ($, e, next) => next({ ...e, text: await $.voice.say(e.text) }))
      }
    `
    texts['voice/hooks/register.js'] = VOICE
    await runtime.reconcile([
      ...modules,
      { plugin: 'caller', path: 'caller/hooks/register.js', root: '/plugins/caller' },
      { plugin: 'voice', path: 'voice/hooks/register.js', root: '/plugins/voice' },
    ])
    expect(runtime.status().map(s => [s.plugin, s.state])).toEqual([
      ['plain', 'loaded'],
      ['caller', 'loaded'],
      ['voice', 'loaded'],
    ])
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'voice:hi' })
  })

  it('the engine\'s own nouns are on what a step builds on; a session whose modules add nothing runs no fold', async () => {
    const { runtime, reports } = world({
      'plain/hooks/register.js': `export function register(on) { on('prompt.submit', ($, e, next) => next(e)) }`,
    })
    await runtime.ready
    expect(runtime.status()[0]!.nouns).toBeUndefined()
    expect(reports).toEqual([])
    expect(runtime.dispatcher.hasHooksFor('engine.create')).toBe(false)
  })
})
