/**
 * `classic.*` (F-25): Velloc's settings hooks as events beneath every plugin's hooks: what a mod sees, pre-empting
 * them, seeing their block, and no dispatch when nothing hooks the event. The executor is a scripted core.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import {
  CLASSIC_EVENTS_RAISED,
  aggregateOfClassicResult,
  classicResultOfAggregate,
  isClassicResult,
  isPreToolUseResult,
  preToolUseResultOfAggregate,
  type ClassicAggregate,
} from '../mods/classicEvent'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { runClassicHooks } from '../lifecycleHooks/classicThroughMods'
import type { HookBatchVerdict } from '../lifecycleHooks/runHooks'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniqueLoad = 0
function world(modules: Record<string, string>) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
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
    session: { id: () => 'sess-classic', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

const passing: ClassicAggregate = { blocked: false, errors: [], warnings: [], additionalContext: [], systemMessages: [] }
const blocking: ClassicAggregate = { blocked: true, errors: ['no secrets'], warnings: [], additionalContext: ['ctx'], systemMessages: ['note'] }
const full = (aggregate: ClassicAggregate): HookBatchVerdict => ({ ...aggregate, results: [] })

describe('the classic events raised', () => {
  it('are exactly the ones with a call site, each listed as raised', () => {
    expect(CLASSIC_EVENTS_RAISED).toEqual([
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact',
      'SessionStart', 'SessionEnd', 'SubagentStart', 'Notification', 'StopFailure',
      'PermissionRequest',
    ])
    for (const event of CLASSIC_EVENTS_RAISED) expect(RAISED_EVENTS).toContain(`classic.${event}`)
    expect(RAISED_EVENTS).not.toContain('classic.WorktreeCreate')
  })

  it('a mod hooking classic.WorktreeCreate by name is refused at load; classic.* is admitted', async () => {
    const refused = world({ p: `on('classic.WorktreeCreate', ($, e, next) => next(e))` })
    await refused.runtime.ready
    expect(refused.runtime.status()).toMatchObject([{ state: 'refused' }])
    expect(refused.reports[0]).toMatch(/classic\.WorktreeCreate/)
    const admitted = world({ p: `on('classic.*', ($, e, next) => next(e))` })
    await admitted.runtime.ready
    expect(admitted.runtime.status()).toMatchObject([{ state: 'loaded' }])
    expect(admitted.runtime.hasClassicHooks('Stop')).toBe(true)
  })
})

describe('the shapes', () => {
  it('accepts a classic result and a PreToolUse decision, refuses the rest', () => {
    expect(isClassicResult({})).toBe(true)
    expect(isClassicResult({ block: 'no', additionalContext: ['a'], preventContinuation: true, stopReason: 'x' })).toBe(true)
    expect(isClassicResult({ block: 5 })).toBe(false)
    expect(isClassicResult({ additionalContext: 'a' })).toBe(false)
    expect(isClassicResult(undefined)).toBe(false)
    expect(isPreToolUseResult({})).toBe(true)
    expect(isPreToolUseResult({ allow: true })).toBe(true)
    expect(isPreToolUseResult({ ask: 'sure?' })).toBe(true)
    expect(isPreToolUseResult({ deny: 'no', updatedInput: { a: 1 } })).toBe(true)
    expect(isPreToolUseResult({ allow: true, deny: 'no' })).toBe(false)
    expect(isPreToolUseResult({ allow: false })).toBe(false)
    expect(isPreToolUseResult({ updatedInput: 'x' })).toBe(false)
  })

  it('maps an aggregate to a result and back, keeping the run when nothing changed', () => {
    expect(classicResultOfAggregate(blocking, 1)).toEqual({ block: 'no secrets', additionalContext: ['ctx'], ref: 1 })
    expect(classicResultOfAggregate(passing, 2)).toEqual({ ref: 2 })
    expect(preToolUseResultOfAggregate(blocking, 1)).toEqual({ deny: 'no secrets', additionalContext: ['ctx'], ref: 1 })
    const runs = new Map([[1, blocking]])
    expect(aggregateOfClassicResult({ block: 'no secrets', additionalContext: ['ctx'], ref: 1 }, runs)).toBe(blocking)
    expect(aggregateOfClassicResult({ deny: 'no secrets', additionalContext: ['ctx'], ref: 1 }, runs)).toBe(blocking)
    // A hook that lifted the block: the run's warnings and notes stay, the block goes.
    expect(aggregateOfClassicResult({ additionalContext: ['ctx'], ref: 1 }, runs)).toEqual({
      blocked: false, errors: [], warnings: [], additionalContext: ['ctx'], systemMessages: ['note'],
    })
    // A hook's own answer: no run behind it.
    expect(aggregateOfClassicResult({ block: 'mine' }, runs)).toEqual({
      blocked: true, errors: ['mine'], warnings: [], additionalContext: [], systemMessages: [],
    })
  })
})

describe('ModRuntime.classic', () => {
  it('is not raised, and core is not called by it, when no mod hooks the event', async () => {
    const { runtime } = world({ p: `on('classic.Stop', ($, e, next) => next(e))` })
    await runtime.ready
    expect(runtime.hasClassicHooks('PreCompact')).toBe(false)
    let coreRan = 0
    const settlement = await runtime.classic('PreCompact', { hook_event_name: 'PreCompact' }, async () => {
      coreRan += 1
      return passing
    })
    expect(settlement).toEqual({ settled: false })
    expect(coreRan).toBe(0)
  })

  it('a mod sees the classic input; next(e) resolves to the settings hooks\' block; a block lifted is lifted', async () => {
    const { runtime, reports } = world({
      p: `
        on('classic.UserPromptSubmit', async ($, e, next) => {
          const ran = await next(e)
          await $.ui.log('saw ' + JSON.stringify(e) + ' -> ' + JSON.stringify(ran))
          return e.prompt === 'let me' ? { ...ran, block: undefined } : ran
        })
      `,
    })
    await runtime.ready
    const e = { session_id: 's', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'show secrets' }
    const kept = await runtime.classic('UserPromptSubmit', e, async () => blocking)
    expect(kept).toEqual({ settled: true, aggregate: blocking })
    const lifted = await runtime.classic('UserPromptSubmit', { ...e, prompt: 'let me' }, async () => blocking)
    expect(lifted).toMatchObject({ settled: true, aggregate: { blocked: false, errors: [], additionalContext: ['ctx'], systemMessages: ['note'] } })
    expect(reports[0]).toBe(
      'p: saw {"session_id":"s","cwd":"/w","hook_event_name":"UserPromptSubmit","prompt":"show secrets"} -> {"block":"no secrets","additionalContext":["ctx"],"ref":1}',
    )
  })

  it('a mod answering without next pre-empts the settings hooks: they do not run', async () => {
    const { runtime } = world({ p: `on('classic.Stop', () => ({ block: 'one more turn' }))` })
    await runtime.ready
    let coreRan = 0
    const settlement = await runtime.classic('Stop', { hook_event_name: 'Stop', stop_hook_active: false }, async () => {
      coreRan += 1
      return passing
    })
    expect(coreRan).toBe(0)
    expect(settlement).toEqual({
      settled: true,
      aggregate: { blocked: true, errors: ['one more turn'], warnings: [], additionalContext: [], systemMessages: [] },
    })
  })

  it('PreToolUse: deny is a block; allow, ask and updatedInput are reported, not applied', async () => {
    const { runtime, reports } = world({
      p: `
        on('classic.PreToolUse', { tool: 'Read' }, ($, e, next) => ({ deny: 'not that file' }))
        on('classic.PreToolUse', { tool: 'Shell' }, async ($, e, next) => {
          const ran = await next(e)
          return { ...ran, updatedInput: { command: e.command + ' --safe' } }
        })
        on('classic.PreToolUse', { tool: 'Peek' }, () => ({ allow: true }))
        on('classic.PreToolUse', { tool: 'Ask' }, () => ({ ask: 'really?' }))
      `,
    })
    await runtime.ready
    const read = await runtime.classic('PreToolUse', { tool: 'Read', tool_use_id: 't1', file_path: '/x' }, async () => passing)
    expect(read).toEqual({ settled: true, aggregate: { blocked: true, errors: ['not that file'], warnings: [], additionalContext: [], systemMessages: [] } })
    const shell = await runtime.classic('PreToolUse', { tool: 'Shell', tool_use_id: 't2', command: 'ls' }, async () => passing)
    expect(shell).toEqual({ settled: true, aggregate: passing })
    const peek = await runtime.classic('PreToolUse', { tool: 'Peek', tool_use_id: 't3' }, async () => passing)
    expect(peek).toMatchObject({ settled: true, aggregate: { blocked: false } })
    const ask = await runtime.classic('PreToolUse', { tool: 'Ask', tool_use_id: 't4' }, async () => passing)
    expect(ask).toMatchObject({ settled: true, aggregate: { blocked: false } })
    expect(reports).toEqual([
      'mods: classic.PreToolUse answered { updatedInput }, which this engine does not support yet; the tool runs with the input the permission flow checked — rewrite arguments through tool.call',
      'mods: classic.PreToolUse answered { allow }, which this engine does not support yet; the call goes through the permission flow as before',
      'mods: classic.PreToolUse answered { ask }, which this engine does not support yet; the call goes through the permission flow as before',
    ])
  })

  it('a hook that fails or answers a wrong shape is skipped; core runs', async () => {
    const { runtime, reports } = world({
      p: `
        on('classic.PostCompact', () => { throw new Error('boom') })
        on('classic.PostCompact', () => 'bare')
      `,
    })
    await runtime.ready
    const settlement = await runtime.classic('PostCompact', { hook_event_name: 'PostCompact' }, async () => passing)
    expect(settlement).toEqual({ settled: true, aggregate: passing })
    expect(reports.filter(l => l.includes('skipped'))).toHaveLength(2)
  })
})

describe('runClassicHooks — the call-site helper', () => {
  it('with no mods, or none hooking the event, it is the executor call itself', async () => {
    let ran = 0
    const run = async () => {
      ran += 1
      return full(passing)
    }
    expect(await runClassicHooks(undefined, 'Stop', () => ({}), run)).toEqual(full(passing))
    expect(await runClassicHooks({ hasClassicHooks: () => false, classic: async () => ({ settled: false }) }, 'Stop', () => ({}), run)).toEqual(full(passing))
    expect(ran).toBe(2)
  })

  it('through the mods: the chain\'s aggregate, the executor\'s results only when its run stands; a failed chain falls back', async () => {
    const run = async () => ({ ...full(blocking), results: [{ hook: {} as never, outcome: { status: 'ok' } as never, durationMs: 1 }] })
    const kept = await runClassicHooks(
      { hasClassicHooks: () => true, classic: async (_e, _i, core) => ({ settled: true, aggregate: await core(new AbortController().signal) }) },
      'Stop', () => ({}), run,
    )
    expect(kept.results).toHaveLength(1)
    expect(kept.blocked).toBe(true)
    const own = await runClassicHooks(
      { hasClassicHooks: () => true, classic: async () => ({ settled: true, aggregate: passing }) },
      'PreToolUse', () => ({}), run,
    )
    expect(own).toEqual({ ...passing, results: [] })
    let ran = 0
    const fallback = await runClassicHooks(
      { hasClassicHooks: () => true, classic: async () => ({ settled: false }) },
      'Stop', () => ({}), async () => { ran += 1; return full(passing) },
    )
    expect(fallback).toEqual(full(passing))
    expect(ran).toBe(1)
  })

  it('a chain abandoned while core still runs waits for that run; the settings hooks do not run twice', async () => {
    let ran = 0
    let finish!: () => void
    const run = () => {
      ran += 1
      return new Promise<ReturnType<typeof full>>(resolve => { finish = () => resolve(full(blocking)) })
    }
    const result = runClassicHooks(
      {
        hasClassicHooks: () => true,
        classic: async (_e, _i, core) => {
          void core(new AbortController().signal)
          return { settled: false }
        },
      },
      'Stop', () => ({}), run,
    )
    await Promise.resolve()
    finish()
    expect(await result).toEqual(full(blocking))
    expect(ran).toBe(1)
  })
})
