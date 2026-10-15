import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type {
  AdvanceTurn,
  EffectIdentity,
  TurnEffect,
  TurnOutput,
  TurnPolicies,
  TurnState,
} from '../../../engine/turnEffects'
import { noTurnExtensions } from '../../../engine/extensionSeam'
import { noToolExtensions } from '../../../toolkit/toolExtensionSeam'
import { FrozenWriteError, freezeDeep } from './freezeDeep'
import { enumerateInterleavings, forEachInterleaving } from './scheduler'
import {
  InterpreterInvariantError,
  mainLine,
  runScriptedTurn,
  type ScheduledArrival,
} from './fakeInterpreter'
import {
  backgroundSettled,
  fakeToolRunner,
  recordingExtensions,
  routeEffects,
  scriptedModel,
  startingTurnState,
} from './fakeParts'

const policies: TurnPolicies = {
  fitContext: () => 'fits',
  chooseNudge: () => undefined,
  stepBudget: ({ k, maxTurns }) => ({ lastStep: maxTurns !== undefined && k >= maxTurns, reached: maxTurns !== undefined && k + 1 > maxTurns }),
  recoverOutputCap: () => 'giveUp',
}

/**
 * A toy transition function, only to exercise the fakes — NOT the engine's
 * decision table (E2 writes the real one). begin → background prefetch +
 * request; a reply with tool calls → tool batch → next request; a reply
 * without → commit `completed`; `cancelled` → commit `aborted`.
 */
const toyAdvance: AdvanceTurn = (state, event) => {
  const mint = (n: number): EffectIdentity => ({ sessionEpoch: state.sessionEpoch, turnId: state.turnId, effectId: state.nextEffectOrdinal + n })
  const request = (s: TurnState, n: number): TurnEffect => ({
    kind: 'requestModel', identity: mint(n), k: s.k, messages: s.messages, baseInstructions: s.baseInstructions,
    userAmbient: s.userAmbient, systemAmbient: s.systemAmbient, tools: s.visibleTools, outputTokenCapOverride: undefined, finalResponse: false,
  })
  const commit = (reason: 'completed' | 'aborted_streaming'): { state: TurnState; effects: TurnEffect[]; outputs: TurnOutput[] } => {
    const conclusion = reason === 'completed'
      ? { kind: 'outcome' as const, phase: 'completed' as const, outcome: { reason } }
      : { kind: 'outcome' as const, phase: 'aborted' as const, outcome: { reason } }
    return {
      state: { ...state, phase: conclusion.phase, conclusion, nextEffectOrdinal: state.nextEffectOrdinal + 1 },
      effects: [{ kind: 'commitTerminal', identity: mint(0), conclusion }],
      outputs: [],
    }
  }
  if (state.phase !== 'running') return { state, effects: [], outputs: [] }
  switch (event.type) {
    case 'begin':
      return {
        state: { ...state, nextEffectOrdinal: state.nextEffectOrdinal + 2 },
        effects: [{ kind: 'startBackground', identity: mint(0), background: 'memoryPrefetch', input: null }, request(state, 1)],
        outputs: [{ message: { type: 'system', subtype: 'stream_request_start' }, origin: 'system' }],
      }
    case 'modelStreamed': {
      const outputs: TurnOutput[] = event.replies.map((message) => ({ message, origin: 'model' }))
      if (event.toolCalls.length === 0) {
        const c = commit('completed')
        return { ...c, outputs }
      }
      return {
        state: { ...state, messages: [...state.messages, ...event.replies], stepToolCalls: event.toolCalls, nextEffectOrdinal: state.nextEffectOrdinal + 1 },
        effects: [{ kind: 'runToolBatch', identity: mint(0), calls: event.toolCalls, replies: event.replies }],
        outputs,
      }
    }
    case 'toolBatchDone': {
      const rows = event.updates.flatMap((u) => (u.kind === 'row' ? [u.message] : []))
      if (event.cancelled) return commit('aborted_streaming')
      const next: TurnState = { ...state, messages: [...state.messages, ...rows], k: state.k + 1, stepToolCalls: [], nextEffectOrdinal: state.nextEffectOrdinal + 1 }
      return { state: next, effects: [request(next, 0)], outputs: rows.map((message) => ({ message, origin: 'tool' as const })) }
    }
    case 'modelFailed':
    case 'cancelled':
      return commit('aborted_streaming')
    default:
      return { state, effects: [], outputs: [] }
  }
}

describe('scheduler', () => {
  const items = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]

  it('enumerates all 6 orders of 3 items, each once', () => {
    const orders = enumerateInterleavings(items).map((o) => o.map((i) => i.label).join(''))
    expect(orders).toEqual(['abc', 'acb', 'bac', 'bca', 'cab', 'cba'])
  })

  it('honours before/after constraints', () => {
    const orders = enumerateInterleavings(items, [['a', 'b']]).map((o) => o.map((i) => i.label).join(''))
    expect(orders).toEqual(['abc', 'acb', 'cab'])
  })

  it('refuses duplicate labels and oversized sets', () => {
    expect(() => enumerateInterleavings([{ label: 'x' }, { label: 'x' }])).toThrow(/unique/)
    expect(() => enumerateInterleavings(Array.from({ length: 9 }, (_, i) => ({ label: `i${i}` })))).toThrow(/too many/)
  })

  it('counts n! orders (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (n) => {
        const fact = Array.from({ length: n }, (_, i) => i + 1).reduce((a, b) => a * b, 1)
        return enumerateInterleavings(Array.from({ length: n }, (_, i) => ({ label: `i${i}` }))).length === fact
      }),
    )
  })
})

describe('freezeDeep', () => {
  it('throws on a write at any depth, including Map and Set mutators', () => {
    const state = freezeDeep(startingTurnState({ messages: [{ type: 'user', nested: { n: 1 } }] }))
    expect(() => {
      ;(state as { k: number }).k = 2
    }).toThrow(TypeError)
    expect(() => (state.messages as unknown[]).push({ type: 'user' })).toThrow(TypeError)
    expect(() => {
      ;(state.messages[0].nested as { n: number }).n = 2
    }).toThrow(TypeError)
    expect(() => (state.fileReadLedger as Map<string, never>).set('a', undefined as never)).toThrow(FrozenWriteError)
    expect(() => (state.nestedMemoryPathsSeen as Set<string>).add('p')).toThrow(FrozenWriteError)
  })

  it('leaves the value structurally equal (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const copy = JSON.parse(JSON.stringify(value)) as unknown
        expect(freezeDeep(copy)).toEqual(JSON.parse(JSON.stringify(value)))
      }),
    )
  })
})

describe('fake interpreter', () => {
  const twoSteps = () => ({
    model: scriptedModel([{ reply: 'looking', toolCalls: [{ id: 'c1', name: 'Read' }] }, { reply: 'done' }]),
    tools: fakeToolRunner({ Read: { text: 'file body' } }),
  })

  it('records outputs before effects and answers each serial effect with one event', () => {
    const parts = twoSteps()
    const run = runScriptedTurn({ advance: toyAdvance, policies, initial: startingTurnState(), respond: routeEffects(parts) })
    const kinds = run.trace.map((e) => (e.kind === 'event' ? `event:${e.event.type}` : e.kind === 'effect' ? `effect:${e.effect.kind}` : e.kind))
    expect(kinds).toEqual([
      'event:begin', 'output', 'effect:startBackground', 'event:backgroundStarted', 'effect:requestModel',
      'event:modelStreamed', 'output', 'effect:runToolBatch',
      'event:toolBatchDone', 'output', 'effect:requestModel',
      'event:modelStreamed', 'output', 'effect:commitTerminal', 'event:effectDone',
    ])
    expect(run.commits).toBe(1)
    expect(run.conclusion).toMatchObject({ phase: 'completed', outcome: { reason: 'completed' } })
    expect(parts.model.requests.map((r) => r.k)).toEqual([1, 2])
  })

  it('aborts the running effect on cancel and feeds cancelled in its place', () => {
    const parts = twoSteps()
    const arrivals: ScheduledArrival[] = [
      { label: 'progress', kind: 'fragment', payload: 'tick' },
      { label: 'stop', kind: 'cancel', payload: 'user' },
    ]
    const run = runScriptedTurn({ advance: toyAdvance, policies, initial: startingTurnState(), respond: routeEffects(parts), arrivals })
    const aborted = run.trace.find((e) => e.kind === 'abortedEffect')
    expect(aborted && aborted.kind === 'abortedEffect' && aborted.effect.kind).toBe('runToolBatch')
    expect(run.trace.some((e) => e.kind === 'event' && e.event.type === 'toolBatchDone')).toBe(false)
    expect(run.conclusion).toMatchObject({ phase: 'aborted' })
    expect(run.commits).toBe(1)
  })

  it('discards events after the terminal commit and stale identities', () => {
    const parts = twoSteps()
    const late = backgroundSettled({ sessionEpoch: 1, turnId: 'turn-1', effectId: 1 }, 'memoryPrefetch', 'recall')
    const stale = backgroundSettled({ sessionEpoch: 0, turnId: 'turn-1', effectId: 1 }, 'memoryPrefetch', 'old')
    const run = runScriptedTurn({
      advance: toyAdvance, policies, initial: startingTurnState(), respond: routeEffects(parts),
      arrivals: [
        { label: 'f1', kind: 'fragment', payload: 1 },
        { label: 'stale', kind: 'backgroundSettle', payload: stale },
        { label: 'f2', kind: 'fragment', payload: 2 },
        { label: 'f3', kind: 'fragment', payload: 3 },
        { label: 'late', kind: 'backgroundSettle', payload: late },
      ],
    })
    const discarded = run.trace.flatMap((e) => (e.kind === 'discarded' ? [e.why] : []))
    expect(discarded).toEqual(['stale identity', 'turn already committed'])
  })

  it('throws on a second terminal commit', () => {
    const doubleCommit: AdvanceTurn = (state, event) => {
      if (event.type !== 'begin') return { state, effects: [], outputs: [] }
      const conclusion = { kind: 'outcome' as const, phase: 'completed' as const, outcome: { reason: 'completed' as const } }
      const id = (n: number) => ({ sessionEpoch: 1, turnId: 'turn-1', effectId: n })
      return {
        state: { ...state, phase: 'completed', conclusion },
        effects: [{ kind: 'commitTerminal', identity: id(1), conclusion }, { kind: 'commitTerminal', identity: id(2), conclusion }],
        outputs: [],
      }
    }
    expect(() => runScriptedTurn({ advance: doubleCommit, policies, initial: startingTurnState(), respond: routeEffects({}) })).toThrow(InterpreterInvariantError)
  })

  it('hands advanceTurn a frozen state', () => {
    const writer: AdvanceTurn = (state) => {
      ;(state as { k: number }).k += 1
      return { state, effects: [], outputs: [] }
    }
    expect(() => runScriptedTurn({ advance: writer, policies, initial: startingTurnState(), respond: routeEffects({}) })).toThrow(TypeError)
  })

  it('commits exactly once in every interleaving of progress, background settle and cancel', () => {
    const settle = backgroundSettled({ sessionEpoch: 1, turnId: 'turn-1', effectId: 1 }, 'memoryPrefetch', 'recall')
    const items: ScheduledArrival[] = [
      { label: 'progress', kind: 'fragment', payload: 'tick' },
      { label: 'settle', kind: 'backgroundSettle', payload: settle },
      { label: 'cancel', kind: 'cancel', payload: 'user' },
    ]
    const runs = forEachInterleaving(items, (order) =>
      runScriptedTurn({ advance: toyAdvance, policies, initial: startingTurnState(), respond: routeEffects(twoSteps()), arrivals: order }),
    )
    expect(runs).toHaveLength(6)
    for (const { result } of runs) {
      expect(result.commits).toBe(1)
      expect(result.conclusion?.phase).toBe('aborted')
    }
  })

  it('keeps the main line equal when only a fragment and a background settle move', () => {
    const settle = backgroundSettled({ sessionEpoch: 1, turnId: 'turn-1', effectId: 1 }, 'memoryPrefetch', 'recall')
    const items: ScheduledArrival[] = [
      { label: 'progress', kind: 'fragment', payload: 'tick' },
      { label: 'settle', kind: 'backgroundSettle', payload: settle },
    ]
    const lines = forEachInterleaving(items, (order) => {
      const run = runScriptedTurn({ advance: toyAdvance, policies, initial: startingTurnState(), respond: routeEffects(twoSteps()), arrivals: order })
      return mainLine(run.trace).filter((e) => !(e.kind === 'event' && e.event.type === 'backgroundSettled'))
    })
    expect(lines[0].result).toEqual(lines[1].result)
  })
})

describe('extension holders', () => {
  it('no-op holders raise nothing and answer as the core would', async () => {
    const tool = noToolExtensions()
    expect(tool.hasToolCallHooks() || tool.hasToolCheckHooks() || tool.hasToolDescribeHooks() || tool.hasClassicHooks('Stop')).toBe(false)
    await expect(tool.toolDescribe({ tool: 'Read', description: 'd', provider: 'anthropic' as never })).resolves.toBe('d')
    const turn = noTurnExtensions()
    await expect(turn.promptSubmit('hi')).resolves.toEqual({ entered: true, text: 'hi', context: [] })
    await expect(turn.whileAskingPerson(async () => 7)).resolves.toBe(7)
    expect(turn.turnStep({} as never, (() => undefined) as never)).toBeUndefined()
  })

  it('recording holder logs member names', async () => {
    const { extensions, calls } = recordingExtensions()
    extensions.hasTurnStepHooks()
    await extensions.turnStart({ text: 'x', turnId: 't' })
    expect(calls).toEqual(['hasTurnStepHooks', 'turnStart'])
  })
})
