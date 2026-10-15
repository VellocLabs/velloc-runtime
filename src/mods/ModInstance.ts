/**
 * The runtime side of one loaded mod: its port and its hooks' links, adapting the
 * chain to the worker messages. `serveCall` implements `$` with the CONTEXT of the
 * calling hook frame (origin plugin, recursion skip, depth). `$` calls do not count
 * against the hook's budget, except a `$.clock` wait.
 */

import {
  NextRejectionPassed,
  type CatchCall,
  type ChainLink,
  type HookCall,
  type HookFrame,
  type ModDispatcher,
} from './ModDispatcher'
import { refusedStream as refusedCallStream, type ChainStream, type DispatchedStream, type StreamCatchCall, type StreamHookCall } from './streamChain'
import {
  HOOK_BUDGET,
  callRateRefusal,
  type DispatchContext,
  type HookRegistration,
  type PluginTier,
} from './modTypes'
import type { ModPeer, ModToRuntime, WireError } from './modWire'
import { PausableDeadline } from '../browser/workerKernel/pausableDeadline'

/** One `$.<noun>.<method>(...args)` as the runtime serves it. */
export type ModCall = {
  readonly plugin: string
  /** The calling module's seat (a plugin's modules share its name); what it
   *  registers belongs to this seat. */
  readonly seat?: string
  readonly noun: string
  readonly method: string
  readonly args: readonly unknown[]
  /** Who made it and what to skip — pass it to `dispatch` when the noun raises
   *  an event. */
  readonly context: DispatchContext
  /** The scope of the dispatch the calling hook was run for; `undefined` for a
   *  call made outside any hook. */
  readonly scope: unknown
  /** Aborts when the calling hook's dispatch is abandoned. */
  readonly signal?: AbortSignal
}

export type ModCallServer = (call: ModCall) => Promise<unknown>

/** Serves a `$` call whose event streams (`$.process.spawn`): the stream
 *  that leaves the outermost hook, nothing run before its first pull. */
export type ModStreamCallServer = (call: ModCall) => DispatchedStream<unknown, unknown>

export type ModInstanceOptions = {
  /** `load` resolves with the hooks but does NOT seat them: `join()` does,
   *  once the runtime has admitted the module (`plugin.register`). */
  deferJoin?: boolean
  /** The group key in the chain: stable across reloads of the same mod, so a
   *  reload keeps its seat. */
  key: string
  plugin: string
  /** The plugin's directory, absolute — `$.plugin.root` in the worker.
   *  Optional for the bare fakes of unit tests; the product always has one. */
  root?: string
  /** The window's language tag — `$.plugin.locale` in the worker. */
  locale?: string
  tier: PluginTier
  generation: number
  peer: ModPeer
  dispatcher: ModDispatcher
  serveCall: ModCallServer
  /** `$` calls that stream. Absent: such a call's first read is refused. */
  serveStream?: ModStreamCallServer
  /** A line the worker wants said outside any hook (a timer callback that
   *  threw), already prefixed with the plugin's name. */
  report?: (line: string) => void
  /** How long `register` may take. */
  loadTimeoutMs?: number
  /** How long a `serve` or `runHandle` run may take, wall clock. */
  serveTimeoutMs?: number
  /** A `serve` or `runHandle` run settled; `timedOut` when its bound expired. */
  onRunSettled?: (timedOut: boolean) => void
  /** How long an abandoned hook may run on before it is dropped as lingering.
   *  Default `HOOK_BUDGET.lingerMs`. */
  lingerMs?: number
}

/** One signal that aborts when any of `signals` does. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

export const MOD_LOAD_TIMEOUT_MS = 30_000
/** The bound on a plugin-noun method or a press handler run in the worker. */
export const MOD_SERVE_TIMEOUT_MS = 60_000

const SETTLED_FRAMES_KEPT = 256

type Settle = { resolve: (value: unknown) => void; reject: (error: unknown) => void }
type LiveInvocation = Settle & {
  call: HookFrame
  /** A plain hook's `next`; absent on a streaming one. */
  next?: HookCall['next']
  /** A streaming hook's run: the streams it opened, and its pending pull. */
  stream?: StreamRun
  /** What this run's latest `next` was rejected with — the ORIGINAL object.
   *  The worker only gets its name and message; when the hook rethrows it,
   *  the worker says so and the chain is handed this one back, so it can tell
   *  "let a rejection pass" from "failed" by identity, and a refusal raised
   *  by the chain itself (`next.to` from a user mod) keeps its message. */
  lastNextError?: unknown
}

/** What a streaming invocation keeps between frames. */
type StreamRun = {
  /** The streams the hook opened beneath, by the `nextId` that opened them. */
  readonly opened: Map<string, ChainStream>
  /** The hook yielded: the pending pull resolves with it. */
  chunk(value: unknown): void
}

/** A stream that rejects its first read with `error` — `next(e)` refused. */
function refusedStream(error: unknown): ChainStream {
  let thrown = false
  return {
    next: async () => {
      if (thrown) return { done: true, value: undefined }
      thrown = true
      throw error
    },
    return: async () => {
      thrown = true
    },
  }
}

function wireError(error: unknown): WireError {
  return {
    name: error instanceof Error && error.name ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  }
}

function fromWire(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export class ModInstance {
  /** Frames dropped because they carried another generation. */
  staleFrames = 0
  private readonly live = new Map<string, LiveInvocation>()
  /** The frames of recently settled invocations, for `$` calls made past
   *  their hook (detached work): oldest first, at most `SETTLED_FRAMES_KEPT`. */
  private readonly settled = new Map<string, DispatchContext>()
  /** The `$` calls being served, by call id: what `mod.cancelCall` aborts. */
  private readonly serving = new Map<string, AbortController>()
  /** The `$` calls that stream (`mod.callStream`), open until read to their
   *  end, closed by the worker (`mod.cancelCall`) or by this instance going
   *  away — never by the calling hook's return: "the loop is the child's
   *  life". */
  private readonly callStreams = new Map<string, { stream: DispatchedStream<unknown, unknown>; invocationId?: string }>()
  /** The handler runs in flight (`mod.runHandle`), by run id. */
  private readonly handleRuns = new Map<string, Settle & { unlisten: () => void }>()
  private seq = 0
  private disposed = false
  private loading: {
    resolve: (hooks: HookRegistration[]) => void
    reject: (error: Error) => void
  } | null = null
  /** The links `mod.loaded` brought, waiting for `join()` (`deferJoin`). */
  private pendingLinks: ChainLink[] | null = null
  /** The `mod.serve` calls in flight, by serve id. */
  private readonly serves = new Map<string, Settle & { unlisten: () => void }>()
  /** The serve bounds of the methods and handlers running now. */
  private readonly runClocks = new Set<PausableDeadline>()

  constructor(private readonly options: ModInstanceOptions) {
    options.peer.onmessage = (event: MessageEvent) => this.onMessage(event.data)
    options.peer.start?.()
  }

  /**
   * Load the module and seat its hooks. Resolves to the registrations once
   * they are in the chain; rejects when the module does not load — it then
   * has no hooks, no seat, nothing.
   */
  load(source: string, moduleOptions: unknown): Promise<HookRegistration[]> {
    if (this.disposed) return Promise.reject(new Error('the mod instance was disposed'))
    if (this.loading) return Promise.reject(new Error('the mod instance is already loading'))
    const { plugin, root, locale, tier } = this.options
    return new Promise<HookRegistration[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loading = null
        reject(
          new Error(
            `${plugin}: register() did not return within ${this.options.loadTimeoutMs ?? MOD_LOAD_TIMEOUT_MS}ms`,
          ),
        )
      }, this.options.loadTimeoutMs ?? MOD_LOAD_TIMEOUT_MS)
      this.loading = {
        resolve: hooks => {
          clearTimeout(timer)
          resolve(hooks)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      }
      try {
        this.post({ type: 'mod.load', plugin, root: root ?? '', ...(locale !== undefined ? { locale } : {}), tier, source, options: moduleOptions })
      } catch (error) {
        const pending = this.loading
        this.loading = null
        pending?.reject(
          new Error(`${plugin}: could not send the module to its worker (${wireError(error).message})`),
        )
      }
    })
  }

  /** Seat the hooks `load` brought (`deferJoin`): they join the chain now.
   *  A no-op when they joined at load. */
  join(): void {
    if (this.disposed || !this.pendingLinks) return
    const links = this.pendingLinks
    this.pendingLinks = null
    this.options.dispatcher.register(this.options.key, links)
  }

  /**
   * Run a method of a noun this module's `engine.create` step added to `$`,
   * in the plugin's own environment, with `args` as the chain left
   * them. Resolves to what it returned; rejects when it threw, is not
   * provided, or `signal` aborted the wait.
   */
  serve(noun: string, method: string, args: unknown[], caller: string, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error(`${this.options.plugin}: the mod was unloaded`))
    const serveId = `s${++this.seq}`
    return this.runInWorker(this.serves, serveId, `$.${noun}.${method}`, signal, () =>
      this.post({ type: 'mod.serve', serveId, noun, method, args, caller }),
    )
  }

  /** Leave the chain and fail whatever is still running. Idempotent.
   *  `keepSeat`: the module is coming back at the next generation, and must
   *  come back where it sat among its tier's plugins. */
  dispose(options: { keepSeat?: boolean } = {}): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingLinks = null
    for (const run of this.serves.values()) {
      run.unlisten()
      run.reject(new Error(`${this.options.plugin}: the mod was unloaded`))
    }
    this.serves.clear()
    if (options.keepSeat) this.options.dispatcher.vacate(this.options.key)
    else this.options.dispatcher.unregister(this.options.key)
    const gone = new Error(`${this.options.plugin}: the mod was unloaded`)
    for (const invocation of this.live.values()) invocation.reject(gone)
    this.live.clear()
    for (const run of this.handleRuns.values()) {
      run.unlisten()
      run.reject(gone)
    }
    this.handleRuns.clear()
    // A wait being served for a timer or a kept `$` has nobody to answer to.
    for (const controller of this.serving.values()) controller.abort()
    this.serving.clear()
    // "… or the module unloading kills the child."
    for (const open of this.callStreams.values()) void open.stream.return(undefined).catch(() => undefined)
    this.callStreams.clear()
    this.loading?.reject(gone)
    this.loading = null
    this.options.peer.onmessage = null
    this.options.peer.close?.()
  }

  /**
   * Run one of the closures a render hook of this module left behind a
   * `press.handle`: the worker runs it in the plugin's environment
   * with `args`. Resolves once it returned; rejects when it threw, is not
   * there (the drawing is gone), or `signal` aborted the wait.
   */
  runHandle(handle: number, which: string | undefined, args: unknown[], signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(`${this.options.plugin}: the mod was unloaded`))
    const runId = `r${++this.seq}`
    return this.runInWorker(this.handleRuns, runId, 'the handler', signal, () =>
      this.post({ type: 'mod.runHandle', runId, handle, ...(which !== undefined ? { which } : {}), args }),
    ).then(() => undefined)
  }

  /**
   * One run in the worker, answered under `id` in `runs`: rejects when
   * `signal` aborts, when it outlasts the serve bound (reported through
   * `onRunSettled`, as a hook out of time is), or when `post` throws.
   */
  private runInWorker(
    runs: Map<string, Settle & { unlisten: () => void }>,
    id: string,
    what: string,
    signal: AbortSignal | undefined,
    post: () => void,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const fail = (name: string, message: string): void => {
        if (!runs.delete(id)) return
        unlisten()
        const error = new Error(message)
        error.name = name
        reject(error)
      }
      const onAbort = (): void => fail('AbortError', `${what}: the wait was abandoned`)
      const boundMs = this.options.serveTimeoutMs ?? MOD_SERVE_TIMEOUT_MS
      const clock = new PausableDeadline(() => {
        if (!runs.has(id)) return
        fail('TimeoutError', `${what}: no answer within ${boundMs}ms of its own time`)
        this.options.onRunSettled?.(true)
      })
      this.runClocks.add(clock)
      clock.start(boundMs)
      const unlisten = (): void => {
        clock.stop()
        this.runClocks.delete(clock)
        signal?.removeEventListener('abort', onAbort)
      }
      runs.set(id, {
        resolve: value => {
          unlisten()
          this.options.onRunSettled?.(false)
          resolve(value)
        },
        reject: error => {
          unlisten()
          reject(error)
        },
        unlisten,
      })
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        post()
      } catch (error) {
        runs.delete(id)
        unlisten()
        reject(new TypeError(`${what}: an argument is not plain data (${wireError(error).message})`))
      }
    })
  }

  /**
   * A `$` wait made outside a live hook — a method's or a handler's, which
   * the worker cannot tag with its run — stops the bound of every run already
   * in flight when it began (one begun later cannot have made it). Each such
   * wait is bounded where it is served. (F-25)
   */
  private whileRunsWait<T>(work: () => Promise<T>): Promise<T> {
    const paused = [...this.runClocks]
    for (const clock of paused) clock.pause()
    const resume = (): void => {
      for (const clock of paused) clock.resume()
    }
    const waited = Promise.resolve().then(work)
    waited.then(resume, resume)
    return waited
  }

  /** The drawing those handles belonged to is gone: the worker forgets the
   *  closures. */
  dropHandles(handles: readonly number[]): void {
    if (this.disposed || handles.length === 0) return
    try {
      this.post({ type: 'mod.dropHandles', handles: [...handles] })
    } catch {
      /* port gone */
    }
  }

  private post(message: Record<string, unknown>): void {
    this.options.peer.postMessage({ ...message, generation: this.options.generation })
  }

  private link(registration: HookRegistration): ChainLink {
    const { key, plugin, tier } = this.options
    return {
      id: `${key}#${this.options.generation}/${registration.hookId}`,
      plugin,
      tier,
      pattern: registration.pattern,
      ...(registration.matcher !== undefined ? { matcher: registration.matcher } : {}),
      ...(registration.streams
        ? {
            streams: true,
            runStream: (call: StreamHookCall) => this.invokeStream(registration.hookId, call, undefined),
            ...(registration.hasCatch
              ? {
                  runCatchStream: (call: StreamCatchCall) =>
                    this.invokeStream(registration.hookId, call, { error: call.error, called: call.called }),
                }
              : {}),
          }
        : {}),
      run: call => this.invoke(registration.hookId, call, undefined),
      ...(!registration.streams && registration.hasCatch
        ? {
            runCatch: (call: CatchCall) =>
              this.invoke(registration.hookId, call, { error: call.error, called: call.called }),
          }
        : {}),
    }
  }

  /** A `$` call made past its hook keeps the hook's depth and recursion
   *  skip, so detached work feeding itself still meets `MAX_DISPATCH_DEPTH`.
   *  Not the dispatch's call count: a timer may outlive it by any number of
   *  calls. */
  private keepSettledFrame(invocationId: string, context: DispatchContext): void {
    const { calls: _calls, ...frame } = context
    this.settled.set(invocationId, frame)
    if (this.settled.size > SETTLED_FRAMES_KEPT) this.settled.delete(this.settled.keys().next().value!)
  }

  /** The context a `$` call runs under: its live hook's, else that hook's
   *  settled frame, else the plugin's own at depth 1. */
  private contextOf(invocationId: string | undefined, invocation: LiveInvocation | undefined): DispatchContext {
    if (invocation) return invocation.call.context
    const kept = invocationId ? this.settled.get(invocationId) : undefined
    return kept ?? { origin: { plugin: this.options.plugin, tier: this.options.tier }, depth: 1 }
  }

  /** After `mod.abort`: a run that has not settled within the linger bound
   *  is reported and dropped, so it pins nothing of its dispatch. */
  private dropIfLingering(invocationId: string, event: string): ReturnType<typeof setTimeout> {
    const lingerMs = this.options.lingerMs ?? HOOK_BUDGET.lingerMs
    return setTimeout(() => {
      const live = this.live.get(invocationId)
      if (!live) return
      this.options.report?.(
        `its hook on ${event} was still running ${lingerMs}ms after the dispatch went on without it; it is dropped`,
      )
      const error = new Error(`${this.options.plugin}: its hook on ${event} lingered`)
      error.name = 'AbortError'
      live.reject(error)
    }, lingerMs)
  }

  private invoke(
    hookId: string,
    call: HookCall,
    caught: { error: CatchCall['error']; called: boolean } | undefined,
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error(`${this.options.plugin}: the mod was unloaded`))
    }
    const invocationId = `i${++this.seq}`
    return new Promise<unknown>((resolve, reject) => {
      let lingering: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        // The chain has gone on without this run; tell the hook to stop.
        try {
          this.post({ type: 'mod.abort', invocationId })
        } catch {
          /* port gone */
        }
        lingering = this.dropIfLingering(invocationId, call.event)
      }
      const done = (): void => {
        clearTimeout(lingering)
        this.live.delete(invocationId)
        this.keepSettledFrame(invocationId, call.context)
        call.signal.removeEventListener('abort', onAbort)
      }
      this.live.set(invocationId, {
        call,
        next: call.next,
        resolve: value => {
          done()
          resolve(value)
        },
        reject: error => {
          done()
          reject(error)
        },
      })
      call.signal.addEventListener('abort', onAbort)
      try {
        this.post({
          type: 'mod.invoke',
          invocationId,
          hookId,
          event: call.event,
          e: call.e,
          origin: call.origin,
          budgetMs: call.budget().ms,
          ...(caught ? { catch: caught } : {}),
        })
      } catch (error) {
        // `e` could not cross the port. The hook cannot run on it; the chain
        // treats that as the hook failing and goes on.
        this.live.get(invocationId)?.reject(
          new TypeError(
            `${call.event}: the event's argument is not plain data (${wireError(error).message})`,
          ),
        )
      }
    })
  }

  /**
   * Start one run of a streaming hook: the worker creates its generator and
   * runs none of it. Each `next()` of the stream returned resumes it to its
   * next `yield` (a chunk) or its end (its result; a rejection when it
   * threw); `return()` closes it, and every stream it had open beneath.
   * Throws when `e` cannot cross the port — the chain counts that as the hook
   * failing.
   */
  private invokeStream(
    hookId: string,
    call: StreamHookCall,
    caught: { error: StreamCatchCall['error']; called: boolean } | undefined,
  ): ChainStream {
    if (this.disposed) throw new Error(`${this.options.plugin}: the mod was unloaded`)
    const invocationId = `i${++this.seq}`
    type Step = IteratorResult<unknown, unknown>
    type Ended = { ok: true; value: unknown } | { ok: false; error: unknown }
    let pending: { resolve: (step: Step) => void; reject: (error: unknown) => void } | null = null
    /** How the run ended, for a pull that comes after. */
    let ended: Ended | null = null
    const opened = new Map<string, ChainStream>()
    let lingering: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      try {
        this.post({ type: 'mod.abort', invocationId })
      } catch {
        /* port gone */
      }
      lingering = this.dropIfLingering(invocationId, call.event)
    }
    const finish = (how: Ended): void => {
      if (ended) return
      ended = how
      clearTimeout(lingering)
      this.live.delete(invocationId)
      this.keepSettledFrame(invocationId, call.context)
      call.signal.removeEventListener('abort', onAbort)
      // The chain closes the streams the hook left open (it knows which one
      // stands); these handles to them are simply dropped.
      opened.clear()
      const waiting = pending
      pending = null
      if (!waiting) return
      if (how.ok) waiting.resolve({ done: true, value: how.value })
      else waiting.reject(how.error)
    }
    this.live.set(invocationId, {
      call,
      stream: {
        opened,
        chunk: value => {
          const waiting = pending
          pending = null
          waiting?.resolve({ done: false, value })
        },
      },
      resolve: value => finish({ ok: true, value }),
      reject: error => finish({ ok: false, error }),
    })
    call.signal.addEventListener('abort', onAbort)
    try {
      this.post({
        type: 'mod.invoke',
        invocationId,
        hookId,
        event: call.event,
        e: call.e,
        origin: call.origin,
        budgetMs: call.budget().ms,
        stream: { budgetPer: call.budgetPer },
        ...(caught ? { catch: caught } : {}),
      })
    } catch (error) {
      finish({ ok: true, value: undefined })
      throw new TypeError(`${call.event}: the event's argument is not plain data (${wireError(error).message})`)
    }
    return {
      next: () => {
        const end = ended as Ended | null
        if (end) {
          return end.ok ? Promise.resolve<Step>({ done: true, value: undefined }) : Promise.reject(end.error)
        }
        if (pending) return Promise.reject(new Error('a streaming hook was pulled twice at once'))
        return new Promise<Step>((resolve, reject) => {
          pending = { resolve, reject }
          try {
            this.post({ type: 'mod.pull', invocationId })
          } catch (error) {
            finish({ ok: false, error })
          }
        })
      },
      return: async () => {
        if (ended) return
        // The worker returns the generator (its `finally` runs) and aborts
        // `next.signal`; nothing it sends after is read.
        onAbort()
        finish({ ok: true, value: undefined })
      },
    }
  }

  private onMessage(data: unknown): void {
    const msg = data as ModToRuntime | null
    if (!msg || this.disposed) return
    if (msg.generation !== this.options.generation) {
      this.staleFrames += 1
      return
    }
    switch (msg.type) {
      case 'mod.loaded': {
        const pending = this.loading
        this.loading = null
        if (!pending) return
        const links = msg.hooks.map(registration => this.link(registration))
        if (this.options.deferJoin) this.pendingLinks = links
        else this.options.dispatcher.register(this.options.key, links)
        pending.resolve(msg.hooks)
        return
      }
      case 'mod.served': {
        const run = this.serves.get(msg.serveId)
        if (!run) return
        this.serves.delete(msg.serveId)
        if (msg.ok) run.resolve(msg.value)
        else run.reject(fromWire(msg.error?.name ?? 'Error', msg.error?.message ?? 'the method failed'))
        return
      }
      case 'mod.loadError': {
        const pending = this.loading
        this.loading = null
        pending?.reject(new Error(`${this.options.plugin}: ${msg.message}`))
        return
      }
      case 'mod.next': {
        const invocation = this.live.get(msg.invocationId)
        if (!invocation) return
        if (invocation.stream) {
          let opened: ChainStream
          try {
            opened = (invocation.call as StreamHookCall).next(msg.e, msg.tier)
          } catch (error) {
            invocation.lastNextError = error
            opened = refusedStream(error)
          }
          invocation.stream.opened.set(msg.nextId, opened)
          return
        }
        const { call } = invocation
        const next = invocation.next!
        const reply = (body: Record<string, unknown>): void => {
          try {
            this.post({
              type: 'mod.nextResult',
              invocationId: msg.invocationId,
              nextId: msg.nextId,
              ...body,
              trace: call.trace(),
            })
          } catch {
            // The result or the trace is not plain data. Say so rather than
            // leave the hook waiting; the trace is dropped.
            this.post({
              type: 'mod.nextResult',
              invocationId: msg.invocationId,
              nextId: msg.nextId,
              ok: false,
              error: {
                name: 'TypeError',
                message: 'what next() settled to is not plain data',
              },
              trace: [],
            })
          }
        }
        next(msg.e, msg.tier).then(
          result => reply({ ok: true, result }),
          error => {
            invocation.lastNextError = error
            reply({ ok: false, error: wireError(error) })
          },
        )
        return
      }
      case 'mod.chunk':
        this.live.get(msg.invocationId)?.stream?.chunk(msg.chunk)
        return
      case 'mod.streamPull': {
        const invocation = this.live.get(msg.invocationId)
        const stream = invocation?.stream?.opened.get(msg.nextId)
        if (!invocation || !stream) return
        const reply = (body: Record<string, unknown>): void => {
          if (this.disposed || !this.live.has(msg.invocationId)) return
          const base = { type: 'mod.streamStep', invocationId: msg.invocationId, nextId: msg.nextId }
          try {
            this.post({ ...base, ...body, trace: invocation.call.trace() })
          } catch {
            this.post({
              ...base,
              ok: false,
              error: { name: 'TypeError', message: 'what the stream beneath gave is not plain data' },
              trace: [],
            })
          }
        }
        stream.next().then(
          step => reply({ ok: true, done: step.done === true, value: step.value }),
          error => {
            invocation.lastNextError = error
            reply({ ok: false, error: wireError(error) })
          },
        )
        return
      }
      case 'mod.streamClose': {
        const opened = this.live.get(msg.invocationId)?.stream?.opened
        const stream = opened?.get(msg.nextId)
        if (!stream) return
        opened!.delete(msg.nextId)
        void stream.return().catch(() => undefined)
        return
      }
      case 'mod.call': {
        const invocation = msg.invocationId ? this.live.get(msg.invocationId) : undefined
        const { plugin, tier } = this.options
        // The call's own abort — `mod.cancelCall` from the worker, or this
        // instance going away — beside the calling frame's, when there is one.
        // The rate limit: a `$` call past `DISPATCH_CALL_RATE` in one
        // dispatch is refused, in the calling hook, by name.
        const calls = invocation?.call.context.calls
        if (calls && !calls.take()) {
          this.post({
            type: 'mod.callResult',
            callId: msg.callId,
            ok: false,
            error: {
              name: 'ModDispatchCallsError',
              message:
                `$.${msg.noun}.${msg.method}: this dispatch of ${invocation.call.event} made $ calls ` +
                `${callRateRefusal()} (the hooks of ${plugin} and what they called); the call is refused`,
            },
          })
          return
        }
        const cancel = new AbortController()
        this.serving.set(msg.callId, cancel)
        const signal = invocation
          ? anySignal([invocation.call.signal, cancel.signal])
          : cancel.signal
        const serve = (): Promise<unknown> =>
          this.options.serveCall({
            plugin,
            seat: this.options.key,
            noun: msg.noun,
            method: msg.method,
            args: msg.args ?? [],
            context: this.contextOf(msg.invocationId, invocation),
            scope: invocation?.call.scope,
            signal,
          })
        // The clock stops while a `$` call is in flight — a `$.clock` wait
        // excepted.
        const served =
          msg.noun === 'clock'
            ? Promise.resolve().then(serve)
            : invocation
              ? invocation.call.whileWaiting(serve)
              : this.whileRunsWait(serve)
        served.then(
          value => {
            this.serving.delete(msg.callId)
            if (this.disposed) return
            try {
              this.post({ type: 'mod.callResult', callId: msg.callId, ok: true, value })
            } catch (error) {
              this.post({
                type: 'mod.callResult',
                callId: msg.callId,
                ok: false,
                error: {
                  name: 'TypeError',
                  message: `$.${msg.noun}.${msg.method}: the result is not plain data (${wireError(error).message})`,
                },
              })
            }
          },
          error => {
            this.serving.delete(msg.callId)
            if (this.disposed) return
            this.post({ type: 'mod.callResult', callId: msg.callId, ok: false, error: wireError(error) })
          },
        )
        return
      }
      case 'mod.callStream': {
        const invocation = msg.invocationId ? this.live.get(msg.invocationId) : undefined
        const { plugin, tier } = this.options
        const calls = invocation?.call.context.calls
        let stream: DispatchedStream<unknown, unknown>
        if (calls && !calls.take()) {
          const error = new Error(
            `$.${msg.noun}.${msg.method}: this dispatch of ${invocation!.call.event} made $ calls ` +
              `${callRateRefusal()} (the hooks of ${plugin} and what they called); the call is refused`,
          )
          error.name = 'ModDispatchCallsError'
          stream = refusedCallStream<unknown, unknown>(error)
        } else if (!this.options.serveStream) {
          const error = new Error(`$.${msg.noun}.${msg.method} is not available here`)
          error.name = 'NotSupportedError'
          stream = refusedCallStream<unknown, unknown>(error)
        } else {
          // No signal: the stream outlives the calling dispatch. The worker
          // closes it when the hook's `next.signal` aborts.
          stream = this.options.serveStream({
            plugin,
            seat: this.options.key,
            noun: msg.noun,
            method: msg.method,
            args: msg.args ?? [],
            context: this.contextOf(msg.invocationId, invocation),
            scope: invocation?.call.scope,
          })
        }
        this.callStreams.set(msg.callId, { stream, ...(msg.invocationId ? { invocationId: msg.invocationId } : {}) })
        return
      }
      case 'mod.callPull': {
        const open = this.callStreams.get(msg.callId)
        if (!open) return
        const reply = (body: Record<string, unknown>): void => {
          if (this.disposed || this.callStreams.get(msg.callId) !== open) return
          if (body.ok !== true || body.done === true) this.callStreams.delete(msg.callId)
          try {
            this.post({ type: 'mod.callStep', callId: msg.callId, ...body })
          } catch (error) {
            this.callStreams.delete(msg.callId)
            void open.stream.return(undefined).catch(() => undefined)
            this.post({
              type: 'mod.callStep',
              callId: msg.callId,
              ok: false,
              error: { name: 'TypeError', message: `what the stream gave is not plain data (${wireError(error).message})` },
            })
          }
        }
        // A read made while the calling hook still runs stops its clock.
        const invocation = open.invocationId ? this.live.get(open.invocationId) : undefined
        const pull = (): Promise<IteratorResult<unknown, unknown>> => open.stream.next()
        const read = invocation ? invocation.call.whileWaiting(pull) : this.whileRunsWait(pull)
        read.then(
          step => reply({ ok: true, done: step.done === true, value: step.value }),
          error => reply({ ok: false, error: wireError(error) }),
        )
        return
      }
      case 'mod.cancelCall': {
        this.serving.get(msg.callId)?.abort()
        const open = this.callStreams.get(msg.callId)
        if (open) {
          this.callStreams.delete(msg.callId)
          void open.stream.return(undefined).catch(() => undefined)
        }
        return
      }
      case 'mod.report':
        this.options.report?.(msg.message)
        return
      case 'mod.handleResult': {
        const run = this.handleRuns.get(msg.runId)
        if (!run) return
        this.handleRuns.delete(msg.runId)
        if (msg.ok) run.resolve(undefined)
        else run.reject(fromWire(msg.error?.name ?? 'Error', msg.error?.message ?? 'the handler failed'))
        return
      }
      case 'mod.result':
        this.live.get(msg.invocationId)?.resolve(msg.result)
        return
      case 'mod.error': {
        const invocation = this.live.get(msg.invocationId)
        if (!invocation) return
        invocation.reject(
          msg.passedNextRejection
            ? (invocation.lastNextError ?? new NextRejectionPassed())
            : fromWire(msg.name, msg.message),
        )
        return
      }
    }
  }
}
