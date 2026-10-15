/**
 * The four turn-level events — `turn.request`, `turn.continue`,
 * `turn.recover`, `ids.next` — through a real `ModRuntime` driving the replay
 * engine: no hook leaves the run as the engine's own; a hook rewrites, short-
 * circuits (answers without `next`), or throws and counts as absent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { engineWorld } from './engine-replay/harness/world'
import type { Trace } from './engine-replay/harness/trace'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ConversationEngineConfig } from '../engine/engineConfig'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0

async function modRuntime(source: string) {
  const reports: string[] = []
  const modules: ModModuleRef[] = [{ plugin: 'probe', path: 'probe/mod.js' }]
  const runtime = new ModRuntime({
    modules,
    readModule: async () => `${source}\n// load ${++uniq}`,
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
    session: { id: () => 'session-1', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  await runtime.ready
  return { runtime, reports }
}

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const toolRound = { label: 'round-1', calls: [{ id: 'act-1', name: 'Act' }] }
const done = { label: 'done', text: 'Done.' }
const overloaded = (label: string) => ({ label, streamError: { type: 'overloaded_error', message: 'Overloaded', httpStatus: 529 } })

type RunOptions = { replies: unknown[]; env?: Record<string, string>; queued?: unknown; prompt?: string }

async function run(runtime: ModRuntime | undefined, options: RunOptions): Promise<Trace> {
  const w = engineWorld({
    tools: [{ name: 'Act' }],
    replies: options.replies as never,
    ...(options.env ? { env: options.env } : {}),
    ...(options.queued ? { queued: options.queued as never } : {}),
    ...(runtime ? { config: { mods: runtime as unknown as ConversationEngineConfig['mods'] } } : {}),
  })
  await w.submit(options.prompt ?? 'check the header')
  return w.finish()
}

const comparable = (t: Trace) => ({
  modelRequests: t.modelRequests,
  transport: t.transport,
  retryDelays: t.retryDelays,
  toolCalls: t.toolCalls,
  emitted: t.emitted,
  terminal: t.terminal,
})
const text = (value: unknown) => JSON.stringify(value)
const typedOnce = { typed: (round: number) => (round === 1 ? [{ uuid: 'typed-1', prompt: 'also the footer', enqueuedAt: 10 }] : []) }

// A module that hooks none of the four (so each event's gate stays shut).
const UNRELATED = `export function register(on) { on('turn.complete', () => undefined); }`

describe('no hook', () => {
  it('leaves the run identical to the engine without mods', async () => {
    const options = { replies: [toolRound, done, title], queued: typedOnce }
    const bare = await run(undefined, options)
    const { runtime } = await modRuntime(UNRELATED)
    expect(runtime.hasTurnRequestHooks()).toBe(false)
    expect(runtime.hasTurnContinueHooks()).toBe(false)
    expect(runtime.hasTurnRecoverHooks()).toBe(false)
    expect(runtime.hasIdsNextHooks()).toBe(false)
    const modded = await run(runtime, options)
    expect(comparable(modded)).toEqual(comparable(bare))
  })
})

describe('turn.request', () => {
  const hello = { replies: [done, title], prompt: 'hello' }

  it('a hook rewrites the system prompt the model receives', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) {
        on('turn.request', async ($, e, next) => next({ ...e, system: e.system + ' MOD-SYSTEM-LINE' }));
      }`)
    const t = await run(runtime, hello)
    expect(text(t.modelRequests[0])).toContain('MOD-SYSTEM-LINE')
    expect(t.terminal).toEqual((await run(undefined, hello)).terminal)
  })

  it('a hook answering without next short-circuits with its own messages', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) {
        on('turn.request', ($, e) => ({ messages: [...e.messages, { role: 'user', content: 'MOD-ADDED' }] }));
      }`)
    const t = await run(runtime, hello)
    expect(text(t.modelRequests[0])).toContain('MOD-ADDED')
  })

  it('a hook that throws is absent: the request goes out as built', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) { on('turn.request', () => { throw new Error('boom'); }); }`)
    const bare = await run(undefined, hello)
    const t = await run(runtime, hello)
    expect(comparable(t)).toEqual(comparable(bare))
  })

  it('is raised once per request series: a retry resends the settled request', async () => {
    const { runtime } = await modRuntime(`
      let raised = 0;
      export function register(on) {
        on('turn.request', async ($, e, next) => next({ ...e, system: e.system + ' RAISED-' + (++raised) }));
      }`)
    const options = { env: { e2eProviderMaxRetries: '3' }, replies: [overloaded('attempt-1'), done, title], prompt: 'hello' }
    const t = await run(runtime, options)
    // The retry resends the settled request: its system prompt is the
    // first attempt's (the trace writes an unchanged one as a reference).
    expect(text(t.modelRequests[0])).toContain('RAISED-1')
    expect((t.modelRequests[1] as { systemPrompt: unknown }).systemPrompt).toBe('<same as previous request>')
    expect(text(t.modelRequests)).not.toContain('RAISED-2')
    expect(t.terminal).toEqual((await run(undefined, options)).terminal)
  })
})

describe('turn.recover', () => {
  const failing = { env: { e2eProviderMaxRetries: '3' }, replies: [overloaded('attempt-1'), done, title], prompt: 'hello' }

  it('a hook may replace the decision the ladder made', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) {
        on('turn.recover', async ($, e, next) => ({ ...(await next(e)), delayMs: 7 }));
      }`)
    const t = await run(runtime, failing)
    expect(t.retryDelays).toEqual([7])
  })

  it('a hook answering without next ends the call: no retry', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) { on('turn.recover', () => ({ retry: false })); }`)
    const t = await run(runtime, { ...failing, replies: [overloaded('attempt-1')] })
    expect(t.retryDelays).toEqual([])
    expect(text(t.terminal)).toContain('api_error')
  })

  it('a hook that throws is absent: the ladder decides', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) { on('turn.recover', () => { throw new Error('boom'); }); }`)
    const bare = await run(undefined, failing)
    const t = await run(runtime, failing)
    expect(t.retryDelays).toEqual(bare.retryDelays)
    expect(t.terminal).toEqual(bare.terminal)
  })

  it('a retry past the last attempt is refused and reported', async () => {
    const { runtime, reports } = await modRuntime(`
      export function register(on) { on('turn.recover', () => ({ retry: true, delayMs: 1 })); }`)
    const t = await run(runtime, { env: { e2eProviderMaxRetries: '1' }, replies: [overloaded('a1'), overloaded('a2')], prompt: 'hello' })
    expect(text(t.terminal)).toContain('api_error')
    expect(reports.some(line => line.includes('turn.recover asked for a retry after the last attempt'))).toBe(true)
  })
})

describe('turn.continue', () => {
  const options = { replies: [toolRound, done, title], queued: typedOnce }

  it('a pass-through hook keeps the next request as the engine builds it', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) { on('turn.continue', async ($, e, next) => next(e)); }`)
    const bare = await run(undefined, options)
    const t = await run(runtime, options)
    expect(t.modelRequests).toEqual(bare.modelRequests)
    expect(t.terminal).toEqual(bare.terminal)
  })

  it('a hook rewrites the pending input', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) {
        on('turn.continue', async ($, e, next) =>
          next({ ...e, pending: { ...e.pending, queuedInput: [...e.pending.queuedInput, { role: 'user', text: 'MOD-CONTINUE' }] } }));
      }`)
    const t = await run(runtime, options)
    expect(text(t.modelRequests[1])).toContain('also the footer')
    expect(text(t.modelRequests[1])).toContain('MOD-CONTINUE')
  })

  it('a stop short-circuits and ends the turn as completed', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) { on('turn.continue', () => ({ stop: 'completed' })); }`)
    const bare = await run(undefined, { replies: [done, title], prompt: 'hello' })
    const t = await run(runtime, { replies: [toolRound, title] })
    expect(t.terminal).toEqual(bare.terminal)
  })

  it('a hook that throws is absent: the turn continues as the engine decided', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) { on('turn.continue', () => { throw new Error('boom'); }); }`)
    const bare = await run(undefined, options)
    const t = await run(runtime, options)
    expect(t.modelRequests).toEqual(bare.modelRequests)
    expect(t.terminal).toEqual(bare.terminal)
  })
})

describe('ids.next', () => {
  const hello = { replies: [done, title], prompt: 'hello' }

  it('is not dispatched when no module hooks it', async () => {
    const { runtime, reports } = await modRuntime(UNRELATED)
    await run(runtime, hello)
    expect(reports.some(line => line.includes('ids.next'))).toBe(false)
  })

  it('a hook mints the ids; one diagnostic line per run', async () => {
    const { runtime, reports } = await modRuntime(`
      let n = 0;
      export function register(on) { on('ids.next', ($, e) => ({ id: 'mod-' + e.kind + '-' + (++n) })); }`)
    const t = await run(runtime, hello)
    expect(text(t.emitted)).toContain('mod-message-')
    expect(reports.filter(line => line.startsWith('mods: ids.next —')).length).toBe(1)
  })

  it('a colliding id is refused and the engine id used', async () => {
    const { runtime, reports } = await modRuntime(`
      export function register(on) { on('ids.next', () => ({ id: 'same-id' })); }`)
    await run(runtime, hello)
    expect(reports.some(line => line.includes('already in use'))).toBe(true)
  })

  it('a hook that throws is absent: the engine ids are used', async () => {
    const { runtime } = await modRuntime(`
      export function register(on) { on('ids.next', () => { throw new Error('boom'); }); }`)
    const bare = await run(undefined, hello)
    const t = await run(runtime, hello)
    expect(t.terminal).toEqual(bare.terminal)
    expect(text(t.emitted)).not.toContain('mod-')
  })
})
