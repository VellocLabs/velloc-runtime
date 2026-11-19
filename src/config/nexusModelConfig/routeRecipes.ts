/**
 * Routes a person composes on a router provider (F-27): each is one model row
 * of the router, an ordered list of other providers' models. Stored on the
 * router's config as `routes`. Shape alone is checked here; whether a
 * candidate's provider may be routed to is checked where a route is used.
 */

// Security: a route that fails the check is dropped whole, never repaired. A
// candidate's limits cap what a paid provider is used for; a route kept with
// an unreadable limit removed would run uncapped.

export const ROUTE_GOALS = ['same-model', 'free-rotation', 'ordered', 'spread'] as const
export type RouteGoal = (typeof ROUTE_GOALS)[number]

export const ROUTES_MAX = 32
export const ROUTE_CANDIDATES_MAX = 32
export const ROUTE_ID_MAX = 64
export const ROUTE_NAME_MAX = 120
export const ROUTE_LIMIT_MAX = 1_000_000_000
const PROVIDER_ID_MAX = 64
const MODEL_ID_MAX = 256
const ROUTE_ID_CHARS = /^[A-Za-z0-9_.-]+$/

/**
 * What a person lets one candidate be used for. Each is a whole number above
 * zero; an absent one is no cap. The platform stores them; the router's
 * module counts against them and stops choosing a candidate that reached one.
 */
export type RouteLimits = {
  requestsPerMinute?: number
  requestsPerDay?: number
  /** Input and output tokens together. */
  tokensPerDay?: number
}

/**
 * One member of a route. `provider` is a provider INSTANCE id, opaque: two
 * candidates with the same `model` under different providers are two members.
 */
export type RouteCandidate = {
  provider: string
  model: string
  limits?: RouteLimits
}

export type RouteRecipe = {
  /** The row id under the router. */
  id: string
  /** The row's name, the person's words. */
  name: string
  goal: RouteGoal
  /** 1 to `ROUTE_CANDIDATES_MAX`, in the person's order. */
  candidates: RouteCandidate[]
  /** `manual` keeps the list's order; `auto` lets the router order it. */
  order: 'auto' | 'manual'
  switchOn: { limits: boolean; serverErrors: boolean; afterReplyStarted: boolean }
  freeFirst: boolean
  stickPerTurn: boolean
  spend?: { usdPerDay: number; whenReached: 'stop' | 'free-only' }
}

/** Which part of a route is not well formed. */
export type RouteRecipeFault =
  | 'shape'
  | 'id'
  | 'name'
  | 'goal'
  | 'candidates'
  | 'candidate'
  | 'duplicate-candidate'
  | 'limits'
  | 'order'
  | 'switchOn'
  | 'flags'
  | 'spend'

const LIMIT_KEYS = ['requestsPerMinute', 'requestsPerDay', 'tokensPerDay'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLimits(raw: unknown): RouteLimits | undefined | 'limits' {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return 'limits'
  const limits: RouteLimits = {}
  for (const key of Object.keys(raw)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) return 'limits'
  }
  for (const key of LIMIT_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ROUTE_LIMIT_MAX) return 'limits'
    limits[key] = value
  }
  return Object.keys(limits).length > 0 ? limits : undefined
}

function readCandidate(raw: unknown): RouteCandidate | RouteRecipeFault {
  if (!isRecord(raw)) return 'candidate'
  const { provider, model } = raw
  if (typeof provider !== 'string' || provider === '' || provider.length > PROVIDER_ID_MAX || /\s/.test(provider)) {
    return 'candidate'
  }
  if (typeof model !== 'string' || model === '' || model.length > MODEL_ID_MAX || model !== model.trim()) {
    return 'candidate'
  }
  const limits = readLimits(raw.limits)
  if (limits === 'limits') return 'limits'
  return limits ? { provider, model, limits } : { provider, model }
}

/**
 * The route `raw` describes, or which part of it is not well formed. The
 * answer is a fresh object holding the known fields alone.
 */
export function readRouteRecipe(raw: unknown): RouteRecipe | RouteRecipeFault {
  if (!isRecord(raw)) return 'shape'
  const { id, name, goal, candidates, order, switchOn, freeFirst, stickPerTurn, spend } = raw
  if (typeof id !== 'string' || id === '' || id.length > ROUTE_ID_MAX || !ROUTE_ID_CHARS.test(id)) return 'id'
  if (typeof name !== 'string' || name.trim() === '' || name.length > ROUTE_NAME_MAX) return 'name'
  if (typeof goal !== 'string' || !(ROUTE_GOALS as readonly string[]).includes(goal)) return 'goal'
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > ROUTE_CANDIDATES_MAX) {
    return 'candidates'
  }
  const members: RouteCandidate[] = []
  const seen = new Set<string>()
  for (const entry of candidates) {
    const member = readCandidate(entry)
    if (typeof member === 'string') return member
    const key = JSON.stringify([member.provider, member.model])
    if (seen.has(key)) return 'duplicate-candidate'
    seen.add(key)
    members.push(member)
  }
  if (order !== 'auto' && order !== 'manual') return 'order'
  if (
    !isRecord(switchOn)
    || typeof switchOn.limits !== 'boolean'
    || typeof switchOn.serverErrors !== 'boolean'
    || typeof switchOn.afterReplyStarted !== 'boolean'
  ) {
    return 'switchOn'
  }
  if (typeof freeFirst !== 'boolean' || typeof stickPerTurn !== 'boolean') return 'flags'
  const recipe: RouteRecipe = {
    id,
    name: name.trim(),
    goal: goal as RouteGoal,
    candidates: members,
    order,
    switchOn: {
      limits: switchOn.limits,
      serverErrors: switchOn.serverErrors,
      afterReplyStarted: switchOn.afterReplyStarted,
    },
    freeFirst,
    stickPerTurn,
  }
  if (spend !== undefined) {
    if (
      !isRecord(spend)
      || typeof spend.usdPerDay !== 'number'
      || !Number.isFinite(spend.usdPerDay)
      || spend.usdPerDay <= 0
      || (spend.whenReached !== 'stop' && spend.whenReached !== 'free-only')
    ) {
      return 'spend'
    }
    recipe.spend = { usdPerDay: spend.usdPerDay, whenReached: spend.whenReached }
  }
  return recipe
}

/** Which part of `raw` is not a well-formed route, or null. */
export function checkRouteRecipe(raw: unknown): RouteRecipeFault | null {
  const read = readRouteRecipe(raw)
  return typeof read === 'string' ? read : null
}

/**
 * The well-formed routes of whatever is stored: a route that fails the check
 * and a second route with an id already seen are dropped, and the list stops
 * at `ROUTES_MAX`. Never throws.
 */
export function sanitizeRouteRecipes(raw: unknown): RouteRecipe[] {
  if (!Array.isArray(raw)) return []
  const out: RouteRecipe[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (out.length >= ROUTES_MAX) break
    const recipe = readRouteRecipe(entry)
    if (typeof recipe === 'string' || seen.has(recipe.id)) continue
    seen.add(recipe.id)
    out.push(recipe)
  }
  return out
}

/** `providers.setRoutes`: replace the routes of one router provider. */
export type SetRoutesPayload = {
  /** The router provider's id. */
  id: string
  /** The whole list. */
  routes: RouteRecipe[]
}

export type SetRoutesResult =
  | { ok: true; routes: RouteRecipe[] }
  | { ok: false; index: number; fault: RouteRecipeFault }
