/**
 * `turn.start`, `turn.complete` and `$.turn.abort` (F-25): `turn.start` observes (`{ turnId }`); `turn.complete`
 * resolves to `{ text }` and a different text shows beneath the answer (a failing hook leaves it); `$.turn.abort`
 * rejects, naming both ids, for a turn that is not running.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { implementedNouns } from '../mods/modNouns'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModUiEvent } from '../mods/modUi'

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

function world(modules: Record<string, string>, options: { abort?: (turnId: string) => void } = {}) {
  const reports: string[] = []
  const events: ModUiEvent[] = []
  const aborted: string[] = []
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
    session: {
      id: () => 'sess-turn',
      cwd: () => '/work/project',
      turn: {
        abort: turnId => {
          if (options.abort) return options.abort(turnId)
          if (turnId !== 'turn-1') throw new Error(`$.turn.abort: ${turnId} is not the running turn (turn-1)`)
          aborted.push(turnId)
        },
      },
    },
    report: line => reports.push(line),
    onUiChanged: event => events.push(event),
  })
  runtimes.push(runtime)
  const logged = (plugin: string) =>
    reports.filter(line => line.startsWith(`${plugin}: {`)).map(line => JSON.parse(line.slice(plugin.length + 2)) as Record<string, unknown>)
  const notes = () => events.filter(e => e.kind === 'state').map(e => (e as { state: { turnNote?: unknown } }).state.turnNote)
  return { runtime, reports, events, aborted, logged, notes }
}

const COMPLETE = {
  turnId: 'turn-1',
  answer: 'The answer.',
  durationMs: 1234,
  reason: 'answer' as const,
  isAborted: false,
}

describe('turn.start / turn.complete — admission', () => {
  it('raises the two boundary events, each step between them, and serves $.turn.abort', () => {
    expect(RAISED_EVENTS).toEqual(expect.arrayContaining(['turn.start', 'turn.step', 'turn.complete', 'turn.abort']))
    expect(implementedNouns()).toContain('turn.abort')
  })
})

describe('turn.start', () => {
  it('hands the hooks the text and the turn id; a different return changes nothing', async () => {
    const { runtime, logged } = world({
      watch: `on('turn.start', async ($, e, next) => {
        const got = await next(e)
        await $.ui.log(JSON.stringify({ e, got }))
        return { turnId: 'forged' }
      })`,
    })
    await runtime.ready
    await runtime.turnStart({ text: 'hello', turnId: 'turn-1' })
    expect(logged('watch')).toEqual([{ e: { text: 'hello', turnId: 'turn-1' }, got: { turnId: 'turn-1' } }])
  })

  it('costs nothing unhooked, and a failing hook does not stop the turn', async () => {
    const { runtime, reports } = world({
      broken: `on('turn.start', () => { throw new Error('kaboom') })`,
    })
    await runtime.ready
    await expect(runtime.turnStart({ text: 'x', turnId: 't' })).resolves.toBeUndefined()
    expect(reports.some(line => line.includes('kaboom'))).toBe(true)
    const { runtime: quiet } = world({ other: `on('prompt.submit', ($, e, next) => next(e))` })
    await quiet.ready
    expect(quiet.hasTurnHooks()).toBe(false)
    await expect(quiet.turnStart({ text: 'x', turnId: 't' })).resolves.toBeUndefined()
  })
})

describe('turn.complete', () => {
  it('next(e) resolves to the answer; the same text leaves no note', async () => {
    const { runtime, logged, notes } = world({
      watch: `on('turn.complete', async ($, e, next) => {
        const got = await next(e)
        await $.ui.log(JSON.stringify({ e, got }))
        return got
      })`,
    })
    await runtime.ready
    expect(await runtime.turnComplete(COMPLETE)).toEqual({})
    expect(logged('watch')).toEqual([{ e: COMPLETE, got: { text: 'The answer.' } }])
    expect(notes().filter(Boolean)).toEqual([])
  })

  it('a different text is shown beneath the answer: the turn note on the ui state, cleared by the next turn.start', async () => {
    const { runtime, notes } = world({
      tldr: `on('turn.complete', ($, e, next) => ({ text: 'TL;DR: ' + e.answer.length + ' chars in ' + e.durationMs + ' ms' }))`,
    })
    await runtime.ready
    expect(await runtime.turnComplete(COMPLETE)).toEqual({ note: 'TL;DR: 11 chars in 1234 ms' })
    expect(runtime.uiSnapshot().turnNote).toEqual({ turnId: 'turn-1', text: 'TL;DR: 11 chars in 1234 ms' })
    expect(notes().at(-1)).toEqual({ turnId: 'turn-1', text: 'TL;DR: 11 chars in 1234 ms' })
    await runtime.turnStart({ text: 'next', turnId: 'turn-2' })
    expect(runtime.uiSnapshot().turnNote).toBeUndefined()
    expect(notes().at(-1)).toBeUndefined()
  })

  it('an aborted turn and an error say so; a refusal carries what the API said', async () => {
    const { runtime, logged } = world({
      watch: `on('turn.complete', async ($, e, next) => { await $.ui.log(JSON.stringify(e)); return next(e) })`,
    })
    await runtime.ready
    await runtime.turnComplete({ ...COMPLETE, reason: 'aborted', isAborted: true, answer: '' })
    await runtime.turnComplete({ ...COMPLETE, reason: 'refusal', refusal: { category: 'x', explanation: null } })
    const [aborted, refused] = logged('watch')
    expect(aborted).toMatchObject({ reason: 'aborted', isAborted: true, answer: '' })
    expect(refused).toMatchObject({ reason: 'refusal', refusal: { category: 'x', explanation: null } })
  })

  it('a hook that fails or answers a wrong shape leaves the answer as it was', async () => {
    const { runtime, reports } = world({
      odd: `on('turn.complete', () => ({ summary: 'nope' }))`,
      broken: `on('turn.complete', () => { throw new Error('kaboom') })`,
    })
    await runtime.ready
    expect(await runtime.turnComplete(COMPLETE)).toEqual({})
    expect(reports.some(line => line.includes('kaboom'))).toBe(true)
  })

  it("a subagent's turn (agentId) raises the event but shows no note", async () => {
    const { runtime, logged } = world({
      tldr: `on('turn.complete', async ($, e, next) => { await $.ui.log(JSON.stringify({ agent: e.agentId })); return { text: 'note' } })`,
    })
    await runtime.ready
    expect(await runtime.turnComplete({ ...COMPLETE, agentId: 'agent-7' })).toEqual({})
    expect(logged('tldr')).toEqual([{ agent: 'agent-7' }])
  })
})

describe('$.turn.abort', () => {
  const aborter = (turnId: string) => `
    on('prompt.submit', async ($, e, next) => {
      try { await $.turn.abort({ turnId: ${JSON.stringify(turnId)} }); await $.ui.log(JSON.stringify({ aborted: true })) }
      catch (error) { await $.ui.log(JSON.stringify({ threw: error.name, message: error.message })) }
      return next(e)
    })`

  it('cancels the running turn by its id; another id rejects, naming both', async () => {
    const { runtime, aborted, logged } = world({ right: aborter('turn-1') })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(aborted).toEqual(['turn-1'])
    expect(logged('right')).toEqual([{ aborted: true }])
    const wrong = world({ wrong: aborter('turn-9') })
    await wrong.runtime.ready
    await wrong.runtime.promptSubmit('go')
    expect(wrong.logged('wrong')[0]).toMatchObject({ message: '$.turn.abort: turn-9 is not the running turn (turn-1)' })
    expect(wrong.aborted).toEqual([])
  })

  it('is an event: a hook above may refuse it; a bad argument is a TypeError', async () => {
    const { runtime, aborted, logged } = world({
      guard: `on('turn.abort', () => ({ deny: 'turns are sacred' }))`,
      right: aborter('turn-1'),
      bad: `on('prompt.submit', async ($, e, next) => {
        try { await $.turn.abort({}) } catch (error) { await $.ui.log(JSON.stringify({ threw: error.name })) }
        return next(e)
      })`,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(aborted).toEqual([])
    expect(logged('right')).toEqual([{ threw: 'DeniedError', message: 'turns are sacred' }])
    expect(logged('bad')).toEqual([{ threw: 'TypeError' }])
  })
})

describe('turn.step — a real module, a generator hook', () => {
  const STEP = { turnId: 'turn-1', index: 0, model: 'big', effort: 'high' as const, messageCount: 3 }
  async function* coreOf(seen: unknown[]): AsyncGenerator<unknown, unknown> {
    yield { kind: 'text', index: 0, text: 'hello' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: 'turn-1', index: 0, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage: null, seen }
  }
  async function drain(stream: AsyncIterable<unknown> | undefined): Promise<unknown[]> {
    const out: unknown[] = []
    for await (const chunk of stream ?? []) out.push(chunk)
    return out
  }

  it('is not raised without a hook on it: the engine calls the model itself', async () => {
    const { runtime } = world({ quiet: `on('turn.start', ($, e, next) => next(e))` })
    await runtime.ready
    expect(runtime.hasTurnStepHooks()).toBe(false)
    expect(runtime.turnStep(STEP, () => coreOf([]) as never)).toBeUndefined()
  })

  it('transforms the response chunk by chunk; core gets the model a hook named, pinned fields as sent', async () => {
    const { runtime, reports } = world({
      shout: `on('turn.step', async function* ($, e, next) {
        for await (const chunk of next({ ...e, model: 'small', turnId: 'forged' })) {
          yield chunk.kind === 'text' ? { ...chunk, text: chunk.text.toUpperCase() } : chunk
        }
      })`,
    })
    await runtime.ready
    expect(reports).toEqual([])
    expect(runtime.hasTurnStepHooks()).toBe(true)
    const arrived: unknown[] = []
    const stream = runtime.turnStep(STEP, e => {
      arrived.push(e)
      return coreOf([]) as never
    })
    expect(await drain(stream)).toEqual([
      { kind: 'text', index: 0, text: 'HELLO' },
      { kind: 'stop', stopReason: 'end_turn', usage: null },
    ])
    expect(arrived).toEqual([{ ...STEP, model: 'small' }])
    await expect(stream!.result).resolves.toMatchObject({ answer: 'hello' })
  })

  it('a hook that fails mid-stream is reported; what it yielded stays and the rest comes from beneath', async () => {
    const { runtime, reports } = world({
      flaky: `on('turn.step', async function* ($, e, next) {
        const beneath = next(e)
        const first = await beneath.next()
        yield { ...first.value, text: 'first:' + first.value.text }
        throw new Error('boom')
      })`,
    })
    await runtime.ready
    const chunks = await drain(runtime.turnStep(STEP, () => coreOf([]) as never))
    expect(chunks).toEqual([
      { kind: 'text', index: 0, text: 'first:hello' },
      { kind: 'stop', stopReason: 'end_turn', usage: null },
    ])
    expect(reports.join('\n')).toMatch(/flaky.*turn\.step.*boom/)
  })
})
