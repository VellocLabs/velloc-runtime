/**
 * Contract: the frames between `ModInstance` (runtime) and `ModWorkerHost` (worker)
 * over the instance's own port: `mod.invoke`, `mod.next`, `mod.call`, `mod.result` /
 * `mod.error`, and pull-driven frames for streaming hooks and calls. Every frame
 * carries the instance's `generation`; a mismatched frame is dropped and counted.
 * Types, plus the nesting limit on what a hook hands back; not part of the C++
 * interface.
 */

import type {
  HookFailure,
  HookRegistration,
  Origin,
  PluginTier,
  StreamBudgetPer,
  TargetTier,
  TraceEntry,
} from './modTypes'

/** An error as it crosses the port: enough to rethrow one of the same name. */
export type WireError = { name: string; message: string }

// ── runtime → worker ──

/** Load the module and run its `register(on, options)`. Sent once, first. */
export type ModLoadMessage = {
  type: 'mod.load'
  generation: number
  plugin: string
  /** The plugin's directory (the one holding plugin.json), absolute —
   *  `$.plugin.root`. */
  root: string
  /** The window's language tag — `$.plugin.locale`. Absent from an older
   *  runtime: the worker then reads `en`. */
  locale?: string
  tier: PluginTier
  /** The hooks module: one self-contained ES module, as text. */
  source: string
  /** The values of the manifest's `userConfig` fields, fixed for this load. */
  options: unknown
}

/** Run one hook (or, with `catch`, its `.catch` handler) for one dispatch. */
export type ModInvokeMessage = {
  type: 'mod.invoke'
  generation: number
  invocationId: string
  hookId: string
  event: string
  e: unknown
  origin: Origin
  /** The own-time budget this run is metered under — what `next.budget.ms`
   *  reads. The runtime is the one that enforces it. */
  budgetMs: number
  catch?: { error: HookFailure; called: boolean }
  /** Set: the hook is a generator on a streaming event. The worker creates
   *  it and waits for `mod.pull`; `budgetPer` is what `next.budget` restarts
   *  on (`pull`: each piece anew). */
  stream?: { budgetPer: StreamBudgetPer }
}

/** Resume a streaming hook to its next `yield` (`mod.chunk`) or its end. */
export type ModPullMessage = {
  type: 'mod.pull'
  generation: number
  invocationId: string
}

/** One step of a stream beneath a streaming hook, for its `mod.streamPull`:
 *  a chunk, the end (`done`, `value` the result), or a rejection. */
export type ModStreamStepMessage = {
  type: 'mod.streamStep'
  generation: number
  invocationId: string
  nextId: string
  ok: boolean
  done?: boolean
  value?: unknown
  error?: WireError
  trace: TraceEntry[]
}

/** What a `mod.next` settled to, with the links beneath for `next.trace`. */
export type ModNextResultMessage = {
  type: 'mod.nextResult'
  generation: number
  invocationId: string
  nextId: string
  ok: boolean
  result?: unknown
  error?: WireError
  trace: TraceEntry[]
}

export type ModCallResultMessage = {
  type: 'mod.callResult'
  generation: number
  callId: string
  ok: boolean
  value?: unknown
  error?: WireError
}

/** One step of a `$` call that streams (`$.process.spawn`), for its
 *  `mod.callPull`: a piece, the end (`done`, `value` the result), or a
 *  rejection. */
export type ModCallStepMessage = {
  type: 'mod.callStep'
  generation: number
  callId: string
  ok: boolean
  done?: boolean
  value?: unknown
  error?: WireError
}

/** The dispatch was abandoned or the hook ran out of budget: `next.signal`
 *  aborts in the worker. The runtime has already gone on without it. */
export type ModAbortMessage = {
  type: 'mod.abort'
  generation: number
  invocationId: string
}

/**
 * Run one of the closures a render hook left behind a `press.handle`
 * a Button's `onPress`, an Input's `onInput` / `onSubmit`
 * (`which`), a Select's `onSelect`, a Markdown's `onLinkPress`. `args` are
 * the closure's arguments, as the chain left them.
 */
export type ModRunHandleMessage = {
  type: 'mod.runHandle'
  generation: number
  runId: string
  handle: number
  which?: string
  args: unknown[]
}

/** The drawing those handles belonged to is gone: the closures with it. */
export type ModDropHandlesMessage = {
  type: 'mod.dropHandles'
  generation: number
  handles: number[]
}

/**
 * Another plugin (or a timer of this one) called a noun THIS module's
 * `engine.create` step added to `$`: run its method, in the plugin's
 * own environment, with `args` as the chain left them. `caller` is the
 * plugin whose `$` call it is.
 */
export type ModServeMessage = {
  type: 'mod.serve'
  generation: number
  serveId: string
  noun: string
  method: string
  args: unknown[]
  caller: string
}

export type ModToWorker =
  | ModLoadMessage
  | ModInvokeMessage
  | ModPullMessage
  | ModStreamStepMessage
  | ModNextResultMessage
  | ModCallResultMessage
  | ModCallStepMessage
  | ModAbortMessage
  | ModRunHandleMessage
  | ModDropHandlesMessage
  | ModServeMessage

// ── worker → runtime ──

/** `register` returned: these are its hooks, in registration order. */
export type ModLoadedMessage = {
  type: 'mod.loaded'
  generation: number
  hooks: HookRegistration[]
}

/** The module did not load: it failed to evaluate, exported no `register`,
 *  `register` threw, or a registration was refused. */
export type ModLoadErrorMessage = {
  type: 'mod.loadError'
  generation: number
  message: string
}

/** The hook called `next(e)` — or `next.to(e, tier)` when `tier` is set. On a
 *  streaming hook it only OPENS the stream beneath: nothing beneath runs
 *  before its first `mod.streamPull`. */
export type ModNextMessage = {
  type: 'mod.next'
  generation: number
  invocationId: string
  nextId: string
  e: unknown
  tier?: TargetTier
}

/**
 * A `$` call the worker no longer waits for: a `$.clock.sleep` whose `signal`
 * aborted, a `$.clock.after` / `every` timer that was cancelled. The runtime
 * aborts what it was serving (the wait, the dispatch beneath); a `mod.callResult`
 * that still arrives for it is dropped by the worker.
 */
export type ModCancelCallMessage = {
  type: 'mod.cancelCall'
  generation: number
  callId: string
}

/** Something the worker wants said, outside any hook frame: a timer callback
 *  that threw. Lands in the runtime's report line, under the plugin's name. */
export type ModReportMessage = {
  type: 'mod.report'
  generation: number
  message: string
}

/** The hook called `$.<noun>.<method>(...args)`. `invocationId` names the hook
 *  frame it was made from — the recursion skip and the budget pause hang off
 *  it. Absent for a call made outside any hook (a timer). */
export type ModCallMessage = {
  type: 'mod.call'
  generation: number
  callId: string
  invocationId?: string
  noun: string
  method: string
  args: unknown[]
}

/** The hook called `$.<noun>.<method>(...args)` on a noun whose event
 *  streams (`$.process.spawn`) and read it for the first time: the runtime
 *  opens the stream and reads nothing. Each read is a `mod.callPull`;
 *  `mod.cancelCall` closes it. */
export type ModCallStreamMessage = {
  type: 'mod.callStream'
  generation: number
  callId: string
  invocationId?: string
  noun: string
  method: string
  args: unknown[]
}

/** Read the next step of the stream `mod.callStream` opened. */
export type ModCallPullMessage = {
  type: 'mod.callPull'
  generation: number
  callId: string
}

/** A streaming hook yielded `chunk`: the answer to the `mod.pull`. */
export type ModChunkMessage = {
  type: 'mod.chunk'
  generation: number
  invocationId: string
  chunk: unknown
}

/** A streaming hook reads the next piece of the stream `nextId` opened. */
export type ModStreamPullMessage = {
  type: 'mod.streamPull'
  generation: number
  invocationId: string
  nextId: string
}

/** A streaming hook left the stream `nextId` opened before its end (a
 *  `break`): what is beneath it is closed. */
export type ModStreamCloseMessage = {
  type: 'mod.streamClose'
  generation: number
  invocationId: string
  nextId: string
}

export type ModResultMessage = {
  type: 'mod.result'
  generation: number
  invocationId: string
  result: unknown
}

export type ModErrorMessage = {
  type: 'mod.error'
  generation: number
  invocationId: string
  name: string
  message: string
  /** The hook threw exactly what its last `next()` rejected with: it let the
   *  rejection pass, which is not a failure of the hook. The error object
   *  itself does not survive the port, so the worker says so. */
  passedNextRejection?: boolean
}

/** What became of a `mod.runHandle`: the closure ran, or it was not there
 *  or threw (`error`). */
export type ModHandleResultMessage = {
  type: 'mod.handleResult'
  generation: number
  runId: string
  ok: boolean
  error?: WireError
}

/** What a `mod.serve` came to: the method's value, or why not. */
export type ModServedMessage = {
  type: 'mod.served'
  generation: number
  serveId: string
  ok: boolean
  value?: unknown
  error?: WireError
}

export type ModToRuntime =
  | ModLoadedMessage
  | ModLoadErrorMessage
  | ModServedMessage
  | ModNextMessage
  | ModChunkMessage
  | ModStreamPullMessage
  | ModStreamCloseMessage
  | ModCallMessage
  | ModCallStreamMessage
  | ModCallPullMessage
  | ModCancelCallMessage
  | ModReportMessage
  | ModResultMessage
  | ModErrorMessage
  | ModHandleResultMessage

/** The noun a `$.script.run` method is served under in the worker that
 *  started the run (`mod.serve`). The `:` keeps it apart from every noun
 *  `engine.create` can add. */
export function scriptNounKey(token: string, noun: string): string {
  return `script:${token}:${noun}`
}

/** How deep a value a hook hands back (its result, a chunk, `next(e)`'s `e`, a
 *  `$` call's argument, a served noun's result) may nest; deeper is refused. */
export const MAX_HANDED_DEPTH = 28_000

/** Whether `value` holds containers nested more than `limit` deep (a container
 *  at the top is depth 1), walked in the order a structured clone writes it: a
 *  container met again is a back-reference, not deeper nesting. Iterative, so
 *  a deep value cannot overflow the stack; each container is walked once. */
export function nestsDeeperThan(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== 'object') return false
  const seen = new Set<object>()
  const stack: Array<[object, number]> = [[value, 1]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!
    if (seen.has(node)) continue
    if (depth > limit) return true
    seen.add(node)
    if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) continue
    const children =
      node instanceof Map ? [...node.keys(), ...node.values()] : node instanceof Set ? [...node] : Object.values(node)
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1])
    }
  }
  return false
}

/** Minimal duplex port shape — a real `MessagePort` satisfies it. */
export type ModPeer = {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
  start?(): void
  close?(): void
}
