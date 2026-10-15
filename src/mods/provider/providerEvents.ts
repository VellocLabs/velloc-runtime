/**
 * The events a provider module may hook and what the runtime holds each to: its
 * own-time budget, whether no answer fails the caller closed, and the answer's
 * outline (`accepts`; a wrong kind is a failed hook).
 */

export const PROVIDER_ABI = 'Velloc provider ABI 1'

export type ProviderEventName =
  | 'provider.models'
  | 'provider.verify'
  | 'provider.login'
  | 'provider.refresh'
  | 'provider.logout'
  | 'provider.request'
  | 'provider.sign'
  | 'provider.retry'
  | 'provider.ids'
  | 'provider.sessionEnd'
  | 'provider.usage'

export type ProviderEventSpec = {
  /** The hook's OWN time per call (paused while its `$` calls are in
   *  flight), counted from the moment it is invoked — the worker's cold start
   *  is never part of it. */
  readonly budgetMs: number
  /** One wall-clock bound over the whole dispatch, the person's time
   *  included (`provider.login`). Absent: the own-time budget alone. */
  readonly wallMs?: number
  /** No answer (no hook answered, or the hook failed) fails the caller: the
   *  request is never sent without the transformation the vendor asked for. */
  readonly failClosed: boolean
  /** The answer carries nothing (`provider.logout`, `provider.sessionEnd`):
   *  a hook returning nothing has answered. */
  readonly void: boolean
  /** Whether a hook's answer is of the right outline. */
  readonly accepts: (answer: unknown) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const anything = (): boolean => true
const record = (answer: unknown): boolean => isRecord(answer)

/** "None while the person is asked; 10 min overall." */
export const PROVIDER_LOGIN_OVERALL_MS = 10 * 60_000

export const PROVIDER_EVENTS: Readonly<Record<ProviderEventName, ProviderEventSpec>> = Object.freeze({
  'provider.models': {
    budgetMs: 30_000,
    failClosed: false,
    void: false,
    accepts: Array.isArray,
  },
  'provider.verify': {
    budgetMs: 20_000,
    failClosed: false,
    void: false,
    accepts: record,
  },
  'provider.login': {
    // Own time is metered like any hook's (a `$` call — asking the person —
    // pauses it); the whole sign-in, the person included, is bounded by the
    // wall clock.
    budgetMs: PROVIDER_LOGIN_OVERALL_MS,
    wallMs: PROVIDER_LOGIN_OVERALL_MS,
    failClosed: false,
    void: false,
    accepts: record,
  },
  'provider.refresh': {
    budgetMs: 30_000,
    failClosed: false,
    void: false,
    accepts: record,
  },
  'provider.logout': {
    budgetMs: 10_000,
    failClosed: false,
    void: true,
    accepts: anything,
  },
  'provider.request': {
    budgetMs: 2_000,
    failClosed: true,
    void: false,
    accepts: record,
  },
  'provider.sign': {
    budgetMs: 2_000,
    failClosed: true,
    void: false,
    accepts: record,
  },
  // "`{ retry: … }` or nothing": nothing is an answer — the error goes on to
  // the engine's retry ladder.
  'provider.retry': {
    budgetMs: 2_000,
    failClosed: false,
    void: false,
    accepts: answer => answer === undefined || answer === null || isRecord(answer),
  },
  'provider.ids': {
    budgetMs: 1_000,
    failClosed: true,
    void: false,
    accepts: answer => Array.isArray(answer) && answer.every(id => typeof id === 'string'),
  },
  'provider.sessionEnd': {
    budgetMs: 5_000,
    failClosed: false,
    void: true,
    accepts: anything,
  },
  'provider.usage': {
    budgetMs: 20_000,
    failClosed: false,
    void: false,
    accepts: record,
  },
})

export const PROVIDER_EVENT_NAMES: readonly ProviderEventName[] = Object.freeze(
  Object.keys(PROVIDER_EVENTS) as ProviderEventName[],
)

export function isProviderEventName(name: string): name is ProviderEventName {
  return Object.prototype.hasOwnProperty.call(PROVIDER_EVENTS, name)
}

/** Whether a hook pattern is under the provider namespace (`provider.x`,
 *  `provider.*`) — a provider module's, never a session module's. */
export function isProviderPattern(pattern: string): boolean {
  const bare = pattern.startsWith('!') ? pattern.slice(1) : pattern
  return bare === 'provider' || bare.startsWith('provider.')
}

// ── `$` for a provider module ──

/**
 * The nouns a provider module may call. `$.provider.*` is the provider's own
 * table (its methods arrive with later packages); `$.log` is a provider
 * module's log line; `$.fs` is `read` alone, of the module's own plugin
 * directory (`pluginOwnFiles.ts`: its per-language text and other files it
 * ships). Every session noun (`$.session`, `$.tool`, `$.prompt`, `$.ui`,
 * `$.model`, `$.process`, `$.state`, `$.env`, …) is refused.
 */
export const PROVIDER_MODULE_NOUNS: readonly string[] = Object.freeze(['provider', 'store', 'http', 'log', 'clock', 'catalog', 'fs'])

/** Within an allowed noun, the methods that are refused anyway. `clock.every`
 *  keeps a timer firing in the worker for ever: a provider module's worker
 *  lives only while it is used (idle exit), so a periodic timer would either
 *  keep it alive or be cut off silently — refused, so it never loads and
 *  then quietly stops. `http` is `fetch` alone. */
const REFUSED_METHODS: readonly string[] = Object.freeze(['clock.every'])
const ONLY_METHODS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  http: Object.freeze(['fetch']),
  log: Object.freeze(['debug', 'info', 'warn', 'error']),
  catalog: Object.freeze(['models', 'model', 'status']),
  fs: Object.freeze(['read']),
})

/** Why a provider module may not call `$.<noun>.<method>`, or null. */
export function refuseProviderModuleCall(noun: string, method: string): string | null {
  const call = `${noun}.${method}`
  if (!PROVIDER_MODULE_NOUNS.includes(noun)) {
    return (
      `$.${noun} is a session noun, which a provider module cannot use — it may use ` +
      `${PROVIDER_MODULE_NOUNS.map(name => `$.${name}`).join(', ')} (${PROVIDER_ABI})`
    )
  }
  if (REFUSED_METHODS.includes(call)) {
    return (
      `$.${call} is not available to a provider module: its worker exits when idle, so a ` +
      `periodic timer would stop without notice — use $.clock.after inside a hook instead (${PROVIDER_ABI})`
    )
  }
  const only = ONLY_METHODS[noun]
  if (only && !only.includes(method)) {
    return `$.${call} is not available to a provider module — $.${noun} offers ${only.map(name => `${name}`).join(', ')} (${PROVIDER_ABI})`
  }
  return null
}
