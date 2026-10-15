/**
 * Synchronous fake interpreter: drives `advanceTurn` with scripted answers and scheduled arrivals and records a
 * trace, with `engine/turnEffects.ts` ordering: outputs before effects; one effect at a time (FIFO); a stream
 * fragment during an effect is recorded, not fed; a cancellation aborts it, feeds `cancelled(cause)` and runs
 * queued effects with `aborted: true`; other arrivals follow the running answer; a background effect answers
 * `backgroundStarted` at once; events after the terminal commit are discarded. State is deep-frozen unless
 * `freeze: false`; two commits or an effect after the commit throw.
 */
import type {
  AdvanceTurn,
  CancelCause,
  EffectIdentity,
  TurnEffect,
  TurnEvent,
  TurnOutput,
  TurnPolicies,
  TurnState,
} from '../../../engine/turnEffects'
import type { TurnConclusion } from '../../../engine/turnOutcome'
import { freezeDeep } from './freezeDeep'
import type { Arrival } from './scheduler'

/** What an arrival delivers: a fragment payload, a cancel cause, or an event. */
export type ScheduledArrival =
  | (Arrival<unknown> & { readonly kind: 'fragment' })
  | (Arrival<CancelCause> & { readonly kind: 'cancel'; readonly payload: CancelCause })
  | (Arrival<TurnEvent> & {
      readonly kind: 'timer' | 'queuedInput' | 'backgroundSettle'
      readonly payload: TurnEvent
    })

export type EffectContext = {
  readonly state: TurnState
  /** True once a cancellation has been delivered in this run. */
  readonly aborted: boolean
}

/** Answers one serial effect with its one event. */
export type EffectResponder = (effect: TurnEffect, ctx: EffectContext) => TurnEvent

export type TraceEntry =
  | { readonly kind: 'event'; readonly event: TurnEvent }
  | { readonly kind: 'output'; readonly output: TurnOutput }
  | { readonly kind: 'effect'; readonly effect: TurnEffect }
  | { readonly kind: 'fragment'; readonly label: string; readonly payload: unknown }
  | { readonly kind: 'abortedEffect'; readonly effect: TurnEffect }
  | { readonly kind: 'discarded'; readonly event: TurnEvent; readonly why: string }

export type ScriptedTurnInput = {
  readonly advance: AdvanceTurn
  readonly policies: TurnPolicies
  readonly initial: TurnState
  readonly respond: EffectResponder
  /** In delivery order: one is delivered during each effect run; leftovers
   *  are delivered after the effect queue drains. */
  readonly arrivals?: readonly ScheduledArrival[]
  readonly freeze?: boolean
  /** Guard against a transition function that never ends. */
  readonly maxEvents?: number
}

export type ScriptedTurnResult = {
  readonly trace: readonly TraceEntry[]
  readonly state: TurnState
  readonly conclusion: TurnConclusion | undefined
  readonly commits: number
}

export class InterpreterInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InterpreterInvariantError'
  }
}

const BACKGROUND_EFFECT = 'startBackground'

function identityOf(event: TurnEvent): EffectIdentity | undefined {
  return 'identity' in event ? event.identity : undefined
}

export function runScriptedTurn(input: ScriptedTurnInput): ScriptedTurnResult {
  const freeze = input.freeze !== false
  const maxEvents = input.maxEvents ?? 500
  const trace: TraceEntry[] = []
  const arrivals = [...(input.arrivals ?? [])]
  const effectQueue: TurnEffect[] = []
  let state = freeze ? freezeDeep(input.initial) : input.initial
  let commits = 0
  let committed = false
  let aborted = false
  let fed = 0

  const feed = (event: TurnEvent): void => {
    const identity = identityOf(event)
    if (committed) {
      trace.push({ kind: 'discarded', event, why: 'turn already committed' })
      return
    }
    if (identity && (identity.sessionEpoch !== state.sessionEpoch || identity.turnId !== state.turnId)) {
      trace.push({ kind: 'discarded', event, why: 'stale identity' })
      return
    }
    fed += 1
    if (fed > maxEvents) throw new InterpreterInvariantError(`more than ${maxEvents} events fed`)
    trace.push({ kind: 'event', event })
    const t = input.advance(state, event, input.policies)
    state = freeze ? freezeDeep(t.state) : t.state
    for (const output of t.outputs) trace.push({ kind: 'output', output })
    effectQueue.push(...t.effects)
  }

  const deliverAfter = (arrival: ScheduledArrival, pending: TurnEvent[]): void => {
    if (arrival.kind === 'fragment') {
      trace.push({ kind: 'fragment', label: arrival.label, payload: arrival.payload })
    } else if (arrival.kind === 'cancel') {
      aborted = true
      pending.push({ type: 'cancelled', cause: arrival.payload })
    } else {
      pending.push(arrival.payload)
    }
  }

  feed({ type: 'begin' })
  for (;;) {
    const effect = effectQueue.shift()
    if (effect) {
      if (committed) throw new InterpreterInvariantError(`effect ${effect.kind} after the terminal commit`)
      trace.push({ kind: 'effect', effect })
      if (effect.kind === 'commitTerminal') {
        commits += 1
        if (commits > 1) throw new InterpreterInvariantError('second terminal commit')
      }
      if (effect.kind === BACKGROUND_EFFECT) {
        feed({ type: 'backgroundStarted', identity: effect.identity })
        continue
      }
      const during = arrivals.shift()
      const pending: TurnEvent[] = []
      if (during?.kind === 'cancel') {
        // Abort the running effect, wait for it (synchronous here), then
        // feed `cancelled` in place of its answer.
        trace.push({ kind: 'abortedEffect', effect })
        aborted = true
        feed({ type: 'cancelled', cause: during.payload })
      } else {
        if (during?.kind === 'fragment') deliverAfter(during, pending)
        const answer = input.respond(effect, { state, aborted })
        feed(answer)
        if (during && during.kind !== 'fragment') deliverAfter(during, pending)
      }
      if (effect.kind === 'commitTerminal') committed = true
      for (const e of pending) feed(e)
      continue
    }
    const late = arrivals.shift()
    if (!late) break
    const pending: TurnEvent[] = []
    deliverAfter(late, pending)
    for (const e of pending) feed(e)
  }
  return { trace, state, conclusion: state.conclusion, commits }
}

/** The trace with fragments and discarded events removed: the "main line"
 *  that must be equal across semantically irrelevant interleavings. */
export function mainLine(trace: readonly TraceEntry[]): TraceEntry[] {
  return trace.filter((e) => e.kind !== 'fragment' && e.kind !== 'discarded')
}
