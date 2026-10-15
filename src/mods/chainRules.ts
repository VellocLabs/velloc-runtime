/**
 * Mods — the rules both dispatch kinds share (`ModDispatcher.dispatch` for a
 * plain event, `streamChain.ts` for a streaming one), kept in one place so the
 * two cannot drift.
 */

import { selectsEvent } from './eventPattern'
import { NEXT_TO_TARGETS, isStreamingEvent, tierIndex, type PluginTier, type TargetTier } from './modTypes'

/** `next.to` continuing beneath: every link above `tier` is passed over. */
export type Bypass = { tier: number; by: string }

/**
 * Whether `link` runs on `event`: its pattern selects the event, and its form
 * is the one that event's dispatch kind runs — an async generator on a
 * streaming event, a plain function on any other.
 */
export function runsOn(link: { pattern: string; streams?: boolean }, event: string): boolean {
  return selectsEvent(link.pattern, event) && (link.streams === true) === isStreamingEvent(event)
}

/**
 * `next.to(e, toTier)` from `link`: the bypass it asks for, or undefined for a
 * plain `next(e)`. An explicit allowlist (NEXT_TO_TARGETS), checked by
 * membership — `toTier` is typed, but it reaches here from a worker as
 * whatever string the module passed. Throws the refusal.
 */
export function nextToBypass(
  link: { plugin: string; tier: PluginTier },
  toTier: TargetTier | undefined,
): Bypass | undefined {
  if (toTier === undefined) return undefined
  const allowed = Object.prototype.hasOwnProperty.call(NEXT_TO_TARGETS, link.tier)
    ? NEXT_TO_TARGETS[link.tier]
    : undefined
  if (!allowed || !(allowed as readonly unknown[]).includes(toTier)) {
    throw new Error(
      `next.to(${JSON.stringify(toTier)}) is refused: ${link.plugin} sits in the ` +
        `${link.tier} tier — ` +
        (allowed
          ? `it may name ${allowed.map(tier => `"${tier}"`).join(', ')}`
          : 'only a managed plugin (prepend, append) may use next.to'),
    )
  }
  return { tier: tierIndex(toTier), by: link.plugin }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function abortError(): Error {
  const error = new Error('the dispatch was abandoned')
  error.name = 'AbortError'
  return error
}
