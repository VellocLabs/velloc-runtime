/**
 * The shared vocabulary of the hook chain (F-25): a mod exports
 * `register(on, options)` and its hooks are `($, e, next)`. Types only, imported by
 * the runtime and the worker alike.
 */

/**
 * The chain's five tiers, OUTERMOST FIRST (earlier = more authority): `prepend` and
 * `append` are managed plugins, `user` installed ones, `builtin` bundled, `core` the
 * engine. `append` sits BETWEEN `user` and `builtin`.
 */
export const TIERS = ['prepend', 'user', 'append', 'builtin', 'core'] as const
export type Tier = (typeof TIERS)[number]

/** A tier a plugin's hooks can sit in — never `core`, the engine's own. */
export type PluginTier = Exclude<Tier, 'core'>

/** What `next.to(e, tier)` may name: never a tier with more authority than a
 *  managed plugin's own (`prepend`), and never `user`. */
export type TargetTier = Exclude<Tier, 'prepend' | 'user'>

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier)
}

/**
 * Security: who may call `next.to`, and what each may name, as an explicit
 * allowlist: `prepend` may name append, builtin or core; `append` only core;
 * `user` and `builtin` nothing. The named tier arrives over a port as an arbitrary
 * string, so only membership here admits it.
 */
export const NEXT_TO_TARGETS: Readonly<Partial<Record<PluginTier, readonly TargetTier[]>>> =
  Object.freeze({
    prepend: Object.freeze(['append', 'builtin', 'core'] as const),
    append: Object.freeze(['core'] as const),
  })

/**
 * Who raised a dispatch: the calling plugin's name and the tier it sits in;
 * the engine reads `{ plugin: 'engine', tier: 'core' }`. Set by the host from
 * where the call came from — nothing a plugin writes reaches it. Every hook of
 * one dispatch sees the same origin, and `next.to` keeps it.
 */
export type Origin = {
  readonly plugin: string
  readonly tier: Tier
}

export const ENGINE_ORIGIN: Origin = Object.freeze({ plugin: 'engine', tier: 'core' })

/**
 * The time bounds every hook runs under, in milliseconds. Each bounds the
 * hook's OWN time: the clock stops while a `next(e)` call or any `$` call of
 * the hook's is in flight (a `$.clock` wait excepted), so a slow chain beneath
 * or a minute-long model call costs it nothing.
 */
export const HOOK_BUDGET = Object.freeze({
  /** A hook's budget per dispatch, from its call to its return; past it the
   *  hook is absent (its `.catch` asked, else the chain goes on without it). */
  ms: 10_000,
  /** A `.catch` handler's grace: a fresh budget from the moment it is called. */
  catchMs: 1_000,
  /** How long a hook may keep running after `next.signal` aborted before it is
   *  reported as lingering. */
  lingerMs: 5_000,
})

/** The budget the code reading `next.budget` runs under. `ms` is 0 and
 *  `remainingMs` Infinity where nothing meters. */
export type NextBudget = {
  readonly ms: number
  readonly remainingMs: number
}

/**
 * Why a hook failed, as its `.catch` handler reads it on `next.error`.
 * `throw`: it threw, or returned what the site refuses; `timeout`: it outran
 * its budget, `message` then what its last `next()` rejected with, if it did.
 */
export type HookFailure = {
  readonly kind: 'throw' | 'timeout'
  readonly message?: string
  /** The grace the handler runs under, in milliseconds. */
  readonly budget: number
}

/**
 * What the chain decided for one link (`next.trace`): `returned`, `passed`,
 * `skipped`, `kept`, `expired`, `caught`, `rejected` (the deepest is where the
 * rejection came from).
 */
export type TraceOutcome =
  | 'caught'
  | 'expired'
  | 'kept'
  | 'passed'
  | 'rejected'
  | 'returned'
  | 'skipped'

/** One settled run of a link beneath the caller, as `next.trace` lists it:
 *  data, not a handle. */
export type TraceEntry = {
  /** The link's place in the chain, 0 the outermost. */
  readonly index: number
  /** The hook's plugin; `engine` for the engine's own core. */
  readonly plugin: string
  readonly tier: Tier
  readonly event: string
  readonly outcome: TraceOutcome
  /** Why the link was skipped without running, when it was: `bypassed by
   *  <plugin>`, whose `next.to` went beneath this tier. Absent when it ran. */
  readonly reason?: string
  /** Its own wall time, its `next()` calls' time in flight taken out. */
  readonly ms: number
  readonly received: unknown
  /** What the link settled on; undefined when it was skipped or rejected. */
  readonly returned: unknown
  /** How many chunks the link yielded up, on a streaming event; absent on
   *  any other. */
  readonly chunks?: number
}

/**
 * "The events that stream: their hooks are async generators, `next(e)` is the
 * stream of everything beneath, and the result is what it returns." A hook on
 * one of these BY NAME must be an async generator ("the one form that loads
 * there"); a generator by name on any other event is refused the same way.
 */
export const STREAMING_EVENTS = Object.freeze(['turn.step', 'process.spawn'] as const)
export type StreamingEventName = (typeof STREAMING_EVENTS)[number]

export function isStreamingEvent(event: string): event is StreamingEventName {
  return (STREAMING_EVENTS as readonly string[]).includes(event)
}

/**
 * How a streaming hook's budget is counted — "only while its own code runs,
 * never at a `yield` or while it reads beneath: on `turn.step` the sum over
 * the response; on `process.spawn` per piece, anew at each pull."
 */
export type StreamBudgetPer = 'stream' | 'pull'

/**
 * One `on(pattern, matcher?, hook)` of a hooks module, as it crosses to the
 * chain: everything the host needs to decide WHETHER to call the hook, so an
 * event no hook selects costs no round trip.
 */
export type HookRegistration = {
  /** Unique within its module load: `<n>` in registration order. */
  readonly hookId: string
  /** An event's name, a glob (`*`, `classic.*`), or a negation of either. */
  readonly pattern: string
  /** Plain data (RegExp included), or absent for "every `e`". */
  readonly matcher?: unknown
  /** Whether the registration took a `.catch` handler. */
  readonly hasCatch: boolean
  /** Whether the hook is an async generator — the form a streaming event
   *  takes. Absent: a plain function. */
  readonly streams?: boolean
}

/**
 * What a `$` call from inside a hook carries into the dispatch it raises: who caused
 * it, and the one hook frame to skip; the dispatch starts at the TOP of the chain.
 */
export type DispatchContext = {
  readonly origin: Origin
  /** The calling hook's link id — the recursion skip. */
  readonly skipLinkId?: string
  /**
   * A plugin whose every hook this dispatch leaves out — for the events the
   * declaration raises "through the other plugins' hooks, this plugin's own
   * skipped" (`$.config.set`: "that plugin's own hooks do not see it").
   * Never carried into a dispatch nested beneath.
   */
  readonly skipPlugin?: string
  /**
   * How many dispatches deep this one is nested through `$` calls. Velloc's
   * guard, not the spec's: skipping only the immediate caller lets two hooks
   * on one event call it back and forth forever, so a dispatch past
   * `MAX_DISPATCH_DEPTH` is refused.
   */
  readonly depth: number
  /**
   * The rate of the `$` calls made in this dispatch, nested dispatches
   * included — ONE meter the whole tree shares. Velloc's guard beside
   * `depth`: the budget clock stops while a `$` call is in flight, so a hook
   * spinning on cheap `$` calls is caught by their rate, not their time. A
   * call past `DISPATCH_CALL_RATE` is refused; a paced hook may make any
   * number. Absent where nothing is dispatching (a timer's `$`).
   */
  readonly calls?: DispatchCallRate
}

/** See `DispatchContext.depth`. */
export const MAX_DISPATCH_DEPTH = 64

/** See `DispatchContext.calls`: `burst` calls at once, then `perSecond`. */
export const DISPATCH_CALL_RATE = Object.freeze({ burst: 512, perSecond: 100 })

/**
 * See `DispatchContext.calls`. A token bucket kept as its theoretical arrival
 * time: a call fits while it is no more than `burst - 1` intervals ahead of
 * now. A refused call takes nothing, so a hook that backs off is served again.
 */
export class DispatchCallRate {
  private ahead = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Takes one call when it fits; false when the dispatch is calling too fast. */
  take(): boolean {
    const interval = 1000 / DISPATCH_CALL_RATE.perSecond
    const at = this.now()
    const due = Math.max(this.ahead, at)
    if (due - at > (DISPATCH_CALL_RATE.burst - 1) * interval) return false
    this.ahead = due + interval
    return true
  }
}

/** The words a refusal by the rate uses, after what was refused. */
export function callRateRefusal(): string {
  return (
    `faster than ${DISPATCH_CALL_RATE.perSecond} a second after a burst of ` +
    `${DISPATCH_CALL_RATE.burst}`
  )
}

/** A hook's `next` called again counts as a `$` call does: it runs every
 *  hook beneath and core again, on a paused clock. Throws past the rate. */
export function countNextAgain(calls: DispatchCallRate, plugin: string, event: string): void {
  if (!calls.take()) {
    throw new Error(
      `${plugin}'s hook on ${event} called next() again ${callRateRefusal()} calls in one dispatch; ` +
        `the call is refused`,
    )
  }
}

/** The kernel `kind` of a mod's worker — what `KernelWindowHost` registers
 *  its bundle under and what the mod runtime asks the kernel for. */
export const MOD_WORKER_KIND = 'mod'

export const ROOT_DISPATCH_CONTEXT: DispatchContext = Object.freeze({
  origin: ENGINE_ORIGIN,
  depth: 0,
})
