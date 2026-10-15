/**
 * Properties of the turn machine over generated scripts: random model replies
 * (text, tool calls that succeed, fail or halt, the four failure kinds), an
 * optional step limit, an optional failure ledger and an optional
 * cancellation at a random point. Every transition is recorded so the
 * properties can look at the state each effect was asked from.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { TurnEffect, TurnEvent, TurnState, Transition } from '../../../engine/turnEffects'
import { advanceTurn, defaultTurnPolicies } from '../../../engine/turnLoop'
import { unansweredCalls } from '../../../engine/turnInvariants'
import { freezeDeep } from '../fakes/freezeDeep'
import { runScriptedTurn, type ScheduledArrival } from '../fakes/fakeInterpreter'
import { fakeToolRunner, routeEffects, scriptedModel, startingTurnState, type ModelStep } from '../fakes/fakeParts'
import { ledgerWith } from '../decisions/driveMachine'

type Step = { state: TurnState; event: TurnEvent; t: Transition }

type Script = {
  steps: ModelStep[]
  maxTurns: number | undefined
  maxFailures: number | undefined
  cancelAt: number | undefined
}

const stepArb: fc.Arbitrary<ModelStep> = fc.oneof(
  fc.constant<ModelStep>({ reply: 'text' }),
  fc.array(fc.constantFrom('Read', 'Bad', 'Ask'), { minLength: 1, maxLength: 3 }).chain((names) =>
    fc.constant<ModelStep>({ reply: 'tools', toolCalls: names.map((name, i) => ({ id: `${name}-${i}`, name })) })),
  fc.constantFrom<ModelStep>({ fail: 'output_cap' }, { fail: 'prompt_too_long' }, { fail: 'api_error', error: 'boom' }),
)

const scriptArb: fc.Arbitrary<Script> = fc.record({
  steps: fc.array(stepArb, { maxLength: 8 }),
  maxTurns: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  maxFailures: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
  cancelAt: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
})

function run(script: Script): { steps: Step[]; trace: ReturnType<typeof runScriptedTurn> } {
  const steps: Step[] = []
  // Call ids are unique per reply; plain replies after the script end every run.
  const model = scriptedModel([
    ...script.steps.map((s, n) => ('toolCalls' in s && s.toolCalls
      ? { ...s, toolCalls: s.toolCalls.map((c, i) => ({ ...c, id: `${c.name}-${n}-${i}` })) }
      : s)),
    ...Array.from({ length: 12 }, () => ({ reply: 'text' })),
  ])
  const arrivals: ScheduledArrival[] = script.cancelAt === undefined
    ? []
    : [...Array.from({ length: script.cancelAt }, (_, i) => ({ label: `pad${i}`, kind: 'fragment' as const })), { label: 'cancel', kind: 'cancel', payload: 'user' }]
  const trace = runScriptedTurn({
    advance: (state, event, policies) => {
      const t = advanceTurn(state, freezeDeep(event), policies)
      steps.push({ state, event, t })
      return t
    },
    policies: defaultTurnPolicies,
    initial: startingTurnState({
      limits: script.maxTurns === undefined ? {} : { maxTurns: script.maxTurns },
      loopLedger: script.maxFailures === undefined ? undefined : ledgerWith(script.maxFailures),
    }),
    respond: routeEffects({ model, tools: fakeToolRunner({ Bad: { isError: true, text: 'failed' }, Ask: { halt: true } }) }),
    arrivals,
  })
  return { steps, trace }
}

const requestsOf = (steps: readonly Step[]) =>
  steps.flatMap((s) => s.t.effects.flatMap((e) => (e.kind === 'requestModel' ? [{ from: s.t.state, effect: e }] : [])))

const PARAMS = { numRuns: 300, seed: 20261008 }

describe('turn machine properties', () => {
  it('commits exactly one terminal and asks for nothing after it', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const { steps, trace } = run(script)
      expect(trace.commits).toBe(1)
      const commitAt = steps.findIndex((s) => s.t.effects.some((e) => e.kind === 'commitTerminal'))
      expect(commitAt).toBeGreaterThanOrEqual(0)
      for (const later of steps.slice(commitAt + 1)) expect(later.t.effects).toEqual([])
      const commitStep = steps[commitAt].t.effects
      expect(commitStep.at(-1)?.kind).toBe('commitTerminal')
    }), PARAMS)
  })

  it('answers every tool call before the next model request', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      for (const { effect } of requestsOf(run(script).steps)) expect(unansweredCalls(effect.messages)).toEqual([])
    }), PARAMS)
  })

  it('never lowers k and raises it by at most one per request', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const { steps } = run(script)
      for (const s of steps) expect(s.t.state.k - s.state.k).toBeGreaterThanOrEqual(0)
      for (const s of steps) expect(s.t.state.k - s.state.k).toBeLessThanOrEqual(1)
      const ks = requestsOf(steps).map((r) => r.effect.k)
      ks.forEach((k, i) => expect(k).toBeGreaterThanOrEqual(i === 0 ? 1 : ks[i - 1]))
    }), PARAMS)
  })

  it('forces the final reply once the failure streak reaches the limit, and max_failures only then', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const { steps, trace } = run(script)
      for (const { from, effect } of requestsOf(steps)) {
        const ledger = from.loopLedger
        if (ledger && ledger.failureStreak >= ledger.settings.maxFailures) expect(effect.finalResponse).toBe(true)
      }
      const outcome = trace.conclusion?.kind === 'outcome' ? trace.conclusion.outcome : undefined
      if (outcome?.reason === 'max_failures') {
        expect(script.maxFailures).toBeDefined()
        expect(outcome.consecutiveFailures).toBeGreaterThanOrEqual(script.maxFailures!)
      }
    }), PARAMS)
  })

  it('is deterministic: the same script gives the same transitions', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const strip = (steps: Step[]) => steps.map((s) => ({ event: s.event.type, effects: s.t.effects.map(shapeOf), outputs: s.t.outputs.length, k: s.t.state.k }))
      const a = strip(run(script).steps)
      const b = strip(run(script).steps)
      expect(a).toEqual(b)
    }), PARAMS)
  })

  it('never writes to the state or the event it is given', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      // The fake interpreter deep-freezes every state and `run` every event;
      // a write throws `FrozenWriteError` and fails the run.
      expect(() => run(script)).not.toThrow()
    }), PARAMS)
  })

  it('gives a structurally equal transition for an equal state and event', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      for (const s of run(script).steps.slice(0, 12)) {
        expect(advanceTurn(s.state, s.event, defaultTurnPolicies)).toEqual(s.t)
      }
    }), { ...PARAMS, numRuns: 100 })
  })
})

function shapeOf(e: TurnEffect): string {
  return `${e.kind}#${e.identity.effectId}`
}
