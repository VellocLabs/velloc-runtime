/**
 * Contract: the stream of a request to a router provider (F-27). One stream
 * id for the reader, served by one target at a time: each target's request is
 * an ordinary driver stream (a leg), and this stream passes its chunks on.
 * When a leg fails the router is asked once for that failure. While no part
 * of a reply has reached the reader, a new target takes the stream over and
 * the reader sees no error. Once a reply has started, the leg's error chunk
 * goes on marked with the router's decision, and the caller's retry sends the
 * call again. Reads keep a leg's own semantics (held, queued, timeout).
 *
 * Security: the router only chooses. Every target was checked before it got
 * here, and each leg runs the target's own seam, credentials and pool.
 */
import type {
  BridgeModelRequestPayload,
  BridgeModelStreamChunk,
} from '../../browser/bridge/browserBridgeProtocol'
import { traceLine } from '../../utils/debugLog'
import { DriverChunkEmitter } from './chunkEmitter'
import type { ModelProvider } from './modelProvider'
import type { FailureEvent } from './providerClassify'
import type { RouteTarget } from './providerRouteAnswer'
import type { RouteErrorMark } from './providerRouter'

export type StreamReadResult = {
  chunks: BridgeModelStreamChunk[]
  done: boolean
  status: 'ok' | 'timeout' | 'done' | 'queued'
}

/** One target's request: what a driver stream is started with. */
export type RouteLeg = {
  target: RouteTarget
  provider: ModelProvider
  payload: BridgeModelRequestPayload
  model: string
}

export type RouteDecision =
  | { kind: 'switch'; leg: RouteLeg }
  | { kind: 'stop'; message?: string }
  | { kind: 'none' }

/** How a routed stream ended, for the router's own bookkeeping. */
export type RoutedEnding = {
  target?: RouteTarget
  ok: boolean
  failure?: FailureEvent
  usage?: { inputTokens: number; outputTokens: number }
  durationMs: number
}

/** The resolution step, as one call's stream uses it. */
export interface StreamRouting {
  /** The router's row, for the stream's first chunk. */
  readonly model: string
  /** The target of the call's next send. Rejects when the request cannot be
   *  sent; the rejection's text is the error the reader gets. */
  resolve(signal: AbortSignal): Promise<{ leg: RouteLeg } | { stop: { message?: string } }>
  /** What follows a failed send; `none` leaves the failure as it is. */
  after(failure: FailureEvent, streamStarted: boolean, signal: AbortSignal): Promise<RouteDecision>
  /** Told once, when the stream is over and no switch follows. */
  ended?(ending: RoutedEnding): void
}

/** What a leg asks before its own recovery of a refused response. */
export type LegRouteHook = {
  /** True when the router took the failure: the leg sends nothing again. */
  taken(failure: FailureEvent): Promise<boolean>
}

/** A driver stream, as a routed stream drives it. */
export interface LegStream {
  start(): void
  read(waitMs: number | undefined): Promise<StreamReadResult>
  cancel(): Promise<void>
  /** The error event the leg ended with. */
  failed(): FailureEvent | undefined
}

export type OpenLeg = (leg: RouteLeg, hook: LegRouteHook) => LegStream

const IDLE_TIMEOUT_TEXT = 'stream_idle_timeout: no chunks from the provider before the read ran out (stream cancelled upstream)'

function isReplyChunk(chunk: BridgeModelStreamChunk): boolean {
  return chunk.type !== 'message_start' && chunk.type !== 'error'
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export class RoutedStream {
  private current: { leg: RouteLeg; stream: LegStream } | undefined
  /** The stream's last chunks when no leg could run. */
  private ending: BridgeModelStreamChunk[] | undefined
  private opening: Promise<void> = Promise.resolve()
  private readonly abort = new AbortController()
  /** Part of a reply has reached the reader. */
  private started = false
  private asked: { failure: FailureEvent; decision: RouteDecision } | undefined
  private reported = false
  private usage: { inputTokens?: number; outputTokens?: number } = {}
  private readonly startedAt = Date.now()

  constructor(
    private readonly routing: StreamRouting,
    private readonly openLeg: OpenLeg,
    /** How long a read that names no wait holds for the first target. */
    private readonly unheldWaitMs: number,
  ) {}

  start(): void {
    this.opening = this.open()
  }

  private async open(): Promise<void> {
    try {
      const first = await this.routing.resolve(this.abort.signal)
      if (this.abort.signal.aborted) return this.endWith([])
      if ('stop' in first) {
        return this.endWith(this.closing(first.stop.message ?? 'the router ended the request', { stop: true }))
      }
      this.run(first.leg)
    } catch (error) {
      if (this.abort.signal.aborted) return this.endWith([])
      this.endWith(this.closing(error instanceof Error ? error.message : String(error), { stop: true }))
    }
  }

  private run(leg: RouteLeg): void {
    const stream = this.openLeg(leg, {
      taken: async failure => (await this.decide(failure)).kind !== 'none',
    })
    this.current = { leg, stream }
    stream.start()
  }

  private endWith(chunks: BridgeModelStreamChunk[]): void {
    this.ending = chunks
    // A cancelled request is not one the router's bookkeeping hears of.
    if (chunks.length > 0) this.report(false, undefined)
  }

  /** The chunks of a stream that ends here, before any target answered. */
  private closing(message: string, mark: RouteErrorMark): BridgeModelStreamChunk[] {
    const chunks = new DriverChunkEmitter().emit([
      { type: 'message_start', model: this.routing.model },
      { type: 'error', message },
    ])
    return chunks.map(chunk => (chunk.type === 'error' ? marked(chunk, mark) : chunk))
  }

  /** The router's decision for `failure`, asked once per failure. */
  private async decide(failure: FailureEvent): Promise<RouteDecision> {
    if (this.asked?.failure === failure) return this.asked.decision
    let decision: RouteDecision = { kind: 'none' }
    try {
      decision = await this.routing.after(failure, this.started, this.abort.signal)
    } catch (error) {
      traceLine(`[providers] a route could not be chosen after a failure: ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
    }
    if (this.abort.signal.aborted) decision = { kind: 'none' }
    this.asked = { failure, decision }
    return decision
  }

  async read(waitMs: number | undefined): Promise<StreamReadResult> {
    if (!this.current && !this.ending) {
      await settledWithin(this.opening, waitMs ?? this.unheldWaitMs)
      // The router is still choosing: the stream is alive and has nothing yet.
      if (!this.current && !this.ending) return { chunks: [], done: false, status: 'ok' }
    }
    if (this.ending) {
      const chunks = this.ending
      this.ending = []
      return { chunks, done: true, status: 'done' }
    }
    const { stream } = this.current!
    const result = await stream.read(waitMs)
    if (result.status === 'timeout') return this.afterTimeout(result)
    const at = result.chunks.findIndex(chunk => chunk.type === 'error')
    if (at < 0) {
      this.note(result.chunks)
      if (result.done && !this.abort.signal.aborted) this.report(true, undefined)
      return result
    }
    const before = result.chunks.slice(0, at)
    this.note(before)
    const failure = stream.failed()
    const decision = failure ? await this.decide(failure) : ({ kind: 'none' } as const)
    return this.settle(decision, before, result.chunks[at]!, failure, result)
  }

  /** A held read ran out and the leg cancelled its request: a failure of the
   *  target like any other, with no error chunk of its own. */
  private async afterTimeout(result: StreamReadResult): Promise<StreamReadResult> {
    const failure: FailureEvent = { type: 'error', message: IDLE_TIMEOUT_TEXT }
    const decision = await this.decide(failure)
    if (decision.kind === 'none') {
      this.report(false, failure)
      return result
    }
    const [chunk] = new DriverChunkEmitter().emit([failure])
    return this.settle(decision, [], chunk!, failure, result)
  }

  private settle(
    decision: RouteDecision,
    before: BridgeModelStreamChunk[],
    errorChunk: BridgeModelStreamChunk,
    failure: FailureEvent | undefined,
    result: StreamReadResult,
  ): StreamReadResult {
    if (decision.kind === 'switch' && !this.started) {
      this.run(decision.leg)
      return { chunks: before, done: false, status: 'ok' }
    }
    if (decision.kind === 'none') {
      this.report(false, failure)
      return result
    }
    const mark: RouteErrorMark = decision.kind === 'switch'
      ? { switch: { ...decision.leg.target } }
      : { stop: true, ...(decision.message !== undefined ? { message: decision.message } : {}) }
    // A switch is not the end of the request: the caller sends it again.
    if (decision.kind === 'stop') this.report(false, failure)
    return { chunks: [...before, marked(errorChunk, mark)], done: true, status: 'done' }
  }

  private note(chunks: readonly BridgeModelStreamChunk[]): void {
    for (const chunk of chunks) {
      if (isReplyChunk(chunk)) this.started = true
      const usage = (chunk.type === 'message_start' ? chunk.message?.usage : chunk.usage) as
        | { input_tokens?: unknown; output_tokens?: unknown }
        | undefined
      if (!usage || typeof usage !== 'object') continue
      const input = count(usage.input_tokens)
      const output = count(usage.output_tokens)
      if (input !== undefined) this.usage.inputTokens = input
      if (output !== undefined) this.usage.outputTokens = output
    }
  }

  private report(ok: boolean, failure: FailureEvent | undefined): void {
    if (this.reported || !this.routing.ended) return
    this.reported = true
    const { inputTokens, outputTokens } = this.usage
    try {
      this.routing.ended({
        ...(this.current ? { target: this.current.leg.target } : {}),
        ok,
        ...(failure ? { failure } : {}),
        ...(inputTokens !== undefined || outputTokens !== undefined
          ? { usage: { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 } }
          : {}),
        durationMs: Date.now() - this.startedAt,
      })
    } catch (error) {
      traceLine(`[providers] the end of a routed request could not be reported: ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
    }
  }

  async cancel(): Promise<void> {
    this.abort.abort()
    await this.current?.stream.cancel()
  }
}

function marked(chunk: BridgeModelStreamChunk, mark: RouteErrorMark): BridgeModelStreamChunk {
  return { ...chunk, error: { type: 'provider_error', message: '', ...chunk.error, route: mark } }
}

/** Resolves when `promise` settles or `ms` pass, whichever is first. */
function settledWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    void promise.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
