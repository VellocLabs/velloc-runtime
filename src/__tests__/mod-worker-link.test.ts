/**
 * A mod end to end minus the Worker: `register` runs in `ModWorkerHost` on one end of a real MessageChannel and
 * `ModInstance` seats its hooks in a real `ModDispatcher` on the other; everything the hook is handed crosses the
 * port.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModDispatcher, type HookFailureReport } from '../mods/ModDispatcher'
import { MAX_HANDED_DEPTH, nestsDeeperThan } from '../mods/modWire'
import { ModInstance, type ModCall, type ModCallServer } from '../mods/ModInstance'
import { installModWorkerHost, type HooksModule } from '../mods/ModWorkerHost'
import { DISPATCH_CALL_RATE, DispatchCallRate, ROOT_DISPATCH_CONTEXT, type PluginTier } from '../mods/modTypes'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/* eslint-disable @typescript-eslint/no-explicit-any -- a hooks module is untyped JS here */
type On = (pattern: any, a?: any, b?: any) => { catch(handler: any): void }
type Register = (on: On, options: any) => unknown

const open: MessagePort[] = []
afterEach(() => {
  for (const port of open.splice(0)) port.close()
})

function world(options: { budgetMs?: number; catchMs?: number } = {}) {
  const failures: HookFailureReport[] = []
  const dispatcher = new ModDispatcher({
    budgetMs: options.budgetMs ?? 5_000,
    catchMs: options.catchMs ?? 5_000,
    onHookFailure: report => failures.push(report),
  })
  const mod = (
    plugin: string,
    register: Register,
    extra: { tier?: PluginTier; serveCall?: ModCallServer; generation?: number } = {},
  ) => {
    const channel = new MessageChannel()
    open.push(channel.port1, channel.port2)
    installModWorkerHost(channel.port2, {
      loadModule: async () => ({ register }) as unknown as HooksModule,
    })
    const instance = new ModInstance({
      key: plugin,
      plugin,
      tier: extra.tier ?? 'user',
      generation: extra.generation ?? 1,
      peer: channel.port1,
      dispatcher,
      serveCall:
        extra.serveCall ??
        (async call => {
          throw new Error(`$.${call.noun}.${call.method} is not served in this test`)
        }),
    })
    return { instance, channel }
  }
  return { dispatcher, failures, mod }
}

/** `levels` objects, each the only value of the one above. */
function nested(levels: number): Record<string, unknown> {
  const top: Record<string, unknown> = {}
  let at = top
  for (let i = 1; i < levels; i++) {
    const inner: Record<string, unknown> = {}
    at.a = inner
    at = inner
  }
  return top
}

describe('loading a hooks module', () => {
  it('reports its registrations and seats them in the chain', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', { tool: 'Bash', input: { command: /^rm / } }, (_$: any, e: any, next: any) => next(e))
      on('prompt.submit', (_$: any, e: any, next: any) => next(e)).catch(() => undefined)
      on('classic.*', (_$: any, e: any, next: any) => next(e))
    })
    const hooks = await instance.load('unused', {})
    expect(hooks.map(h => [h.hookId, h.pattern, h.hasCatch])).toEqual([
      ['h1', 'tool.call', false],
      ['h2', 'prompt.submit', true],
      ['h3', 'classic.*', false],
    ])
    // The matcher crossed the port as data — the RegExp included.
    expect(hooks[0]!.matcher).toEqual({ tool: 'Bash', input: { command: /^rm / } })
    expect(dispatcher.hasHooksFor('tool.call')).toBe(true)
    expect(dispatcher.hasHooksFor('classic.Stop')).toBe(true)
    expect(dispatcher.hasHooksFor('ui.render')).toBe(false)
  })

  it('awaits an async register, and hands it its frozen options', async () => {
    const { mod } = world()
    let frozen = false
    const { instance } = mod('acme', async (on, options) => {
      await sleep(20)
      frozen = Object.isFrozen(options) && Object.isFrozen(options.nested)
      on(options.event, (_$: any, e: any, next: any) => next(e))
    })
    const hooks = await instance.load('unused', { event: 'tool.call', nested: { a: 1 } })
    expect(hooks.map(h => h.pattern)).toEqual(['tool.call'])
    expect(frozen).toBe(true)
  })

  it.each([
    ['a pattern that is not one', (on: On) => on('not a pattern', () => 1), /is not an event pattern/],
    ['a hook that is not a function', (on: On) => on('tool.call', 'nope'), /the hook is not a function/],
    ['a matcher that is not an object', (on: On) => on('tool.call', 'Bash', () => 1), /the matcher is not an object/],
    ['a second .catch', (on: On) => {
      const registration = on('tool.call', () => 1)
      registration.catch(() => 1)
      registration.catch(() => 1)
    }, /takes one \.catch/],
    ['a .catch on engine.create', (on: On) => on('engine.create', () => 1).catch(() => 1), /takes no \.catch/],
    ['a register that throws', () => {
      throw new Error('bad config')
    }, /bad config/],
  ])('does not load on %s — no hooks, no seat', async (_name, register, message) => {
    const { dispatcher, mod } = world()
    const { instance } = mod('acme', register as Register)
    await expect(instance.load('unused', {})).rejects.toThrow(message)
    expect(dispatcher.hasHooksFor('tool.call')).toBe(false)
  })

  it('does not load a module whose matcher is not plain data', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', { tool: () => true }, (_$: any, e: any, next: any) => next(e))
    })
    await expect(instance.load('unused', {})).rejects.toThrow(/^acme: /)
    expect(dispatcher.hasHooksFor('tool.call')).toBe(false)
  })

  it('does not load a module that exports no register', async () => {
    const dispatcher = new ModDispatcher()
    const channel = new MessageChannel()
    open.push(channel.port1, channel.port2)
    installModWorkerHost(channel.port2, { loadModule: async () => ({}) as unknown as HooksModule })
    const instance = new ModInstance({
      key: 'acme', plugin: 'acme', tier: 'user', generation: 1,
      peer: channel.port1, dispatcher, serveCall: async () => null,
    })
    await expect(instance.load('unused', {})).rejects.toThrow('acme: the hooks module does not export register(on, options)')
  })

  it('on() and .catch() after register returned throw', async () => {
    const { mod } = world()
    let late: On | undefined
    let registration: { catch(handler: any): void } | undefined
    const { instance } = mod('acme', on => {
      late = on
      registration = on('tool.call', (_$: any, e: any, next: any) => next(e))
    })
    await instance.load('unused', {})
    expect(() => late!('prompt.submit', () => 1)).toThrow('on() was called after register() returned')
    expect(() => registration!.catch(() => 1)).toThrow('.catch() was called after register() returned')
  })
})

describe('what a hook is handed', () => {
  it('e is its own copy, frozen to every depth; a rewrite is a copy passed to next', async () => {
    const { dispatcher, failures, mod } = world()
    const seen: Record<string, unknown> = {}
    const { instance } = mod('acme', on => {
      on('tool.call', (_$: any, e: any, next: any) => {
        seen.frozen = Object.isFrozen(e) && Object.isFrozen(e.input) && Object.isFrozen(e.input.args)
        try {
          e.input.command = 'ls'
        } catch (error) {
          seen.threw = (error as Error).name
        }
        return next({ ...e, input: { ...e.input, command: 'ls' } })
      })
    })
    await instance.load('unused', {})
    const original = { tool: 'Bash', input: { command: 'rm -rf /', args: [1] } }
    let coreSaw: unknown
    await dispatcher.dispatch('tool.call', original, e => ((coreSaw = e), { ok: true }))
    expect(seen).toEqual({ frozen: true, threw: 'TypeError' })
    expect(coreSaw).toEqual({ tool: 'Bash', input: { command: 'ls', args: [1] } })
    // The engine's own object was neither frozen nor touched.
    expect(Object.isFrozen(original)).toBe(false)
    expect(original.input.command).toBe('rm -rf /')
    expect(failures).toEqual([])
  })

  it('answering without next ends the chain', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod('guard', on => {
      on('tool.call', { tool: 'Bash' }, () => ({ deny: 'no shell here' }))
    })
    await instance.load('unused', {})
    let coreRan = false
    await expect(
      dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => ((coreRan = true), { ok: true })),
    ).resolves.toEqual({ deny: 'no shell here' })
    expect(coreRan).toBe(false)
    // The matcher is evaluated in the runtime: no round trip for a tool it does not name.
    await expect(dispatcher.dispatch('tool.call', { tool: 'Read' }, () => ({ ok: true }))).resolves.toEqual({ ok: true })
  })

  it('next carries event, origin, is, signal, budget — and trace once it was called', async () => {
    const { dispatcher, mod } = world({ budgetMs: 4_321 })
    const seen: Record<string, unknown> = {}
    const { instance } = mod('acme', on => {
      on('tool.*', async (_$: any, e: any, next: any) => {
        seen.event = next.event
        seen.origin = next.origin
        seen.is = [next.is('tool.call', e), next.is('tool.*', e), next.is('prompt.submit', e), next.is('!tool.call', e)]
        seen.signal = next.signal instanceof AbortSignal && !next.signal.aborted
        seen.budgetMs = next.budget.ms
        seen.remaining = next.budget.remainingMs > 0 && next.budget.remainingMs <= 4_321
        seen.traceBefore = next.trace
        seen.frozen = Object.isFrozen(next) && Object.isFrozen(next.origin)
        seen.noCatchFields = !('error' in next) && !('called' in next)
        const result = await next(e)
        seen.traceAfter = next.trace.map((t: any) => [t.plugin, t.tier, t.outcome])
        return result
      })
    })
    await instance.load('unused', {})
    await dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => ({ ok: true }))
    expect(seen).toEqual({
      event: 'tool.call',
      origin: { plugin: 'engine', tier: 'core' },
      is: [true, true, false, false],
      signal: true,
      budgetMs: 4_321,
      remaining: true,
      traceBefore: [],
      frozen: true,
      noCatchFields: true,
      traceAfter: [['engine', 'core', 'returned']],
    })
  })

  it('$ is not thenable, and a noun is the same table within one invocation', async () => {
    const { dispatcher, mod } = world()
    const seen: Record<string, unknown> = {}
    const { instance } = mod('acme', on => {
      on('tool.call', async ($: any, e: any, next: any) => {
        seen.then = [$.then, $.fs.then]
        seen.stable = $.fs === $.fs
        seen.awaited = (await $) === $
        return next(e)
      })
    })
    await instance.load('unused', {})
    await dispatcher.dispatch('tool.call', {}, () => 'ok')
    expect(seen).toEqual({ then: [undefined, undefined], stable: true, awaited: true })
  })
})

describe('$ — served by the runtime', () => {
  it('a call reaches serveCall with its noun, method and arguments, and its result comes back', async () => {
    const { dispatcher, mod } = world()
    const calls: Array<Pick<ModCall, 'plugin' | 'noun' | 'method' | 'args'>> = []
    const { instance } = mod(
      'acme',
      on => {
        on('prompt.submit', async ($: any, e: any, next: any) => {
          const count = Number((await $.store.get('count')) ?? 0) + 1
          await $.store.set('count', count)
          return next({ ...e, text: `${e.text} (#${count})` })
        })
      },
      {
        serveCall: async call => {
          calls.push({ plugin: call.plugin, noun: call.noun, method: call.method, args: [...call.args] })
          return call.method === 'get' ? 41 : undefined
        },
      },
    )
    await instance.load('unused', {})
    await expect(
      dispatcher.dispatch('prompt.submit', { text: 'hi' }, e => ({ text: (e as { text: string }).text })),
    ).resolves.toEqual({ text: 'hi (#42)' })
    expect(calls).toEqual([
      { plugin: 'acme', noun: 'store', method: 'get', args: ['count'] },
      { plugin: 'acme', noun: 'store', method: 'set', args: ['count', 42] },
    ])
  })

  it('a dispatch calling $ faster than the rate has the rest refused, in the hook, by name', async () => {
    const { dispatcher, mod } = world()
    let served = 0
    const { instance } = mod(
      'busy',
      on => {
        on('prompt.submit', async ($: any, e: any, next: any) => {
          let refused: string | undefined
          let made = 0
          for (let i = 0; i < 600 && refused === undefined; i++) {
            try {
              await $.session.id()
              made += 1
            } catch (error: any) {
              refused = `${error.name}: ${error.message}`
            }
          }
          return next({ ...e, text: `${made} ${refused ?? 'none'}` })
        })
      },
      { serveCall: async () => (served += 1, 's1') },
    )
    await instance.load('unused', {})
    // A clock that never moves: the burst is all the dispatch gets.
    const frozen = () => ({ context: { ...ROOT_DISPATCH_CONTEXT, calls: new DispatchCallRate(() => 0) } })
    const { burst } = DISPATCH_CALL_RATE
    const result = (await dispatcher.dispatch('prompt.submit', { text: 'hi' }, e => e, frozen())) as { text: string }
    expect(served).toBe(burst)
    expect(result.text).toBe(
      `${burst} ModDispatchCallsError: $.session.id: this dispatch of prompt.submit made $ calls ` +
        `faster than 100 a second after a burst of 512 (the hooks of busy and what they called); the call is refused`,
    )
    // The next dispatch starts a meter of its own.
    served = 0
    const again = (await dispatcher.dispatch('prompt.submit', { text: 'hi' }, e => e, frozen())) as { text: string }
    expect(again.text.startsWith(`${burst} `)).toBe(true)
  })

  it("a rejection carries its name and message into the hook", async () => {
    const { dispatcher, mod } = world()
    let caught: unknown
    const { instance } = mod(
      'acme',
      on => {
        on('tool.call', async ($: any, e: any, next: any) => {
          caught = await $.fs.read('/etc/shadow').catch((error: Error) => [error.name, error.message])
          return next(e)
        })
      },
      {
        serveCall: async () => {
          const error = new Error('outside the workspace')
          error.name = 'NotAllowedError'
          throw error
        },
      },
    )
    await instance.load('unused', {})
    await dispatcher.dispatch('tool.call', {}, () => 'ok')
    expect(caught).toEqual(['NotAllowedError', 'outside the workspace'])
  })

  it('an argument that is not plain data is refused in the worker, by name', async () => {
    const { dispatcher, mod } = world()
    let caught: unknown
    const { instance } = mod('acme', on => {
      on('tool.call', async ($: any, e: any, next: any) => {
        caught = await $.ui.toast(() => 'nope').catch((error: Error) => error.message)
        return next(e)
      })
    })
    await instance.load('unused', {})
    await dispatcher.dispatch('tool.call', {}, () => 'ok')
    expect(caught).toMatch(/^\$\.ui\.toast: an argument is not plain data/)
  })

  it('carries the calling hook as context: its plugin as origin, every pending frame as the recursion skip', async () => {
    const { dispatcher, mod } = world()
    const ran: string[] = []
    const origins: unknown[] = []
    // What a noun that raises its own event does with the context it is handed.
    const serveCall: ModCallServer = call =>
      dispatcher.dispatch(`${call.noun}.${call.method}`, call.args[0], () => 'written', {
        context: call.context,
      })
    const { instance: acme } = mod(
      'acme',
      on => {
        on('fs.write', async ($: any, e: any, next: any) => {
          ran.push('acme:caller')
          if (!e.nested) await $.fs.write({ path: e.path, nested: true })
          return next(e)
        })
        on('fs.write', (_$: any, e: any, next: any) => {
          ran.push('acme:sibling')
          origins.push(next.origin)
          return next(e)
        })
      },
      { serveCall },
    )
    const { instance: audit } = mod(
      'audit',
      on => {
        on('fs.write', (_$: any, e: any, next: any) => {
          ran.push('audit')
          origins.push(next.origin)
          return next(e)
        })
      },
      { tier: 'prepend', serveCall },
    )
    await acme.load('unused', {})
    await audit.load('unused', {})
    await dispatcher.dispatch('fs.write', { path: 'a.txt' }, () => 'written')
    expect(ran).toEqual([
      'audit', 'acme:caller',     // the engine's dispatch
      'acme:sibling',             // acme's own call: from the top, the caller and audit (its next pending) skipped
      'acme:sibling',             // the outer chain goes on beneath the caller
    ])
    expect(origins).toEqual([
      { plugin: 'engine', tier: 'core' }, // audit, on the engine's dispatch
      { plugin: 'acme', tier: 'user' },   // the sibling, on acme's call
      { plugin: 'engine', tier: 'core' }, // the sibling, on the engine's dispatch
    ])
  })

  it('costs the hook nothing while it is in flight — a $.clock wait excepted', async () => {
    const { dispatcher, failures, mod } = world({ budgetMs: 250 })
    const serveCall: ModCallServer = async () => {
      await sleep(600)
      return 'done'
    }
    const { instance } = mod(
      'acme',
      on => {
        on('tool.call', async ($: any, e: any, next: any) => {
          const before = next.budget.remainingMs
          await $.model.complete({ prompt: 'slow' })
          // 600 ms passed on the wall; the mirror in the worker agrees it was not the hook's.
          if (before - next.budget.remainingMs > 200) throw new Error('the budget mirror counted the $ call')
          return next(e)
        })
        on('prompt.submit', async ($: any, e: any, next: any) => {
          await $.clock.sleep(600)
          return next(e)
        })
      },
      { serveCall },
    )
    await instance.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toEqual([])
    // The same 600 ms, spent on `$.clock`: the hook's own time, and over budget.
    await expect(dispatcher.dispatch('prompt.submit', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toMatchObject([{ plugin: 'acme', event: 'prompt.submit', outcome: 'expired' }])
  })
})

describe('failure, across the port', () => {
  it('a hook that throws is reported by name and the chain goes on', async () => {
    const { dispatcher, failures, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', () => {
        throw new RangeError('kaboom')
      })
    })
    await instance.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toMatchObject([
      { plugin: 'acme', tier: 'user', event: 'tool.call', outcome: 'skipped', failure: { kind: 'throw', message: 'kaboom' } },
    ])
  })

  it('letting a rejection of next pass is not a failure: the engine gets its own error back', async () => {
    const { dispatcher, failures, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', (_$: any, e: any, next: any) => next(e))
    })
    await instance.load('unused', {})
    const boom = new Error('core refused')
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(failures).toEqual([])
  })

  it('the rejection reaches the hook with its name and message, and it may answer instead', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', (_$: any, e: any, next: any) =>
        next(e).catch((error: Error) => ({ rescued: `${error.name}: ${error.message}` })),
      )
    })
    await instance.load('unused', {})
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        const error = new Error('core refused')
        error.name = 'PermissionError'
        throw error
      }),
    ).resolves.toEqual({ rescued: 'PermissionError: core refused' })
  })

  it('next() with no argument rejects in the worker, naming the hook', async () => {
    const { dispatcher, failures, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', (_$: any, _e: any, next: any) => next())
    })
    await instance.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures[0]!.failure.message).toBe("next() was called with no argument by acme's hook on tool.call")
  })

  it("next.to from a user mod is refused by the runtime — it fails the hook, not the org's", async () => {
    const { dispatcher, failures, mod } = world()
    const ran: string[] = []
    const { instance: sneaky } = mod('sneaky', on => {
      on('tool.call', (_$: any, e: any, next: any) => next.to(e, 'core'))
    })
    const { instance: org } = mod(
      'org',
      on => {
        on('tool.call', (_$: any, e: any, next: any) => (ran.push('org'), next(e)))
      },
      { tier: 'append' },
    )
    await sneaky.load('unused', {})
    await org.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(ran).toEqual(['org'])
    expect(failures[0]!.failure.message).toMatch(/next\.to\("core"\) is refused: sneaky sits in the user tier/)
  })

  it('a tier that is not one, passed across the port, is refused with what was passed', async () => {
    // `next.to`'s tier is typed in the module, but the runtime receives
    // whatever string the worker sent — even from a managed plugin.
    const { dispatcher, failures, mod } = world()
    const ran: string[] = []
    const { instance: org } = mod(
      'org',
      on => {
        on('tool.call', (_$: any, e: any, next: any) => next.to(e, 'kernel'))
        on('prompt.submit', (_$: any, e: any, next: any) => next.to(e, 'builtin'))
      },
      { tier: 'append' },
    )
    const { instance: peer } = mod(
      'peer',
      on => {
        on('*', (_$: any, e: any, next: any) => (ran.push(`peer:${next.event}`), next(e)))
      },
      { tier: 'append' },
    )
    await org.load('unused', {})
    await peer.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    await expect(dispatcher.dispatch('prompt.submit', {}, () => 'core')).resolves.toBe('core')
    // Neither refusal skipped the peer managed plugin.
    expect(ran).toEqual(['peer:tool.call', 'peer:prompt.submit'])
    expect(failures.map(f => f.failure.message)).toEqual([
      'next.to("kernel") is refused: org sits in the append tier — it may name "core"',
      'next.to("builtin") is refused: org sits in the append tier — it may name "core"',
    ])
  })

  it('a managed mod may: next.to skips the tiers between, and the trace says who was bypassed', async () => {
    const { dispatcher, mod } = world()
    let trace: unknown
    const { instance: org } = mod(
      'org',
      on => {
        on('tool.call', async (_$: any, e: any, next: any) => {
          const result = await next.to(e, 'core')
          trace = next.trace.map((t: any) => [t.plugin, t.outcome, t.reason])
          return result
        })
      },
      { tier: 'prepend' },
    )
    const { instance: user } = mod('user', on => {
      on('tool.call', () => ({ deny: 'the user says no' }))
    })
    await org.load('unused', {})
    await user.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(trace).toEqual([
      ['user', 'skipped', 'bypassed by org'],
      ['engine', 'returned', undefined],
    ])
  })

  it('a hook over budget: its signal aborts in the worker and the chain has gone on', async () => {
    const { dispatcher, failures, mod } = world({ budgetMs: 30 })
    let aborted: Promise<boolean> | undefined
    const { instance } = mod('acme', on => {
      on('tool.call', async (_$: any, _e: any, next: any) => {
        aborted = new Promise(resolve => next.signal.addEventListener('abort', () => resolve(true)))
        await sleep(300)
        return 'too late'
      })
    })
    await instance.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toMatchObject([{ outcome: 'expired', failure: { kind: 'timeout' } }])
    await expect(aborted).resolves.toBe(true)
  })

  it('.catch runs afresh with error and called, and its next is replay-safe', async () => {
    const { dispatcher, mod } = world()
    let coreRuns = 0
    let handed: unknown
    const { instance } = mod('acme', on => {
      on('tool.call', async (_$: any, e: any, next: any) => {
        await next(e)
        throw new Error('after next')
      }).catch(async (_$: any, e: any, next: any) => {
        handed = { error: next.error, called: next.called }
        return { replayed: await next(e) }
      })
    })
    await instance.load('unused', {})
    await expect(dispatcher.dispatch('tool.call', {}, () => `core#${++coreRuns}`)).resolves.toEqual({
      replayed: 'core#1',
    })
    expect(coreRuns).toBe(1)
    expect(handed).toEqual({ error: { kind: 'throw', message: 'after next', budget: 5_000 }, called: true })
  })
})

describe('the instance', () => {
  it('drops and counts a frame of another generation', async () => {
    const { dispatcher, mod } = world()
    const { instance, channel } = mod(
      'acme',
      on => {
        on('tool.call', (_$: any, e: any, next: any) => next(e))
      },
      { generation: 7 },
    )
    await instance.load('unused', {})
    // A late frame from a worker of generation 6, on this instance's port.
    channel.port2.postMessage({ type: 'mod.result', generation: 6, invocationId: 'i1', result: 'ghost' })
    channel.port2.postMessage({ type: 'mod.loaded', generation: 6, hooks: [] })
    await sleep(20)
    expect(instance.staleFrames).toBe(2)
    // The real hook still answers; the ghost result reached nobody.
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
  })

  it('a reload under the same key takes the same seat with the new hooks', async () => {
    const { dispatcher, mod } = world()
    const ran: string[] = []
    const first = mod('acme', on => {
      on('tool.call', (_$: any, e: any, next: any) => (ran.push('acme v1'), next(e)))
    })
    const other = mod('other', on => {
      on('tool.call', (_$: any, e: any, next: any) => (ran.push('other'), next(e)))
    })
    await first.instance.load('unused', {})
    await other.instance.load('unused', {})
    const second = mod(
      'acme',
      on => {
        on('tool.call', (_$: any, e: any, next: any) => (ran.push('acme v2'), next(e)))
      },
      { generation: 2 },
    )
    await second.instance.load('unused', {})
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    expect(ran).toEqual(['acme v2', 'other'])
  })

  it('dispose leaves the chain and fails what is still running — the chain goes on', async () => {
    const { dispatcher, failures, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', async (_$: any, e: any, next: any) => {
        await sleep(300)
        return next(e)
      })
    })
    await instance.load('unused', {})
    const pending = dispatcher.dispatch('tool.call', {}, () => 'core')
    await sleep(20)
    instance.dispose()
    instance.dispose()
    await expect(pending).resolves.toBe('core')
    expect(failures).toMatchObject([{ outcome: 'skipped', failure: { message: 'acme: the mod was unloaded' } }])
    expect(dispatcher.hasHooksFor('tool.call')).toBe(false)
    await expect(instance.load('unused', {})).rejects.toThrow('the mod instance was disposed')
  })

  it('a register that never returns fails the load', async () => {
    const dispatcher = new ModDispatcher()
    const channel = new MessageChannel()
    open.push(channel.port1, channel.port2)
    installModWorkerHost(channel.port2, {
      loadModule: async () => ({ register: () => new Promise(() => {}) }) as unknown as HooksModule,
    })
    const instance = new ModInstance({
      key: 'acme', plugin: 'acme', tier: 'user', generation: 1,
      peer: channel.port1, dispatcher, serveCall: async () => null, loadTimeoutMs: 40,
    })
    await expect(instance.load('unused', {})).rejects.toThrow('acme: register() did not return within 40ms')
  })
})

describe('a hook whose worker cannot answer', () => {
  const deny = (reason: string) => ({ deny: reason })

  it('refuses the action when the module goes away mid-run, and the seat refuses until it is back', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', async (_$: any, e: any, next: any) => {
        await sleep(200)
        return next(e)
      })
    })
    await instance.load('unused', {})
    let coreRuns = 0
    const pending = dispatcher.dispatch('tool.call', {}, () => ++coreRuns, { refusal: deny })
    await sleep(30)
    instance.dispose({ keepSeat: true })
    await expect(pending).resolves.toEqual({ deny: "acme's hook on tool.call could not answer (the mod was unloaded)" })
    await expect(dispatcher.dispatch('tool.call', {}, () => ++coreRuns, { refusal: deny })).resolves.toEqual({
      deny: "acme's hook on tool.call could not answer (its hooks worker is restarting)",
    })
    expect(coreRuns).toBe(0)
  })

  it('withholds what already ran when the answer never comes back', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod('acme', on => {
      on('tool.call', async (_$: any, e: any, next: any) => {
        const ran = await next(e)
        await sleep(200)
        return ran
      })
    })
    await instance.load('unused', {})
    let coreRuns = 0
    const pending = dispatcher.dispatch('tool.call', {}, () => ++coreRuns, { refusal: deny })
    await sleep(60)
    expect(coreRuns).toBe(1)
    instance.dispose()
    await expect(pending).resolves.toEqual({ deny: "acme's hook on tool.call could not answer (the mod was unloaded)" })
  })

  it('lets an event with no refusal go on beneath, as before', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod('acme', on => {
      on('session.idle', async (_$: any, e: any, next: any) => {
        await sleep(200)
        return next(e)
      })
    })
    await instance.load('unused', {})
    const pending = dispatcher.dispatch('session.idle', {}, () => 'core')
    await sleep(30)
    instance.dispose()
    await expect(pending).resolves.toBe('core')
  })
})

describe('how deep a value a hook hands back may nest', () => {
  it('counts containers, iteratively; a cycle ends; bytes are leaves', () => {
    expect(MAX_HANDED_DEPTH).toBe(28_000)
    expect(nestsDeeperThan('text', 0)).toBe(false)
    expect(nestsDeeperThan(nested(MAX_HANDED_DEPTH), MAX_HANDED_DEPTH)).toBe(false)
    expect(nestsDeeperThan(nested(MAX_HANDED_DEPTH + 1), MAX_HANDED_DEPTH)).toBe(true)
    expect(nestsDeeperThan([[{ a: new Map([['k', new Set([[1]])]]) }]], 5)).toBe(true)
    expect(nestsDeeperThan([[{ a: new Map([['k', new Set([[1]])]]) }]], 6)).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(nestsDeeperThan(cyclic, 2)).toBe(false)
    // The view is one level; its million bytes are not walked.
    expect(nestsDeeperThan({ bytes: new Uint8Array(1_000_000) }, 2)).toBe(false)
  })

  it('refuses a result deeper than the limit, naming it: the hook failed', async () => {
    const { dispatcher, failures, mod } = world()
    const { instance } = mod('acme', on => {
      on('fs.write', () => nested(MAX_HANDED_DEPTH + 1))
    })
    await instance.load('unused', {})
    await expect(dispatcher.dispatch('fs.write', {}, () => 'core')).resolves.toBe('core')
    expect(failures.map(f => f.failure.message)).toEqual([
      "the hook's result is not plain data (it nests deeper than 28,000 levels)",
    ])
  })

  it('refuses next(e) and a $ call with an argument deeper than the limit', async () => {
    const { dispatcher, mod } = world()
    const { instance } = mod(
      'acme',
      on => {
        on('fs.write', async ($: any, e: any, next: any) => {
          const said: string[] = []
          await next(nested(MAX_HANDED_DEPTH + 1)).catch((error: Error) => said.push(error.message))
          await $.fs.read(nested(MAX_HANDED_DEPTH + 1)).catch((error: Error) => said.push(error.message))
          return { said }
        })
      },
      { serveCall: async () => 'served' },
    )
    await instance.load('unused', {})
    await expect(dispatcher.dispatch('fs.write', {}, () => 'core')).resolves.toEqual({
      said: [
        'next(e): e is not plain data (it nests deeper than 28,000 levels)',
        '$.fs.read: an argument is not plain data (it nests deeper than 28,000 levels)',
      ],
    })
  })
})
