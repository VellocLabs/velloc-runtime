/**
 * A transition under construction. The phase helpers of the turn machine
 * build one of these from the read-only input state, add effects and outputs
 * to it, and seal it into a `Transition`. Nothing here performs IO: an
 * effect is a request the interpreter carries out later.
 */
import type {
  EffectIdentity,
  MessageOrigin,
  TurnEffect,
  TurnOutput,
  TurnState,
  Transition,
} from './turnEffects'
import type { TerminalPhase, TurnConclusion, TurnOutcome } from './turnOutcome'
import type { Message } from '../runtime/RuntimeTypes'
import {
  TERMINAL_ABORTED,
  TERMINAL_AWAITING_USER,
  TERMINAL_COMPLETED,
  TERMINAL_MAX_TURNS,
  TERMINAL_STOP_HOOK_PREVENTED,
} from '../runtime/VercelModelConstants'

/** Marks a row id the interpreter has to replace with a minted one. */
export const UNMINTED_ROW_ID = 'unminted-row:'

export type Draft = {
  state: TurnState
  readonly effects: TurnEffect[]
  readonly outputs: TurnOutput[]
}

type EffectBody = TurnEffect extends infer E ? (E extends TurnEffect ? Omit<E, 'identity'> : never) : never

export function openDraft(state: TurnState): Draft {
  return { state, effects: [], outputs: [] }
}

export function seal(d: Draft): Transition {
  return { state: d.state, effects: d.effects, outputs: d.outputs }
}

/** The input state, unchanged, with nothing to do. */
export function idle(state: TurnState): Transition {
  return { state, effects: [], outputs: [] }
}

export function patchState(d: Draft, fields: Partial<TurnState>): void {
  d.state = { ...d.state, ...fields }
}

function nextIdentity(d: Draft): EffectIdentity {
  const identity: EffectIdentity = {
    sessionEpoch: d.state.sessionEpoch,
    turnId: d.state.turnId,
    effectId: d.state.nextEffectOrdinal,
  }
  patchState(d, { nextEffectOrdinal: d.state.nextEffectOrdinal + 1 })
  return identity
}

/** Queues an effect; it becomes the one whose answer is awaited. */
export function request(d: Draft, body: EffectBody): EffectIdentity {
  const identity = nextIdentity(d)
  d.effects.push({ ...body, identity } as TurnEffect)
  patchState(d, { awaiting: identity })
  return identity
}

export function emit(d: Draft, message: Message, origin: MessageOrigin): void {
  d.outputs.push({ message, origin })
}

/** A placeholder id for a row this machine builds; the interpreter mints the
 *  real one before the row leaves the loop. */
export function rowId(d: Draft): string {
  const id = `${UNMINTED_ROW_ID}${d.state.turnId}:${d.state.nextEffectOrdinal}`
  patchState(d, { nextEffectOrdinal: d.state.nextEffectOrdinal + 1 })
  return id
}

export function phaseOf(outcome: TurnOutcome): TerminalPhase {
  switch (outcome.reason) {
    case TERMINAL_COMPLETED:
    case TERMINAL_STOP_HOOK_PREVENTED:
    case TERMINAL_MAX_TURNS:
      return 'completed'
    case TERMINAL_AWAITING_USER:
      return 'awaiting_user'
    case TERMINAL_ABORTED:
      return 'aborted'
    default:
      return 'failed'
  }
}

/** The one running → terminal move: sets the phase and the conclusion and
 *  queues the single `commitTerminal`. A second call is a no-op. */
export function conclude(d: Draft, conclusion: TurnConclusion): void {
  if (d.state.phase !== 'running') return
  patchState(d, { phase: conclusion.phase, conclusion })
  request(d, { kind: 'commitTerminal', conclusion })
}

export function finish(d: Draft, outcome: TurnOutcome): void {
  conclude(d, { kind: 'outcome', phase: phaseOf(outcome), outcome })
}
