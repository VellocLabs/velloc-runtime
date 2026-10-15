/**
 * Runs the real `advanceTurn` through the synchronous fake interpreter with a
 * scripted model, fake tools and optional overrides, and summarises the run
 * for the decision tables and the properties.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LoopLedger, TurnEffect, TurnEvent, TurnPolicies, TurnState } from '../../../engine/turnEffects'
import { advanceTurn, defaultTurnPolicies } from '../../../engine/turnLoop'
import { createAgentLoopState } from '../../../engine/loop/agentLoopState'
import { defaultAgentLoopSettings } from '../../../config/agentLoopConfig'
import { runScriptedTurn, type EffectContext, type ScheduledArrival, type ScriptedTurnResult, type TraceEntry } from '../fakes/fakeInterpreter'
import {
  fakeToolRunner,
  routeEffects,
  scriptedModel,
  startingTurnState,
  type FakeToolAnswer,
  type ModelStep,
} from '../fakes/fakeParts'

export type MachineScript = {
  readonly model: readonly ModelStep[]
  readonly tools?: Readonly<Record<string, FakeToolAnswer>>
  readonly state?: Partial<TurnState>
  readonly policies?: Partial<TurnPolicies>
  readonly arrivals?: readonly ScheduledArrival[]
  readonly other?: (effect: TurnEffect, ctx: EffectContext) => TurnEvent | undefined
}

export type MachineRun = ScriptedTurnResult & {
  readonly effectKinds: string[]
  readonly requests: Extract<TurnEffect, { kind: 'requestModel' }>[]
  readonly batches: Extract<TurnEffect, { kind: 'runToolBatch' }>[]
}

export function driveMachine(script: MachineScript): MachineRun {
  const model = scriptedModel(script.model)
  const tools = fakeToolRunner(script.tools ?? {})
  const result = runScriptedTurn({
    advance: advanceTurn,
    policies: { ...defaultTurnPolicies, ...script.policies },
    initial: startingTurnState(script.state ?? {}),
    respond: routeEffects({ model, tools, other: script.other }),
    arrivals: script.arrivals,
  })
  return {
    ...result,
    effectKinds: effectsOf(result.trace).map((e) => e.kind),
    requests: model.requests,
    batches: tools.batches,
  }
}

export function effectsOf(trace: readonly TraceEntry[]): TurnEffect[] {
  return trace.flatMap((e) => (e.kind === 'effect' ? [e.effect] : []))
}

export function eventsOf(trace: readonly TraceEntry[]): TurnEvent[] {
  return trace.flatMap((e) => (e.kind === 'event' ? [e.event] : []))
}

/** A loop ledger with the given failure limit and streak. */
export function ledgerWith(maxFailures: number, failureStreak = 0): LoopLedger {
  const live = createAgentLoopState({ ...defaultAgentLoopSettings(), maxFailures })
  return { ...live, failureStreak, countedFailureToolCallIds: new Set() }
}

const FIXTURE_DIR = join(__dirname, '..', 'fixtures')

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f: string) => f.endsWith('.trace.json'))
    .map((f: string) => f.slice(0, -'.trace.json'.length))
    .sort()
}

/** The loop terminal a fixture recorded, or undefined when the loop never
 *  concluded (a command, a dropped prompt, a delivery consumed elsewhere). */
export function recordedTerminal(name: string): Record<string, unknown> | undefined {
  const trace = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.trace.json`), 'utf-8')) as {
    terminal: null | { reason?: string; terminal?: Record<string, unknown> }
  }
  const t = trace.terminal
  if (!t) return undefined
  if (t.terminal) return t.terminal
  return typeof t.reason === 'string' ? (t as Record<string, unknown>) : undefined
}
