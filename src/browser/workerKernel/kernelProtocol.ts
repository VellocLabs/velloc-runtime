/**
 * Contract: the isolated-worker kernel's wire vocabulary across three realms (F-21).
 *
 *   SharedWorker (IsolatedWorkerKernel) ──control MessageChannel──▶ window (WindowWorkerHost)
 *   window (WindowWorkerHost)           ──new Worker + [peer]────▶ DedicatedWorker
 *   SharedWorker (IsolatedWorkerKernel) ◀──data MessageChannel───▶ DedicatedWorker
 *
 * The window owns spawn / terminate; init, nested calls, logs and the result run
 * on the data channel. A profile picks the `kind`, its `init` and its nouns
 * (`runjs`: `runJs/runJsProtocol.ts`). Types only: no runtime imports. Both ends
 * come from one build and C++ never reads these, so no `NEXUS_INTERFACE_VERSION`
 * bump.
 */

/** One captured log line from the worker's code. */
export type KernelLogLine = {
  /** 'log' | 'info' | 'warn' | 'error' | 'debug'. */
  level: string
  text: string
}

// ── Control channel: SharedWorker (kernel) ⇄ window (WindowWorkerHost) ──

/** Kernel → window: spawn a fresh DedicatedWorker of `kind` under `key`. The
 *  worker's end of the data channel rides the transfer list (`[peer]`), read
 *  window-side from `event.ports[0]`. `init` is the profile's own payload; it
 *  travels by structured clone the whole way (kernel → window → worker) and is
 *  never parsed as source. */
export type WorkerSpawnMessage = {
  type: 'worker.spawn'
  /** Identifies this worker for the rest of its life: `<kind>-<seq>-<time>`. */
  key: string
  /** Which of the window host's spawners builds the worker. */
  kind: string
  init: unknown
  /** What the worker is called after its kind (`nexus-mod: <name>`) — the
   *  name DevTools lists it by. A label only; nothing reads it back. */
  name?: string
}

/** Kernel → window: terminate the worker under `key` (done, timeout, or
 *  abort). Idempotent window-side (an unknown key is a no-op). */
export type WorkerTerminateMessage = {
  type: 'worker.terminate'
  key: string
}

/** Window → kernel: the worker was spawned and handed its data port. Clears
 *  the kernel's spawn-ack deadline — its absence is how a dead control port
 *  (window closed or reloading; MessagePort death is unobservable) fails a run
 *  in seconds instead of eating the full execution timeout. */
export type WorkerSpawnedMessage = {
  type: 'worker.spawned'
  key: string
}

/** Window → kernel: the worker could not be spawned, crashed, or its module
 *  failed to load (`worker.onerror`) — fail the pending run fast instead of
 *  waiting out the timeout. */
export type WorkerErrorMessage = {
  type: 'worker.error'
  key: string
  message: string
}

/** Window → kernel: this window is going away (`pagehide`, not into the
 *  back/forward cache) — a reload or a close. Its frames, and every worker
 *  they spawned, go with it. MessagePort death is unobservable, so without
 *  this a long-lived worker on a dead window is never reported gone. */
export type WindowLeavingMessage = {
  type: 'window.leaving'
}

// ── Sound: kernel → the newest window, which plays it (`$.audio`, F-25) ──

/** What a window plays: a URL its media element loads, or the bytes. */
export type WindowAudioSource = { url: string } | { base64: string; mime: string }

/** Kernel → window: play `source` now, beside whatever is playing. */
export type WindowAudioPlayMessage = {
  type: 'audio.play'
  id: string
  source: WindowAudioSource
  loop: boolean
  /** Linear, 0 to 4. */
  gain: number
}

/** Kernel → window: speak `text` after the utterances queued before it. */
export type WindowAudioSpeakMessage = {
  type: 'audio.speak'
  id: string
  text: string
  /** The voice's exact name; absent, the synthesizer's default. */
  voice?: string
}

/** Kernel → window: stop the clip or utterance `id` (playing or queued).
 *  An unknown id is a no-op. */
export type WindowAudioStopMessage = {
  type: 'audio.stop'
  id: string
}

/** Window → kernel: `id` is over — it ended, was stopped, or `error` names
 *  why it could not play. */
export type WindowAudioEndedMessage = {
  type: 'audio.ended'
  id: string
  error?: { name: string; message: string }
}

export type WindowAudioToWindow = WindowAudioPlayMessage | WindowAudioSpeakMessage | WindowAudioStopMessage

export type WorkerControlToWindow = WorkerSpawnMessage | WorkerTerminateMessage | WindowAudioToWindow
export type WorkerControlToKernel =
  | WorkerSpawnedMessage
  | WorkerErrorMessage
  | WindowLeavingMessage
  | WindowAudioEndedMessage

// ── Worker init: window (WindowWorkerHost) → DedicatedWorker ──

/** Window → worker: the profile's `init`, forwarded verbatim (one more
 *  structured clone). The data-channel port (`peer`) rides the transfer list,
 *  read worker-side from `event.ports[0]`. */
export type WorkerInitMessage = {
  type: 'worker.init'
  init: unknown
}

// ── Data channel: SharedWorker (kernel) ⇄ DedicatedWorker (peer) ──

/** Worker → kernel: the worker's code is about to run. Everything before it —
 *  worker creation, module load, realm hardening, a profile's own probes — is
 *  STARTUP, and startup is not the code's to pay for. The kernel arms the
 *  execution clock on this message, so `timeoutMs` measures the code and
 *  nothing else. */
export type KernelStartedMessage = {
  type: 'k.started'
}

/** Worker → kernel: one nested call. `noun` names the capability and must be
 *  in the run's own table (`KernelRunOptions.nouns`) — a noun the profile did
 *  not grant is refused `NotSupportedError`, which is what keeps a worker's
 *  reach closed by construction. `op` and `payload` are the noun's own. */
export type KernelCallMessage = {
  type: 'k.call'
  callId: string
  noun: string
  op: string
  payload: Record<string, unknown>
}

/** Kernel → worker: the result of a nested call. On `ok:false`, `error.name`
 *  is carried across so the worker can rethrow an error of the shape its
 *  caller expects (a DOMException name for a filesystem noun, say). */
export type KernelCallResultMessage = {
  type: 'k.callResult'
  callId: string
  ok: boolean
  data?: unknown
  error?: { name: string; message: string }
}

/** Worker → kernel: a captured log line. Streamed as the ONLY log channel —
 *  the kernel accumulates these (port delivery is in-order, so every line
 *  precedes `k.done` / `k.error`), which is what lets the timeout, interrupt
 *  and crash paths still surface the output produced so far. */
export type KernelLogMessage = {
  type: 'k.log'
  level: string
  text: string
}

/** Worker → kernel: the code finished. `result` is its serialized return value
 *  (null when it returned nothing serializable). Logs are NOT repeated here —
 *  the kernel already holds the streamed `k.log` lines. */
export type KernelDoneMessage = {
  type: 'k.done'
  result: string | null
}

/** Worker → kernel: the code threw. Logs: see `KernelDoneMessage`. `name`,
 *  `parseFailed`, `line` and `column` are optional detail a profile may attach
 *  (the `runjs` profile does — see `runJsWorkerCore.ts`): the error's
 *  constructor name, whether the code never PARSED, and code-relative
 *  coordinates of the failing frame. */
export type KernelErrorMessage = {
  type: 'k.error'
  message: string
  name?: string
  parseFailed?: boolean
  stack?: string
  line?: number
  column?: number
}

export type KernelDataToKernel =
  | KernelStartedMessage
  | KernelCallMessage
  | KernelLogMessage
  | KernelDoneMessage
  | KernelErrorMessage

export type KernelDataToWorker = KernelCallResultMessage
