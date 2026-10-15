/**
 * Contract: the hook chain (F-25). `dispatch(event, e, core)` nests the hooks around
 * core, outermost first: prepend → user → append → builtin → core; with no hook it
 * IS a call of `core`. A hook that FAILS (throws, wrong answer, over budget) is
 * absent, not fatal: its `.catch` first, else beneath runs in its place (`skipped`)
 * or its `next` result stands (`kept`). A core rejection travels up. The budget is
 * the hook's OWN time. Security: `next.to(e, tier)` is allowlisted
 * (NEXT_TO_TARGETS): no user hook skips the organization's, and no appended managed
 * plugin skips its peers. Streaming events use `dispatchStream` (streamChain.ts).
 */

import { PausableDeadline } from '../browser/workerKernel/pausableDeadline'
import { abortError, errorMessage, nextToBypass, runsOn, type Bypass } from './chainRules'
import { matches } from './eventPattern'
import {
  countNextAgain,
  HOOK_BUDGET,
  MAX_DISPATCH_DEPTH,
  DispatchCallRate,
  ROOT_DISPATCH_CONTEXT,
  tierIndex,
  type DispatchContext,
  type HookFailure,
  type NextBudget,
  type Origin,
  type PluginTier,
  type StreamBudgetPer,
  type TargetTier,
  type TraceEntry,
  type TraceOutcome,
} from './modTypes'
import {
  runStreamDispatch,
  type ChainStream,
  type DispatchedStream,
  type StreamCatchCall,
  type StreamHookCall,
} from './streamChain'

/** The rest of the chain, as one hook receives it. `toTier` is `next.to`. */
export type ChainNext = (e: unknown, toTier?: TargetTier) => Promise<unknown>

/** What a link is handed for one run of its hook, whatever its form. */
export type HookFrame = {
  readonly event: string
  readonly e: unknown
  /** Who raised this dispatch. */
  readonly origin: Origin
  /** What a `$` call made from THIS hook carries into the dispatch it raises:
   *  this hook's plugin as origin, this link as the recursion skip, one deeper. */
  readonly context: DispatchContext
  /** The links beneath, for this hook's latest `next` call: nearest first, the
   *  engine's last. Empty before `next` is called. */
  trace(): readonly TraceEntry[]
  /** Run a wait that is not the hook's own time (a `$` call): the budget
   *  clock stops for its duration. */
  whileWaiting<T>(work: () => Promise<T>): Promise<T>
  budget(): NextBudget
  /** Aborts when the dispatch is abandoned or this hook ran out of budget. */
  readonly signal: AbortSignal
  /** Whatever the engine attached to this dispatch (the session, the loop). */
  readonly scope: unknown
}

/** What a link is handed for one run of a plain (non-streaming) hook. */
export type HookCall = HookFrame & {
  readonly next: ChainNext
}

/** What a link's `.catch` handler is handed: the same call, afresh, with why
 *  the hook failed and whether it had called `next`. Its `next` is
 *  replay-safe: when `called`, it resolves to what the hook's last call
 *  settled to and nothing beneath runs again; when not, it runs the hooks
 *  beneath once and a later call replays. */
export type CatchCall = HookCall & {
  readonly error: HookFailure
  readonly called: boolean
}

/** One hook, placed in the chain. */
export interface ChainLink {
  /** Unique across every plugin's hooks — the recursion skip names it. */
  readonly id: string
  readonly plugin: string
  readonly tier: PluginTier
  readonly pattern: string
  /** Absent: every `e` of the events the pattern selects. */
  readonly matcher?: unknown
  /** Resolves to the hook's answer; rejects when the hook threw. */
  run(call: HookCall): Promise<unknown>
  /** Present when the registration took a `.catch`. Resolving `undefined`
   *  means the handler stood aside (the hook is absent). */
  runCatch?(call: CatchCall): Promise<unknown>
  /** The hook is an async generator: it runs on streaming events alone, by
   *  `runStream`, and `run` is never called. */
  readonly streams?: boolean
  /** Start the hook as a stream: each pull resumes it to its next `yield`;
   *  the stream's completion value is what it returned (`undefined`: it
   *  returned nothing). Rejects a pull when the hook threw. */
  runStream?(call: StreamHookCall): ChainStream
  /** Its `.catch` handler, a generator too, "continuing the stream". */
  runCatchStream?(call: StreamCatchCall): ChainStream
}

/**
 * What a link rejects `run` with when its hook let a rejection of `next` pass
 * and the original error object is not available to compare (it crossed a
 * port). A link running beside the chain just rethrows the error it caught.
 */
export class NextRejectionPassed extends Error {
  constructor() {
    super('the hook let a rejection of next() pass')
    this.name = 'NextRejectionPassed'
  }
}

/** A dispatch nested through `$` calls past `MAX_DISPATCH_DEPTH`. */
export class ModDispatchDepthError extends Error {
  constructor(event: string, origin: Origin) {
    super(
      `mod dispatch of "${event}" is nested more than ${MAX_DISPATCH_DEPTH} deep ` +
        `(last raised by ${origin.plugin}): hooks are calling each other back through $`,
    )
    this.name = 'ModDispatchDepthError'
  }
}

/** A failed hook, as the chain reports it: once per failure, by name. */
export type HookFailureReport = {
  readonly plugin: string
  readonly tier: PluginTier
  readonly event: string
  readonly linkId: string
  readonly failure: HookFailure
  /** What the chain did about it. */
  readonly outcome: TraceOutcome
}

export type DispatchOptions = {
  /** Who raised it and what to skip. Absent: the engine, at depth 0. */
  context?: DispatchContext
  /** Abandons the dispatch: every hook's `signal` aborts and `dispatch`
   *  rejects `AbortError`. */
  signal?: AbortSignal
  /** Handed to every link as `call.scope`. */
  scope?: unknown
  /** Whether a hook's answer is one this event takes. Default: anything but
   *  `undefined` — "returning nothing is a failure". An event whose result is
   *  void passes `() => true`. `plugin` is the hook's who answered. */
  accepts?: (result: unknown, plugin: string) => boolean
  /** Run only the hooks of the groups registered under these keys — "a later
   *  one runs its hooks alone" (`session.start` after a respawn). */
  onlyGroup?: string | readonly string[]
  /** Handed the whole dispatch's trace once it settled, outermost first —
   *  what a caller reads to name the hook that answered (`plugin.register`'s
   *  refusal names who refused). */
  trace?: (entries: readonly TraceEntry[]) => void
  /** Each hook's own-time budget for THIS dispatch, in place of the
   *  dispatcher's: `session.end`'s hooks share one short wall-clock bound,
   *  and `next.budget` must say so. */
  budgetMs?: number
}

export type StreamDispatchOptions = Omit<DispatchOptions, 'accepts'> & {
  /** Whether a hook's RESULT (what its generator returned) is one this event
   *  takes. Default: anything but `undefined`. */
  accepts?: (result: unknown) => boolean
  /** How a hook's own time is counted: summed over the stream (`turn.step`,
   *  the default) or anew at each pull (`process.spawn`). */
  budgetPer?: StreamBudgetPer
}

export type ModDispatcherOptions = {
  onHookFailure?: (report: HookFailureReport) => void
  /** A hook answered in time (whatever it answered). With `onHookFailure`
   *  this lets a caller count failures IN A ROW. */
  onHookAnswered?: (linkId: string) => void
  /** Test seams; default to HOOK_BUDGET. */
  budgetMs?: number
  catchMs?: number
}

type Settled =
  | { ok: true; result: unknown; entries: TraceEntry[] }
  | { ok: false; error: unknown; entries: TraceEntry[] }

type Run = {
  event: string
  origin: Origin
  depth: number
  calls: DispatchCallRate
  budgetMs: number
  candidates: readonly ChainLink[]
  core: (e: unknown) => unknown
  accepts: (result: unknown, plugin: string) => boolean
  signal: AbortSignal
  scope: unknown
}

export class ModDispatcher {
  private readonly groups = new Map<string, { seq: number; links: readonly ChainLink[] }>()
  private seq = 0
  /** Every link, outermost first: by tier, then by the order its group was
   *  registered, then by the order the hooks were registered in it. */
  private chain: readonly ChainLink[] = []
  private readonly budgetMs: number
  private readonly catchMs: number

  constructor(private readonly options: ModDispatcherOptions = {}) {
    this.budgetMs = options.budgetMs ?? HOOK_BUDGET.ms
    this.catchMs = options.catchMs ?? HOOK_BUDGET.catchMs
  }

  /**
   * Seat one module's hooks. `key` names the group for `unregister`; a group
   * registered under a key already in use replaces it IN PLACE (a reload keeps
   * its seat among its tier's plugins).
   */
  register(key: string, links: readonly ChainLink[]): void {
    const existing = this.groups.get(key)
    this.groups.set(key, { seq: existing?.seq ?? ++this.seq, links: [...links] })
    this.rebuild()
  }

  unregister(key: string): void {
    if (this.groups.delete(key)) this.rebuild()
  }

  /** Seat the named groups in the order `keys` gives, on the seats they
   *  hold between them; a group not named keeps its own. */
  reorder(keys: readonly string[]): void {
    const named = keys.filter(key => this.groups.has(key))
    const seqs = named.map(key => this.groups.get(key)!.seq).sort((a, b) => a - b)
    named.forEach((key, index) => {
      this.groups.set(key, { ...this.groups.get(key)!, seq: seqs[index]! })
    })
    this.rebuild()
  }

  /** Take a group's hooks out of the chain but KEEP ITS SEAT: the module is
   *  expected back (a respawn), and must come back where it sat. */
  vacate(key: string): void {
    const existing = this.groups.get(key)
    if (!existing) return
    this.groups.set(key, { seq: existing.seq, links: [] })
    this.rebuild()
  }

  /** Whether any hook that would run on `event` is registered (whatever its
   *  matcher says): one selecting it, of the form its dispatch kind runs. */
  hasHooksFor(event: string): boolean {
    return this.chain.some(link => runsOn(link, event))
  }

  /** The hooks registered on `event`, each with its plugin and its matcher
   *  (absent: every `e`) — what `ui.render`'s "hooked" sites are read off. */
  matchersFor(event: string): Array<{ plugin: string; matcher?: unknown }> {
    return this.chain
      .filter(link => runsOn(link, event))
      .map(link => ({ plugin: link.plugin, ...(link.matcher !== undefined ? { matcher: link.matcher } : {}) }))
  }

  private rebuild(): void {
    const ordered = [...this.groups.values()].sort((a, b) => a.seq - b.seq)
    const all = ordered.flatMap((group, groupIndex) =>
      group.links.map((link, linkIndex) => ({ link, groupIndex, linkIndex })),
    )
    all.sort(
      (a, b) =>
        tierIndex(a.link.tier) - tierIndex(b.link.tier) ||
        a.groupIndex - b.groupIndex ||
        a.linkIndex - b.linkIndex,
    )
    this.chain = all.map(entry => entry.link)
  }

  /**
   * Raise `event`: run the hooks that select it around `core`, and resolve to
   * what the chain settled on. Rejects with what `core` (or a link that let
   * it pass) rejected with, with `AbortError` when `signal` aborts, and with
   * `ModDispatchDepthError` past the nesting cap.
   */
  async dispatch<R>(
    event: string,
    e: unknown,
    core: (e: unknown) => R | Promise<R>,
    options: DispatchOptions = {},
  ): Promise<R> {
    const context = options.context ?? ROOT_DISPATCH_CONTEXT
    if (context.depth > MAX_DISPATCH_DEPTH) {
      throw new ModDispatchDepthError(event, context.origin)
    }
    const candidates = this.candidatesFor(event, context, options.onlyGroup)
    if (candidates.length === 0) return core(e)
    if (options.signal?.aborted) throw abortError()

    const controller = new AbortController()
    const run: Run = {
      event,
      origin: context.origin,
      depth: context.depth,
      // A nested dispatch (a `$` call's) shares its root's meter.
      calls: context.calls ?? new DispatchCallRate(),
      budgetMs: options.budgetMs ?? this.budgetMs,
      candidates,
      core,
      accepts: options.accepts ?? (result => result !== undefined),
      signal: controller.signal,
      scope: options.scope,
    }
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort()
        reject(abortError())
      }
      options.signal?.addEventListener('abort', onAbort)
    })
    try {
      const settled = await Promise.race([this.runFrom(run, 0, e), abandoned])
      options.trace?.(settled.entries)
      if (!settled.ok) throw settled.error
      return settled.result as R
    } finally {
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      // Whatever is still running for this dispatch (a hook that lingers past
      // its budget, a `next` nobody awaits any more) should stop.
      controller.abort()
    }
  }

  /**
   * Raise streaming event `event`: the stream leaving the outermost hook, lazy; with
   * no hook it IS `core(e)`. Rejects a pull with core's rejection, `AbortError` on
   * `signal`, or `ModDispatchDepthError`; `return()` closes everything beneath.
   */
  dispatchStream<C = unknown, R = unknown>(
    event: string,
    e: unknown,
    core: (e: unknown) => AsyncIterator<C, R>,
    options: StreamDispatchOptions = {},
  ): DispatchedStream<C, R> {
    const context = options.context ?? ROOT_DISPATCH_CONTEXT
    return runStreamDispatch<C, R>({
      event,
      e,
      core,
      context,
      candidates:
        context.depth > MAX_DISPATCH_DEPTH ? [] : this.candidatesFor(event, context, options.onlyGroup),
      refusal: context.depth > MAX_DISPATCH_DEPTH ? new ModDispatchDepthError(event, context.origin) : undefined,
      accepts: options.accepts ?? (result => result !== undefined),
      budgetMs: options.budgetMs ?? this.budgetMs,
      catchMs: this.catchMs,
      budgetPer: options.budgetPer ?? 'stream',
      ...(options.signal ? { signal: options.signal } : {}),
      scope: options.scope,
      ...(options.trace ? { trace: options.trace } : {}),
      ...(this.options.onHookFailure ? { onHookFailure: this.options.onHookFailure } : {}),
      ...(this.options.onHookAnswered ? { onHookAnswered: this.options.onHookAnswered } : {}),
    })
  }

  /** The links a dispatch of `event` visits, outermost first: those that
   *  select it in the form its kind runs, the recursion skip (and a skipped
   *  plugin's every hook) left out. */
  private candidatesFor(
    event: string,
    context: DispatchContext,
    onlyGroup?: string | readonly string[],
  ): readonly ChainLink[] {
    const only =
      onlyGroup === undefined
        ? undefined
        : new Set((typeof onlyGroup === 'string' ? [onlyGroup] : onlyGroup).flatMap(key => this.groups.get(key)?.links ?? []))
    return this.chain.filter(
      link =>
        link.id !== context.skipLinkId &&
        link.plugin !== context.skipPlugin &&
        runsOn(link, event) &&
        (only === undefined || only.has(link)),
    )
  }

  /** Run the chain from candidate `index` down: the first link there that
   *  takes this `e`, or core. */
  private async runFrom(
    run: Run,
    index: number,
    e: unknown,
    bypass?: Bypass,
  ): Promise<Settled> {
    const bypassed: TraceEntry[] = []
    for (let i = index; i < run.candidates.length; i++) {
      const link = run.candidates[i]!
      if (bypass && tierIndex(link.tier) < bypass.tier) {
        bypassed.push({
          index: i,
          plugin: link.plugin,
          tier: link.tier,
          event: run.event,
          outcome: 'skipped',
          reason: `bypassed by ${bypass.by}`,
          ms: 0,
          received: e,
          returned: undefined,
        })
        continue
      }
      // The matcher reads `e` as it ARRIVES here — a hook above may have
      // rewritten it — so it is tested per link, not once per dispatch.
      if (link.matcher !== undefined && !matches(link.matcher, e)) continue
      const settled = await this.runLink(run, i, link, e)
      return { ...settled, entries: [...bypassed, ...settled.entries] }
    }
    const started = Date.now()
    const engine = (outcome: TraceOutcome, returned: unknown): TraceEntry => ({
      index: run.candidates.length,
      plugin: 'engine',
      tier: 'core',
      event: run.event,
      outcome,
      ms: Date.now() - started,
      received: e,
      returned,
    })
    try {
      const result = await run.core(e)
      return { ok: true, result, entries: [...bypassed, engine('returned', result)] }
    } catch (error) {
      return { ok: false, error, entries: [...bypassed, engine('rejected', undefined)] }
    }
  }

  private async runLink(
    run: Run,
    index: number,
    link: ChainLink,
    e: unknown,
  ): Promise<Settled> {
    const started = Date.now()
    let nextTime = 0
    /** The hook called `next` / `next.to` at least once, settled or in flight. */
    let called = false
    /** The latest `next` call: in flight, then settled. */
    let latest: Promise<Settled> | undefined
    let last: Settled | undefined
    /** The hook's own run is over (it answered, failed or expired): a `next`
     *  it calls from now on — a hook that lingers past its budget — reaches
     *  nothing. Its `.catch` handler's `next` is a different function. */
    let hookOver = false

    const controller = new AbortController()
    const onDispatchAbort = (): void => controller.abort()
    run.signal.addEventListener('abort', onDispatchAbort)

    const context: DispatchContext = {
      origin: { plugin: link.plugin, tier: link.tier },
      skipLinkId: link.id,
      depth: run.depth + 1,
      calls: run.calls,
    }

    const entry = (outcome: TraceOutcome, returned: unknown): TraceEntry => ({
      index,
      plugin: link.plugin,
      tier: link.tier,
      event: run.event,
      outcome,
      ms: Math.max(0, Date.now() - started - nextTime),
      received: e,
      returned,
    })

    const below = (): TraceEntry[] => (last ? last.entries : [])

    /** `next` for the hook (`replay: false`) or its `.catch` (`replay: true`). */
    const makeNext =
      (clock: PausableDeadline, replay: boolean): ChainNext =>
      async (e2, toTier) => {
        if (e2 === undefined) {
          throw new Error(
            `next() was called with no argument by ${link.plugin}'s hook on ${run.event}`,
          )
        }
        const bypass = nextToBypass(link, toTier)
        if (!replay && hookOver) {
          throw new Error(
            `next() was called by ${link.plugin}'s hook on ${run.event} after the dispatch had gone on without it`,
          )
        }
        if (replay && latest) {
          // Replay-safe: nothing beneath runs again, the argument is unread.
          const settled = await latest
          if (!settled.ok) throw settled.error
          return settled.result
        }
        if (called) countNextAgain(run.calls, link.plugin, run.event)
        called = true
        const began = Date.now()
        const flight = clock.whilePaused(() => this.runFrom(run, index + 1, e2, bypass))
        latest = flight
        const settled = await flight
        nextTime += Date.now() - began
        // Only the LATEST call's settlement is the hook's "last next".
        if (latest === flight) last = settled
        if (!settled.ok) throw settled.error
        return settled.result
      }

    const callFor = (
      clock: PausableDeadline,
      budgetMs: number,
      replay: boolean,
      signal: AbortSignal,
    ): HookCall => ({
      event: run.event,
      e,
      origin: run.origin,
      context,
      next: makeNext(clock, replay),
      trace: below,
      whileWaiting: work => clock.whilePaused(work),
      budget: () => ({ ms: budgetMs, remainingMs: clock.remainingMs() }),
      signal,
      scope: run.scope,
    })

    type Ran =
      | { kind: 'value'; value: unknown }
      | { kind: 'throw'; error: unknown }
      | { kind: 'expired' }

    /** Run `work` under a fresh own-time budget of `ms`; what it starts is
     *  stopped through `signal`. */
    const timed = async (
      ms: number,
      replay: boolean,
      signal: AbortSignal,
      work: (call: HookCall) => Promise<unknown>,
    ): Promise<Ran> => {
      let expire!: () => void
      const expiry = new Promise<Ran>(resolve => {
        expire = () => resolve({ kind: 'expired' })
      })
      const clock = new PausableDeadline(expire)
      clock.start(ms)
      try {
        return await Promise.race([
          Promise.resolve()
            .then(() => work(callFor(clock, ms, replay, signal)))
            .then(
              (value): Ran => ({ kind: 'value', value }),
              (error): Ran => ({ kind: 'throw', error }),
            ),
          expiry,
        ])
      } finally {
        clock.stop()
      }
    }

    try {
      const ran = await timed(run.budgetMs, false, controller.signal, call => link.run(call))
      hookOver = true
      if (ran.kind !== 'expired') this.options.onHookAnswered?.(link.id)

      if (ran.kind === 'value' && run.accepts(ran.value, link.plugin)) {
        const passed = last?.ok === true && ran.value === last.result
        return {
          ok: true,
          result: ran.value,
          entries: [entry(passed ? 'passed' : 'returned', ran.value), ...below()],
        }
      }

      // The hook let a rejection from beneath pass: that is not a failure of
      // the hook, and the rejection goes on up.
      if (
        ran.kind === 'throw' &&
        last &&
        !last.ok &&
        (ran.error === last.error || ran.error instanceof NextRejectionPassed)
      ) {
        return { ok: false, error: last.error, entries: [entry('rejected', undefined), ...below()] }
      }

      // Everything else is a FAILED hook.
      const failure: HookFailure =
        ran.kind === 'expired'
          ? {
              kind: 'timeout',
              ...(last && !last.ok ? { message: errorMessage(last.error) } : {}),
              budget: this.catchMs,
            }
          : {
              kind: 'throw',
              message:
                ran.kind === 'throw'
                  ? errorMessage(ran.error)
                  : ran.value === undefined
                    ? 'the hook returned nothing'
                    : 'the hook returned a result this event does not take',
              budget: this.catchMs,
            }
      // Out of budget: whatever the hook started for this dispatch should stop.
      if (ran.kind === 'expired') controller.abort()
      const report = (outcome: TraceOutcome): void => {
        this.options.onHookFailure?.({
          plugin: link.plugin,
          tier: link.tier,
          event: run.event,
          linkId: link.id,
          failure,
          outcome,
        })
      }

      // A `next` still in flight belongs to this link: let it settle before
      // anything is decided ("the handler runs once that call settled").
      if (latest) last = await latest

      if (link.runCatch) {
        const runCatch = link.runCatch.bind(link)
        const hadCalled = called
        // The handler's own signal: the hook's was aborted when its budget
        // ran out, and a `$` call the handler makes on that one would fail
        // at once. This one stops with the dispatch, or with its own grace.
        const catchController = new AbortController()
        const onCatchAbort = (): void => catchController.abort()
        run.signal.addEventListener('abort', onCatchAbort)
        if (run.signal.aborted) catchController.abort()
        let caught: Ran
        try {
          caught = await timed(this.catchMs, true, catchController.signal, call =>
            runCatch({ ...call, error: failure, called: hadCalled }),
          )
        } finally {
          run.signal.removeEventListener('abort', onCatchAbort)
        }
        if (caught.kind === 'expired') catchController.abort()
        if (latest) last = await latest
        if (caught.kind === 'value' && caught.value !== undefined && run.accepts(caught.value, link.plugin)) {
          report('caught')
          return { ok: true, result: caught.value, entries: [entry('caught', caught.value), ...below()] }
        }
        // The handler stood aside, failed or overran its grace: the hook is
        // absent, as if it had no handler.
      }

      const absent: TraceOutcome | undefined =
        failure.kind === 'timeout' ? 'expired' : undefined
      if (called && last) {
        // It failed AFTER `next`: that run's result stands.
        if (!last.ok) {
          report('rejected')
          return { ok: false, error: last.error, entries: [entry('rejected', undefined), ...below()] }
        }
        const outcome = absent ?? 'kept'
        report(outcome)
        return { ok: true, result: last.result, entries: [entry(outcome, last.result), ...below()] }
      }
      // It failed BEFORE `next`: the hooks beneath and core run in its place,
      // on the `e` it was given.
      const outcome = absent ?? 'skipped'
      report(outcome)
      const beneath = await this.runFrom(run, index + 1, e)
      return { ...beneath, entries: [entry(outcome, undefined), ...beneath.entries] }
    } finally {
      run.signal.removeEventListener('abort', onDispatchAbort)
    }
  }
}
