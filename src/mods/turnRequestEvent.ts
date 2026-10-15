/**
 * `turn.request`: the whole request of one step before it is sent; a hook may replace
 * `system`, `messages`, `tools`, `model`, `effort`. Image / document parts cross as
 * placeholders `{ kind, bytes, ref }`; one naming a ref this request never gave
 * refuses the rewrite. Pure.
 */

import { TURN_STEP_EFFORTS } from './turnStepEvent'

/** The thinking tiers a request may be sent with. */
export type TurnRequestEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type TurnRequestInput = {
  turnId: string
  /** The step's index in the turn, from 0 (`turn.step`'s). */
  index: number
  model: string
  effort?: TurnRequestEffort
  /** The system prompt, its parts joined by a blank line. */
  system: string
  /** The messages as the transport sends them, bodies held. */
  messages: readonly unknown[]
  /** The tool definitions as the transport sends them. */
  tools: readonly unknown[]
  agentId?: string
}

/** What the chain settles on: the request to send. Missing: as built. */
export type TurnRequestRewrite = {
  system?: string
  messages?: unknown[]
  tools?: unknown[]
  model?: string
  effort?: TurnRequestEffort
}

/** A held body, as a hook sees it. */
export type HeldBody = { kind: 'image' | 'document'; bytes: number; ref: string }

const HELD_KINDS: ReadonlySet<string> = new Set(['image', 'document'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The decoded size of the largest inline string a part carries (base64 is
 *  counted as the bytes it decodes to; a data URL without its prefix). */
function bodyBytes(part: Record<string, unknown>): number {
  let largest = 0
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const comma = value.startsWith('data:') ? value.indexOf(',') : -1
      const body = comma >= 0 ? value.slice(comma + 1) : value
      largest = Math.max(largest, Math.floor((body.length * 3) / 4))
    } else if (isRecord(value)) {
      for (const inner of Object.values(value)) visit(inner)
    }
  }
  for (const [key, value] of Object.entries(part)) if (key !== 'type') visit(value)
  return largest
}

/** A copy of `value` with every image / document part replaced by its
 *  placeholder; the parts go into `held` under their refs. */
export function holdBodies(
  value: unknown,
  held: Map<string, unknown>,
  kindOf: (part: Record<string, unknown>) => HeldBody['kind'] | undefined = heldKindOfType,
): unknown {
  if (Array.isArray(value)) return value.map(item => holdBodies(item, held, kindOf))
  if (!isRecord(value)) return value
  const kind = kindOf(value)
  if (kind !== undefined) {
    const ref = `b${held.size}`
    held.set(ref, value)
    const placeholder: HeldBody = { kind, bytes: bodyBytes(value), ref }
    return placeholder
  }
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) out[key] = holdBodies(inner, held, kindOf)
  return out
}

/** The turn messages' own rule: a part whose `type` is `image` / `document`. */
function heldKindOfType(part: Record<string, unknown>): HeldBody['kind'] | undefined {
  return typeof part.type === 'string' && HELD_KINDS.has(part.type) ? (part.type as HeldBody['kind']) : undefined
}

function isPlaceholder(value: Record<string, unknown>): boolean {
  return typeof value.ref === 'string' && typeof value.kind === 'string' && HELD_KINDS.has(value.kind) && value.type === undefined
}

/** `value` with each placeholder replaced by the part it names. A ref this
 *  request never gave refuses the whole value. */
export function restoreBodies(value: unknown, held: ReadonlyMap<string, unknown>): { value: unknown } | { refused: string } {
  let refused: string | undefined
  const walk = (item: unknown): unknown => {
    if (refused !== undefined) return item
    if (Array.isArray(item)) return item.map(walk)
    if (!isRecord(item)) return item
    if (isPlaceholder(item)) {
      const ref = item.ref as string
      if (!held.has(ref)) {
        refused = `the ${String(item.kind)} placeholder ${ref} is not one this request gave`
        return item
      }
      return held.get(ref)
    }
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(item)) out[key] = walk(inner)
    return out
  }
  const restored = walk(value)
  return refused !== undefined ? { refused } : { value: restored }
}

/** The system prompt as the event's one string. */
export function systemTextOf(system: unknown): string {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.filter(part => typeof part === 'string').join('\n\n')
  return ''
}

export function isTurnRequestEffort(value: unknown): value is TurnRequestEffort {
  return typeof value === 'string' && TURN_STEP_EFFORTS.includes(value)
}

/** What a `turn.request` hook may answer. */
export function isTurnRequestResult(value: unknown): value is TurnRequestRewrite {
  if (!isRecord(value)) return false
  if (value.system !== undefined && typeof value.system !== 'string') return false
  if (value.messages !== undefined && !Array.isArray(value.messages)) return false
  if (value.tools !== undefined && !Array.isArray(value.tools)) return false
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model.trim() === '')) return false
  if (value.effort !== undefined && !isTurnRequestEffort(value.effort)) return false
  return true
}

/** Core: the request as it ARRIVED — `turnId`, `index` and `agentId`
 *  pinned (a rewrite of them is kept as sent), the rest as a hook above
 *  handed it down, a field of the wrong kind as built. */
export function arrivedTurnRequest(sent: TurnRequestInput, arrived: unknown): TurnRequestRewrite {
  const a = isRecord(arrived) ? arrived : {}
  return {
    system: typeof a.system === 'string' ? a.system : sent.system,
    messages: Array.isArray(a.messages) ? a.messages : [...sent.messages],
    tools: Array.isArray(a.tools) ? a.tools : [...sent.tools],
    model: typeof a.model === 'string' && a.model.trim() !== '' ? a.model : sent.model,
    ...(isTurnRequestEffort(a.effort) ? { effort: a.effort } : sent.effort !== undefined ? { effort: sent.effort } : {}),
  }
}
