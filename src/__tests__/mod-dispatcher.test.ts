/**
 * The hook chain, with hooks running BESIDE it (plain functions): order,
 * outcomes, the budget clock, `.catch`, `next.to`, the trace and the recursion
 * skip. The same chain with hooks across a port is `mod-worker-link.test.ts`.
 *
 * Every rule asserted here is one the `claude-code` module's type
 * declarations state for the chain, plus Velloc's own nesting cap.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ModDispatchDepthError,
  ModDispatcher,
  ModHookUnreachableError,
  NextRejectionPassed,
  type CatchCall,
  type ChainLink,
  type HookCall,
  type HookFailureReport,
} from '../mods/ModDispatcher'
import {
  DISPATCH_CALL_RATE,
  DispatchCallRate,
  MAX_DISPATCH_DEPTH,
  ROOT_DISPATCH_CONTEXT,
  type PluginTier,
} from '../mods/modTypes'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let linkSeq = 0
function link(
  plugin: string,
  tier: PluginTier,
  pattern: string,
  run: (call: HookCall) => unknown,
  extra: { matcher?: unknown; runCatch?: (call: CatchCall) => unknown; id?: string } = {},
): ChainLink {
  const runCatch = extra.runCatch
  return {
    id: extra.id ?? `${plugin}/${++linkSeq}`,
    plugin,
    tier,
    pattern,
    ...(extra.matcher !== undefined ? { matcher: extra.matcher } : {}),
    run: async call => run(call),
    ...(runCatch ? { runCatch: async (call: CatchCall) => runCatch(call) } : {}),
  }
}

function setup(options: { budgetMs?: number; catchMs?: number } = {}) {
  const failures: HookFailureReport[] = []
  const dispatcher = new ModDispatcher({
    budgetMs: options.budgetMs ?? 5_000,
    catchMs: options.catchMs ?? 5_000,
    onHookFailure: report => failures.push(report),
  })
  return { dispatcher, failures }
}

describe('ModDispatcher — order', () => {
  it('is a plain call of core when no hook selects the event', async () => {
    const { dispatcher } = setup()
    dispatcher.register('a', [link('a', 'user', 'tool.call', call => call.next(call.e))])
    const e = { text: 'hi' }
    const result = { ok: true }
    expect(dispatcher.hasHooksFor('prompt.submit')).toBe(false)
    expect(dispatcher.hasHooksFor('tool.call')).toBe(true)
    // Same references in, same reference out: nothing was wrapped or copied.
    await expect(dispatcher.dispatch('prompt.submit', e, got => (got === e ? result : null))).resolves.toBe(result)
  })

  it('nests tiers outermost first — prepend, user, append, builtin, core — whatever the registration order', async () => {
    const { dispatcher } = setup()
    const order: string[] = []
    const hook = (name: string, tier: PluginTier) =>
      link(name, tier, 'tool.call', async call => {
        order.push(`>${name}`)
        const result = await call.next(call.e)
        order.push(`<${name}`)
        return result
      })
    dispatcher.register('builtin', [hook('builtin', 'builtin')])
    dispatcher.register('append', [hook('append', 'append')])
    dispatcher.register('user', [hook('user', 'user')])
    dispatcher.register('prepend', [hook('prepend', 'prepend')])
    await dispatcher.dispatch('tool.call', {}, () => {
      order.push('core')
      return 'done'
    })
    expect(order).toEqual([
      '>prepend', '>user', '>append', '>builtin', 'core', '<builtin', '<append', '<user', '<prepend',
    ])
  })

  it('within a tier: by the order the modules were registered, then the order of their hooks', async () => {
    const { dispatcher } = setup()
    const order: string[] = []
    const hook = (name: string) =>
      link(name, 'user', 'tool.call', call => {
        order.push(name)
        return call.next(call.e)
      })
    dispatcher.register('first', [hook('first.1'), hook('first.2')])
    dispatcher.register('second', [hook('second.1')])
    await dispatcher.dispatch('tool.call', {}, () => 'done')
    expect(order).toEqual(['first.1', 'first.2', 'second.1'])
  })

  it('a reload under the same key keeps its seat; unregister removes it', async () => {
    const { dispatcher } = setup()
    const order: string[] = []
    const hook = (name: string) =>
      link(name, 'user', 'tool.call', call => {
        order.push(name)
        return call.next(call.e)
      })
    dispatcher.register('a', [hook('a')])
    dispatcher.register('b', [hook('b')])
    dispatcher.register('a', [hook('a2')])
    await dispatcher.dispatch('tool.call', {}, () => 'done')
    expect(order).toEqual(['a2', 'b'])
    dispatcher.unregister('a')
    order.length = 0
    await dispatcher.dispatch('tool.call', {}, () => 'done')
    expect(order).toEqual(['b'])
  })
})

describe('ModDispatcher — answering and rewriting', () => {
  it('a hook that returns without next answers for itself: nothing beneath runs', async () => {
    const { dispatcher } = setup()
    let coreRan = false
    let lowerRan = false
    dispatcher.register('guard', [link('guard', 'user', 'tool.call', () => ({ deny: 'no' }))])
    dispatcher.register('lower', [
      link('lower', 'builtin', 'tool.call', call => {
        lowerRan = true
        return call.next(call.e)
      }),
    ])
    await expect(
      dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => {
        coreRan = true
        return { ok: true }
      }),
    ).resolves.toEqual({ deny: 'no' })
    expect([lowerRan, coreRan]).toEqual([false, false])
  })

  it('next({ ...e, x }) rewrites what the rest of the chain and core see', async () => {
    const { dispatcher } = setup()
    const seen: unknown[] = []
    dispatcher.register('rewrite', [
      link('rewrite', 'user', 'prompt.submit', call => call.next({ ...(call.e as object), text: 'rewritten' })),
    ])
    dispatcher.register('observe', [
      link('observe', 'builtin', 'prompt.submit', call => {
        seen.push(call.e)
        return call.next(call.e)
      }),
    ])
    await dispatcher.dispatch('prompt.submit', { text: 'typed' }, e => {
      seen.push(e)
      return { text: (e as { text: string }).text }
    })
    expect(seen).toEqual([{ text: 'rewritten' }, { text: 'rewritten' }])
  })

  it('each call of next runs the hooks beneath again', async () => {
    const { dispatcher } = setup()
    let coreRuns = 0
    dispatcher.register('twice', [
      link('twice', 'user', 'tool.call', async call => {
        await call.next(call.e)
        return call.next(call.e)
      }),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => ++coreRuns)).resolves.toBe(2)
  })

  it('tests a matcher against e as it ARRIVES at the link, after rewrites above it', async () => {
    const { dispatcher } = setup()
    const ran: string[] = []
    dispatcher.register('rename', [
      link('rename', 'user', 'tool.call', call => call.next({ ...(call.e as object), tool: 'Write' })),
    ])
    dispatcher.register('bash-only', [
      link('bash-only', 'builtin', 'tool.call', call => (ran.push('bash-only'), call.next(call.e)), {
        matcher: { tool: 'Bash' },
      }),
    ])
    dispatcher.register('write-only', [
      link('write-only', 'builtin', 'tool.call', call => (ran.push('write-only'), call.next(call.e)), {
        matcher: { tool: 'Write' },
      }),
    ])
    await dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => 'done')
    expect(ran).toEqual(['write-only'])
  })

  it('selects by pattern: a name, a glob, a negation', async () => {
    const { dispatcher } = setup()
    const ran: string[] = []
    const hook = (pattern: string) =>
      link(pattern, 'user', pattern, call => (ran.push(pattern), call.next(call.e)))
    dispatcher.register('p', [hook('tool.call'), hook('tool.*'), hook('*'), hook('!tool.call'), hook('prompt.submit')])
    await dispatcher.dispatch('tool.call', {}, () => 'done')
    expect(ran).toEqual(['tool.call', 'tool.*', '*'])
    ran.length = 0
    await dispatcher.dispatch('prompt.submit', {}, () => 'done')
    expect(ran).toEqual(['*', '!tool.call', 'prompt.submit'])
  })
})

describe('ModDispatcher — a hook that fails is absent, not fatal', () => {
  it('failed BEFORE next: the hooks beneath and core run in its place, on the e it was given', async () => {
    const { dispatcher, failures } = setup()
    const coreSaw: unknown[] = []
    dispatcher.register('broken', [
      link('broken', 'user', 'tool.call', () => {
        throw new Error('kaboom')
      }),
    ])
    await expect(
      dispatcher.dispatch('tool.call', { tool: 'Bash' }, e => (coreSaw.push(e), 'core result')),
    ).resolves.toBe('core result')
    expect(coreSaw).toEqual([{ tool: 'Bash' }])
    expect(failures).toMatchObject([
      { plugin: 'broken', event: 'tool.call', outcome: 'skipped', failure: { kind: 'throw', message: 'kaboom' } },
    ])
  })

  it("failed AFTER next: that run's result stands", async () => {
    const { dispatcher, failures } = setup()
    let coreRuns = 0
    dispatcher.register('broken', [
      link('broken', 'user', 'tool.call', async call => {
        await call.next(call.e)
        throw new Error('too late')
      }),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => `core#${++coreRuns}`)).resolves.toBe('core#1')
    expect(coreRuns).toBe(1)
    expect(failures).toMatchObject([{ outcome: 'kept', failure: { message: 'too late' } }])
  })

  it('returning nothing is a failure — unless the event takes it', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('silent', [link('silent', 'user', '*', () => undefined)])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toMatchObject([{ outcome: 'skipped', failure: { kind: 'throw', message: 'the hook returned nothing' } }])
    failures.length = 0
    // A void event: the hook answered (with nothing), so core does not run.
    let coreRan = false
    await expect(
      dispatcher.dispatch('ui.toast', {}, () => void (coreRan = true), { accepts: () => true }),
    ).resolves.toBeUndefined()
    expect(coreRan).toBe(false)
    expect(failures).toEqual([])
  })

  it('a result the event does not take is a failure too', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('wrong', [link('wrong', 'user', 'tool.call', () => 'not an object')])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => ({ ok: true }), { accepts: r => typeof r === 'object' && r !== null }),
    ).resolves.toEqual({ ok: true })
    expect(failures[0]!.failure.message).toBe('the hook returned a result this event does not take')
  })

  it('next() with no argument rejects, naming the hook', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('forgetful', [
      link('forgetful', 'user', 'tool.call', call => (call.next as (e?: unknown) => Promise<unknown>)()),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures[0]!.failure.message).toBe(
      "next() was called with no argument by forgetful's hook on tool.call",
    )
  })
})

describe('ModDispatcher — rejections travel up', () => {
  it('a rejection of core passes through every hook that lets it', async () => {
    const { dispatcher, failures } = setup()
    const boom = new Error('core refused')
    dispatcher.register('a', [link('a', 'user', 'tool.call', call => call.next(call.e))])
    dispatcher.register('b', [link('b', 'builtin', 'tool.call', call => call.next(call.e))])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    // Letting a rejection pass is not a failure of the hook.
    expect(failures).toEqual([])
  })

  it('a hook may catch the rejection and answer in its place', async () => {
    const { dispatcher } = setup()
    dispatcher.register('rescue', [
      link('rescue', 'user', 'tool.call', call => call.next(call.e).catch(() => ({ rescued: true }))),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        throw new Error('core refused')
      }),
    ).resolves.toEqual({ rescued: true })
  })

  it('a link across a port signals a passed rejection with NextRejectionPassed', async () => {
    const { dispatcher, failures } = setup()
    const boom = new Error('core refused')
    dispatcher.register('remote', [
      link('remote', 'user', 'tool.call', async call => {
        await call.next(call.e).catch(() => {})
        throw new NextRejectionPassed()
      }),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(failures).toEqual([])
  })

  it("a hook that fails on its own after next rejected cannot keep a result that isn't there", async () => {
    const { dispatcher, failures } = setup()
    const boom = new Error('core refused')
    dispatcher.register('broken', [
      link('broken', 'user', 'tool.call', async call => {
        await call.next(call.e).catch(() => {})
        throw new Error('and then I broke')
      }),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(failures).toMatchObject([{ outcome: 'rejected' }])
  })
})

describe("ModDispatcher — the budget is the hook's OWN time", () => {
  it('a hook that outruns it is absent; its signal aborts', async () => {
    const { dispatcher, failures } = setup({ budgetMs: 30 })
    let aborted = false
    dispatcher.register('slow', [
      link('slow', 'user', 'tool.call', async call => {
        call.signal.addEventListener('abort', () => (aborted = true))
        await sleep(200)
        return 'too late'
      }),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(aborted).toBe(true)
    expect(failures).toMatchObject([{ outcome: 'expired', failure: { kind: 'timeout' } }])
  })

  it('stands still while next is in flight: a slow chain beneath costs the hook nothing', async () => {
    const { dispatcher, failures } = setup({ budgetMs: 200 })
    dispatcher.register('patient', [
      link('patient', 'user', 'tool.call', async call => `saw ${String(await call.next(call.e))}`),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, async () => {
        await sleep(500)
        return 'core'
      }),
    ).resolves.toBe('saw core')
    expect(failures).toEqual([])
  })

  it('stands still while a $ call is in flight (whileWaiting), and reads on next.budget', async () => {
    const { dispatcher, failures } = setup({ budgetMs: 200 })
    const budgets: number[] = []
    dispatcher.register('caller', [
      link('caller', 'user', 'tool.call', async call => {
        budgets.push(call.budget().ms)
        const before = call.budget().remainingMs
        await call.whileWaiting(() => sleep(500))
        const after = call.budget().remainingMs
        budgets.push(before - after)
        return 'answered'
      }),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('answered')
    expect(failures).toEqual([])
    expect(budgets[0]).toBe(200)
    // 500 ms passed on the wall; the hook's own clock barely moved.
    expect(budgets[1]!).toBeLessThan(150)
  })

  it('expired AFTER next: the result beneath stands, reported expired', async () => {
    const { dispatcher, failures } = setup({ budgetMs: 30 })
    dispatcher.register('slow', [
      link('slow', 'user', 'tool.call', async call => {
        await call.next(call.e)
        await sleep(200)
        return 'too late'
      }),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toMatchObject([{ outcome: 'expired' }])
  })

  it('a hook that lingers past its budget can no longer reach the chain', async () => {
    const { dispatcher } = setup({ budgetMs: 20 })
    let coreRuns = 0
    let late: unknown
    const lingered = new Promise<void>(resolve => {
      dispatcher.register('linger', [
        link('linger', 'user', 'tool.call', async call => {
          await sleep(80)
          late = await call.next(call.e).catch((error: Error) => error.message)
          resolve()
          return 'too late'
        }),
      ])
    })
    await dispatcher.dispatch('tool.call', {}, () => ++coreRuns)
    await lingered
    expect(coreRuns).toBe(1)
    expect(late).toMatch(/after the dispatch had gone on without it/)
  })
})

describe('ModDispatcher — .catch', () => {
  it("the handler's answer stands as the hook's result", async () => {
    const { dispatcher, failures } = setup()
    let handed: Pick<CatchCall, 'error' | 'called'> | undefined
    let coreRan = false
    dispatcher.register('guarded', [
      link(
        'guarded',
        'user',
        'tool.call',
        () => {
          throw new Error('kaboom')
        },
        {
          runCatch: call => {
            handed = { error: call.error, called: call.called }
            return { deny: 'policy unavailable' }
          },
        },
      ),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => ((coreRan = true), 'core')),
    ).resolves.toEqual({ deny: 'policy unavailable' })
    expect(coreRan).toBe(false)
    expect(handed).toEqual({ error: { kind: 'throw', message: 'kaboom', budget: 5_000 }, called: false })
    expect(failures).toMatchObject([{ outcome: 'caught' }])
  })

  it("after a timeout the handler's signal is a live one of its own — the hook's was aborted", async () => {
    const { dispatcher } = setup({ budgetMs: 30 })
    let hookSignal: AbortSignal | undefined
    let handlerAborted: boolean | undefined
    dispatcher.register('slow', [
      link(
        'slow',
        'user',
        'tool.call',
        async call => {
          hookSignal = call.signal
          await sleep(200)
          return 'too late'
        },
        {
          runCatch: call => {
            handlerAborted = call.signal.aborted
            return { deny: 'timed out, so no' }
          },
        },
      ),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toEqual({
      deny: 'timed out, so no',
    })
    expect(hookSignal!.aborted).toBe(true)
    expect(handlerAborted).toBe(false)
  })

  it('a handler that returns undefined stands aside: the hook is absent', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('guarded', [
      link(
        'guarded',
        'user',
        'tool.call',
        () => {
          throw new Error('kaboom')
        },
        { runCatch: () => undefined },
      ),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toMatchObject([{ outcome: 'skipped' }])
  })

  it('its next is replay-safe when the hook HAD called next: nothing beneath runs again', async () => {
    const { dispatcher } = setup()
    let coreRuns = 0
    dispatcher.register('guarded', [
      link(
        'guarded',
        'user',
        'tool.call',
        async call => {
          await call.next(call.e)
          throw new Error('after next')
        },
        {
          runCatch: async call => {
            expect(call.called).toBe(true)
            // The argument is unread on a replay.
            const replayed = await call.next({ ignored: true })
            return `caught ${String(replayed)}`
          },
        },
      ),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => `core#${++coreRuns}`)).resolves.toBe('caught core#1')
    expect(coreRuns).toBe(1)
  })

  it('its next runs the hooks beneath ONCE when the hook had not, and replays after', async () => {
    const { dispatcher } = setup()
    let coreRuns = 0
    dispatcher.register('guarded', [
      link(
        'guarded',
        'user',
        'tool.call',
        () => {
          throw new Error('before next')
        },
        {
          runCatch: async call => {
            const first = await call.next(call.e)
            const second = await call.next(call.e)
            return `${String(first)}+${String(second)}`
          },
        },
      ),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => `core#${++coreRuns}`)).resolves.toBe('core#1+core#1')
    expect(coreRuns).toBe(1)
  })

  it('a handler that overruns its grace is as if there were none', async () => {
    const { dispatcher, failures } = setup({ catchMs: 20 })
    dispatcher.register('guarded', [
      link(
        'guarded',
        'user',
        'tool.call',
        () => {
          throw new Error('kaboom')
        },
        {
          runCatch: async () => {
            await sleep(150)
            return 'too late'
          },
        },
      ),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(failures).toMatchObject([{ outcome: 'skipped' }])
  })

  it('is asked on a timeout too, with what it is', async () => {
    const { dispatcher } = setup({ budgetMs: 20 })
    dispatcher.register('guarded', [
      link('guarded', 'user', 'tool.call', () => sleep(150).then(() => 'late'), {
        runCatch: call => `caught ${call.error.kind}`,
      }),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('caught timeout')
  })
})

describe('ModDispatcher — next.to', () => {
  function tiers(dispatcher: ModDispatcher, onPrepend: (call: HookCall) => unknown) {
    const ran: string[] = []
    const pass = (name: string, tier: PluginTier) =>
      link(name, tier, 'tool.call', call => (ran.push(name), call.next(call.e)))
    dispatcher.register('org-first', [link('org-first', 'prepend', 'tool.call', onPrepend)])
    dispatcher.register('user', [pass('user', 'user')])
    dispatcher.register('org-last', [pass('org-last', 'append')])
    dispatcher.register('builtin', [pass('builtin', 'builtin')])
    return ran
  }

  it("a prepend hook continues at append: the user's hooks are skipped, and traced as bypassed", async () => {
    const { dispatcher } = setup()
    let trace: ReturnType<HookCall['trace']> = []
    const ran = tiers(dispatcher, async call => {
      const result = await call.next(call.e, 'append')
      trace = call.trace()
      return result
    })
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    expect(ran).toEqual(['org-last', 'builtin'])
    expect(trace.map(t => [t.plugin, t.tier, t.outcome, t.reason])).toEqual([
      ['user', 'user', 'skipped', 'bypassed by org-first'],
      ['org-last', 'append', 'passed', undefined],
      ['builtin', 'builtin', 'passed', undefined],
      ['engine', 'core', 'returned', undefined],
    ])
  })

  it('a prepend hook may go straight to core', async () => {
    const { dispatcher } = setup()
    const ran = tiers(dispatcher, call => call.next(call.e, 'core'))
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(ran).toEqual([])
  })

  it("an append hook may name core, and nothing above it", async () => {
    const { dispatcher, failures } = setup()
    const ran: string[] = []
    dispatcher.register('org-last', [
      link('org-last', 'append', 'tool.call', call => call.next(call.e, 'core')),
    ])
    dispatcher.register('builtin', [
      link('builtin', 'builtin', 'tool.call', call => (ran.push('builtin'), call.next(call.e))),
    ])
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    expect(ran).toEqual([])
    expect(failures).toEqual([])
  })

  it("is refused to a user hook — no user hook skips the organization's", async () => {
    const { dispatcher, failures } = setup()
    const ran: string[] = []
    dispatcher.register('sneaky', [
      link('sneaky', 'user', 'tool.call', call => call.next(call.e, 'core')),
    ])
    dispatcher.register('org-last', [
      link('org-last', 'append', 'tool.call', call => (ran.push('org-last'), call.next(call.e))),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    // The refusal fails the hook; the chain goes on WITH the org's hook.
    expect(ran).toEqual(['org-last'])
    expect(failures[0]!.failure.message).toMatch(/next\.to\("core"\) is refused: sneaky sits in the user tier/)
  })

  it('is refused to a builtin hook, and to a target at or above its own tier', async () => {
    const { dispatcher, failures } = setup()
    dispatcher.register('builtin', [link('builtin', 'builtin', 'tool.call', call => call.next(call.e, 'core'))])
    dispatcher.register('org', [link('org', 'append', 'prompt.submit', call => call.next(call.e, 'append'))])
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    await dispatcher.dispatch('prompt.submit', {}, () => 'core')
    expect(failures.map(f => f.plugin)).toEqual(['builtin', 'org'])
    expect(failures[0]!.failure.message).toBe(
      'next.to("core") is refused: builtin sits in the builtin tier — only a managed plugin (prepend, append) may use next.to',
    )
    expect(failures[1]!.failure.message).toBe(
      'next.to("append") is refused: org sits in the append tier — it may name "core"',
    )
  })

  it('an append hook may NOT name builtin: it would skip its peers in the append tier', async () => {
    // The rule is an allowlist, not "any tier beneath my own". `builtin` IS
    // beneath `append`, and admitting it lets one appended managed plugin
    // silently bypass another — which is what the tier gate exists to stop.
    const { dispatcher, failures } = setup()
    const ran: string[] = []
    dispatcher.register('org-a', [
      link('org-a', 'append', 'tool.call', call => call.next(call.e, 'builtin' as never)),
    ])
    dispatcher.register('org-b', [
      link('org-b', 'append', 'tool.call', call => (ran.push('org-b'), call.next(call.e))),
    ])
    dispatcher.register('builtin', [
      link('builtin', 'builtin', 'tool.call', call => (ran.push('builtin'), call.next(call.e))),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    // The refusal fails org-a's hook; its PEER still runs, and so does builtin.
    expect(ran).toEqual(['org-b', 'builtin'])
    expect(failures).toMatchObject([{ plugin: 'org-a', outcome: 'skipped' }])
    expect(failures[0]!.failure.message).toBe(
      'next.to("builtin") is refused: org-a sits in the append tier — it may name "core"',
    )
  })

  it('a prepend hook may not name user or prepend — neither is a target at all', async () => {
    const { dispatcher, failures } = setup()
    const ran: string[] = []
    dispatcher.register('org', [
      link('org', 'prepend', 'tool.call', call => call.next(call.e, 'user' as never)),
      link('org', 'prepend', 'prompt.submit', call => call.next(call.e, 'prepend' as never)),
    ])
    dispatcher.register('user', [
      link('user', 'user', '*', call => (ran.push('user'), call.next(call.e))),
    ])
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    await dispatcher.dispatch('prompt.submit', {}, () => 'core')
    expect(ran).toEqual(['user', 'user'])
    expect(failures.map(f => f.failure.message)).toEqual([
      'next.to("user") is refused: org sits in the prepend tier — it may name "append", "builtin", "core"',
      'next.to("prepend") is refused: org sits in the prepend tier — it may name "append", "builtin", "core"',
    ])
  })

  it('refuses a tier that is not one — whatever a module passed', async () => {
    const { dispatcher, failures } = setup()
    const bogus: unknown[] = ['kernel', '', 'constructor', '__proto__', 3, null, { tier: 'core' }]
    let coreRuns = 0
    for (const tier of bogus) {
      dispatcher.register('org', [
        link('org', 'prepend', 'tool.call', call => call.next(call.e, tier as never)),
      ])
      await dispatcher.dispatch('tool.call', {}, () => ++coreRuns)
    }
    expect(coreRuns).toBe(bogus.length)
    expect(failures).toHaveLength(bogus.length)
    for (const failure of failures) {
      expect(failure.failure.message).toMatch(/^next\.to\(.*\) is refused: org sits in the prepend tier/)
    }
  })

  it('prepend may name builtin: the user and append tiers are skipped, builtin is not', async () => {
    const { dispatcher } = setup()
    const ran = tiers(dispatcher, call => call.next(call.e, 'builtin'))
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    expect(ran).toEqual(['builtin'])
  })
})

describe('ModDispatcher — the trace', () => {
  it('lists the links beneath for the latest next call: nearest first, the engine last', async () => {
    const { dispatcher } = setup()
    let before: ReturnType<HookCall['trace']> = []
    let after: ReturnType<HookCall['trace']> = []
    dispatcher.register('top', [
      link('top', 'prepend', 'tool.call', async call => {
        before = call.trace()
        const result = await call.next(call.e)
        after = call.trace()
        return result
      }),
    ])
    dispatcher.register('answers', [
      link('answers', 'user', 'tool.call', async call => ({ wrapped: await call.next({ tool: 'rewritten' }) })),
    ])
    dispatcher.register('broken', [
      link('broken', 'builtin', 'tool.call', () => {
        throw new Error('kaboom')
      }),
    ])
    await dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => 'core')
    expect(before).toEqual([])
    expect(after.map(t => [t.index, t.plugin, t.tier, t.outcome])).toEqual([
      [1, 'answers', 'user', 'returned'],
      [2, 'broken', 'builtin', 'skipped'],
      [3, 'engine', 'core', 'returned'],
    ])
    expect(after[0]).toMatchObject({ event: 'tool.call', received: { tool: 'Bash' }, returned: { wrapped: 'core' } })
    expect(after[1]).toMatchObject({ received: { tool: 'rewritten' }, returned: undefined })
    expect(after[2]).toMatchObject({ received: { tool: 'rewritten' }, returned: 'core' })
    for (const entry of after) expect(entry.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('ModDispatcher — who raised it, and the recursion skip', () => {
  it("every hook of one dispatch sees the same origin; the engine's by default", async () => {
    const { dispatcher } = setup()
    const origins: unknown[] = []
    dispatcher.register('a', [link('a', 'user', 'tool.call', call => (origins.push(call.origin), call.next(call.e)))])
    dispatcher.register('b', [link('b', 'builtin', 'tool.call', call => (origins.push(call.origin), call.next(call.e)))])
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    expect(origins).toEqual([
      { plugin: 'engine', tier: 'core' },
      { plugin: 'engine', tier: 'core' },
    ])
  })

  it("a $ call from a hook raises a dispatch from the TOP, skipping every hook whose own call is pending above it", async () => {
    const { dispatcher } = setup()
    const ran: string[] = []
    const origins: unknown[] = []
    // `caller` hooks fs.write and, inside it, makes the same call on `$`.
    const caller = link(
      'acme',
      'user',
      'fs.write',
      async call => {
        ran.push(`caller(depth ${call.context.depth - 1})`)
        if ((call.e as { nested?: boolean }).nested) return call.next(call.e)
        // What `$.fs.write` does: the same event, raised with this hook's context.
        await dispatcher.dispatch('fs.write', { nested: true }, () => 'inner core', { context: call.context })
        return call.next(call.e)
      },
      { id: 'acme/caller' },
    )
    // The same plugin's OTHER hook on the event: it is NOT skipped.
    const sibling = link('acme', 'user', 'fs.write', call => {
      ran.push('sibling')
      origins.push(call.origin)
      return call.next(call.e)
    })
    // A hook ABOVE the caller, of its tier: its `next` is pending, so its frame
    // is skipped too.
    const above = link('org', 'user', 'fs.write', call => (ran.push('above'), call.next(call.e)))
    dispatcher.register('org', [above])
    dispatcher.register('acme', [caller, sibling])
    await dispatcher.dispatch('fs.write', {}, () => 'outer core')
    expect(ran).toEqual([
      'above', 'caller(depth 0)',   // the engine's dispatch reaches the caller
      'sibling',                    // the caller's own: from the top, the caller and above skipped
      'sibling',                    // …then the outer chain continues beneath the caller
    ])
    expect(origins).toEqual([
      { plugin: 'acme', tier: 'user' },   // raised by acme's hook
      { plugin: 'engine', tier: 'core' }, // raised by the engine
    ])
  })

  it('two hooks calling each other back through $ end at once: each frame is skipped beneath itself', async () => {
    const { dispatcher, failures } = setup()
    const ran: string[] = []
    let coreRuns = 0
    const pingPong = (name: string) =>
      link(name, 'user', 'fs.write', async call => {
        ran.push(`${name}(depth ${call.context.depth - 1})`)
        await dispatcher.dispatch('fs.write', call.e, () => ++coreRuns, { context: call.context })
        return call.next(call.e)
      })
    dispatcher.register('a', [pingPong('a')])
    dispatcher.register('b', [pingPong('b')])
    await dispatcher.dispatch('fs.write', {}, () => ++coreRuns)
    // b on the outer chain runs beneath a's pending `next`: its call skips both.
    expect(ran).toEqual(['a(depth 0)', 'b(depth 1)', 'b(depth 0)'])
    expect(coreRuns).toBe(4)
    expect(failures).toEqual([])
  })

  it("a $ call from beneath a guard of a higher tier still passes that guard; the caller is skipped, no .catch asked", async () => {
    const { dispatcher, failures } = setup()
    const ran: string[] = []
    const asked: string[] = []
    // `guard` calls next; `inner`, beneath it, makes a $ call of the event.
    const guard = link('guard', 'prepend', 'tool.call', call => (ran.push('guard'), call.next(call.e)), {
      runCatch: () => (asked.push('guard'), { deny: 'no' }),
    })
    const inner = link(
      'inner',
      'user',
      'tool.call',
      async call => {
        ran.push('inner')
        if (!(call.e as { nested?: boolean }).nested) {
          await dispatcher.dispatch('tool.call', { nested: true }, () => 'inner core', { context: call.context })
        }
        return call.next(call.e)
      },
      { runCatch: () => (asked.push('inner'), { deny: 'no' }) },
    )
    dispatcher.register('guard', [guard])
    dispatcher.register('inner', [inner])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core')).resolves.toBe('core')
    // The nested call passes the prepend guard again; the caller is skipped.
    expect(ran).toEqual(['guard', 'inner', 'guard'])
    expect(asked).toEqual([])
    expect(failures).toEqual([])
  })

  it('refuses a dispatch raised past the cap', async () => {
    const { dispatcher } = setup()
    await expect(
      dispatcher.dispatch('fs.write', {}, () => 'core', {
        context: { origin: { plugin: 'a', tier: 'user' }, depth: MAX_DISPATCH_DEPTH + 1 },
      }),
    ).rejects.toBeInstanceOf(ModDispatchDepthError)
  })
})

describe('ModDispatcher — a hook that cannot answer', () => {
  const deny = (reason: string) => ({ deny: reason })
  const unreachable = (plugin: string) => new ModHookUnreachableError(plugin, 'its worker is gone')

  it('refuses an action that declares a refusal; core never runs and no .catch is asked', async () => {
    const { dispatcher, failures } = setup()
    const asked: string[] = []
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', () => Promise.reject(unreachable('a')), {
        runCatch: () => (asked.push('a'), { result: 'caught' }),
      }),
    ])
    let coreRuns = 0
    await expect(
      dispatcher.dispatch('tool.call', {}, () => ++coreRuns, { refusal: deny }),
    ).resolves.toEqual({ deny: "a's hook on tool.call could not answer (its worker is gone)" })
    expect(coreRuns).toBe(0)
    expect(asked).toEqual([])
    expect(failures.map(f => [f.plugin, f.failure.message, f.outcome])).toEqual([
      ['a', 'its worker is gone; the action is refused', 'returned'],
    ])
  })

  it('after its next ran, the refusal still stands: what ran beneath is withheld', async () => {
    const { dispatcher } = setup()
    let coreRuns = 0
    const traces: unknown[] = []
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', async call => {
        await call.next(call.e)
        throw unreachable('a')
      }),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => ++coreRuns, {
        refusal: deny,
        trace: entries => traces.push(entries.map(entry => [entry.plugin, entry.outcome, entry.reason])),
      }),
    ).resolves.toEqual({ deny: "a's hook on tool.call could not answer (its worker is gone)" })
    expect(coreRuns).toBe(1)
    expect(traces).toEqual([
      [
        ['a', 'returned', 'refused: its worker is gone'],
        ['engine', 'returned', undefined],
      ],
    ])
  })

  it('a hook lost while its next still runs refuses at once, without waiting on what runs beneath', async () => {
    const { dispatcher } = setup()
    let finishCore!: () => void
    const coreHeld = new Promise<string>(resolve => (finishCore = () => resolve('core')))
    let lose!: () => void
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', call => {
        void call.next(call.e)
        return new Promise((_, reject) => (lose = () => reject(unreachable('a'))))
      }),
    ])
    const settled = dispatcher.dispatch('tool.call', {}, () => coreHeld, { refusal: deny })
    await sleep(5)
    lose()
    await expect(settled).resolves.toEqual({ deny: "a's hook on tool.call could not answer (its worker is gone)" })
    finishCore()
  })

  it('passStandIns: a restarting seat is passed over even where a refusal is declared', async () => {
    const { dispatcher } = setup()
    dispatcher.register('a', [link('a', 'user', 'plugin.register', call => call.next(call.e))])
    dispatcher.vacate('a')
    await expect(
      dispatcher.dispatch('plugin.register', {}, () => ({ allow: true }), {
        refusal: reason => ({ refuse: reason }),
        passStandIns: true,
      }),
    ).resolves.toEqual({ allow: true })
  })

  it('without a refusal, such a hook is absent as a failed one: beneath runs in its place', async () => {
    const { dispatcher } = setup()
    dispatcher.register('a', [link('a', 'user', 'session.idle', () => Promise.reject(unreachable('a')))])
    await expect(dispatcher.dispatch('session.idle', {}, () => 'core')).resolves.toBe('core')
  })

  it('an error a hook throws is never taken for one, whatever its name', async () => {
    const { dispatcher } = setup()
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', () => {
        const forged = new Error('a: its worker is gone')
        forged.name = 'ModHookUnreachableError'
        throw forged
      }),
    ])
    await expect(dispatcher.dispatch('tool.call', {}, () => 'core', { refusal: deny })).resolves.toBe('core')
  })

  it("a seat whose worker restarts keeps its hooks as stand-ins: they refuse where a refusal is declared, as their matcher selects", async () => {
    const { dispatcher } = setup()
    const ran: string[] = []
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', call => (ran.push('a'), call.next(call.e)), { matcher: { tool: 'Bash' } }),
    ])
    dispatcher.register('b', [link('b', 'user', 'tool.call', call => (ran.push('b'), call.next(call.e)))])
    dispatcher.vacate('a')
    expect(dispatcher.hasHooksFor('tool.call')).toBe(true)
    expect(dispatcher.matchersFor('tool.call').map(m => m.plugin)).toEqual(['b'])
    await expect(dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => 'core', { refusal: deny })).resolves.toEqual({
      deny: "a's hook on tool.call could not answer (its hooks worker is restarting)",
    })
    expect(ran).toEqual([])
    // Its matcher does not select this call: it is not asked, nothing is refused.
    await expect(dispatcher.dispatch('tool.call', { tool: 'Read' }, () => 'core', { refusal: deny })).resolves.toBe('core')
    // An event with no refusal passes it over.
    await expect(dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => 'core')).resolves.toBe('core')
    expect(ran).toEqual(['b', 'b'])
    // The module back in its seat: its hook runs again, first.
    dispatcher.register('a', [link('a', 'user', 'tool.call', call => (ran.push('a2'), call.next(call.e)))])
    await dispatcher.dispatch('tool.call', { tool: 'Bash' }, () => 'core', { refusal: deny })
    expect(ran).toEqual(['b', 'b', 'a2', 'b'])
  })
})

describe('DispatchCallRate', () => {
  it('takes a burst at once, then one call per interval; a refused call takes nothing', () => {
    let now = 1_000
    const rate = new DispatchCallRate(() => now)
    for (let i = 0; i < DISPATCH_CALL_RATE.burst; i++) expect(rate.take()).toBe(true)
    expect(rate.take()).toBe(false)
    expect(rate.take()).toBe(false)
    now += 1000 / DISPATCH_CALL_RATE.perSecond
    expect(rate.take()).toBe(true)
    expect(rate.take()).toBe(false)
    // Idle for a second: that second's calls are back, never more than the burst.
    now += 60_000
    for (let i = 0; i < DISPATCH_CALL_RATE.burst; i++) expect(rate.take()).toBe(true)
    expect(rate.take()).toBe(false)
  })

  it("meters each plugin on its own: one plugin's burst does not spend another's", () => {
    const rate = new DispatchCallRate(() => 0)
    for (let i = 0; i < DISPATCH_CALL_RATE.burst; i++) expect(rate.take('spinner')).toBe(true)
    expect(rate.take('spinner')).toBe(false)
    expect(rate.take('guard')).toBe(true)
  })

  it('reads a monotonic clock: a wall clock stepped back does not refuse a paced caller', () => {
    const wall = vi.spyOn(Date, 'now')
    try {
      const rate = new DispatchCallRate()
      wall.mockReturnValue(1_000_000)
      expect(rate.take('guard')).toBe(true)
      wall.mockReturnValue(1_000_000 - 60_000)
      for (let i = 0; i < 10; i++) expect(rate.take('guard')).toBe(true)
    } finally {
      wall.mockRestore()
    }
  })

  it('a caller pacing itself at the rate is never refused, however many calls it makes', () => {
    let now = 0
    const rate = new DispatchCallRate(() => now)
    for (let i = 0; i < 100_000; i++) {
      expect(rate.take()).toBe(true)
      now += 1000 / DISPATCH_CALL_RATE.perSecond
    }
  })
})

/** A root context whose clock never moves: the burst is the whole allowance. */
const frozenRoot = () => ({ ...ROOT_DISPATCH_CONTEXT, calls: new DispatchCallRate(() => 0) })

describe('ModDispatcher — the call rate', () => {
  it('starts one meter per root dispatch and hands the same one to every nested dispatch', async () => {
    const { dispatcher } = setup()
    const seen: DispatchCallRate[] = []
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', async call => {
        seen.push(call.context.calls!)
        // A `$` call's dispatch: nested under this one, with the same count.
        await dispatcher.dispatch('fs.write', {}, () => 'core', { context: call.context })
        return call.next(call.e)
      }),
      link('a', 'user', 'fs.write', call => {
        seen.push(call.context.calls!)
        return call.next(call.e)
      }),
    ])
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    await dispatcher.dispatch('tool.call', {}, () => 'core')
    expect(seen).toHaveLength(4)
    expect(seen[0]).toBeInstanceOf(DispatchCallRate)
    expect(seen[1]).toBe(seen[0])
    expect(seen[2]).not.toBe(seen[0])
    expect(seen[3]).toBe(seen[2])
  })

  it('a next called again counts: a tight retry loop is refused instead of re-running core without end', async () => {
    const { dispatcher } = setup()
    let cores = 0
    let ended: string | undefined
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', async call => {
        // Bounded: a regression fails the test instead of spinning on microtasks.
        for (let tries = 0; tries < DISPATCH_CALL_RATE.burst * 2; tries++) {
          try {
            await call.next(call.e)
          } catch (error) {
            if (/called next\(\) again faster than/.test(String(error))) {
              ended = String(error)
              return 'gave up'
            }
          }
        }
        return 'never refused'
      }),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        cores += 1
        throw new Error('still failing')
      }, { context: frozenRoot() }),
    ).resolves.toBe('gave up')
    expect(cores).toBe(DISPATCH_CALL_RATE.burst + 1)
    expect(ended).toMatch(
      /^Error: a's hook on tool\.call called next\(\) again faster than 100 a second after a burst of 512 calls in one dispatch/,
    )
  })

  it('a retry loop that paces itself is served past the burst', async () => {
    const { dispatcher } = setup()
    let now = 0
    const context = { ...ROOT_DISPATCH_CONTEXT, calls: new DispatchCallRate(() => now) }
    const wanted = DISPATCH_CALL_RATE.burst * 3
    let cores = 0
    dispatcher.register('a', [
      link('a', 'user', 'tool.call', async call => {
        // Bounded: a regression fails the test instead of spinning on microtasks.
        for (let tries = 0; tries < wanted * 2; tries++) {
          try {
            return await call.next(call.e)
          } catch (error) {
            if (/called next\(\) again faster than/.test(String(error))) throw error
            now += 1000 / DISPATCH_CALL_RATE.perSecond
          }
        }
        return 'gave up'
      }),
    ])
    await expect(
      dispatcher.dispatch('tool.call', {}, () => {
        cores += 1
        if (cores < wanted) throw new Error('not yet')
        return 'done'
      }, { context }),
    ).resolves.toBe('done')
    expect(cores).toBe(wanted)
  })
})

describe('ModDispatcher — a budget set per dispatch', () => {
  it("is what next.budget reads and when the hook expires", async () => {
    const { dispatcher, failures } = setup({ budgetMs: 5_000 })
    let read: number | undefined
    dispatcher.register('slow', [
      link('slow', 'user', 'session.end', async call => {
        read = call.budget().ms
        await sleep(300)
        return call.next(call.e)
      }),
    ])
    const began = Date.now()
    await expect(
      dispatcher.dispatch('session.end', {}, () => ({ ok: true }), { budgetMs: 40 }),
    ).resolves.toEqual({ ok: true })
    expect(Date.now() - began).toBeLessThan(250)
    expect(read).toBe(40)
    expect(failures.map(f => f.failure.kind)).toEqual(['timeout'])
  })
})

describe('ModDispatcher — abandoning a dispatch', () => {
  it("rejects AbortError and aborts every running hook's signal", async () => {
    const { dispatcher } = setup()
    const controller = new AbortController()
    let aborted = false
    dispatcher.register('slow', [
      link('slow', 'user', 'tool.call', async call => {
        call.signal.addEventListener('abort', () => (aborted = true))
        await sleep(200)
        return call.next(call.e)
      }),
    ])
    const pending = dispatcher.dispatch('tool.call', {}, () => 'core', { signal: controller.signal })
    await sleep(10)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(aborted).toBe(true)
  })

  it('hands every hook the scope the engine attached', async () => {
    const { dispatcher } = setup()
    const scope = { sessionId: 's1' }
    let seen: unknown
    dispatcher.register('a', [link('a', 'user', 'tool.call', call => ((seen = call.scope), call.next(call.e)))])
    await dispatcher.dispatch('tool.call', {}, () => 'core', { scope })
    expect(seen).toBe(scope)
  })
})
