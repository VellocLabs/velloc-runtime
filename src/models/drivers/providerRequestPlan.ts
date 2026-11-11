/**
 * The per-request plan a provider's `request` hook may answer beside its
 * edits: `limits`, `timeouts`, `route` (F-27).
 *
 * Contract: `readRequestPlan` returns the plan parts the answer states, each
 * within the platform's bounds, or undefined when it states none. It throws
 * on a part of the wrong shape, an unknown property inside a part, and on any
 * `route`; the caller fails the request closed, as for every other part of
 * the answer.
 *
 * Security: the answer is plugin input. A limit never exceeds what the
 * model's row states (the platform's ceiling when the row states nothing),
 * a timeout never leaves the bounds of a declared one, and a request that
 * names an egress is not sent over the direct connection instead.
 */
import { NEXUS_MODEL_CONFIG } from '../../config/nexusModelConfig'
import { findConfiguredModelIn } from '../../config/nexusModelConfig/findConfiguredModel'
import { clampTimeouts, TIMEOUT_KEYS, type ProviderTimeouts } from './providerTimeouts'

export type ProviderRequestLimits = {
  maxOutputTokens?: number
  /** Bounds this request's build only; what the UI shows is the model row's. */
  contextWindow?: number
}

export type ProviderRequestPlan = {
  limits?: ProviderRequestLimits
  timeouts?: ProviderTimeouts
}

/** What the model's row states, when it states it. */
export type ModelCeilings = {
  maxOutputTokens?: number
  contextWindow?: number
}

/** The figures the model's row states; none for a model no row covers. */
export function modelCeilingsOf(providerId: string, model: string): ModelCeilings {
  const row = findConfiguredModelIn(NEXUS_MODEL_CONFIG, providerId, model)
  return {
    ...(row?.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
    ...(row?.contextWindow ? { contextWindow: row.contextWindow } : {}),
  }
}

/** The most a plan may ask for when the model's row states no figure. */
export const PLAN_MAX_OUTPUT_TOKENS_CEILING = 128_000
export const PLAN_CONTEXT_WINDOW_CEILING = 2_000_000

const LIMIT_KEYS = ['maxOutputTokens', 'contextWindow'] as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${what}.${key} is not a known property (known: ${allowed.join(', ')})`)
  }
}

function tokenCount(value: unknown, ceiling: number, what: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${what} is not a whole number of tokens, 1 or more`)
  }
  return Math.min(value, ceiling)
}

function readLimits(value: unknown, ceilings: ModelCeilings): ProviderRequestLimits | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('limits is not an object')
  onlyKeys(value, LIMIT_KEYS, 'limits')
  const maxOutputTokens = tokenCount(
    value.maxOutputTokens,
    ceilings.maxOutputTokens ?? PLAN_MAX_OUTPUT_TOKENS_CEILING,
    'limits.maxOutputTokens',
  )
  const contextWindow = tokenCount(
    value.contextWindow,
    ceilings.contextWindow ?? PLAN_CONTEXT_WINDOW_CEILING,
    'limits.contextWindow',
  )
  if (maxOutputTokens === undefined && contextWindow === undefined) return undefined
  return {
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  }
}

function readTimeouts(value: unknown): ProviderTimeouts | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('timeouts is not an object')
  onlyKeys(value, TIMEOUT_KEYS, 'timeouts')
  for (const key of TIMEOUT_KEYS) {
    const ms = value[key]
    if (ms !== undefined && !(typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)) {
      throw new Error(`timeouts.${key} is not a number of milliseconds, 0 or more`)
    }
  }
  const timeouts = clampTimeouts(value as ProviderTimeouts)
  return Object.keys(timeouts).length > 0 ? timeouts : undefined
}

export function readRequestPlan(answer: Record<string, unknown>, ceilings: ModelCeilings = {}): ProviderRequestPlan | undefined {
  if (answer.route !== undefined) {
    if (typeof answer.route !== 'string' || answer.route === '') throw new Error('route is not the name of an egress')
    // A provider cannot declare an egress yet, so no name can be one of its own.
    throw new Error(`route "${answer.route.slice(0, 64)}" is not an egress this provider declares`)
  }
  const limits = readLimits(answer.limits, ceilings)
  const timeouts = readTimeouts(answer.timeouts)
  if (!limits && !timeouts) return undefined
  return { ...(limits ? { limits } : {}), ...(timeouts ? { timeouts } : {}) }
}
