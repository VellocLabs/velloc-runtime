/**
 * Contract: the STREAMING dispatch kind (async-generator hooks), PULL-driven: a
 * reader that stops reading stops the chain, core included. The budget is the hook's
 * own time only. A hook failing mid-stream keeps what it yielded; its `.catch` is
 * asked first, else the rest from beneath goes on (`kept`) or beneath runs in its
 * place (`skipped`). Returning while a stream beneath is open closes it. Closing the
 * outermost stream closes every link and core. A hook failing after closing its own
 * stream rejects the dispatch.
 */

import { PausableDeadline } from '../browser/workerKernel/pausableDeadline'
import { abortError, errorMessage, nextToBypass, type Bypass } from './chainRules'
import { matches } from './eventPattern'
import {
  NextRejectionPassed,
  type ChainLink,
  type HookFailureReport,
  type HookFrame,
} from './ModDispatcher'
import {
  countNextAgain,
  tierIndex,
  type DispatchCallCount,
  type DispatchContext,
  type HookFailure,
  type Origin,
  type StreamBudgetPer,
  type TargetTier,
  type TraceEntry,
  type TraceOutcome,
} from './modTypes'

/**
 * One stream in the chain, pulled one chunk at a time. Its completion value
 * (`done: true`) is the result. `return()` stops reading: whatever produces
 * it is closed — a hook's generator returned, core's work cancelled.
 */
export interface ChainStream {
  next(): Promise<IteratorResult<unknown, unknown>>
  return(): Promise<void>
}

/** What a streaming link is handed for one run of its generator hook. */
export type StreamHookCall = HookFrame & {
  /** Opens a fresh stream of everything beneath (`next(e)`, or `next.to(e,
   *  tier)` with `toTier`). Throws the refusal (no argument, a `next.to` the
   *  tier may not name, a call after the dispatch went on without the hook). */
  readonly next: (e: unknown, toTier?: TargetTier) => ChainStream
  readonly budgetPer: StreamBudgetPer
}

/** What a streaming link's `.catch` handler is handed. */
export type StreamCatchCall = StreamHookCall & {
  readonly error: HookFailure
  readonly called: boolean
}

/**
 * What the engine reads: the stream that leaves the outermost hook — an async
 * generator of the event's chunks returning its result — and `result`, which
 * "settles with what beneath returned once the stream has been read to its
 * end; rejects if the stream is closed before that."
 */
export type DispatchedStream<C, R> = AsyncGenerator<C, R | undefined, undefined> & {
  readonly result: Promise<R>
}

export type StreamDispatchParams<C, R> = {
  event: string
  e: unknown
  core: (e: unknown) => AsyncIterator<C, R>
  context: DispatchContext
  candidates: readonly ChainLink[]
  /** Set: the dispatch is refused before it starts (the nesting cap). */
  refusal?: Error
  accepts: (result: unknown) => boolean
  budgetMs: number
  catchMs: number
  budgetPer: StreamBudgetPer
  signal?: AbortSignal
  scope: unknown
  trace?: (entries: readonly TraceEntry[]) => void
  onHookFailure?: (report: HookFailureReport) => void
  onHookAnswered?: (linkId: string) => void
}

type Run = {
  event: string
  origin: Origin
  depth: number
  calls: DispatchCallCount
  budgetMs: number
  catchMs: number
  budgetPer: StreamBudgetPer
  candidates: readonly ChainLink[]
  core: (e: unknown) => AsyncIterator<unknown, unknown>
  accepts: (result: unknown) => boolean
  signal: AbortSignal
  scope: unknown
  onHookFailure?: (report: HookFailureReport) => void
  onHookAnswered?: (linkId: string) => void
}

type StreamState = 'open' | 'done' | 'failed' | 'closed'

/** A stream of the chain that knows how it ended, for the links above it. */
interface Settling extends ChainStream {
  state(): StreamState
  result(): unknown
  error(): unknown
  /** This link and those beneath it, nearest first; empty while open. */
  entries(): TraceEntry[]
}

const DONE_EMPTY: IteratorResult<unknown, unknown> = Object.freeze({ done: true, value: undefined })

/** Calls of `fn` run one after another, never two at once. */
function serial<T>(fn: () => Promise<T>): () => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return () => {
    const run = tail.then(fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

const EXPIRED = Symbol('expired')

/**
 * A streaming hook's own-time clock. The hook's code runs only between a
 * pull and the `yield` (or return) that answers it, so the clock runs only
 * inside `run`: `stream` keeps one budget across every pull, `pull` gives each
 * pull a fresh one.
 */
class OwnClock {
  private deadline!: PausableDeadline
  private expiry!: Promise<typeof EXPIRED>
  private used = false

  constructor(
    private readonly ms: number,
    private readonly per: StreamBudgetPer,
  ) {
    this.fresh()
  }

  private fresh(): void {
    let fire!: () => void
    this.expiry = new Promise(resolve => {
      fire = () => resolve(EXPIRED)
    })
    this.deadline = new PausableDeadline(() => fire())
    // Held until the first `run`: the hook is not running yet.
    this.deadline.pause()
    this.deadline.start(this.ms)
  }

  async run<T>(work: () => Promise<T>): Promise<T | typeof EXPIRED> {
    if (this.per === 'pull' && this.used) this.fresh()
    this.used = true
    this.deadline.resume()
    try {
      return await Promise.race([work(), this.expiry])
    } finally {
      this.deadline.pause()
    }
  }

  whilePaused<T>(work: () => Promise<T>): Promise<T> {
    return this.deadline.whilePaused(work)
  }

  remainingMs(): number {
    return this.deadline.remainingMs()
  }

  stop(): void {
    this.deadline.stop()
  }
}

/** Raise a streaming event: see `ModDispatcher.dispatchStream`. */
export function runStreamDispatch<C, R>(params: StreamDispatchParams<C, R>): DispatchedStream<C, R> {
  if (params.refusal) return failed<C, R>(params.refusal)
  if (params.candidates.length === 0) {
    // "With no hook on the event, dispatch IS a call of core."
    return dispatched<C, R>(coreStream(params.core as Run['core'], params.e, 0, params.event, []), undefined)
  }
  if (params.signal?.aborted) return failed<C, R>(abortError())
  const controller = new AbortController()
  const run: Run = {
    event: params.event,
    origin: params.context.origin,
    depth: params.context.depth,
    // A nested dispatch (a `$` call's) shares its root's count.
    calls: params.context.calls ?? { made: 0 },
    budgetMs: params.budgetMs,
    catchMs: params.catchMs,
    budgetPer: params.budgetPer,
    candidates: params.candidates,
    core: params.core as Run['core'],
    accepts: params.accepts,
    signal: controller.signal,
    scope: params.scope,
    ...(params.onHookFailure ? { onHookFailure: params.onHookFailure } : {}),
    ...(params.onHookAnswered ? { onHookAnswered: params.onHookAnswered } : {}),
  }
  return dispatched<C, R>(runFrom(run, 0, params.e), {
    controller,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.trace ? { trace: params.trace } : {}),
  })
}

/** A stream refused before it opens: its first pull rejects with `error`. */
export function refusedStream<C, R>(error: unknown): DispatchedStream<C, R> {
  return failed<C, R>(error)
}

/** A stream that rejects its first pull with `error`. */
function failed<C, R>(error: unknown): DispatchedStream<C, R> {
  let thrown = false
  const stream: Settling = {
    next: async () => {
      if (thrown) return DONE_EMPTY
      thrown = true
      throw error
    },
    return: async () => {
      thrown = true
    },
    state: () => 'failed',
    result: () => undefined,
    error: () => error,
    entries: () => [],
  }
  return dispatched<C, R>(stream, undefined)
}

/** The engine's face of the outermost stream. */
function dispatched<C, R>(
  top: Settling,
  owned: { controller: AbortController; signal?: AbortSignal; trace?: (entries: readonly TraceEntry[]) => void } | undefined,
): DispatchedStream<C, R> {
  let settle!: { resolve: (value: R) => void; reject: (error: unknown) => void }
  const result = new Promise<R>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // Read by whoever wants it; never an unhandled rejection by itself.
  result.catch(() => undefined)
  let finished = false
  let onAbort: (() => void) | undefined
  const abandoned = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError())
    owned?.signal?.addEventListener('abort', onAbort, { once: true })
  })
  abandoned.catch(() => undefined)
  const end = (): void => {
    finished = true
    if (onAbort) owned?.signal?.removeEventListener('abort', onAbort)
    // Whatever is still running for this dispatch (a hook that lingers past
    // its budget, a stream nobody reads any more) should stop.
    owned?.controller.abort()
  }
  const pull = serial(async (): Promise<IteratorResult<C, R | undefined>> => {
    if (finished) return DONE_EMPTY as IteratorResult<C, undefined>
    try {
      const step = await (owned?.signal ? Promise.race([top.next(), abandoned]) : top.next())
      if (step.done) {
        owned?.trace?.(top.entries())
        settle.resolve(step.value as R)
        end()
      }
      return step as IteratorResult<C, R>
    } catch (error) {
      owned?.trace?.(top.entries())
      settle.reject(error)
      end()
      void top.return().catch(() => undefined)
      throw error
    }
  })
  const close = async (): Promise<void> => {
    if (finished) return
    settle.reject(new Error('the stream was closed before its end'))
    end()
    await top.return().catch(() => undefined)
  }
  const stream = {
    next: () => pull(),
    return: async (value?: R | undefined): Promise<IteratorResult<C, R | undefined>> => {
      await close()
      return { done: true, value }
    },
    throw: async (error?: unknown): Promise<IteratorResult<C, R | undefined>> => {
      await close()
      throw error
    },
    [Symbol.asyncIterator]() {
      return stream
    },
    result,
  }
  return stream as unknown as DispatchedStream<C, R>
}

/** The chain from candidate `index` down: the first link there that takes
 *  this `e`, or core. */
function runFrom(run: Run, index: number, e: unknown, bypass?: Bypass): Settling {
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
    // rewritten it.
    if (link.matcher !== undefined && !matches(link.matcher, e)) continue
    return prefixed(linkStream(run, i, link, e), bypassed)
  }
  return coreStream(run.core, e, run.candidates.length, run.event, bypassed)
}

function prefixed(stream: Settling, before: readonly TraceEntry[]): Settling {
  if (before.length === 0) return stream
  return { ...stream, entries: () => (stream.state() === 'open' ? [] : [...before, ...stream.entries()]) }
}

/** The engine's own innermost link: `core(e)`, started at the first pull. */
function coreStream(
  core: Run['core'],
  e: unknown,
  index: number,
  event: string,
  bypassed: readonly TraceEntry[],
): Settling {
  let iterator: AsyncIterator<unknown, unknown> | undefined
  let state: StreamState = 'open'
  let result: unknown
  let error: unknown
  let chunks = 0
  let entry: TraceEntry | undefined
  const started = Date.now()
  const finish = (outcome: TraceOutcome, returned: unknown): void => {
    entry = {
      index,
      plugin: 'engine',
      tier: 'core',
      event,
      outcome,
      ms: Date.now() - started,
      received: e,
      returned,
      chunks,
    }
  }
  return {
    next: serial(async () => {
      if (state === 'done') return { done: true, value: result }
      if (state === 'failed') throw error
      if (state === 'closed') return DONE_EMPTY
      try {
        iterator ??= core(e)
        const step = await iterator.next()
        if ((state as StreamState) === 'closed') return DONE_EMPTY
        if (step.done) {
          state = 'done'
          result = step.value
          finish('returned', step.value)
          return { done: true, value: step.value }
        }
        chunks += 1
        return { done: false, value: step.value }
      } catch (caught) {
        if ((state as StreamState) === 'closed') return DONE_EMPTY
        state = 'failed'
        error = caught
        finish('rejected', undefined)
        throw caught
      }
    }),
    return: async () => {
      if (state !== 'open') return
      state = 'closed'
      finish('returned', undefined)
      await iterator?.return?.()?.catch?.(() => undefined)
    },
    state: () => state,
    result: () => result,
    error: () => error,
    entries: () => (entry ? [...bypassed, entry] : []),
  }
}

type Active = {
  iter: ChainStream
  clock: OwnClock
  /** The `.catch` handler's run, not the hook's. */
  catching: boolean
}

/** One generator hook, placed in the chain. */
function linkStream(run: Run, index: number, link: ChainLink, e: unknown): Settling {
  const started = Date.now()
  /** Time spent reading beneath, out of the trace entry's `ms`. */
  let beneathMs = 0
  let chunks = 0
  let state: StreamState = 'open'
  let result: unknown
  let error: unknown
  let outcome: TraceOutcome | undefined
  let returned: unknown
  /** The hook's generator, then its `.catch` handler's. */
  let active: Active | undefined
  /** Forwarded once the hook is out of the picture: the rest of the stream
   *  it had open, or beneath run in its place. */
  let fallback: Settling | undefined
  /** The hook called `next` / `next.to` at least once. */
  let called = false
  /** The latest stream the hook opened beneath, and every one it opened. */
  let latest: Settling | undefined
  const opened: Settling[] = []
  /** The hook's own run is over: a `next` it calls from now on reaches
   *  nothing. Its `.catch` handler's `next` is a different function. */
  let hookOver = false
  let catchTried = false
  let failure: HookFailure | undefined

  const controller = new AbortController()
  /** The `.catch` handler's own signal: the hook's is aborted by then, and a
   *  `$` call on it would fail at once. Stops with the dispatch, or when the
   *  handler overruns its grace. */
  let catchController: AbortController | undefined
  const onRunAbort = (): void => {
    controller.abort()
    catchController?.abort()
  }
  run.signal.addEventListener('abort', onRunAbort)

  const context: DispatchContext = {
    origin: { plugin: link.plugin, tier: link.tier },
    skipLinkId: link.id,
    depth: run.depth + 1,
    calls: run.calls,
  }

  const below = (): TraceEntry[] => (fallback ?? latest)?.entries() ?? []

  const report = (what: TraceOutcome): void => {
    if (!failure) return
    run.onHookFailure?.({
      plugin: link.plugin,
      tier: link.tier,
      event: run.event,
      linkId: link.id,
      failure,
      outcome: what,
    })
  }

  /** A stream the hook reads beneath: the clock stops while it waits. */
  const view = (stream: Settling, clock: OwnClock): ChainStream => ({
    next: async () => {
      const began = Date.now()
      try {
        return await clock.whilePaused(() => stream.next())
      } finally {
        beneathMs += Date.now() - began
      }
    },
    return: () => stream.return(),
  })

  const openBeneath = (clock: OwnClock, replay: boolean) => (e2: unknown, toTier?: TargetTier): ChainStream => {
    if (e2 === undefined) {
      throw new Error(`next() was called with no argument by ${link.plugin}'s hook on ${run.event}`)
    }
    const bypass = nextToBypass(link, toTier)
    if (!replay && hookOver) {
      throw new Error(
        `next() was called by ${link.plugin}'s hook on ${run.event} after the dispatch had gone on without it`,
      )
    }
    // Replay-safe: the stream the hook had open, from where it stood; the
    // argument unread.
    if (replay && latest) return view(latest, clock)
    if (called) countNextAgain(run.calls, link.plugin, run.event)
    called = true
    const stream = runFrom(run, index + 1, e2, bypass)
    latest = stream
    opened.push(stream)
    return view(stream, clock)
  }

  const callFor = (
    clock: OwnClock,
    budgetMs: number,
    replay: boolean,
    signal: AbortSignal = controller.signal,
  ): StreamHookCall => ({
    event: run.event,
    e,
    origin: run.origin,
    context,
    next: openBeneath(clock, replay),
    trace: below,
    whileWaiting: work => clock.whilePaused(work),
    budget: () => ({ ms: budgetMs, remainingMs: clock.remainingMs() }),
    signal,
    scope: run.scope,
    budgetPer: run.budgetPer,
  })

  const cleanup = (): void => {
    run.signal.removeEventListener('abort', onRunAbort)
    active?.clock.stop()
    // A stream the hook opened and left open has nobody to read it.
    for (const stream of opened) {
      if (stream !== fallback && stream.state() === 'open') void stream.return().catch(() => undefined)
    }
  }

  const settleOk = (how: TraceOutcome, value: unknown): IteratorResult<unknown, unknown> => {
    state = 'done'
    outcome = how
    result = value
    returned = value
    cleanup()
    return { done: true, value }
  }

  const settleRejected = (reason: unknown): never => {
    state = 'failed'
    outcome = 'rejected'
    error = reason
    cleanup()
    throw reason
  }

  const forward = async (): Promise<IteratorResult<unknown, unknown>> => {
    const source = fallback!
    let step: IteratorResult<unknown, unknown>
    try {
      step = await source.next()
    } catch (caught) {
      if ((state as StreamState) === 'closed') return DONE_EMPTY
      // What was forwarded rejected: the rejection goes on up, as from
      // beneath. The outcome the hook earned stands in the trace.
      state = 'failed'
      error = caught
      cleanup()
      throw caught
    }
    if ((state as StreamState) === 'closed') return DONE_EMPTY
    if (!step.done) return step
    state = 'done'
    result = step.value
    if (outcome !== 'skipped' && outcome !== 'expired') returned = step.value
    cleanup()
    return step
  }

  /** Forward `stream`'s rest under `how`, the hook's failure reported so. */
  const leave = (stream: Settling, how: TraceOutcome): Promise<IteratorResult<unknown, unknown>> => {
    report(how)
    outcome = how
    fallback = stream
    return forward()
  }

  /** The hook is absent (failed, its handler stood aside or failed too). */
  const absent = (): Promise<IteratorResult<unknown, unknown>> => {
    const expired: TraceOutcome | undefined = failure?.kind === 'timeout' ? 'expired' : undefined
    if (called && latest) {
      switch (latest.state()) {
        case 'done':
          report(expired ?? 'kept')
          return Promise.resolve(settleOk(expired ?? 'kept', latest.result()))
        case 'open':
          // "A chunk yielded stays … the rest from beneath it."
          return leave(latest, expired ?? 'kept')
        case 'failed':
          report('rejected')
          return Promise.resolve().then(() => settleRejected(latest!.error()))
        case 'closed':
          report('rejected')
          return Promise.resolve().then(() =>
            settleRejected(
              new Error(
                `${link.plugin}'s hook on ${run.event} failed after it closed the stream beneath: ` +
                  'nothing is left to stand',
              ),
            ),
          )
      }
    }
    // It failed BEFORE `next`: beneath runs in its place, on the `e` it was
    // given, after whatever it yielded.
    return leave(runFrom(run, index + 1, e), expired ?? 'skipped')
  }

  const fail = (what: HookFailure): Promise<IteratorResult<unknown, unknown>> => {
    failure = what
    // Whatever the hook started for this dispatch should stop.
    controller.abort()
    if (link.runCatchStream && !catchTried) {
      catchTried = true
      const clock = new OwnClock(run.catchMs, 'stream')
      catchController = new AbortController()
      if (run.signal.aborted) catchController.abort()
      try {
        active = {
          iter: link.runCatchStream({
            ...callFor(clock, run.catchMs, true, catchController.signal),
            error: what,
            called,
          }),
          clock,
          catching: true,
        }
      } catch {
        return absent()
      }
      return pullActive()
    }
    return absent()
  }

  const pullActive = async (): Promise<IteratorResult<unknown, unknown>> => {
    const run_ = active!
    type Ran =
      | { kind: 'chunk'; value: unknown }
      | { kind: 'done'; value: unknown }
      | { kind: 'throw'; error: unknown }
      | { kind: 'expired' }
    let ran: Ran
    try {
      const step = await run_.clock.run(() => run_.iter.next())
      ran = step === EXPIRED ? { kind: 'expired' } : step.done ? { kind: 'done', value: step.value } : { kind: 'chunk', value: step.value }
    } catch (caught) {
      ran = { kind: 'throw', error: caught }
    }
    if ((state as StreamState) === 'closed') return DONE_EMPTY
    if (ran.kind === 'chunk') {
      chunks += 1
      return { done: false, value: ran.value }
    }

    // This run is over.
    run_.clock.stop()
    if (!run_.catching) {
      hookOver = true
      if (ran.kind !== 'expired') run.onHookAnswered?.(link.id)
    }
    if (ran.kind === 'expired') {
      if (run_.catching) catchController?.abort()
      void run_.iter.return().catch(() => undefined)
    }

    if (ran.kind === 'done') {
      if (ran.value !== undefined) {
        if (run.accepts(ran.value)) {
          if (run_.catching) report('caught')
          return settleOk(run_.catching ? 'caught' : 'returned', ran.value)
        }
        if (run_.catching) return absent()
        return fail({ kind: 'throw', message: 'the hook returned a result this event does not take', budget: run.catchMs })
      }
      // Returning nothing lets its last `next(e)`'s result stand.
      if (latest?.state() === 'done') {
        if (run_.catching) report('caught')
        return settleOk(run_.catching ? 'caught' : 'passed', latest.result())
      }
      if (latest?.state() === 'open') {
        if (run_.catching) return leave(latest, 'caught')
        outcome = 'passed'
        fallback = latest
        return forward()
      }
      if (run_.catching) return absent()
      return fail({ kind: 'throw', message: 'the hook returned nothing', budget: run.catchMs })
    }

    if (ran.kind === 'throw') {
      // The hook let a rejection from beneath pass: not a failure of the
      // hook, and the rejection goes on up.
      if (
        !run_.catching &&
        latest?.state() === 'failed' &&
        (ran.error === latest.error() || ran.error instanceof NextRejectionPassed)
      ) {
        return settleRejected(latest.error())
      }
      if (run_.catching) return absent()
      return fail({ kind: 'throw', message: errorMessage(ran.error), budget: run.catchMs })
    }

    if (run_.catching) return absent()
    return fail({
      kind: 'timeout',
      ...(latest?.state() === 'failed' ? { message: errorMessage(latest.error()) } : {}),
      budget: run.catchMs,
    })
  }

  return {
    next: serial(async () => {
      if (state === 'done') return { done: true, value: result }
      if (state === 'failed') throw error
      if (state === 'closed') return DONE_EMPTY
      if (fallback) return forward()
      if (!active) {
        const clock = new OwnClock(run.budgetMs, run.budgetPer)
        try {
          if (!link.runStream) throw new Error(`${link.plugin}'s hook on ${run.event} is not a generator`)
          active = { iter: link.runStream(callFor(clock, run.budgetMs, false)), clock, catching: false }
        } catch (caught) {
          hookOver = true
          active = { iter: { next: async () => DONE_EMPTY, return: async () => undefined }, clock, catching: false }
          return fail({ kind: 'throw', message: errorMessage(caught), budget: run.catchMs })
        }
      }
      return pullActive()
    }),
    return: async () => {
      if (state !== 'open') return
      state = 'closed'
      outcome ??= 'returned'
      controller.abort()
      const closing = [active?.iter.return(), fallback?.return(), ...opened.map(stream => stream.return())]
      cleanup()
      await Promise.all(closing.map(done => done?.catch(() => undefined)))
    },
    state: () => state,
    result: () => result,
    error: () => error,
    entries: () =>
      state === 'open'
        ? []
        : [
            {
              index,
              plugin: link.plugin,
              tier: link.tier,
              event: run.event,
              outcome: outcome ?? 'returned',
              ms: Math.max(0, Date.now() - started - beneathMs),
              received: e,
              returned,
              chunks,
            },
            ...below(),
          ],
  }
}
