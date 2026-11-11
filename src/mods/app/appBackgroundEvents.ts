/**
 * Admission of an app's background module (F-40): the events it may hook
 * and the nouns it may call. Security: the module runs outside every
 * session, so every session noun is refused by name, before it loads where
 * the scan sees the call and at the call otherwise.
 */

import type { HookRegistration } from '../modTypes'
import type { ModUses } from '../modScan'
import { isValidPattern } from '../eventPattern'

export const APP_BACKGROUND_ABI = 'Velloc app background ABI 0.1'

export const APP_BACKGROUND_EVENTS: readonly string[] = Object.freeze(['app.start', 'app.stop', 'app.action', 'app.show', 'app.layout', 'app.hide', 'app.press', 'mcp.status'])

/** The nouns a background module may call; `$.plugin` holds values, not calls. */
export const APP_BACKGROUND_NOUNS: readonly string[] = Object.freeze(['app', 'store', 'http', 'log', 'clock', 'fs', 'mcp', 'plugin'])

const ONLY_METHODS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  app: Object.freeze(['state', 'publish', 'badge', 'analyze']),
  http: Object.freeze(['fetch']),
  log: Object.freeze(['debug', 'info', 'warn', 'error']),
  mcp: Object.freeze(['call', 'connect']),
})

/** Why a background module may not hook what it registered, or null. */
export function refuseAppBackgroundRegistrations(hooks: readonly HookRegistration[]): string | null {
  const foreign: string[] = []
  const generators: string[] = []
  for (const hook of hooks) {
    const { pattern } = hook
    if (!isValidPattern(pattern) || pattern.startsWith('!') || !APP_BACKGROUND_EVENTS.includes(pattern)) {
      foreign.push(pattern)
      continue
    }
    if (hook.streams === true) generators.push(pattern)
  }
  const reasons: string[] = []
  if (foreign.length > 0) {
    const events = `${APP_BACKGROUND_EVENTS.slice(0, -1).join(', ')} and ${APP_BACKGROUND_EVENTS.at(-1)}`
    reasons.push(
      `an app's background module hooks ${events} alone, and it hooks ` +
        `${[...new Set(foreign)].join(', ')} — put session hooks in a module listed under the manifest's hooks (${APP_BACKGROUND_ABI})`,
    )
  }
  if (generators.length > 0) {
    reasons.push(`its hook on ${[...new Set(generators)].join(', ')} is an async generator; the app events take a plain function`)
  }
  return reasons.length > 0 ? reasons.join('; ') : null
}

/** Why a background module may not call `$.<noun>.<method>`, or null. */
export function refuseAppBackgroundCall(noun: string, method: string): string | null {
  if (!APP_BACKGROUND_NOUNS.includes(noun)) {
    return (
      `$.${noun} is a session noun, which an app's background module cannot use — it may use ` +
      `${APP_BACKGROUND_NOUNS.map(name => `$.${name}`).join(', ')} (${APP_BACKGROUND_ABI})`
    )
  }
  const only = ONLY_METHODS[noun]
  if (only && !only.includes(method)) {
    return `$.${noun}.${method} is not available to an app's background module — $.${noun} offers ${only.join(', ')} (${APP_BACKGROUND_ABI})`
  }
  return null
}

/** Why what the module calls (as scanned before it runs) is not what it may call, or null. */
export function refuseAppBackgroundUses(uses: ModUses): string | null {
  const reasons: string[] = []
  for (const call of uses.calls) {
    const dot = call.indexOf('.')
    const reason = refuseAppBackgroundCall(dot === -1 ? call : call.slice(0, dot), dot === -1 ? '' : call.slice(dot + 1))
    if (reason && !reasons.includes(reason)) reasons.push(reason)
  }
  return reasons.length > 0 ? reasons.join('; ') : null
}
