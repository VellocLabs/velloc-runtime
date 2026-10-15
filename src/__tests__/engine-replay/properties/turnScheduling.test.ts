/**
 * Deterministic scheduling: every order in which concurrent arrivals (stream
 * fragments, a background settle, a timer, a stale answer, a cancellation) can
 * reach the machine is replayed, one trace per order. Arrivals that the
 * machine has no use for must not change what it asks for; a cancellation
 * must always end the turn aborted with every tool call answered.
 */
import { describe, expect, it } from 'vitest'
import type { EffectIdentity, TurnEffect, TurnEvent } from '../../../engine/turnEffects'
import { advanceTurn, defaultTurnPolicies } from '../../../engine/turnLoop'
import { unansweredCalls } from '../../../engine/turnInvariants'
import { enumerateInterleavings, type OrderConstraint } from '../fakes/scheduler'
import { runScriptedTurn, type ScheduledArrival, type TraceEntry } from '../fakes/fakeInterpreter'
import { backgroundSettled, fakeToolRunner, routeEffects, scriptedModel, startingTurnState } from '../fakes/fakeParts'

const STATE = startingTurnState()
const identity = (effectId: number, turnId = STATE.turnId): EffectIdentity => ({ sessionEpoch: STATE.sessionEpoch, turnId, effectId })

function play(arrivals: readonly ScheduledArrival[]) {
  return runScriptedTurn({
    advance: advanceTurn,
    policies: defaultTurnPolicies,
    initial: STATE,
    respond: routeEffects({
      model: scriptedModel([
        { reply: 'tools', toolCalls: [{ id: 'c1', name: 'Read' }, { id: 'c2', name: 'Read' }] },
        { reply: 'done' },
      ]),
      tools: fakeToolRunner(),
    }),
    arrivals,
  })
}

const effectLine = (trace: readonly TraceEntry[]): string[] =>
  trace.flatMap((e) => (e.kind === 'effect' ? [effectShape(e.effect)] : []))

function effectShape(e: TurnEffect): string {
  return e.kind === 'runStopHooks' ? `${e.kind}:${e.event}` : e.kind
}

const fragment = (label: string): ScheduledArrival => ({ label, kind: 'fragment', payload: label })
const event = (label: string, kind: 'timer' | 'backgroundSettle', payload: TurnEvent): ScheduledArrival => ({ label, kind, payload })

describe('turn machine scheduling', () => {
  const baseline = play([])

  it('the baseline run completes', () => {
    expect(baseline.conclusion).toMatchObject({ outcome: { reason: 'completed' } })
  })

  it('fragments, an unawaited settle, a stray timer and a stale answer never change the effects asked for', () => {
    const items: ScheduledArrival[] = [
      fragment('f1'),
      fragment('f2'),
      // The memory prefetch is never waited for; its settle is noted only.
      event('prefetch', 'backgroundSettle', backgroundSettled(identity(3), 'memoryPrefetch', 'recalled')),
      event('timer', 'timer', { type: 'timerElapsed', identity: identity(999) }),
      // An answer for an earlier turn is discarded by its identity.
      event('stale', 'backgroundSettle', backgroundSettled(identity(1, 'turn-0'), 'toolDigest', null)),
    ]
    const constraints: OrderConstraint[] = [['f1', 'f2']]
    const orders = enumerateInterleavings(items, constraints)
    expect(orders).toHaveLength(60)
    const expected = effectLine(baseline.trace)
    for (const order of orders) {
      const r = play(order)
      expect(effectLine(r.trace), order.map((o) => o.label).join(' > ')).toEqual(expected)
      expect(r.conclusion).toEqual(baseline.conclusion)
      expect(r.commits).toBe(1)
    }
  })

  it('a cancellation at any point ends the turn aborted with every call answered', () => {
    const serialEffects = effectLine(baseline.trace).filter((k) => k !== 'startBackground' && k !== 'commitTerminal').length
    for (let at = 0; at < serialEffects; at += 1) {
      const pad = Array.from({ length: at }, (_, i) => fragment(`p${i}`))
      const r = play([...pad, { label: 'cancel', kind: 'cancel', payload: 'user' }])
      expect(r.commits, `cancel at ${at}`).toBe(1)
      const reason = r.conclusion?.kind === 'outcome' ? r.conclusion.outcome.reason : undefined
      const asked = r.trace.some((e) => e.kind === 'effect' && e.effect.kind === 'runToolBatch')
      // Past the final Stop hook the turn has already decided to complete.
      expect(['aborted_streaming', 'completed'], `cancel at ${at}`).toContain(reason)
      if (asked && reason === 'aborted_streaming') {
        // The transcript — the rows already sent, this step's replies and
        // results, and what the cancellation yielded — leaves no call open.
        const outputs = r.trace.flatMap((e) => (e.kind === 'output' ? [e.output.message] : []))
        const transcript = [...r.state.messages, ...r.state.stepReplies, ...r.state.stepResults, ...outputs]
        expect(unansweredCalls(transcript), `cancel at ${at}`).toEqual([])
      }
    }
  })

  it('a cancellation and a fragment arrive in either order with the same outcome', () => {
    const orders = enumerateInterleavings<ScheduledArrival>([
      fragment('pad0'), fragment('pad1'), fragment('pad2'), fragment('pad3'),
      { label: 'cancel', kind: 'cancel', payload: 'user' },
    ], [['pad0', 'pad1'], ['pad1', 'pad2'], ['pad2', 'pad3']])
    const outcomes = new Set(orders.map((o) => JSON.stringify(play(o).conclusion)))
    // The cancel lands on a different effect in each order, yet every run
    // concludes, once, as aborted.
    expect([...outcomes]).toEqual([JSON.stringify({ kind: 'outcome', phase: 'aborted', outcome: { reason: 'aborted_streaming' } })])
  })
})
