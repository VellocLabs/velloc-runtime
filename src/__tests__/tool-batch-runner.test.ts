import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryRuntimeDeps, QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { DeferredMessageUpdate } from '../toolkit/run/executeToolCall'
import { planToolBatches, runToolBatch, type ToolBatchRunner } from '../toolkit/run/toolBatchRunner'
import type { ToolContract } from '../toolkit/toolContract'

type Script = (call: QueryToolUseBlock, ctx: ToolCallContext) => AsyncGenerator<DeferredMessageUpdate, void>

const scripts = new Map<string, Script>()
const log: string[] = []
const hookCalls: { kind: 'pre' | 'post'; args: unknown[] }[] = []

// The runner is injected: a scripted call and a recording telemetry bracket,
// through the real batch runner.
const fakeRunner: ToolBatchRunner = {
  executeCall: ((call: QueryToolUseBlock, _a: unknown, _c: unknown, ctx: ToolCallContext) => {
    const script = scripts.get(call.toolCallId) ?? defaultScript
    return script(call, ctx)
  }) as unknown as ToolBatchRunner['executeCall'],
  before: async (...args: unknown[]) => {
    hookCalls.push({ kind: 'pre', args })
  },
  after: async (...args: unknown[]) => {
    hookCalls.push({ kind: 'post', args })
  },
}

const executeToolCalls = (...args: Parameters<typeof runToolBatch>) =>
  runToolBatch(args[0], args[1], args[2], args[3], args[4], fakeRunner)

function resultMessage(id: string, isError = false): Message {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: id, isError }] },
  }
}

const defaultScript: Script = async function* (call) {
  log.push(`start:${call.toolCallId}`)
  yield { message: resultMessage(call.toolCallId) }
  log.push(`end:${call.toolCallId}`)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => (resolve = r))
  return { promise, resolve }
}

type ToolSpec = {
  safe?: boolean | (() => boolean)
  interactive?: boolean
}

function makeContext(tools: Record<string, ToolSpec>, extra: Record<string, unknown> = {}) {
  let inProgress = new Set<string>()
  let maxInProgress = 0
  const ctx = {
    options: {
      tools: Object.entries(tools).map(([name, spec]) => ({
        name,
        parallelSafe: () => (typeof spec.safe === 'function' ? spec.safe() : !!spec.safe),
        ...(spec.interactive !== undefined ? { haltsForUser: () => spec.interactive } : {}),
      })),
    },
    markCallsInFlight: (f: (prev: Set<string>) => Set<string>) => {
      inProgress = f(inProgress)
      maxInProgress = Math.max(maxInProgress, inProgress.size)
    },
    ...extra,
  } as unknown as ToolCallContext
  return { ctx, inProgress: () => inProgress, maxInProgress: () => maxInProgress }
}

function call(id: string, toolName: string, args: unknown = {}): QueryToolUseBlock {
  return { type: 'tool-call', toolCallId: id, toolName, args }
}

function assistantFor(calls: QueryToolUseBlock[]): ModelReplyRow {
  return {
    type: 'assistant',
    uuid: 'a1',
    message: { role: 'assistant', content: calls.map(c => ({ ...c })) },
  } as ModelReplyRow
}

let uuidCounter = 0
const deps = { uuid: () => `uuid-${++uuidCounter}` } as QueryRuntimeDeps

async function collect(gen: AsyncGenerator<unknown, void>) {
  const out: any[] = []
  for await (const u of gen) out.push(u)
  return out
}

function idsOf(updates: any[]): string[] {
  return updates.filter(u => u.message).map(u => u.message.message.content[0].toolCallId)
}

beforeEach(() => {
  scripts.clear()
  log.length = 0
  hookCalls.length = 0
  uuidCounter = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('executeToolCalls — batching', () => {
  it('yields nothing for an empty list', async () => {
    const { ctx } = makeContext({})
    expect(await collect(executeToolCalls([], [], vi.fn(), ctx, deps))).toEqual([])
  })

  it('groups adjacent safe calls and isolates every unsafe call', async () => {
    const { ctx } = makeContext({ R: { safe: true }, W: { safe: false } })
    const calls = [call('1', 'R'), call('2', 'R'), call('3', 'W'), call('4', 'W'), call('5', 'R')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    // Safe batches emit one trailing context update; 1+2 is one batch, 5 another.
    expect(updates.filter(u => !u.message)).toHaveLength(2)
    // The unsafe calls ran one at a time, in order, after the first batch.
    expect(log.indexOf('start:3')).toBeGreaterThan(log.indexOf('end:2'))
    expect(log.indexOf('start:4')).toBeGreaterThan(log.indexOf('end:3'))
    expect(log.indexOf('start:5')).toBeGreaterThan(log.indexOf('end:4'))
  })

  it('treats unknown tools, interactive tools and throwing safety checks as unsafe', async () => {
    const { ctx } = makeContext({
      Ask: { safe: true, interactive: true },
      Boom: { safe: () => { throw new Error('bad input') } },
      R: { safe: true },
    })
    const calls = [call('1', 'Missing'), call('2', 'Ask'), call('3', 'Boom'), call('4', 'R'), call('5', 'R')]
    const assistant = assistantFor(calls)
    const updates = await collect(executeToolCalls(calls, [assistant], vi.fn(), ctx, deps))
    expect(idsOf(updates)).toEqual(['1', '2', '3', '4', '5'])
    // Only 4+5 form a parallel batch.
    expect(updates.filter(u => !u.message)).toHaveLength(1)
    expect((calls[0] as any).toolBatch).toBeUndefined()
    expect((calls[2] as any).toolBatch).toBeUndefined()
    expect((calls[3] as any).toolBatch).toEqual({ mode: 'concurrent', batchId: 'uuid-1', batchSize: 2 })
  })

  it('passes {} to the safety check when args are missing', async () => {
    const seen: unknown[] = []
    const { ctx } = makeContext({})
    ;(ctx.options.tools as any).push({ name: 'T', parallelSafe: (i: unknown) => (seen.push(i), true) })
    await collect(executeToolCalls([{ type: 'tool-call', toolCallId: '1', toolName: 'T' }], [assistantFor([])], vi.fn(), ctx, deps))
    expect(seen).toEqual([{}])
  })
})

describe('executeToolCalls — parallel batches', () => {
  it('caps parallelism at 10 by default and honours the env override', async () => {
    const calls = Array.from({ length: 14 }, (_, i) => call(`c${i}`, 'R'))
    {
      const { ctx, maxInProgress } = makeContext({ R: { safe: true } })
      await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
      expect(maxInProgress()).toBe(10)
    }
    for (const [value, expected] of [['3abc', 3], ['0', 10], ['-2', 10], ['x', 10], ['', 10]] as const) {
      vi.stubEnv('VELLOC_MAX_TOOL_USE_CONCURRENCY', value)
      const { ctx, maxInProgress } = makeContext({ R: { safe: true } })
      await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
      expect(maxInProgress()).toBe(expected)
    }
  })

  it('starts queued calls in input order as slots free', async () => {
    vi.stubEnv('VELLOC_MAX_TOOL_USE_CONCURRENCY', '1')
    const { ctx } = makeContext({ R: { safe: true } })
    const calls = [call('a', 'R'), call('b', 'R'), call('c', 'R')]
    await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  })

  it('yields in arrival order with the batch-start context, then applies modifiers in input order', async () => {
    const gate = deferred()
    scripts.set('slow', async function* () {
      await gate.promise
      yield { message: resultMessage('slow'), contextPatch: { toolUseID: 'slow', modifyContext: c => ({ ...c, trail: [...((c as any).trail ?? []), 'slow1'] }) as any } }
      yield { contextPatch: { toolUseID: 'slow', modifyContext: c => ({ ...c, trail: [...((c as any).trail ?? []), 'slow2'] }) as any } }
    })
    scripts.set('fast', async function* () {
      yield { message: resultMessage('fast'), contextPatch: { toolUseID: 'fast', modifyContext: c => ({ ...c, trail: [...((c as any).trail ?? []), 'fast'] }) as any } }
      gate.resolve()
    })
    const { ctx } = makeContext({ R: { safe: true } })
    const calls = [call('slow', 'R'), call('fast', 'R')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(updates.map(u => u.message?.message.content[0].toolCallId)).toEqual(['fast', 'slow', undefined, undefined])
    for (const u of updates.slice(0, 3)) expect(u.newContext).toBe(ctx)
    expect(updates[3].message).toBeUndefined()
    expect(updates[3].newContext.trail).toEqual(['slow1', 'slow2', 'fast'])
  })

  it('emits a trailing context update even without modifiers', async () => {
    const { ctx } = makeContext({ R: { safe: true } })
    const calls = [call('1', 'R')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(updates).toHaveLength(2)
    expect(updates[1]).toEqual({ newContext: ctx })
  })

  it('tags blocks and assistant parts of a multi-call batch only', async () => {
    const { ctx } = makeContext({ R: { safe: true }, W: {} })
    const calls = [call('1', 'R'), call('2', 'R'), call('3', 'W'), call('4', 'R')]
    const assistant = assistantFor(calls)
    const other = { type: 'assistant', message: { content: 'text' } } as unknown as ModelReplyRow
    await collect(executeToolCalls(calls, [other, assistant], vi.fn(), ctx, deps))
    const tag = { mode: 'concurrent', batchId: 'uuid-1', batchSize: 2 }
    const parts = (assistant.message as any).content
    expect((calls[0] as any).toolBatch).toEqual(tag)
    expect((calls[1] as any).toolBatch).toBe((calls[0] as any).toolBatch)
    expect(parts[0].toolBatch).toEqual(tag)
    expect(parts[1].toolBatch).toEqual(tag)
    expect(parts[2].toolBatch).toBeUndefined()
    expect(parts[3].toolBatch).toBeUndefined()
    expect((calls[3] as any).toolBatch).toBeUndefined()
  })

  it('keeps siblings running when one call reports an error', async () => {
    scripts.set('bad', async function* () {
      yield { message: resultMessage('bad', true) }
    })
    const { ctx } = makeContext({ R: { safe: true } })
    const calls = [call('bad', 'R'), call('ok', 'R')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(idsOf(updates).sort()).toEqual(['bad', 'ok'])
    const posts = hookCalls.filter(h => h.kind === 'post').map(h => h.args[3])
    expect(posts.sort()).toEqual([false, true])
  })

  it('stops at a pending update mid-batch and still finalizes running siblings', async () => {
    const gate = deferred()
    scripts.set('slow', async function* () {
      await gate.promise
      yield { message: resultMessage('slow') }
    })
    scripts.set('ask', async function* () {
      // The sibling is still mid-flight when the halt arrives.
      setTimeout(gate.resolve, 10)
      yield { pendingToolUse: { toolUseId: 'ask', toolName: 'R' } as any }
    })
    const { ctx, inProgress } = makeContext({ R: { safe: true } })
    const calls = [call('slow', 'R'), call('ask', 'R'), call('after', 'W')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(updates).toHaveLength(1)
    expect(updates[0].pendingToolUse.toolUseId).toBe('ask')
    expect(log).not.toContain('start:after')
    expect(hookCalls.filter(h => h.kind === 'post')).toHaveLength(2)
    expect(inProgress().size).toBe(0)
  })
})

describe('executeToolCalls — solo calls', () => {
  it('applies modifiers immediately so later updates and calls see them', async () => {
    let seenByNext: unknown
    scripts.set('1', async function* () {
      yield { contextPatch: { toolUseID: '1', modifyContext: c => ({ ...c, mark: 1 }) as any } }
      yield { message: resultMessage('1') }
    })
    scripts.set('2', async function* (_c, ctx) {
      seenByNext = (ctx as any).mark
      yield { message: resultMessage('2') }
    })
    const { ctx } = makeContext({ W: {} })
    const calls = [call('1', 'W'), call('2', 'W')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(updates.map(u => u.newContext.mark)).toEqual([1, 1, 1])
    expect(seenByNext).toBe(1)
    // Post-hook of call 1 sees the modified context.
    expect((hookCalls.find(h => h.kind === 'post')!.args[0] as any).mark).toBe(1)
  })

  it('does not abort later calls after an error or a page change', async () => {
    scripts.set('1', async function* () {
      yield { message: resultMessage('1', true), agentMeta: { postUrl: 'a', terminatesSequence: true } }
    })
    const { ctx } = makeContext({ W: {} })
    const calls = [call('1', 'W'), call('2', 'W')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(idsOf(updates)).toEqual(['1', '2'])
  })

  it('skips a call when there is no assistant message at all', async () => {
    const { ctx, inProgress } = makeContext({ W: {} })
    const updates = await collect(executeToolCalls([call('1', 'W')], [], vi.fn(), ctx, deps))
    expect(updates).toEqual([])
    expect(hookCalls).toEqual([])
    expect(log).toEqual([])
    expect(inProgress().size).toBe(0)
  })

  it('falls back to the first assistant message when no part matches', async () => {
    const { ctx } = makeContext({ W: {} })
    const updates = await collect(executeToolCalls([call('1', 'W')], [assistantFor([])], vi.fn(), ctx, deps))
    expect(idsOf(updates)).toEqual(['1'])
  })
})

describe('executeToolCalls — hooks and finalisation', () => {
  it('passes hook arguments and the success flag', async () => {
    const meta1 = { postUrl: 'x' }
    const meta2 = { postUrl: 'y' }
    scripts.set('1', async function* () {
      yield { agentMeta: meta1 }
      yield { message: resultMessage('1'), agentMeta: meta2 }
    })
    const { ctx } = makeContext({ W: {} })
    const c = { ...call('1', 'W'), input: { q: 1 } }
    await collect(executeToolCalls([c], [assistantFor([c])], vi.fn(), ctx, deps))
    expect(hookCalls).toEqual([
      { kind: 'pre', args: [ctx, 'W', { q: 1 }] },
      { kind: 'post', args: [ctx, 'W', meta2, true] },
    ])
  })

  it('reports failure and undefined meta for an error result', async () => {
    scripts.set('1', async function* () {
      yield { message: resultMessage('1', true) }
    })
    const { ctx } = makeContext({ W: {} })
    await collect(executeToolCalls([call('1', 'W')], [assistantFor([])], vi.fn(), ctx, deps))
    expect(hookCalls[1]!.args.slice(2)).toEqual([undefined, false])
  })

  it('finalizes exactly once when the consumer stops early', async () => {
    const { ctx, inProgress } = makeContext({ W: {}, R: { safe: true } })
    for (const tool of ['W', 'R']) {
      hookCalls.length = 0
      const calls = [call('1', tool), call('2', tool)]
      const gen = executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps)
      await gen.next()
      await gen.return(undefined)
      expect(hookCalls.filter(h => h.kind === 'post').length).toBeGreaterThanOrEqual(1)
      expect(hookCalls.filter(h => h.kind === 'post').length).toBe(hookCalls.filter(h => h.kind === 'pre').length)
      expect(inProgress().size).toBe(0)
    }
  })

  it('finalizes and rethrows when a tool throws', async () => {
    scripts.set('1', async function* () {
      throw new Error('tool exploded')
    })
    const { ctx, inProgress } = makeContext({ R: { safe: true }, W: {} })
    for (const tool of ['W', 'R']) {
      hookCalls.length = 0
      const calls = [call('1', tool), call('2', tool)]
      await expect(collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))).rejects.toThrow('tool exploded')
      const posts = hookCalls.filter(h => h.kind === 'post')
      expect(posts.length).toBe(hookCalls.filter(h => h.kind === 'pre').length)
      expect(posts.find(p => true)!.args[3]).toBe(false)
      expect(inProgress().size).toBe(0)
    }
  })

  it('ends the run right after a pending update in a solo call', async () => {
    scripts.set('1', async function* () {
      yield { pendingToolUse: { toolUseId: '1', toolName: 'W' } as any }
      log.push('after-pending')
    })
    const { ctx, inProgress } = makeContext({ W: {} })
    const calls = [call('1', 'W'), call('2', 'W')]
    const updates = await collect(executeToolCalls(calls, [assistantFor(calls)], vi.fn(), ctx, deps))
    expect(updates).toHaveLength(1)
    expect(log).toEqual([])
    expect(hookCalls.filter(h => h.kind === 'post')).toHaveLength(1)
    expect(inProgress().size).toBe(0)
  })
})

describe('planToolBatches', () => {
  const tool = (name: string, spec: { safe?: boolean | (() => boolean); halts?: boolean }) =>
    ({
      name,
      parallelSafe: () => (typeof spec.safe === 'function' ? spec.safe() : !!spec.safe),
      ...(spec.halts ? { haltsForUser: () => true } : {}),
    }) as unknown as ToolContract
  const call = (id: string, toolName: string): QueryToolUseBlock =>
    ({ type: 'tool-call', toolCallId: id, toolName }) as QueryToolUseBlock
  const tools = [
    tool('R', { safe: true }),
    tool('W', { safe: false }),
    tool('Ask', { safe: true, halts: true }),
    tool('Boom', { safe: () => { throw new Error('x') } }),
  ]
  const shape = (calls: QueryToolUseBlock[]) =>
    planToolBatches(calls, tools).map(b => `${b.parallel ? 'P' : 'S'}:${b.calls.map(c => c.toolCallId).join(',')}`)

  it('groups adjacent parallel-safe calls and isolates the rest', () => {
    expect(shape([call('1', 'R'), call('2', 'R'), call('3', 'W'), call('4', 'R'), call('5', 'R')])).toEqual([
      'P:1,2',
      'S:3',
      'P:4,5',
    ])
  })

  it('treats unknown tools, halting tools and throwing checks as unsafe', () => {
    expect(shape([call('1', 'R'), call('2', 'Nope'), call('3', 'Ask'), call('4', 'Boom'), call('5', 'R')])).toEqual([
      'P:1',
      'S:2',
      'S:3',
      'S:4',
      'P:5',
    ])
  })

  it('plans nothing for no calls', () => {
    expect(planToolBatches([], tools)).toEqual([])
  })
})
