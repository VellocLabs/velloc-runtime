/**
 * Contract: the isolated-worker kernel, SharedWorker side (F-21). The SharedWorker
 * cannot `new Worker()`, so per run the kernel makes a data `MessageChannel`, asks
 * a window over the control channel to spawn a DedicatedWorker of the profile's
 * `kind` with the far end and the profile's `init`, then talks to the worker
 * directly: `k.call` → the run's noun table → `k.callResult`, `k.log`,
 * `k.done` / `k.error`; on completion, timeout or abort it has the window
 * `terminate()` it. The window never sits on the data path.
 * `runOnce` runs code to completion and owns the spawn-ack and startup deadlines,
 * the execution clock that pauses during nested calls, the log budget, the drain
 * of in-flight calls before settling, abort and teardown. `openInstance` only
 * brokers a long-lived worker (a mod) and hands over its data port.
 * Control ports form a pool, one per guest window (`workerHost.attachControlPort`):
 *   - spawns go through the newest live port;
 *   - a port leaves on `window.leaving` or its `close` event, and its workers
 *     settle `crashed`;
 *   - a port that misses a spawn ack is demoted to oldest, and `openInstance`
 *     tries the next; a failed `postMessage` is not taken as death.
 * `whenKernelControlPortAttached` waits for a port, bounded by the owner's signal.
 */

import type {
  KernelDataToKernel,
  KernelLogLine,
  WindowAudioEndedMessage,
  WorkerControlToKernel,
} from './kernelProtocol'
import { PausableDeadline } from './pausableDeadline'

/** Serves one noun of a run: `op` and `payload` are the noun's own. A
 *  rejection's `name` and `message` are carried back to the worker. */
export type KernelNounHandler = (
  op: string,
  payload: Record<string, unknown>,
) => Promise<unknown>

export type KernelLogBudget = {
  /** Cap on the console lines a run RETAINS. */
  lines: number
  /** Companion budget: UTF-16 code units of retained text. */
  chars: number
}

export type KernelRunOptions = {
  /** Which of the window host's spawners builds the worker. */
  kind: string
  /** The profile's payload for the worker — structured-cloned the whole way. */
  init: unknown
  /** Cap on the worker code's OWN execution; on expiry the worker is
   *  terminated and the run rejects with a timeout error. It starts when the
   *  code starts (`k.started`), not when the run is requested, and pauses for
   *  every nested call — startup is covered by its own deadlines
   *  (KERNEL_STARTUP_TIMEOUT_MS), and whatever a nested call waits on (a
   *  permission prompt, a long command) is never the code's to pay for. */
  timeoutMs: number
  /** Cancels the run (worker terminated) when the owner is interrupted. */
  signal?: AbortSignal
  /**
   * The run's CLOSED capability table: the nouns its worker may call, and who
   * serves each. A noun that is absent — or present but `undefined` — is
   * refused `NotSupportedError` before anything runs, so a worker can reach
   * exactly what its profile granted and nothing else.
   */
  nouns: Readonly<Record<string, KernelNounHandler | undefined>>
  /** The message a refused noun is answered with. */
  unavailable?: (noun: string) => string
  onLog?: (line: KernelLogLine) => void
  /** How the run names itself in every message a person or a model reads
   *  (`run_js timed out after …`). */
  label: string
  /** What the nested calls are, for the "still in flight" warning
   *  (`workspace / bash`). */
  nestedCallLabel?: string
  logBudget?: KernelLogBudget
}

export type KernelRunResult = {
  /** The worker code's serialized return value, or null. */
  result: string | null
  logs: KernelLogLine[]
}

/**
 * A run's rejection that still carries the log lines the worker streamed
 * before it failed (a throw, a timeout, a worker crash, an interrupt), so the
 * caller can show how far the code got. A throw may also carry `location`:
 * code-relative line/column already adjusted worker-side.
 */
export class KernelRunFailure extends Error {
  readonly logs: KernelLogLine[]
  readonly location?: { line: number; column: number }
  /** The worker error's own name (`SyntaxError`, `TypeError`, …). Deliberately
   *  NOT `name` — this class sets that. Absent when the failure is not a throw
   *  at all (timeout, worker crash, transport death). */
  readonly errorName?: string
  /** The code never PARSED — as opposed to an error it threw while running. */
  readonly parseFailed: boolean
  /** The worker-side stack, when the worker sent one. */
  readonly remoteStack?: string
  constructor(
    message: string,
    logs: KernelLogLine[],
    detail: {
      remoteStack?: string
      location?: { line: number; column: number }
      errorName?: string
      parseFailed?: boolean
    } = {},
  ) {
    super(message)
    this.name = 'KernelRunFailure'
    if (detail.remoteStack) this.stack = detail.remoteStack
    this.logs = logs
    this.remoteStack = detail.remoteStack
    this.location = detail.location
    this.errorName = detail.errorName
    this.parseFailed = detail.parseFailed === true
  }
}

/** How long a spawn may go unacknowledged before the run fails fast. A dead
 *  control port (window closed or reloading) is unobservable — without the ack
 *  a run would hang on a worker that will never exist. Armed on every run: the
 *  execution clock does not cover this phase (see KERNEL_STARTUP_TIMEOUT_MS). */
export const KERNEL_SPAWN_ACK_TIMEOUT_MS = 5_000

/** How long the whole STARTUP phase may take — arm to `k.started`, i.e. worker
 *  creation, module load, realm hardening and a profile's own probes. It is
 *  the backstop for a worker that is acknowledged but never begins running (a
 *  module that hangs on load). Generous on purpose: a machine under a full e2e
 *  run can take seconds to spawn a worker, and paying that out of a short
 *  execution timeout is exactly the bug this deadline replaced. */
export const KERNEL_STARTUP_TIMEOUT_MS = 30_000

/** Default cap on the console lines a run RETAINS — code that logs in a tight
 *  loop must not grow the runtime's memory without bound. Past either budget
 *  further lines are dropped and ONE `… N more lines dropped` marker is
 *  appended when the run settles. */
export const KERNEL_DEFAULT_LOG_BUDGET: KernelLogBudget = {
  lines: 2_000,
  chars: 512 * 1024,
}

let controlPort: MessagePort | null = null
/** Every window's control port still attached, oldest first. The newest is
 *  `controlPort`; when it leaves, the one before it takes over. */
const attachedPorts: MessagePort[] = []
/** Owners waiting for a window to attach (`whenKernelControlPortAttached`). */
const attachWaiters = new Set<() => void>()
/** The `close` listener each pooled port carries, to take it off again. */
const closeListeners = new Map<MessagePort, () => void>()

/** A service beside the spawner on the same pool (`$.audio`'s player): it
 *  hears its windows' answers and each window leaving. */
export type KernelWindowListener = {
  audioEnded?(port: MessagePort, message: WindowAudioEndedMessage): void
  left?(port: MessagePort): void
}
const windowListeners = new Set<KernelWindowListener>()

/** Listen beside the spawner; returns the unsubscribe. */
export function addKernelWindowListener(listener: KernelWindowListener): () => void {
  windowListeners.add(listener)
  return () => {
    windowListeners.delete(listener)
  }
}

/** Every attached window's port, the one new work goes to first. */
export function kernelControlPortsNewestFirst(): MessagePort[] {
  return [...attachedPorts].reverse()
}
let runSeq = 0

/** Per-run control-channel hooks: `workerError` fast-fails the run, `spawned`
 *  clears its spawn-ack deadline. `port` is the window it was spawned through. */
const controlHandlers = new Map<
  string,
  { port: MessagePort; workerError: (message: string) => void; spawned: () => void }
>()

/** Attach the control channel to the window (called from PortMessageRouter on
 *  `workerHost.attachControlPort`). A later attach (another window, or a
 *  reload re-running boot) becomes the port new workers are spawned through;
 *  the earlier one stays attached until its window leaves. */
export function setKernelControlPort(port: MessagePort): void {
  const at = attachedPorts.indexOf(port)
  if (at !== -1) attachedPorts.splice(at, 1)
  attachedPorts.push(port)
  controlPort = port
  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as WorkerControlToKernel | null
    if (!msg) return
    if (msg.type === 'worker.error') {
      controlHandlers.get(msg.key)?.workerError(msg.message)
    } else if (msg.type === 'worker.spawned') {
      controlHandlers.get(msg.key)?.spawned()
    } else if (msg.type === 'window.leaving') {
      windowLeft(port)
    } else if (msg.type === 'audio.ended') {
      for (const listener of [...windowListeners]) listener.audioEnded?.(port, msg)
    }
  }
  port.start()
  // The port's own death: Chromium fires `close` on a MessagePort once its
  // entangled end is gone — the window's realm closed or crashed, which no
  // `pagehide` reports. (A test's fake port may have no event target.)
  if (!closeListeners.has(port) && typeof port.addEventListener === 'function') {
    const onClose = (): void => windowLeft(port)
    closeListeners.set(port, onClose)
    port.addEventListener('close', onClose)
  }
  for (const wake of [...attachWaiters]) wake()
}

/** A window is going away, and with it every worker its frames spawned: each
 *  run or instance spawned through it fails as a crashed worker would (a
 *  long-lived one's `closed` settles `crashed`, so its owner restarts it), and
 *  new spawns go through the window attached before it, if any. */
function windowLeft(port: MessagePort): void {
  const at = attachedPorts.indexOf(port)
  if (at !== -1) attachedPorts.splice(at, 1)
  if (controlPort === port) controlPort = attachedPorts.at(-1) ?? null
  port.onmessage = null
  const onClose = closeListeners.get(port)
  if (onClose) {
    closeListeners.delete(port)
    port.removeEventListener('close', onClose)
  }
  for (const handler of [...controlHandlers.values()]) {
    if (handler.port === port) handler.workerError('the window that hosted it went away')
  }
  for (const listener of [...windowListeners]) listener.left?.(port)
}

/** A window did not acknowledge a spawn in time: it may be dead (nothing told
 *  us) or only slow. It keeps its place in the pool but goes to the back, so
 *  the next spawn tries every other window first. */
function demotePort(port: MessagePort): void {
  const at = attachedPorts.indexOf(port)
  if (at === -1 || attachedPorts.length < 2) return
  attachedPorts.splice(at, 1)
  attachedPorts.unshift(port)
  controlPort = attachedPorts.at(-1) ?? null
}

export function isKernelAvailable(): boolean {
  return controlPort !== null
}

/** How many windows' control ports are in the pool now. */
export function kernelControlPortCount(): number {
  return attachedPorts.length
}

/**
 * Resolves once some window's control port is in the pool — at once when one
 * already is. Rejects `AbortError` when `signal` aborts first: the owner
 * bounds the wait (a provider mod fails closed when no window comes).
 */
export function whenKernelControlPortAttached(signal?: AbortSignal): Promise<void> {
  if (controlPort) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const wake = (): void => {
      attachWaiters.delete(wake)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      attachWaiters.delete(wake)
      const error = new Error('the wait for a window was abandoned')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    attachWaiters.add(wake)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Test seam: reset module state between unit tests. */
export function resetKernelForTests(): void {
  for (const [port, onClose] of closeListeners) port.removeEventListener('close', onClose)
  closeListeners.clear()
  controlPort = null
  attachedPorts.length = 0
  attachWaiters.clear()
  runSeq = 0
  controlHandlers.clear()
}

/**
 * Run one worker to completion. Resolves with the worker code's serialized
 * result + retained logs, or rejects (a throw, a timeout, an abort, a worker
 * crash). Always tears the worker down.
 */
export async function runOnce(opts: KernelRunOptions): Promise<KernelRunResult> {
  const port = controlPort
  const { label } = opts
  if (!port) {
    throw new Error(
      `${label} is unavailable: no execution worker is attached to this session.`,
    )
  }
  if (opts.signal?.aborted) {
    throw new Error(`${label} aborted before it started.`)
  }

  const key = `${opts.kind}-${++runSeq}-${Date.now()}`
  const budget = opts.logBudget ?? KERNEL_DEFAULT_LOG_BUDGET
  const channel = new MessageChannel()
  const local = channel.port1 // SharedWorker end
  const remote = channel.port2 // handed to the worker

  return new Promise<KernelRunResult>((resolve, reject) => {
    let settled = false
    // The execution clock — see `PausableDeadline` and the comment at
    // `onTimeout` below. Armed by `markCodeStarted`, paused for every nested
    // call, stopped for good once the run settles or starts draining.
    const clock = new PausableDeadline(() => onTimeout())
    let spawnAckTimer: ReturnType<typeof setTimeout> | null = null
    let startupTimer: ReturnType<typeof setTimeout> | null = null
    /** True once `k.started` (or any other worker traffic) proved the code is
     *  running — the point the execution clock starts. */
    let codeStarted = false
    /** Log lines streamed by the worker so far — the single log source for
     *  BOTH the success result and every failure path. */
    const seenLogs: KernelLogLine[] = []
    /** Retained-log accounting against the budget. */
    let seenLogChars = 0
    let droppedLogLines = 0
    const recordLog = (line: KernelLogLine): void => {
      if (
        seenLogs.length >= budget.lines ||
        seenLogChars + line.text.length > budget.chars
      ) {
        droppedLogLines += 1
        return
      }
      seenLogs.push(line)
      seenLogChars += line.text.length
      opts.onLog?.(line)
    }
    /**
     * Nested handlers still in flight. `k.done` arrives when the code returns,
     * possibly before an un-awaited call has landed, so `k.done` / `k.error`
     * drain this set first and the run settles only after every handler has.
     */
    const inflight = new Set<Promise<void>>()
    /** Set while `k.done` / `k.error` is waiting on `inflight` to empty. */
    let drainSettle: (() => void) | null = null
    const track = (work: Promise<unknown>): void => {
      const entry: Promise<void> = work.then(
        () => undefined,
        () => undefined,
      )
      inflight.add(entry)
      void entry.then(() => {
        inflight.delete(entry)
        if (inflight.size === 0 && drainSettle) {
          const settle = drainSettle
          drainSettle = null
          settle()
        }
      })
    }
    /** Settle the run once no nested handler is outstanding (immediately when
     *  none is). A later timeout / abort / crash still wins via `finish`'s
     *  guard. */
    const settleAfterDrain = (fn: () => void): void => {
      if (settled || drainSettle) return
      if (inflight.size === 0) {
        finish(fn)
        return
      }
      const outstanding = inflight.size
      const what = opts.nestedCallLabel ? ` (${opts.nestedCallLabel})` : ''
      // The code has returned: there is no execution left to time. The run is
      // only waiting on the last handlers to land, so their resumes must not
      // re-arm the clock.
      clock.stop()
      drainSettle = () => {
        recordLog({
          level: 'warn',
          text: `${label}: ${outstanding} nested call(s)${what} were still in flight when the script returned (missing await?) — waited for them to complete.`,
        })
        finish(fn)
      }
    }

    const clearSpawnAck = (): void => {
      if (spawnAckTimer) {
        clearTimeout(spawnAckTimer)
        spawnAckTimer = null
      }
    }

    const clearStartup = (): void => {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
    }

    const cleanup = (): void => {
      clock.stop()
      clearSpawnAck()
      clearStartup()
      controlHandlers.delete(key)
      opts.signal?.removeEventListener('abort', onAbort)
      try {
        local.onmessage = null
        local.close()
      } catch {
        /* already closed */
      }
      // Tell the window to tear the worker down (idempotent window-side).
      try {
        port.postMessage({ type: 'worker.terminate', key })
      } catch {
        /* control channel gone — nothing to reclaim */
      }
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      if (droppedLogLines > 0) {
        // Appended ONCE, at settle, so the count is final. Bypasses the budget
        // check on purpose — it is the one line that explains the gap.
        const marker = {
          level: 'warn',
          text: `… ${droppedLogLines} more line${droppedLogLines === 1 ? '' : 's'} dropped (${label} log budget: ${budget.lines} lines / ${budget.chars} chars)`,
        }
        seenLogs.push(marker)
        opts.onLog?.(marker)
      }
      fn()
    }

    const fail = (
      message: string,
      detail?: ConstructorParameters<typeof KernelRunFailure>[2],
    ): void => {
      reject(new KernelRunFailure(message, seenLogs, detail))
    }

    const onAbort = (): void => {
      finish(() => fail(`${label} was interrupted.`))
    }

    // The execution timeout bounds the worker code's OWN JavaScript, not the
    // time it spends BLOCKED on a nested call — those are serviced in the
    // trusted runtime, and one can legitimately wait on a PERMISSION PROMPT
    // the user has not answered yet. So the clock PAUSES for the duration of
    // every nested call and RESUMES when the last one settles; otherwise a 30s
    // timeout would terminate the worker mid-prompt. Depth-counted so
    // concurrent nested calls (Promise.all) pause once and resume only when
    // all have returned.
    const onTimeout = (): void => {
      finish(() => fail(`${label} timed out after ${opts.timeoutMs}ms.`))
    }
    /** Startup is over — stop the startup deadline and start the EXECUTION
     *  clock. Idempotent, and a no-op once anything has settled. Driven by
     *  `k.started`, but any worker traffic proves the same thing, so the clock
     *  still arms if that message is ever lost. */
    const markCodeStarted = (): void => {
      if (codeStarted || settled) return
      codeStarted = true
      clearStartup()
      // A nested call cannot precede the code, but if one somehow is in flight
      // the clock belongs paused — its resume arms it on the way out.
      clock.start(opts.timeoutMs)
    }

    local.onmessage = (event: MessageEvent) => {
      const msg = event.data as KernelDataToKernel | null
      if (!msg) return
      // Any data-channel traffic proves the worker is alive, even if the
      // control-channel ack was lost (e.g. the window died right after the
      // spawn handoff) — don't fast-fail a run that is actually running. It
      // also proves the code is past startup, so the execution clock starts.
      clearSpawnAck()
      markCodeStarted()
      switch (msg.type) {
        case 'k.started':
          // The clock is already armed by markCodeStarted above; nothing else
          // to do — the message exists to arm it BEFORE the code's first log
          // or nested call, so purely computational code is timed.
          return
        case 'k.call': {
          const { callId, noun } = msg
          // Own properties only: `nouns` is a profile-built table, and a worker
          // naming `constructor` or `__proto__` must reach nothing.
          const handler = Object.prototype.hasOwnProperty.call(opts.nouns, noun)
            ? opts.nouns[noun]
            : undefined
          if (!handler) {
            local.postMessage({
              type: 'k.callResult',
              callId,
              ok: false,
              error: {
                name: 'NotSupportedError',
                message:
                  opts.unavailable?.(noun) ??
                  `${noun} is not available in this run.`,
              },
            })
            return
          }
          track(
            clock.whilePaused(() => handler(msg.op, msg.payload))
              .then(data =>
                local.postMessage({
                  type: 'k.callResult',
                  callId,
                  ok: true,
                  data,
                }),
              )
              .catch(err =>
                local.postMessage({
                  type: 'k.callResult',
                  callId,
                  ok: false,
                  // Carry the handler's error NAME across: a filesystem noun's
                  // are DOMException names (NotFoundError / NotAllowedError /
                  // …) its facade rethrows as a platform-shaped exception.
                  error: {
                    name: err instanceof Error && err.name ? err.name : 'Error',
                    message: err instanceof Error ? err.message : String(err),
                  },
                }),
              ),
          )
          return
        }
        case 'k.log': {
          recordLog({ level: msg.level, text: msg.text })
          return
        }
        case 'k.done': {
          settleAfterDrain(() => resolve({ result: msg.result, logs: seenLogs }))
          return
        }
        case 'k.error': {
          settleAfterDrain(() =>
            fail(msg.message, {
              remoteStack: msg.stack,
              location:
                typeof msg.line === 'number'
                  ? { line: msg.line, column: msg.column ?? 1 }
                  : undefined,
              errorName: msg.name,
              parseFailed: msg.parseFailed === true,
            }),
          )
          return
        }
      }
    }
    local.start()

    controlHandlers.set(key, {
      port,
      workerError: message => {
        finish(() => fail(`${label} worker error: ${message}`))
      },
      spawned: clearSpawnAck,
    })

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort)
    }
    // The execution clock is NOT armed here — startup is not the code's to pay
    // for, so it starts on `k.started` (markCodeStarted). Two deadlines cover
    // the phase instead: the window must acknowledge the spawn, and the worker
    // must actually begin running.
    startupTimer = setTimeout(() => {
      finish(() =>
        fail(
          `${label} could not start: the execution worker did not begin running within ${KERNEL_STARTUP_TIMEOUT_MS}ms.`,
        ),
      )
    }, KERNEL_STARTUP_TIMEOUT_MS)
    spawnAckTimer = setTimeout(() => {
      finish(() =>
        fail(
          `${label} could not start: the execution window did not respond within ${KERNEL_SPAWN_ACK_TIMEOUT_MS}ms (the app UI may be closed or reloading).`,
        ),
      )
    }, KERNEL_SPAWN_ACK_TIMEOUT_MS)

    // Ask the window to spawn the worker, handing it the far end of the pipe.
    try {
      port.postMessage(
        { type: 'worker.spawn', key, kind: opts.kind, init: opts.init },
        [remote],
      )
    } catch (err) {
      finish(() =>
        fail(
          `${label} failed to reach its execution worker: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      )
    }
  })
}

// ── a worker that lives ──

export type KernelInstanceOptions = {
  /** Which of the window host's spawners builds the worker. */
  kind: string
  /** The profile's payload for the worker — structured-cloned the whole way. */
  init: unknown
  /** How the instance names itself in the messages a person reads. */
  label: string
  /** What DevTools lists the worker as, after its kind — a mod's plugin. */
  name?: string
  /**
   * How long the spawn may go unacknowledged. Default
   * `KERNEL_SPAWN_ACK_TIMEOUT_MS`, which suits a spawn made in the middle of
   * a session. A spawn made while the session BOOTS can sit queued on the
   * control port until the sandboxed spawner frame has committed
   * (`SANDBOX_READY_TIMEOUT_MS`), so a profile that spawns at boot allows for
   * that.
   */
  spawnAckTimeoutMs?: number
}

/** Why an instance's worker is no longer there. */
export type KernelInstanceClosed = {
  /** `closed`: the owner called `close()`. `crashed`: the window reported the
   *  worker gone (a crash, a module that failed to load, a spawner that
   *  threw). */
  reason: 'closed' | 'crashed'
  message?: string
}

export type KernelInstance = {
  /** Names the worker for the rest of its life: `<kind>-<seq>-<time>`. */
  readonly key: string
  /** The runtime's end of the data channel. The profile's own protocol runs
   *  on it; the kernel neither reads nor writes it. */
  readonly port: MessagePort
  /** Settles once, when the worker is gone — whoever's doing that was. */
  readonly closed: Promise<KernelInstanceClosed>
  /** Terminate the worker and close the port. Idempotent. */
  close(): void
}

/**
 * Contract: spawn a worker that stays. Resolves once a window acknowledges the
 * spawn (the same 5 s deadline as `runOnce`), rejects if it reports the worker
 * could not be created. A window that misses the ack, or leaves mid-spawn, is
 * passed over for the next live one; a reported worker error or an unsendable
 * spawn is final. No execution clock, log budget or noun table: a long-lived
 * profile meters its own work and speaks its own protocol on `port`.
 */
export async function openInstance(opts: KernelInstanceOptions): Promise<KernelInstance> {
  const { label } = opts
  if (!controlPort) {
    throw new Error(
      `${label} is unavailable: no execution worker is attached to this session.`,
    )
  }
  const tried = new Set<MessagePort>()
  let lastError: Error | undefined
  for (;;) {
    // Newest first, each window once.
    const control = [...attachedPorts].reverse().find(port => !tried.has(port))
    if (!control) {
      throw (
        lastError ??
        new Error(`${label} is unavailable: no execution worker is attached to this session.`)
      )
    }
    tried.add(control)
    const attempt = await openThrough(control, opts)
    if (attempt.ok) return attempt.instance
    lastError = attempt.error
    if (!attempt.tryAnother) throw attempt.error
  }
}

type OpenAttempt =
  | { ok: true; instance: KernelInstance }
  | { ok: false; error: Error; tryAnother: boolean }

/** One spawn through one window's control port. */
async function openThrough(control: MessagePort, opts: KernelInstanceOptions): Promise<OpenAttempt> {
  const { label } = opts
  const key = `${opts.kind}-${++runSeq}-${Date.now()}`
  const channel = new MessageChannel()
  const local = channel.port1
  const remote = channel.port2
  const ackTimeoutMs = opts.spawnAckTimeoutMs ?? KERNEL_SPAWN_ACK_TIMEOUT_MS

  let state: 'opening' | 'open' | 'gone' = 'opening'
  let settleClosed!: (closed: KernelInstanceClosed) => void
  const closed = new Promise<KernelInstanceClosed>(resolve => {
    settleClosed = resolve
  })

  const teardown = (outcome: KernelInstanceClosed): void => {
    if (state === 'gone') return
    state = 'gone'
    controlHandlers.delete(key)
    try {
      local.close()
    } catch {
      /* already closed */
    }
    // Tell the window to tear the worker down (idempotent window-side).
    try {
      control.postMessage({ type: 'worker.terminate', key })
    } catch {
      /* control channel gone — nothing to reclaim */
    }
    settleClosed(outcome)
  }

  const failure = await new Promise<OpenAttempt | null>(resolve => {
    const ackTimer = setTimeout(() => {
      teardown({ reason: 'crashed', message: 'the spawn was never acknowledged' })
      demotePort(control)
      resolve({
        ok: false,
        tryAnother: true,
        error: new Error(
          `${label} could not start: the execution window did not respond within ${ackTimeoutMs}ms (the app UI may be closed or reloading).`,
        ),
      })
    }, ackTimeoutMs)
    controlHandlers.set(key, {
      port: control,
      spawned: () => {
        if (state !== 'opening') return
        clearTimeout(ackTimer)
        state = 'open'
        resolve(null)
      },
      workerError: message => {
        clearTimeout(ackTimer)
        const wasOpening = state === 'opening'
        teardown({ reason: 'crashed', message })
        if (wasOpening) {
          resolve({
            ok: false,
            // The window itself went away mid-spawn: another may still host it.
            tryAnother: !attachedPorts.includes(control),
            error: new Error(`${label} worker error: ${message}`),
          })
        }
      },
    })
    try {
      control.postMessage(
        {
          type: 'worker.spawn',
          key,
          kind: opts.kind,
          init: opts.init,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
        },
        [remote],
      )
    } catch (err) {
      clearTimeout(ackTimer)
      teardown({ reason: 'crashed', message: 'the spawn could not be sent' })
      resolve({
        ok: false,
        tryAnother: false,
        error: new Error(
          `${label} failed to reach its execution worker: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      })
    }
  })
  if (failure) return failure

  return {
    ok: true,
    instance: {
      key,
      port: local,
      closed,
      close: () => teardown({ reason: 'closed' }),
    },
  }
}
