/**
 * The cheap nouns (F-25): `$.plugin.name` / `.root`, the `$.session.*` values, `$.env.get` / `.set`,
 * `$.settings.read`, and the worker-side timers `$.clock.after` / `.every`. Real module text on a MessageChannel;
 * a mod reports through `$.ui.log` into `reports`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { implementedNouns, type ModNounHost } from '../mods/modNouns'
import { ModRuntime, SlotEnv, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
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

/** A slot whose modules are `register` bodies; `host` is what the session
 *  supplies beyond `id` and `cwd`. */
function world(
  modules: Record<string, string>,
  host: Partial<ModNounHost> = {},
  options: { roots?: Record<string, string>; budgetMs?: number } = {},
) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({
    plugin,
    path: `/plugins/${plugin}/hooks/register.js`,
    ...(options.roots?.[plugin] !== undefined ? { root: options.roots[plugin] } : {}),
  }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path =>
      `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 'sess-cheap', cwd: () => '/work/project', ...host },
    report: line => reports.push(line),
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

/** A `prompt.submit` hook that logs what `expr` evaluates to. */
const logging = (expr: string): string => `
  on('prompt.submit', async ($, e, next) => {
    try {
      await $.ui.log(JSON.stringify(await (${expr})))
    } catch (error) {
      await $.ui.log('ERR ' + error.name + ': ' + error.message)
    }
    return next(e)
  })
`

describe('the nouns are listed as raised events', () => {
  it('every cheap noun is implemented and raised', () => {
    for (const noun of [
      'session.root', 'session.model', 'session.turns', 'session.version',
      'session.surfaces', 'session.surface', 'session.repo',
      'env.get', 'env.set', 'settings.read', 'clock.after', 'clock.every',
    ]) {
      expect(implementedNouns(), noun).toContain(noun)
      expect(RAISED_EVENTS, noun).toContain(noun)
    }
  })
})

describe('$.telemetry', () => {
  it('log and mark resolve on a well-formed entry, reject a malformed one, and raise their events', async () => {
    const tries = [
      `$.telemetry.log({ event: 'pane_opened', props: { files: 2, wide: true, page: { value: 'ready', of: ['ready', 'later'] } } })`,
      `$.telemetry.mark({ feature: 'diff_pane', kind: 'ok' })`,
      `$.telemetry.mark({ feature: 'diff_pane', kind: 'sad', reason: 'no_git' })`,
      `$.telemetry.log({ event: 'pane_opened', props: { path: 'free text' } })`,
      `$.telemetry.log({ event: 'Pane Opened' })`,
      `$.telemetry.mark({ feature: 'diff_pane', kind: 'bad' })`,
      `$.telemetry.mark({ feature: 'diff_pane', kind: 'ok', reason: 'x' })`,
    ]
    const { runtime, reports } = world({
      recorder: `
        on('prompt.submit', async ($, e, next) => {
          for (const attempt of [${tries.map(t => `() => ${t}`).join(', ')}]) {
            try {
              await attempt()
              await $.ui.log('queued')
            } catch (error) {
              await $.ui.log('ERR ' + error.name)
            }
          }
          return next(e)
        })
      `,
      // Hooked by name, a plugin reads what was recorded.
      reader: `
        on('telemetry.log', ($, e, next) => { $.ui.log('saw ' + e.event); return next(e) })
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports.filter(line => line.startsWith('recorder:'))).toEqual([
      'recorder: queued',
      'recorder: queued',
      'recorder: queued',
      'recorder: ERR TypeError',
      'recorder: ERR TypeError',
      'recorder: ERR TypeError',
      'recorder: ERR TypeError',
    ])
    expect(reports).toContain('reader: saw pane_opened')
  })
})

describe('$.plugin', () => {
  it('name and root are values from plugin.json, not calls', async () => {
    const { runtime, reports } = world(
      { greeter: logging('({ name: $.plugin.name, root: $.plugin.root, isFn: typeof $.plugin.name })') },
      {},
      { roots: { greeter: '/home/u/.velloc/plugins/greeter' } },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'greeter: {"name":"greeter","root":"/home/u/.velloc/plugins/greeter","isFn":"string"}',
    ])
  })

  it('a ref without a root reads the plugin directory off the module path', async () => {
    const { runtime, reports } = world({ greeter: logging('$.plugin.root') })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['greeter: "/plugins/greeter"'])
  })

  it('the values are frozen', async () => {
    const { runtime, reports } = world({
      greeter: logging('(() => { try { $.plugin.name = "x"; return "changed" } catch (e) { return e.name } })()'),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['greeter: "TypeError"'])
  })
})

describe('$.session', () => {
  it('root is the project root, and the cwd when the host has none', async () => {
    const a = world({ p: logging('$.session.root()') }, { root: () => '/work' })
    await a.runtime.ready
    await a.runtime.promptSubmit('hi')
    expect(a.reports).toEqual(['p: "/work"'])
    const b = world({ p: logging('$.session.root()') })
    await b.runtime.ready
    await b.runtime.promptSubmit('hi')
    expect(b.reports).toEqual(['p: "/work/project"'])
  })

  it('model and turns are the engine\'s, read at the call', async () => {
    let turns = 0
    const { runtime, reports } = world(
      { p: logging('({ model: await $.session.model(), turns: await $.session.turns() })') },
      { model: () => 'claude-fable-5-1', turns: () => turns },
    )
    await runtime.ready
    turns = 3
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: {"model":"claude-fable-5-1","turns":3}'])
  })

  it('version is what the host reports', async () => {
    const { runtime, reports } = world(
      { p: logging('$.session.version()') },
      { version: () => ({ version: 'velloc/1', builtAt: '2026-10-03T00:00:00Z' }) },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: {"version":"velloc/1","builtAt":"2026-10-03T00:00:00Z"}'])
  })

  it('surfaces is [desktop] and surface is desktop', async () => {
    const { runtime, reports } = world({
      p: logging('({ surfaces: await $.session.surfaces(), surface: await $.session.surface() })'),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: {"surfaces":["desktop"],"surface":"desktop"}'])
  })

  it('repo is read from the working copy on each call; null outside one', async () => {
    let repo: Awaited<ReturnType<NonNullable<ModNounHost['repo']>>> = null
    const { runtime, reports } = world({ p: logging('$.session.repo()') }, { repo: async () => repo })
    await runtime.ready
    await runtime.promptSubmit('hi')
    repo = { root: '/work/project', remote: 'git@github.com:a/b.git', internal: false, name: null }
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'p: null',
      'p: {"root":"/work/project","remote":"git@github.com:a/b.git","internal":false,"name":null}',
    ])
  })

  it('a noun the host does not supply is refused by name, not guessed', async () => {
    const { runtime, reports } = world({ p: logging('$.session.model()') })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'p: ERR NotSupportedError: $.session.model is not available: this session does not supply it',
    ])
  })
})

describe('$.env', () => {
  it('get reads what set wrote; unset is undefined; set(undefined) unsets', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => {
        const before = await $.env.get('GIT_PAGER')
        await $.env.set('GIT_PAGER', 'cat')
        const after = await $.env.get('GIT_PAGER')
        await $.env.set('GIT_PAGER', undefined)
        const gone = await $.env.get('GIT_PAGER')
        return { before, after, gone }
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: {"after":"cat"}'])
  })

  it('the environment is the slot\'s: every module in it sees one map', async () => {
    const { runtime, reports } = world({
      writer: `on('session.start', async ($, e, next) => { await $.env.set('TEAM', 'blue'); return next(e) })`,
      reader: logging("$.env.get('TEAM')"),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['reader: "blue"'])
  })

  it('a host-supplied environment is used instead', async () => {
    const env = new SlotEnv()
    env.set('HOME', '/home/u')
    const { runtime, reports } = world({ p: logging("$.env.get('HOME')") }, { env })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: "/home/u"'])
  })

  it('a name that is not a string, or a value that is not, is a TypeError', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => {
        const a = await $.env.get(5).catch(e => e.name)
        const b = await $.env.set('X', 5).catch(e => e.name)
        return [a, b]
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ["TypeError","TypeError"]'])
  })

  it('set resolves {} once the variable is set or unset', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => [await $.env.set('GIT_PAGER', 'cat'), await $.env.set('GIT_PAGER', undefined)])()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: [{},{}]'])
  })

  it("a hook's { deny } before the write resolves { deny } and nothing is written; a deny after it, or a hook's own answer, does not", async () => {
    const { runtime, reports } = world({
      guard: `
        on('env.set', async ($, e, next) => {
          if (e.name === 'TOKEN') return { deny: 'no tokens here' }
          if (e.name === 'LATE') { await next(e); return { deny: 'too late' } }
          if (e.name === 'ANSWERED') return { value: {} }
          return next(e)
        })
      `,
      p: logging(`(async () => {
        const token = await $.env.set('TOKEN', 'abc')
        const late = await $.env.set('LATE', 'x')
        const answered = await $.env.set('ANSWERED', 'y')
        const plain = await $.env.set('PLAIN', 'z')
        return {
          token, late, answered, plain,
          read: [await $.env.get('TOKEN'), await $.env.get('LATE'), await $.env.get('ANSWERED'), await $.env.get('PLAIN')],
        }
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    const line = reports.find(r => r.startsWith('p: '))!
    expect(JSON.parse(line.slice('p: '.length))).toEqual({
      token: { deny: 'no tokens here' },
      late: {},
      answered: {},
      plain: {},
      read: [null, 'x', null, 'z'],
    })
  })

  it('is an event: another mod may rewrite a value as it is set, and sees the name', async () => {
    const { runtime, reports } = world({
      guard: `
        on('env.set', { name: 'TOKEN' }, ($, e, next) => next({ ...e, value: '<redacted>' }))
        on('env.get', ($, e, next) => { if (e.name === 'SECRET') return { value: undefined }; return next(e) })
      `,
      p: logging(`(async () => {
        await $.env.set('TOKEN', 'abc')
        await $.env.set('SECRET', 'xyz')
        return [await $.env.get('TOKEN'), await $.env.get('SECRET')]
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ["<redacted>",null]'])
  })
})

describe('a $ call\'s event answers { value } or { deny }', () => {
  it('next(e) resolves to { value }; a hook\'s { deny } rejects the caller with a DeniedError', async () => {
    const { runtime, reports } = world({
      guard: `
        on('session.root', async ($, e, next) => {
          const got = await next(e)
          await $.ui.log('saw ' + JSON.stringify(got))
          return { value: got.value + '/sub' }
        })
        on('session.turns', () => ({ deny: 'turns are private' }))
      `,
      p: logging(`(async () => [
        await $.session.root(),
        await $.session.turns().catch(e => e.name + ': ' + e.message),
      ])()`),
    }, { turns: () => 7 })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'guard: saw {"value":"/work/project"}',
      'p: ["/work/project/sub","DeniedError: turns are private"]',
    ])
  })

  it('a hook answering a bare value, or nothing, is skipped and core answers', async () => {
    const { runtime, reports } = world({
      sloppy: `
        on('session.root', () => '/elsewhere')
        on('session.cwd', () => undefined)
      `,
      p: logging(`(async () => [await $.session.root(), await $.session.cwd()])()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'sloppy: session.root hook failed: the hook returned a result this event does not take (skipped)',
      'sloppy: session.cwd hook failed: the hook returned nothing (skipped)',
      'p: ["/work/project","/work/project"]',
    ])
    expect(runtime.status()).toMatchObject([{ state: 'loaded' }, { state: 'loaded' }])
  })
})

describe('$.settings.read', () => {
  it('reads the merged settings, or one source, as the host answers', async () => {
    const asked: unknown[] = []
    const { runtime, reports } = world(
      {
        p: logging(`(async () => ({
          merged: await $.settings.read(),
          user: await $.settings.read({ source: 'user' }),
          policy: await $.settings.read({ source: 'policy' }),
        }))()`),
      },
      {
        settings: async args => {
          asked.push(args)
          return args.source === 'policy' ? {} : { permissions: { defaultMode: 'ask' } }
        },
      },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'p: {"merged":{"permissions":{"defaultMode":"ask"}},"user":{"permissions":{"defaultMode":"ask"}},"policy":{}}',
    ])
    expect(asked).toEqual([{}, { source: 'user' }, { source: 'policy' }])
  })

  it('refuses a source that is not one', async () => {
    const { runtime, reports } = world(
      { p: logging("$.settings.read({ source: 'global' })") },
      { settings: async () => ({}) },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports[0]).toMatch(/^p: ERR TypeError: \$\.settings\.read: source must be one of user, project, local, flag, policy$/)
  })
})

describe('$.clock timers — the callback lives in the worker', () => {
  it('after(ms, fn) runs fn once, in the worker, with a $ of its own', async () => {
    const { runtime, reports } = world({
      p: `
        let fired = 0
        on('session.start', ($, e, next) => {
          $.clock.after(20, () => { fired += 1; $.ui.log('fired ' + fired + ' cwd=' + typeof $.session.cwd) })
          return next(e)
        })
        on('prompt.submit', async ($, e, next) => { await $.ui.log('fired=' + fired); return next(e) })
      `,
    })
    await runtime.ready
    await until(() => reports.length >= 1)
    await sleep(60)
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: fired 1 cwd=function', 'p: fired=1'])
  })

  it('cancel() before it fires stops it', async () => {
    const { runtime, reports } = world({
      p: `
        on('session.start', ($, e, next) => {
          const timer = $.clock.after(30, () => $.ui.log('fired'))
          timer.cancel()
          $.clock.after(60, () => $.ui.log('later'))
          return next(e)
        })
      `,
    })
    await runtime.ready
    await until(() => reports.length >= 1)
    expect(reports).toEqual(['p: later'])
  })

  it('every(ms, fn) ticks until cancel(), one dispatch per period', async () => {
    const { runtime, reports } = world({
      watcher: `let periods = 0; on('clock.every', ($, e, next) => { periods += 1; return next(e) })
        on('prompt.submit', async ($, e, next) => { await $.ui.log('periods=' + periods); return next(e) })`,
      p: `
        let ticks = 0
        on('session.start', ($, e, next) => {
          const timer = $.clock.every(15, () => { ticks += 1; if (ticks === 3) { timer.cancel(); $.ui.log('ticked 3') } })
          return next(e)
        })
      `,
    })
    await runtime.ready
    await until(() => reports.includes('p: ticked 3'))
    await sleep(60)
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ticked 3', 'watcher: periods=3'])
  })

  it('a parked every or after does not keep the runtime busy; a sleep does', async () => {
    const { runtime, reports } = world({
      p: `
        on('session.start', ($, e, next) => {
          $.clock.every(60_000, () => {})
          $.clock.after(60_000, () => {})
          return next(e)
        })
        on('prompt.submit', async ($, e, next) => { await $.clock.sleep(e.text === 'nap' ? 80 : 0); return next(e) })
      `,
    })
    await runtime.ready
    await sleep(20)
    expect(runtime.isBusy()).toBe(false)
    const napping = runtime.promptSubmit('nap')
    await sleep(30)
    expect(runtime.isBusy()).toBe(true)
    await napping
    expect(runtime.isBusy()).toBe(false)
    expect(reports).toEqual([])
  })

  it('a hook above may refuse a period, and the interval ends; a refused after never runs', async () => {
    const { runtime, reports } = world({
      guard: `
        on('clock.after', ($, e, next) => { $.ui.log('refused after ' + e.ms); return { deny: 'no timers' } })
        on('clock.every', ($, e, next) => ({ deny: 'no timers' }))
      `,
      p: `
        on('session.start', ($, e, next) => {
          $.clock.after(5, () => $.ui.log('after ran'))
          $.clock.every(5, () => $.ui.log('every ran'))
          return next(e)
        })
      `,
    })
    await runtime.ready
    await until(() => reports.length >= 1)
    await sleep(80)
    expect(reports.filter(line => line.startsWith('p:'))).toEqual([])
    expect(reports).toContain('guard: refused after 5')
  })

  it('a callback that throws is reported under the plugin, and the timer goes on', async () => {
    const { runtime, reports } = world({
      p: `
        on('session.start', ($, e, next) => {
          let n = 0
          const timer = $.clock.every(10, () => { n += 1; if (n === 1) throw new Error('boom'); if (n === 2) { timer.cancel(); $.ui.log('second') } })
          return next(e)
        })
      `,
    })
    await runtime.ready
    await until(() => reports.includes('p: second'))
    expect(reports).toEqual(['p: a $.clock.every callback failed: boom', 'p: second'])
  })

  it('ms and fn are checked at the call', async () => {
    const { runtime, reports } = world({
      p: logging(`(() => {
        const errors = []
        try { $.clock.after(10, 'x') } catch (e) { errors.push(e.name) }
        try { $.clock.every(0, () => {}) } catch (e) { errors.push(e.name) }
        try { $.clock.after(-1, () => {}) } catch (e) { errors.push(e.name) }
        return errors
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ["TypeError","TypeError","TypeError"]'])
  })

  it('a timer does not count against any hook\'s budget', async () => {
    const { runtime, reports } = world(
      {
        p: `
          on('prompt.submit', async ($, e, next) => {
            $.clock.after(200, () => $.ui.log('fired'))
            return next({ ...e, text: e.text + ' ok' })
          })
        `,
      },
      {},
      { budgetMs: 50 },
    )
    await runtime.ready
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ entered: true, text: 'hi ok' })
    expect(reports.some(line => line.includes('ran out of time'))).toBe(false)
    await until(() => reports.includes('p: fired'))
  })
})

describe('$.clock.sleep with a signal', () => {
  it('aborting the signal rejects the sleep at once', async () => {
    const { runtime, reports } = world({
      p: `
        on('prompt.submit', async ($, e, next) => {
          const controller = new AbortController()
          setTimeout(() => controller.abort(), 10)
          const started = Date.now()
          const outcome = await $.clock.sleep(5000, { signal: controller.signal }).then(() => 'slept', err => err.name)
          await $.ui.log(outcome + ' quick=' + (Date.now() - started < 1000))
          return next(e)
        })
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: AbortError quick=true'])
  })

  it('a signal already aborted rejects without a round trip', async () => {
    const { runtime, reports } = world({
      p: logging(`$.clock.sleep(5000, { signal: AbortSignal.abort() }).then(() => 'slept', err => err.name)`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: "AbortError"'])
  })
})

describe('$.env.set beneath a draw', () => {
  it("an env.set hook raised from a ui.render hook keeps the draw's scope, as an env.get hook does", async () => {
    const { runtime, reports } = world({
      drawer: `
        on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
          await $.env.get('K')
          await $.env.set('K', 'v')
          const { Text } = $.ui.resolve(e)
          return Text({ children: ['drawn'] })
        })`,
      guard: `
        const tryWrite = ($, tag) => $.state.set({ plugin: 'guard', key: tag }, 1).then(() => 'written', err => err.name)
        on('env.get', async ($, e, next) => {
          await $.ui.log('env.get hook state.set: ' + await tryWrite($, 'get'))
          return next(e)
        })
        on('env.set', async ($, e, next) => {
          await $.ui.log('env.set hook state.set: ' + await tryWrite($, 'set'))
          return next(e)
        })`,
    })
    await runtime.ready
    await runtime.render({
      component: 'AbovePrompt',
      requestId: 'band',
      props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    })
    expect(reports).toContain('guard: env.get hook state.set: DeniedError')
    expect(reports).toContain('guard: env.set hook state.set: DeniedError')
  })
})
