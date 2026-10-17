/**
 * Security: the worker side of one hooks module. `$` is a proxy whose every call is a
 * `mod.call` to the runtime; the module has no other way out. `e` is a FROZEN copy
 * (a rewrite is a copy passed to `next`). Each invocation gets its own `$` so calls
 * are attributed to their hook frame.
 */

import { isValidPattern, selectsEvent } from './eventPattern'
import type {
  HookFailure,
  HookRegistration,
  NextBudget,
  Origin,
  TargetTier,
  TraceEntry,
} from './modTypes'
import type {
  ModInvokeMessage,
  ModLoadMessage,
  ModPeer,
  ModRunHandleMessage,
  ModServeMessage,
  ModToWorker,
  WireError,
} from './modWire'
import { MAX_HANDED_DEPTH, nestsDeeperThan } from './modWire'
import { isEngineTable, type EngineTable } from './modEngineTable'
import { MOD_DEFAULT_LOCALE, normalizeModLocale } from './modLocale'
import { DESKTOP_ELEMENTS, RENDER_SURFACE } from './modRender'
import { makeInteractHandle, makeProviderNoun } from './provider/nouns/workerProviderNoun'

/** What a hooks module exports — `register`, and nothing the loader reads
 *  besides. Its return is dropped, a promise awaited. */
export type HooksModule = {
  register: (on: (...args: unknown[]) => unknown, options: unknown) => unknown
}

export type ModWorkerHostOptions = {
  /** Turn the module's text into the module. Defaults to importing it as a
   *  `data:` module — the only kind of import the worker's CSP allows. */
  loadModule?: (source: string) => Promise<HooksModule>
}

type HookFunction = (dollar: unknown, e: unknown, next: unknown) => unknown

type Registered = {
  hookId: string
  pattern: string
  matcher?: unknown
  hook: HookFunction
  catchHandler?: HookFunction
  /** The hook is an `async function*` — the form a streaming event takes. */
  streams: boolean
}

/** Whether `fn` is an `async function*`: the one form that loads on a
 *  streaming event. Read off the function itself — a generator's call does
 *  not run its body, so nothing else tells before it is pulled. */
export function isAsyncGeneratorFunction(fn: unknown): boolean {
  return typeof fn === 'function' && Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]'
}

function isAsyncIterator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    typeof (value as { return?: unknown }).return === 'function'
  )
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

type Invocation = {
  id: string
  controller: AbortController
  /** The error object the latest rejected `next` threw into the hook. */
  lastRejection?: Error
  trace: readonly TraceEntry[]
  /** Mirror of the runtime's own-time clock, for `next.budget`. */
  budgetMs: number
  started: number
  waited: number
  waitDepth: number
  waitBegan: number
  /** A streaming hook's generator, once created; and how its budget is
   *  counted (`pull`: anew at each pull). */
  gen?: AsyncGenerator<unknown, unknown, unknown>
  budgetPer?: 'stream' | 'pull'
}

function moduleDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:text/javascript;base64,${btoa(binary)}`
}

const importDataModule = (source: string): Promise<HooksModule> =>
  import(/* @vite-ignore */ moduleDataUrl(source)) as Promise<HooksModule>

/** Freeze plain data to every depth, in place. The value is this worker's own
 *  copy (it came through the port), so freezing it shares nothing. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return value
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

function toError(wire: WireError | undefined, fallback: string): Error {
  const error = new Error(wire?.message ?? fallback)
  error.name = wire?.name ?? 'Error'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The JSX globals `h` and `Fragment`, defined before any module loads; they build
 * plain `{ type, props, children }` data. A string tag is refused by the surface.
 */
export function installJsxGlobals(scope: object = globalThis): void {
  const target = scope as Record<string, unknown>
  if (typeof target.h !== 'function') {
    target.h = (tag: unknown, props: unknown, ...children: unknown[]) => {
      const kids = children
        .flat(Infinity)
        .filter(child => child !== null && child !== undefined && child !== false)
      // A component: called with its props and children, as JSX's classic
      // runtime does; a string tag: the element as data.
      if (typeof tag === 'function') {
        return (tag as (props: Record<string, unknown>) => unknown)({
          ...((props as Record<string, unknown> | null | undefined) ?? {}),
          children: kids,
        })
      }
      return { type: tag, props: props ?? null, children: kids }
    }
  }
  if (typeof target.Fragment !== 'function') {
    // "`<>...</>`: a column Box around the children."
    target.Fragment = (props: { children?: unknown[] } | null | undefined) => ({
      type: 'Box',
      props: { flexDirection: 'column' },
      children: props?.children ?? [],
    })
  }
}

export function installModWorkerHost(
  peer: ModPeer,
  options: ModWorkerHostOptions = {},
): void {
  installJsxGlobals()
  const loadModule = options.loadModule ?? importDataModule
  let generation = -1
  let plugin = ''
  /** `$.plugin`: `{ name, root, locale }`, frozen, from `mod.load`. */
  let pluginValues: Readonly<{ name: string; root: string; locale: string }> = Object.freeze({
    name: '',
    root: '',
    locale: MOD_DEFAULT_LOCALE,
  })
  const hooks = new Map<string, Registered>()
  /** The nouns this module's `engine.create` step added to `$`: each
   *  method a function of the plugin's own, run here on `mod.serve`. */
  const provided = new Map<string, Record<string, (...args: unknown[]) => unknown>>()
  const invocations = new Map<string, Invocation>()
  const pendingNext = new Map<string, Pending & { invocation: Invocation }>()
  /** A streaming hook's read of a stream beneath, waiting for its
   *  `mod.streamStep`, by the `nextId` that opened the stream. */
  const pendingSteps = new Map<
    string,
    { invocation: Invocation; resolve: (step: { done: boolean; value: unknown }) => void; reject: (error: Error) => void }
  >()
  const pendingCalls = new Map<string, Pending>()
  /** A read of a `$` call that streams (`$.process.spawn`), waiting for its
   *  `mod.callStep`, by the call's id. */
  const pendingCallSteps = new Map<
    string,
    { resolve: (step: { done: boolean; value: unknown }) => void; reject: (error: Error) => void }
  >()
  let seq = 0

  /** Throws (as a failed clone does, so each sender reports it the same way)
   *  when a value the frame hands over nests past `MAX_HANDED_DEPTH`. */
  const post = (message: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(message)) {
      const values = key === 'args' && Array.isArray(value) ? value : [value]
      if (values.some(item => nestsDeeperThan(item, MAX_HANDED_DEPTH))) {
        throw new RangeError(`it nests deeper than ${MAX_HANDED_DEPTH.toLocaleString('en-US')} levels`)
      }
    }
    peer.postMessage({ ...message, generation })
  }

  // ── the own-time mirror behind `next.budget` ──

  const beginWait = (invocation: Invocation): void => {
    if (invocation.waitDepth === 0) invocation.waitBegan = performance.now()
    invocation.waitDepth += 1
  }
  const endWait = (invocation: Invocation): void => {
    if (invocation.waitDepth === 0) return
    invocation.waitDepth -= 1
    if (invocation.waitDepth === 0) {
      invocation.waited += performance.now() - invocation.waitBegan
    }
  }
  const budgetOf = (invocation: Invocation): NextBudget => {
    const now = performance.now()
    const waiting = invocation.waitDepth > 0 ? now - invocation.waitBegan : 0
    const own = now - invocation.started - invocation.waited - waiting
    return Object.freeze({
      ms: invocation.budgetMs,
      remainingMs: Math.max(0, invocation.budgetMs - own),
    })
  }

  // ── `$` ──

  const abortError = (message: string): Error => {
    const error = new Error(message)
    error.name = 'AbortError'
    return error
  }

  /** A `$` call that failed, logged to this worker's console under the plugin's
   *  name whether or not the module catches it; an abandoned wait is not a failure (F-25). */
  const logCallFailure = (noun: string, method: string, error: Error): void => {
    if (error.name === 'AbortError') return
    console.warn(`[mod ${plugin || '?'}] $.${noun}.${method} failed: ${error.name}: ${error.message}`, error)
  }

  const callRuntime = (
    invocation: Invocation | undefined,
    noun: string,
    method: string,
    args: unknown[],
    /** Stops waiting: the runtime is told (`mod.cancelCall`) and the call
     *  rejects here at once with an AbortError. */
    cancel?: AbortSignal,
  ): Promise<unknown> => {
    const callId = `c${++seq}`
    // A `$.clock` wait is the one `$` call that counts against the budget.
    const pauses = invocation !== undefined && noun !== 'clock'
    return new Promise<unknown>((resolve, reject) => {
      const onCancel = (): void => {
        if (!pendingCalls.has(callId)) return
        pendingCalls.delete(callId)
        if (pauses) endWait(invocation)
        try {
          post({ type: 'mod.cancelCall', callId })
        } catch {
          /* port gone */
        }
        reject(abortError(`$.${noun}.${method}: the wait was abandoned`))
      }
      pendingCalls.set(callId, {
        resolve: value => {
          cancel?.removeEventListener('abort', onCancel)
          if (pauses) endWait(invocation)
          resolve(value)
        },
        reject: error => {
          cancel?.removeEventListener('abort', onCancel)
          if (pauses) endWait(invocation)
          logCallFailure(noun, method, error)
          reject(error)
        },
      })
      if (cancel?.aborted) {
        onCancel()
        return
      }
      cancel?.addEventListener('abort', onCancel, { once: true })
      try {
        post({
          type: 'mod.call',
          callId,
          ...(invocation ? { invocationId: invocation.id } : {}),
          noun,
          method,
          args,
        })
        if (pauses) beginWait(invocation)
      } catch (error) {
        // An argument that cannot cross the port (a function, say).
        pendingCalls.delete(callId)
        const refused = new TypeError(`$.${noun}.${method}: an argument is not plain data (${errorMessage(error)})`)
        logCallFailure(noun, method, refused)
        reject(refused)
      }
    })
  }

  // `$.clock` timers: the callback stays in this worker; a hook above may refuse the
  // dispatch, and a restarted worker takes every timer with it.

  const reportOutsideHook = (line: string): void => {
    try {
      post({ type: 'mod.report', message: line })
    } catch {
      /* port gone */
    }
  }

  const runTimerCallback = (which: 'after' | 'every', fn: () => void): void => {
    try {
      const result = fn() as unknown
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).then(undefined, error => {
          reportOutsideHook(`a $.clock.${which} callback failed: ${errorMessage(error)}`)
        })
      }
    } catch (error) {
      reportOutsideHook(`a $.clock.${which} callback failed: ${errorMessage(error)}`)
    }
  }

  const timerCall =
    (which: 'after' | 'every') =>
    (ms: unknown, fn: unknown): { cancel: () => void } => {
      if (typeof fn !== 'function') {
        throw new TypeError(`$.clock.${which}(ms, fn): fn is not a function`)
      }
      const least = which === 'every' ? 1 : 0
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < least) {
        throw new TypeError(
          `$.clock.${which}(ms, fn): ms must be a number of at least ${least}`,
        )
      }
      const controller = new AbortController()
      const once = (): Promise<void> =>
        callRuntime(undefined, 'clock', which, [{ ms }], controller.signal).then(
          () => undefined,
        )
      const run = async (): Promise<void> => {
        for (;;) {
          try {
            await once()
          } catch {
            // Cancelled, refused by a hook above, or the runtime went away:
            // the timer is over, and so is the interval.
            return
          }
          if (controller.signal.aborted) return
          runTimerCallback(which, fn as () => void)
          if (which === 'after') return
        }
      }
      void run()
      return Object.freeze({ cancel: () => controller.abort() })
    }

  /** `$.clock`: `now` and `sleep` cross as calls; `sleep`'s `signal` (which
   *  cannot cross) is honoured here; `after` / `every` keep their callback. */
  const makeClock = (invocation: Invocation | undefined): unknown => {
    const clock = {
      now: () => callRuntime(invocation, 'clock', 'now', []),
      sleep: (ms: unknown, options?: unknown): Promise<unknown> => {
        const signal =
          options && typeof options === 'object'
            ? (options as { signal?: unknown }).signal
            : undefined
        const cancel =
          signal instanceof AbortSignal
            ? signal
            : undefined
        return callRuntime(invocation, 'clock', 'sleep', [{ ms }], cancel)
      },
      after: timerCall('after'),
      every: timerCall('every'),
    }
    return new Proxy(Object.freeze(clock), {
      get: (target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined
        if (Object.prototype.hasOwnProperty.call(target, method)) {
          return target[method as keyof typeof target]
        }
        return (...args: unknown[]) => callRuntime(invocation, 'clock', method, args)
      },
    })
  }

  /** `$.model`: `complete`'s `options.signal` "does not cross, it aborts the
   *  call" — honoured here as `sleep`'s is; `fork` and `classify` cross as
   *  calls, cut by the dispatch alone. */
  const makeModel = (invocation: Invocation | undefined): unknown => {
    const model = {
      complete: (request: unknown, options?: unknown): Promise<unknown> => {
        const signal =
          options && typeof options === 'object' ? (options as { signal?: unknown }).signal : undefined
        const own = signal instanceof AbortSignal ? signal : undefined
        // "If `options.signal` aborts, the call resolves `aborted`": the wait
        // abandoned by the plugin's own signal — or a signal already aborted,
        // which sends no request — is that answer, not a throw (review fix).
        const aborted = { isAnswered: false, reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
        if (own?.aborted) return Promise.resolve(aborted)
        return callRuntime(invocation, 'model', 'complete', [request], own).catch(error => {
          if (own?.aborted) return aborted
          throw error
        })
      },
    }
    return new Proxy(Object.freeze(model), {
      get: (target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined
        if (Object.prototype.hasOwnProperty.call(target, method)) {
          return target[method as keyof typeof target]
        }
        return (...args: unknown[]) => callRuntime(invocation, 'model', method, args)
      },
    })
  }

  /** `$.audio`: `play`'s `options.signal` does not cross — it stops the
   *  clip, and the call then resolves; a loop needs one to end it. */
  const makeAudio = (invocation: Invocation | undefined): unknown => {
    const audio = {
      play: (clip: unknown, options?: unknown): Promise<unknown> => {
        const given = options && typeof options === 'object' ? (options as Record<string, unknown>) : undefined
        const own = given?.signal instanceof AbortSignal ? given.signal : undefined
        if (given?.shouldLoop === true && !own) {
          return Promise.reject(new TypeError('$.audio.play: a looped clip needs the signal that ends it'))
        }
        if (own?.aborted) return Promise.resolve(undefined)
        const crossing = given ? { shouldLoop: given.shouldLoop, gain: given.gain } : undefined
        return callRuntime(invocation, 'audio', 'play', crossing ? [clip, crossing] : [clip], own).then(
          () => undefined,
          error => {
            if (own?.aborted) return undefined
            throw error
          },
        )
      },
      speak: (text: unknown, options?: unknown): Promise<unknown> =>
        callRuntime(invocation, 'audio', 'speak', options === undefined ? [text] : [text, options]),
    }
    return new Proxy(Object.freeze(audio), {
      get: (target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined
        if (Object.prototype.hasOwnProperty.call(target, method)) {
          return target[method as keyof typeof target]
        }
        return (...args: unknown[]) => callRuntime(invocation, 'audio', method, args)
      },
    })
  }

  /**
   * A streaming `$` call (`$.process.spawn`): lazy until the first read; closed only by
   * leaving it or the calling hook's `next.signal` aborting. A read waits outside the
   * hook's clock.
   */
  const callRuntimeStream = (invocation: Invocation | undefined, noun: string, method: string, args: unknown[]): unknown => {
    let settleResult!: { resolve: (value: unknown) => void; reject: (error: unknown) => void }
    const result = new Promise<unknown>((resolve, reject) => {
      settleResult = { resolve, reject }
    })
    result.catch(() => undefined)
    const callId = `c${++seq}`
    let state: 'idle' | 'open' | 'done' | 'closed' = 'idle'
    let reading: Promise<unknown> = Promise.resolve()
    const signal = invocation?.controller.signal
    const onAbort = (): void => close(abortError(`$.${noun}.${method}: the hook's dispatch was abandoned`))
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    /** Settles the read in flight without a step from the runtime. */
    let endRead: ((error?: Error) => void) | undefined
    const read = (): Promise<IteratorResult<unknown, unknown>> => {
      if (state === 'done' || state === 'closed') return Promise.resolve({ done: true, value: undefined })
      if (state === 'idle') {
        if (signal?.aborted) {
          state = 'closed'
          const error = abortError(`$.${noun}.${method}: the hook's dispatch was abandoned`)
          settleResult.reject(error)
          return Promise.reject(error)
        }
        try {
          post({
            type: 'mod.callStream',
            callId,
            ...(invocation ? { invocationId: invocation.id } : {}),
            noun,
            method,
            args,
          })
        } catch (error) {
          state = 'done'
          const refused = new TypeError(`$.${noun}.${method}: an argument is not plain data (${errorMessage(error)})`)
          logCallFailure(noun, method, refused)
          settleResult.reject(refused)
          return Promise.reject(refused)
        }
        state = 'open'
        signal?.addEventListener('abort', onAbort, { once: true })
      }
      return new Promise<IteratorResult<unknown, unknown>>((resolve, reject) => {
        endRead = error => (error ? reject(error) : resolve({ done: true, value: undefined }))
        pendingCallSteps.set(callId, {
          resolve: step => {
            if (invocation) endWait(invocation)
            if (step.done) {
              state = 'done'
              finish()
              settleResult.resolve(step.value)
              resolve({ done: true, value: step.value })
            } else {
              resolve({ done: false, value: deepFreeze(step.value) })
            }
          },
          reject: error => {
            if (invocation) endWait(invocation)
            state = 'done'
            finish()
            logCallFailure(noun, method, error)
            settleResult.reject(error)
            reject(error)
          },
        })
        if (invocation) beginWait(invocation)
        try {
          post({ type: 'mod.callPull', callId })
        } catch (error) {
          pendingCallSteps.get(callId)?.reject(new Error(errorMessage(error)))
          pendingCallSteps.delete(callId)
        }
      })
    }
    const close = (error?: Error): void => {
      if (state === 'done' || state === 'closed') return
      const opened = state === 'open'
      state = 'closed'
      finish()
      settleResult.reject(error ?? new Error('the stream was closed before its end'))
      // A read in flight ends with the stream: done when the hook closed it,
      // rejected when its dispatch was abandoned.
      const pending = pendingCallSteps.get(callId)
      if (pending) {
        pendingCallSteps.delete(callId)
        if (invocation) endWait(invocation)
        endRead?.(error)
      }
      if (!opened) return
      try {
        post({ type: 'mod.cancelCall', callId })
      } catch {
        /* port gone */
      }
    }
    const stream = {
      next: (): Promise<IteratorResult<unknown, unknown>> => {
        // One read at a time: a second waits for the first.
        const run = reading.then(read)
        reading = run.catch(() => undefined)
        return run
      },
      return: async (value?: unknown): Promise<IteratorResult<unknown, unknown>> => {
        close()
        return { done: true, value }
      },
      throw: async (error?: unknown): Promise<IteratorResult<unknown, unknown>> => {
        close()
        throw error
      },
      [Symbol.asyncIterator]() {
        return stream
      },
      result,
    }
    return Object.freeze(stream)
  }

  /** `$.process`: `spawn` is a stream (`callRuntimeStream`); the rest are
   *  calls. */
  const makeProcess = (invocation: Invocation | undefined): unknown =>
    new Proxy(Object.freeze({}), {
      get: (_target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined
        if (method === 'spawn') {
          return (...args: unknown[]) => callRuntimeStream(invocation, 'process', 'spawn', args)
        }
        return (...args: unknown[]) => callRuntime(invocation, 'process', method, args)
      },
    })

  /** The tables behind `$`, one per noun, made once per `$`. */
  const makeNounTables = (invocation: Invocation | undefined): ((noun: string) => unknown) => {
    const nouns = new Map<string, unknown>()
    const nounOf = (noun: string): unknown => {
      let table = nouns.get(noun)
      // `$.provider` (a provider module's): objects with functions are
      // assembled here from flat calls — see `workerProviderNoun`.
      if (!table && noun === 'provider') {
        table = makeProviderNoun((method, args) => callRuntime(invocation, 'provider', method, args))
        nouns.set(noun, table)
      }
      if (!table) {
        table =
          // `$.plugin.name` / `$.plugin.root` are VALUES, not calls: "from
          // plugin.json", fixed at load.
          noun === 'plugin'
            ? pluginValues
            : noun === 'clock'
              ? makeClock(invocation)
              : noun === 'ui'
                ? makeUi(invocation)
                : noun === 'model'
                  ? makeModel(invocation)
                  : noun === 'audio'
                    ? makeAudio(invocation)
                  : noun === 'process'
                    ? makeProcess(invocation)
                    : new Proxy(Object.freeze({}), {
                  get: (_target, method) =>
                    // `then`: so that `await $.fs` does not treat the noun as a promise.
                    typeof method !== 'string' || method === 'then'
                      ? undefined
                      : (...args: unknown[]) => callRuntime(invocation, noun, method, args),
                })
        nouns.set(noun, table)
      }
      return table
    }
    return nounOf
  }

  const makeDollar = (invocation: Invocation | undefined): unknown => {
    const nounOf = makeNounTables(invocation)
    return new Proxy(Object.freeze({}), {
      get: (_target, noun) =>
        typeof noun !== 'string' || noun === 'then' ? undefined : nounOf(noun),
    })
  }

  // `engine.create`: `$` is folded hook by hook as a descriptor. A returned property
  // that is one of `built`'s tables is kept, a missing one withheld, a new one is this
  // plugin's noun; replacing another plugin's noun fails the step.

  /**
   * `provider.login`: the hook gets `e.interact` (the handle that drives the
   * sign-in dialog), and when it throws, the runtime is told why - the words
   * are the vendor's and the dialog shows them. The failure itself goes on.
   */
  const runProviderLogin = async (
    invocation: Invocation,
    msg: ModInvokeMessage,
    fn: HookFunction,
  ): Promise<unknown> => {
    const e = deepFreeze(msg.e) as Record<string, unknown>
    const call = (method: string, args: unknown[]): Promise<unknown> =>
      callRuntime(invocation, 'provider', method, args)
    const loginId = e.loginId
    try {
      return await fn(
        makeDollar(invocation),
        Object.freeze({ ...e, interact: makeInteractHandle(call, loginId) }),
        makeNext(invocation, msg),
      )
    } catch (error) {
      await call('interactFail', [loginId, errorMessage(error)]).catch(() => undefined)
      throw error
    }
  }

  const runEngineCreate = async (
    invocation: Invocation,
    msg: ModInvokeMessage,
    fn: HookFunction,
  ): Promise<unknown> => {
    const nounOf = makeNounTables(invocation)
    const rawNext = makeNext(invocation, msg) as ((e: unknown) => Promise<unknown>) & Record<string, unknown>
    /** The tables `built` holds, by noun, across every `next` call. */
    const builtTables = new Map<string, unknown>()
    let last: EngineTable | undefined
    const build = (table: EngineTable): Readonly<Record<string, unknown>> => {
      last = table
      const out: Record<string, unknown> = {}
      for (const noun of Object.keys(table.nouns)) {
        let value = builtTables.get(noun)
        if (value === undefined) {
          value = nounOf(noun)
          builtTables.set(noun, value)
        }
        out[noun] = value
      }
      return Object.freeze(out)
    }
    const next = (e: unknown): Promise<unknown> =>
      rawNext(e).then(result => {
        if (!isEngineTable(result)) {
          throw new TypeError('next(e) at engine.create did not resolve to the table $ is built from')
        }
        return build(result)
      })
    // Descriptors, not values: `trace` and `budget` are getters that stay live.
    for (const key of Object.keys(rawNext)) {
      Object.defineProperty(next, key, Object.getOwnPropertyDescriptor(rawNext, key)!)
    }
    // "What an `engine.create` hook receives as `$`: nothing."
    const result = await fn(Object.freeze({}), deepFreeze(msg.e), Object.freeze(next))
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new TypeError(
        'an engine.create step returns $ as built so far (what next(e) resolved to) with this plugin\'s nouns added',
      )
    }
    const returned = result as Record<string, unknown>
    const table: EngineTable = {
      nouns: {},
      owners: {},
      withheld: { ...(last?.withheld ?? {}) },
      ...(last === undefined ? { withheldAll: plugin } : {}),
    }
    const added = new Map<string, Record<string, (...args: unknown[]) => unknown>>()
    for (const [noun, value] of Object.entries(returned)) {
      if (builtTables.has(noun)) {
        if (value !== builtTables.get(noun)) {
          throw new Error(
            `${plugin}'s engine.create step replaced $.${noun}, which ${last?.owners[noun] ?? 'the engine'} ` +
              'added: a step may add nouns and withhold nouns, not replace one',
          )
        }
        table.nouns[noun] = last!.nouns[noun]!
        table.owners[noun] = last!.owners[noun]!
        continue
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`$.${noun}, as ${plugin}'s engine.create step returned it, is not an object of methods`)
      }
      const fns: Record<string, (...args: unknown[]) => unknown> = {}
      for (const [method, member] of Object.entries(value as Record<string, unknown>)) {
        if (typeof member === 'function') fns[method] = member as (...args: unknown[]) => unknown
      }
      const methods = Object.keys(fns)
      if (methods.length === 0) {
        throw new TypeError(`$.${noun}, as ${plugin}'s engine.create step returned it, holds no method`)
      }
      added.set(noun, fns)
      table.nouns[noun] = methods
      table.owners[noun] = plugin
    }
    for (const noun of builtTables.keys()) {
      if (!(noun in returned)) table.withheld[noun] = plugin
    }
    // The step stood: its nouns are what this module provides from now on
    // (the runtime's table decides which of them are served).
    for (const [noun, fns] of added) provided.set(noun, fns)
    return table
  }

  /** `mod.serve`: a method of a noun this module provides, run here. */
  const serve = async (msg: ModServeMessage): Promise<void> => {
    const fns = provided.get(msg.noun)
    const fn = fns?.[msg.method]
    if (!fns || !fn) {
      post({
        type: 'mod.served',
        serveId: msg.serveId,
        ok: false,
        error: {
          name: 'NotSupportedError',
          message: fns
            ? `$.${msg.noun}.${msg.method} is not a method ${plugin} provides (it provides: ${Object.keys(fns)
                .map(method => `${msg.noun}.${method}`)
                .join(', ')})`
            : `$.${msg.noun} is not a noun ${plugin} provides`,
        },
      })
      return
    }
    try {
      const value = await fn(...(msg.args ?? []).map(arg => deepFreeze(arg)))
      try {
        post({ type: 'mod.served', serveId: msg.serveId, ok: true, value })
      } catch (error) {
        post({
          type: 'mod.served',
          serveId: msg.serveId,
          ok: false,
          error: { name: 'TypeError', message: `$.${msg.noun}.${msg.method}: the result is not plain data (${errorMessage(error)})` },
        })
      }
    } catch (error) {
      post({
        type: 'mod.served',
        serveId: msg.serveId,
        ok: false,
        error: { name: error instanceof Error && error.name ? error.name : 'Error', message: errorMessage(error) },
      })
    }
  }

  // `$.ui.resolve(e)`: element constructors for render hooks. Handlers stay in this
  // worker under `press.handle`, dropped when the drawing is replaced and pruned to
  // the ones the returned tree holds.

  type Handle = { element: string; fns: Record<string, (...args: unknown[]) => unknown> }
  const handles = new Map<number, Handle>()
  const createdIn = new Map<string, Set<number>>()
  let nextHandle = 0

  const keepHandle = (
    invocation: Invocation | undefined,
    element: string,
    fns: Record<string, (...args: unknown[]) => unknown>,
  ): number => {
    const id = ++nextHandle
    handles.set(id, { element, fns })
    if (invocation) {
      let set = createdIn.get(invocation.id)
      if (!set) {
        set = new Set()
        createdIn.set(invocation.id, set)
      }
      set.add(id)
    }
    return id
  }

  /** The handles a tree holds that are THIS plugin's. */
  const handlesOf = (tree: unknown): Set<number> => {
    const out = new Set<number>()
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      const record = node as { press?: unknown; children?: unknown }
      const press = record.press as { plugin?: unknown; handle?: unknown } | undefined
      if (press && typeof press === 'object' && press.plugin === plugin && typeof press.handle === 'number') {
        out.add(press.handle)
      }
      if (Array.isArray(record.children)) for (const child of record.children) visit(child)
    }
    visit(tree)
    return out
  }

  /** An invocation is over: of the handles it made, keep those its `ui.render`
   *  answer holds, forget the rest. */
  const settleHandles = (invocation: Invocation, event: string, result: unknown): void => {
    const made = createdIn.get(invocation.id)
    if (!made) return
    createdIn.delete(invocation.id)
    const kept = event === 'ui.render' ? handlesOf(result) : new Set<number>()
    for (const id of made) if (!kept.has(id)) handles.delete(id)
  }

  /** JSX children as the element holds them: flat, the dropped values gone,
   *  numbers as their strings. */
  const kidsOf = (children: unknown): unknown[] =>
    [children]
      .flat(Infinity)
      .filter(child => child !== null && child !== undefined && child !== false && child !== true)
      .map(child => (typeof child === 'number' ? String(child) : child))

  const withoutChildren = (props: unknown): Record<string, unknown> => {
    const { children: _children, ...rest } = (props ?? {}) as Record<string, unknown>
    return rest
  }

  const makeElements = (invocation: Invocation | undefined): Record<string, unknown> => {
    const styled = (type: 'Box' | 'Text') => (props: unknown) => ({
      type,
      props: withoutChildren(props),
      children: kidsOf((props as { children?: unknown } | null | undefined)?.children),
    })
    const leaf = (type: string) => (props: unknown) => ({ type, props: withoutChildren(props) })
    const table: Record<string, unknown> = {
      Box: styled('Box'),
      Text: styled('Text'),
      Button: (props: unknown) => {
        const { onPress, ...rest } = withoutChildren(props) as { onPress?: unknown } & Record<string, unknown>
        if (typeof onPress !== 'function') throw new TypeError('Button: onPress is not a function')
        const kids = kidsOf((props as { children?: unknown } | null | undefined)?.children)
        const label =
          typeof rest.label === 'string' ? rest.label : kids.length === 1 && typeof kids[0] === 'string' ? kids[0] : undefined
        if (label === undefined) throw new TypeError('Button: a label, or one string child, is required')
        const key = typeof rest.key === 'string' ? rest.key : label
        const handle = keepHandle(invocation, 'Button', { default: onPress as (...args: unknown[]) => unknown })
        return { type: 'Button', props: { ...rest, key, label }, press: { plugin, handle } }
      },
      Input: (props: unknown) => {
        const { onInput, onSubmit, ...rest } = withoutChildren(props) as {
          onInput?: unknown
          onSubmit?: unknown
        } & Record<string, unknown>
        if (typeof onSubmit !== 'function') throw new TypeError('Input: onSubmit is not a function')
        if (onInput !== undefined && typeof onInput !== 'function') {
          throw new TypeError('Input: onInput is not a function')
        }
        const fns: Record<string, (...args: unknown[]) => unknown> = {
          submit: onSubmit as (...args: unknown[]) => unknown,
        }
        if (typeof onInput === 'function') fns.change = onInput as (...args: unknown[]) => unknown
        const handle = keepHandle(invocation, 'Input', fns)
        return { type: 'Input', props: rest, press: { plugin, handle } }
      },
      Select: (props: unknown) => {
        const { onSelect, ...rest } = withoutChildren(props) as { onSelect?: unknown } & Record<string, unknown>
        if (typeof onSelect !== 'function') throw new TypeError('Select: onSelect is not a function')
        const handle = keepHandle(invocation, 'Select', { default: onSelect as (...args: unknown[]) => unknown })
        return { type: 'Select', props: rest, press: { plugin, handle } }
      },
      Svg: leaf('Svg'),
      Link: (props: unknown) => ({
        type: 'Link',
        props: withoutChildren(props),
        children: kidsOf((props as { children?: unknown } | null | undefined)?.children),
      }),
      Code: leaf('Code'),
      Markdown: (props: unknown) => {
        const { onLinkPress, ...rest } = withoutChildren(props) as { onLinkPress?: unknown } & Record<string, unknown>
        if (onLinkPress === undefined) return { type: 'Markdown', props: rest }
        if (typeof onLinkPress !== 'function') throw new TypeError('Markdown: onLinkPress is not a function')
        const handle = keepHandle(invocation, 'Markdown', { default: onLinkPress as (...args: unknown[]) => unknown })
        return { type: 'Markdown', props: rest, press: { plugin, handle } }
      },
    }
    for (const name of Object.keys(table)) {
      if (!(DESKTOP_ELEMENTS as readonly string[]).includes(name)) delete table[name]
    }
    return Object.freeze(table)
  }

  /** `$.ui`: `resolve` is a read served here; the rest cross as calls. */
  const makeUi = (invocation: Invocation | undefined): unknown => {
    let elements: Record<string, unknown> | undefined
    const local = {
      resolve: (e: unknown): unknown => {
        const surface = e && typeof e === 'object' ? (e as { surface?: unknown }).surface : undefined
        if (surface !== RENDER_SURFACE) {
          throw new TypeError(
            `$.ui.resolve(e): e is not this surface's ui.render argument (surface ${JSON.stringify(surface)})`,
          )
        }
        elements ??= makeElements(invocation)
        return elements
      },
    }
    return new Proxy(Object.freeze(local), {
      get: (target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined
        if (Object.prototype.hasOwnProperty.call(target, method)) {
          return target[method as keyof typeof target]
        }
        return (...args: unknown[]) => callRuntime(invocation, 'ui', method, args)
      },
    })
  }

  const runHandle = async (msg: ModRunHandleMessage): Promise<void> => {
    const held = handles.get(msg.handle)
    const fn = held?.fns[msg.which ?? 'default']
    if (!held || !fn) {
      post({
        type: 'mod.handleResult',
        runId: msg.runId,
        ok: false,
        error: { name: 'Error', message: `no such handler: ${msg.handle}${msg.which ? ` (${msg.which})` : ''}` },
      })
      return
    }
    try {
      await fn(...(msg.args ?? []).map(arg => deepFreeze(arg)))
      post({ type: 'mod.handleResult', runId: msg.runId, ok: true })
    } catch (error) {
      post({
        type: 'mod.handleResult',
        runId: msg.runId,
        ok: false,
        error: {
          name: error instanceof Error && error.name ? error.name : 'Error',
          message: `a ${held.element} handler failed: ${errorMessage(error)}`,
        },
      })
    }
  }

  // ── `next` ──

  const makeNext = (invocation: Invocation, msg: ModInvokeMessage): unknown => {
    const call = (e: unknown, tier: TargetTier | undefined): Promise<unknown> => {
      if (e === undefined) {
        return Promise.reject(
          new Error(
            `next() was called with no argument by ${plugin}'s hook on ${msg.event}`,
          ),
        )
      }
      const nextId = `n${++seq}`
      return new Promise<unknown>((resolve, reject) => {
        pendingNext.set(nextId, {
          invocation,
          resolve: value => {
            endWait(invocation)
            resolve(value)
          },
          reject: error => {
            endWait(invocation)
            reject(error)
          },
        })
        try {
          post({
            type: 'mod.next',
            invocationId: invocation.id,
            nextId,
            e,
            ...(tier !== undefined ? { tier } : {}),
          })
          beginWait(invocation)
        } catch (error) {
          pendingNext.delete(nextId)
          reject(
            new TypeError(`next(e): e is not plain data (${errorMessage(error)})`),
          )
        }
      })
    }
    return decorateNext(call, invocation, msg)
  }

  /** `next` with what it carries besides being called: `to`, `signal`, `is`,
   *  `event`, `origin`, `trace`, `budget`, and in a `.catch` handler `error`
   *  and `called`. The same on a plain hook's `next` and a streaming one's. */
  const decorateNext = <T>(
    call: (e: unknown, tier: TargetTier | undefined) => T,
    invocation: Invocation,
    msg: ModInvokeMessage,
  ): unknown => {
    const next = (e: unknown): T => call(e, undefined)
    Object.defineProperties(next, {
      to: { value: (e: unknown, tier: TargetTier) => call(e, tier), enumerable: true },
      signal: { value: invocation.controller.signal, enumerable: true },
      is: {
        value: (pattern: string) => selectsEvent(pattern, msg.event),
        enumerable: true,
      },
      event: { value: msg.event, enumerable: true },
      origin: { value: Object.freeze({ ...msg.origin }) as Origin, enumerable: true },
      trace: { get: () => invocation.trace, enumerable: true },
      budget: { get: () => budgetOf(invocation), enumerable: true },
      ...(msg.catch
        ? {
            error: {
              value: Object.freeze({ ...msg.catch.error }) as HookFailure,
              enumerable: true,
            },
            called: { value: msg.catch.called, enumerable: true },
          }
        : {}),
    })
    return Object.freeze(next)
  }

  /**
   * A streaming hook's `next`: each call opens a fresh lazy stream of everything
   * beneath; `.result` settles once read to the end. Leaving early closes beneath.
   */
  const makeStreamNext = (invocation: Invocation, msg: ModInvokeMessage): unknown => {
    const open = (e: unknown, tier: TargetTier | undefined): unknown => {
      let settleResult!: { resolve: (value: unknown) => void; reject: (error: unknown) => void }
      const result = new Promise<unknown>((resolve, reject) => {
        settleResult = { resolve, reject }
      })
      result.catch(() => undefined)
      /** Set: the stream could not open — its first read throws this. */
      let refused: Error | undefined
      const nextId = `n${++seq}`
      if (e === undefined) {
        refused = new Error(`next() was called with no argument by ${plugin}'s hook on ${msg.event}`)
      } else {
        try {
          post({
            type: 'mod.next',
            invocationId: invocation.id,
            nextId,
            e,
            ...(tier !== undefined ? { tier } : {}),
          })
        } catch (error) {
          refused = new TypeError(`next(e): e is not plain data (${errorMessage(error)})`)
        }
      }
      let state: 'open' | 'done' | 'closed' = 'open'
      let reading: Promise<unknown> = Promise.resolve()
      const read = (): Promise<IteratorResult<unknown, unknown>> => {
        if (state !== 'open') return Promise.resolve({ done: true, value: undefined })
        if (refused) {
          const error = refused
          state = 'done'
          settleResult.reject(error)
          return Promise.reject(error)
        }
        return new Promise<IteratorResult<unknown, unknown>>((resolve, reject) => {
          pendingSteps.set(nextId, {
            invocation,
            resolve: step => {
              endWait(invocation)
              if (step.done) {
                state = 'done'
                settleResult.resolve(step.value)
                resolve({ done: true, value: step.value })
              } else {
                resolve({ done: false, value: deepFreeze(step.value) })
              }
            },
            reject: error => {
              endWait(invocation)
              state = 'done'
              settleResult.reject(error)
              reject(error)
            },
          })
          beginWait(invocation)
          try {
            post({ type: 'mod.streamPull', invocationId: invocation.id, nextId })
          } catch (error) {
            pendingSteps.get(nextId)?.reject(new Error(errorMessage(error)))
            pendingSteps.delete(nextId)
          }
        })
      }
      const close = (): void => {
        if (state !== 'open') return
        state = 'closed'
        settleResult.reject(new Error('the stream was closed before its end'))
        if (refused) return
        try {
          post({ type: 'mod.streamClose', invocationId: invocation.id, nextId })
        } catch {
          /* port gone */
        }
      }
      const stream = {
        next: (): Promise<IteratorResult<unknown, unknown>> => {
          // One read at a time: a second waits for the first.
          const run = reading.then(read)
          reading = run.catch(() => undefined)
          return run
        },
        return: async (value?: unknown): Promise<IteratorResult<unknown, unknown>> => {
          close()
          return { done: true, value }
        },
        throw: async (error?: unknown): Promise<IteratorResult<unknown, unknown>> => {
          close()
          throw error
        },
        [Symbol.asyncIterator]() {
          return stream
        },
        result,
      }
      return Object.freeze(stream)
    }
    return decorateNext(open, invocation, msg)
  }

  // ── load ──

  const load = async (msg: ModLoadMessage): Promise<void> => {
    generation = msg.generation
    plugin = msg.plugin
    provided.clear()
    pluginValues = Object.freeze({
      name: msg.plugin,
      root: msg.root ?? '',
      locale: normalizeModLocale(msg.locale),
    })
    let registering = true
    const registered: Registered[] = []
    const on = (...args: unknown[]): unknown => {
      if (!registering) {
        throw new Error('on() was called after register() returned')
      }
      const [pattern, second, third] = args
      if (!isValidPattern(pattern)) {
        throw new TypeError(`on(): ${JSON.stringify(pattern)} is not an event pattern`)
      }
      const hasMatcher = args.length >= 3
      const matcher = hasMatcher ? second : undefined
      const hook = hasMatcher ? third : second
      if (typeof hook !== 'function') {
        throw new TypeError(`on("${pattern}"): the hook is not a function`)
      }
      if (
        hasMatcher &&
        (matcher === null ||
          typeof matcher !== 'object' ||
          Array.isArray(matcher) ||
          matcher instanceof RegExp)
      ) {
        throw new TypeError(
          `on("${pattern}"): the matcher is not an object (a partial of the event's argument)`,
        )
      }
      const entry: Registered = {
        hookId: `h${registered.length + 1}`,
        pattern,
        ...(hasMatcher ? { matcher } : {}),
        hook: hook as HookFunction,
        streams: isAsyncGeneratorFunction(hook),
      }
      registered.push(entry)
      return Object.freeze({
        catch: (handler: unknown): void => {
          if (!registering) {
            throw new Error('.catch() was called after register() returned')
          }
          if (pattern === 'engine.create') {
            throw new Error(
              'on("engine.create") takes no .catch: its hook has no budget and its failure is the load\'s',
            )
          }
          if (entry.catchHandler) {
            throw new Error(`on("${pattern}"): a registration takes one .catch`)
          }
          if (typeof handler !== 'function') {
            throw new TypeError(`on("${pattern}").catch: the handler is not a function`)
          }
          // "A `.catch` handler on a streaming hook is a generator too,
          // continuing the stream" — and only there.
          if (isAsyncGeneratorFunction(handler) !== entry.streams) {
            throw new TypeError(
              entry.streams
                ? `on("${pattern}").catch: the hook is an async generator, so its handler must be one too`
                : `on("${pattern}").catch: the handler is an async generator, but the hook is not`,
            )
          }
          entry.catchHandler = handler as HookFunction
        },
      })
    }
    try {
      const module = await loadModule(msg.source)
      if (!module || typeof module.register !== 'function') {
        throw new Error('the hooks module does not export register(on, options)')
      }
      await module.register(on, deepFreeze(msg.options))
      registering = false
      const wire: HookRegistration[] = registered.map(entry => ({
        hookId: entry.hookId,
        pattern: entry.pattern,
        ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
        hasCatch: entry.catchHandler !== undefined,
        ...(entry.streams ? { streams: true } : {}),
      }))
      // A matcher that is not plain data (a function inside it) cannot cross
      // the port: that throws here, and the module does not load.
      post({ type: 'mod.loaded', hooks: wire })
      for (const entry of registered) hooks.set(entry.hookId, entry)
    } catch (error) {
      registering = false
      hooks.clear()
      post({ type: 'mod.loadError', message: errorMessage(error) })
    }
  }

  // ── one run of one hook ──

  const invoke = async (msg: ModInvokeMessage): Promise<void> => {
    const entry = hooks.get(msg.hookId)
    const fn = msg.catch ? entry?.catchHandler : entry?.hook
    if (!fn) {
      post({
        type: 'mod.error',
        invocationId: msg.invocationId,
        name: 'Error',
        message: `no such hook: ${msg.hookId}`,
      })
      return
    }
    const invocation: Invocation = {
      id: msg.invocationId,
      controller: new AbortController(),
      trace: Object.freeze([]),
      budgetMs: msg.budgetMs,
      started: performance.now(),
      waited: 0,
      waitDepth: 0,
      waitBegan: 0,
    }
    if (msg.stream) {
      startStream(invocation, msg, fn)
      return
    }
    invocations.set(invocation.id, invocation)
    try {
      const result =
        msg.event === 'engine.create' && !msg.catch
          ? await runEngineCreate(invocation, msg, fn)
          : msg.event === 'provider.login' && !msg.catch
            ? await runProviderLogin(invocation, msg, fn)
            : await fn(makeDollar(invocation), deepFreeze(msg.e), makeNext(invocation, msg))
      settleHandles(invocation, msg.event, result)
      try {
        post({ type: 'mod.result', invocationId: invocation.id, result })
      } catch (error) {
        post({
          type: 'mod.error',
          invocationId: invocation.id,
          name: 'TypeError',
          message: `the hook's result is not plain data (${errorMessage(error)})`,
        })
      }
    } catch (error) {
      settleHandles(invocation, msg.event, undefined)
      post({
        type: 'mod.error',
        invocationId: invocation.id,
        name: error instanceof Error && error.name ? error.name : 'Error',
        message: errorMessage(error),
        ...(error !== undefined && error === invocation.lastRejection
          ? { passedNextRejection: true }
          : {}),
      })
    } finally {
      invocations.delete(invocation.id)
    }
  }

  // ── one run of one streaming hook ──

  const streamError = (invocation: Invocation, error: unknown): void => {
    post({
      type: 'mod.error',
      invocationId: invocation.id,
      name: error instanceof Error && error.name ? error.name : 'Error',
      message: errorMessage(error),
      ...(error !== undefined && error === invocation.lastRejection ? { passedNextRejection: true } : {}),
    })
  }

  /** The run is over: forget it, and fail any read of beneath it still waits
   *  on, so a generator parked there can unwind. */
  const endStream = (invocation: Invocation): void => {
    invocations.delete(invocation.id)
    for (const [nextId, step] of pendingSteps) {
      if (step.invocation !== invocation) continue
      pendingSteps.delete(nextId)
      step.reject(abortError('the hook was stopped'))
    }
  }

  /** Create the generator; run none of it. It is suspended — not its own
   *  time — until the first `mod.pull`. */
  const startStream = (invocation: Invocation, msg: ModInvokeMessage, fn: HookFunction): void => {
    invocation.budgetPer = msg.stream!.budgetPer
    invocations.set(invocation.id, invocation)
    beginWait(invocation)
    let gen: unknown
    try {
      gen = fn(makeDollar(invocation), deepFreeze(msg.e), makeStreamNext(invocation, msg))
    } catch (error) {
      endStream(invocation)
      streamError(invocation, error)
      return
    }
    if (!isAsyncIterator(gen)) {
      endStream(invocation)
      streamError(invocation, new TypeError(`the hook on ${msg.event} is not an async generator`))
      return
    }
    invocation.gen = gen
  }

  /** Resume the generator to its next `yield` or its end. */
  const pullStream = async (invocationId: string): Promise<void> => {
    const invocation = invocations.get(invocationId)
    const gen = invocation?.gen
    if (!invocation || !gen) return
    endWait(invocation)
    if (invocation.budgetPer === 'pull') {
      // "Per piece, anew at each pull."
      invocation.started = performance.now()
      invocation.waited = 0
    }
    let step: IteratorResult<unknown, unknown>
    try {
      step = await gen.next()
    } catch (error) {
      if (!invocations.has(invocationId)) return
      endStream(invocation)
      streamError(invocation, error)
      return
    }
    if (!invocations.has(invocationId)) return
    if (step.done) {
      endStream(invocation)
      try {
        post({ type: 'mod.result', invocationId, result: step.value })
      } catch (error) {
        streamError(invocation, new TypeError(`the hook's result is not plain data (${errorMessage(error)})`))
      }
      return
    }
    try {
      post({ type: 'mod.chunk', invocationId, chunk: step.value })
    } catch (error) {
      endStream(invocation)
      void gen.return(undefined).catch(() => undefined)
      streamError(invocation, new TypeError(`a chunk the hook yielded is not plain data (${errorMessage(error)})`))
      return
    }
    // Suspended at its `yield`: not its own time.
    beginWait(invocation)
  }

  peer.onmessage = (event: MessageEvent) => {
    const msg = event.data as ModToWorker | null
    if (!msg) return
    if (msg.type === 'mod.load') {
      void load(msg)
      return
    }
    if (msg.generation !== generation) return
    switch (msg.type) {
      case 'mod.invoke':
        void invoke(msg)
        return
      case 'mod.nextResult': {
        const pending = pendingNext.get(msg.nextId)
        if (!pending) return
        pendingNext.delete(msg.nextId)
        pending.invocation.trace = deepFreeze(msg.trace ?? [])
        if (msg.ok) {
          pending.resolve(msg.result)
        } else {
          const error = toError(msg.error, 'next() rejected')
          pending.invocation.lastRejection = error
          pending.reject(error)
        }
        return
      }
      case 'mod.callResult': {
        const pending = pendingCalls.get(msg.callId)
        if (!pending) return
        pendingCalls.delete(msg.callId)
        if (msg.ok) pending.resolve(msg.value)
        else pending.reject(toError(msg.error, '$ call failed'))
        return
      }
      case 'mod.callStep': {
        const pending = pendingCallSteps.get(msg.callId)
        if (!pending) return
        pendingCallSteps.delete(msg.callId)
        if (msg.ok) pending.resolve({ done: msg.done === true, value: msg.value })
        else pending.reject(toError(msg.error, 'the stream rejected'))
        return
      }
      case 'mod.pull':
        void pullStream(msg.invocationId)
        return
      case 'mod.streamStep': {
        const pending = pendingSteps.get(msg.nextId)
        if (!pending) return
        pendingSteps.delete(msg.nextId)
        pending.invocation.trace = deepFreeze(msg.trace ?? [])
        if (msg.ok) {
          pending.resolve({ done: msg.done === true, value: msg.value })
        } else {
          const error = toError(msg.error, 'the stream beneath rejected')
          pending.invocation.lastRejection = error
          pending.reject(error)
        }
        return
      }
      case 'mod.abort': {
        const invocation = invocations.get(msg.invocationId)
        if (!invocation) return
        invocation.controller.abort()
        if (invocation.gen) {
          // The chain has gone on without it: the generator is returned (its
          // `finally` runs) once whatever it awaits lets go.
          const gen = invocation.gen
          endStream(invocation)
          void gen.return(undefined).catch(() => undefined)
        }
        return
      }
      case 'mod.runHandle':
        void runHandle(msg)
        return
      case 'mod.dropHandles':
        for (const handle of msg.handles) handles.delete(handle)
        return
      case 'mod.serve':
        void serve(msg)
        return
    }
  }
  peer.start?.()
}
