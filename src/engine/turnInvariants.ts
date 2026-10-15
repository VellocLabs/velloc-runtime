/**
 * Contract: turn-engine invariants (F-26). Safety-critical (a result whose call got no verdict, a
 * lifted path-safety ask): fail closed everywhere. Consistency: throw in tests/dev, skip + log in
 * production. Recoverable: existing recovery + log. Logged only: calls answered before the next
 * request, rows name their origin, model-visible rows were recorded.
 */
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import { MSG_TYPE_ASSISTANT } from '../runtime/VercelModelConstants'
import { traceLine } from '../utils/debugLog'
import type { TurnEffect, TurnEvent, TurnState, Transition } from './turnEffects'
import { resultPartsOf, toolCallsOf } from './turnRows'

export type InvariantTier = 'safety' | 'consistency' | 'recoverable' | 'observed'

export class TurnInvariantError extends Error {
  constructor(readonly tier: InvariantTier, message: string) {
    super(`[turn invariant: ${tier}] ${message}`)
    this.name = 'TurnInvariantError'
  }
}

/** Tests and development builds throw on consistency violations. */
export function strictInvariants(): boolean {
  const viteDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
  const vitest = typeof process !== 'undefined' && !!process.env?.VITEST
  return viteDev || vitest
}

function note(tier: InvariantTier, message: string): void {
  traceLine(`[turn invariant: ${tier}] ${message}`, { level: 'warn' })
}

/** Safety-critical: false means deny. Never throws, never lets it through. */
export function failClosed(holds: boolean, message: string): boolean {
  if (!holds) note('safety', message)
  return holds
}

/** Consistency: throws when strict; otherwise logs and returns false so the
 *  caller skips the duplicate action. */
export function consistent(holds: boolean, message: string, strict = strictInvariants()): boolean {
  if (holds) return true
  if (strict) throw new TurnInvariantError('consistency', message)
  note('consistency', message)
  return false
}

/** Recoverable and observed-only: logged; the normal path continues. */
export function recoverable(holds: boolean, message: string): void {
  if (!holds) note('recoverable', message)
}

export function observed(holds: boolean, message: string): void {
  if (!holds) note('observed', message)
}

const SERIAL_IO: ReadonlySet<TurnEffect['kind']> = new Set(['requestModel', 'runToolBatch'])

/** Unanswered tool calls in the rows a request is built from. */
export function unansweredCalls(rows: readonly Message[]): string[] {
  const asked: string[] = []
  const answered = new Set<string>()
  for (const row of rows) {
    if (row.type === MSG_TYPE_ASSISTANT) asked.push(...toolCallsOf(row as ModelReplyRow).map((c) => c.toolCallId))
    for (const part of resultPartsOf(row)) answered.add(part.toolCallId)
  }
  return asked.filter((id) => !answered.has(id))
}

/** Rows of a model request that were never recorded: every row the model sees
 *  must be one the loop received or yielded (system and ambient context ride
 *  outside the rows). `aliases` maps a placeholder row id to its minted id. */
export function unrecordedRows(
  rows: readonly Message[],
  recorded: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): string[] {
  const missing: string[] = []
  for (const row of rows) {
    const id = (row as { uuid?: unknown }).uuid
    if (typeof id !== 'string') continue
    if (recorded.has(id) || recorded.has(aliases.get(id) ?? '')) continue
    missing.push(id)
  }
  return missing
}

/** Logged only: a model request built from a row nobody recorded. */
export function checkRecorded(
  k: number,
  rows: readonly Message[],
  recorded: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): void {
  const missing = unrecordedRows(rows, recorded, aliases)
  observed(missing.length === 0, `request ${k} carries unrecorded rows: ${missing.join(', ')}`)
}

/**
 * Checks one transition. Returns it unchanged, or — in production after a
 * consistency violation — with the offending effects removed.
 */
export function guardTransition(prev: TurnState, event: TurnEvent, t: Transition, strict = strictInvariants()): Transition {
  let effects = t.effects
  if (prev.phase !== 'running' && effects.length > 0) {
    if (!consistent(false, `${effects.length} effect(s) after the terminal commit (event ${event.type})`, strict)) {
      effects = []
    }
  }
  const commits = effects.filter((e) => e.kind === 'commitTerminal')
  if (commits.length > 1 && !consistent(false, 'more than one terminal commit in a transition', strict)) {
    let kept = false
    effects = effects.filter((e) => e.kind !== 'commitTerminal' || (kept ? false : (kept = true)))
  }
  const serial = effects.filter((e) => SERIAL_IO.has(e.kind))
  if (serial.length > 1 && !consistent(false, 'two model calls or tool batches queued at once', strict)) {
    effects = effects.filter((e) => !SERIAL_IO.has(e.kind) || e === serial[0])
  }
  for (const e of effects) {
    if (e.kind !== 'requestModel') continue
    const open = unansweredCalls(e.messages)
    observed(open.length === 0, `request ${e.k} carries unanswered tool calls: ${open.join(', ')}`)
  }
  for (const o of t.outputs) observed(typeof o.origin === 'string', 'an output row has no origin')
  if ('identity' in event && event.identity) {
    const stale = event.identity.sessionEpoch !== prev.sessionEpoch || event.identity.turnId !== prev.turnId
    recoverable(!stale, `stale ${event.type} answer dropped (effect ${event.identity.effectId})`)
  }
  return effects === t.effects ? t : { ...t, effects }
}
