/**
 * Contract: serves `model.streamStart / streamRead / streamCancel` in the runtime with
 * the host's contract. streamStart answers at once; later failures arrive as chunks
 * ending in an `error` chunk. streamRead is a held read: chunks, or after `waitMs`
 * `status: 'timeout'`, which also cancels upstream. streamCancel is idempotent.
 */
import type {
  BridgeModelRequestPayload,
  BridgeModelStreamChunk,
  BrowserBridgeTransport,
} from '../../browser/bridge/browserBridgeProtocol'
import {
  openRawProviderStream,
  RawProviderStreamError,
  type RawProviderStream,
} from '../../browser/bridge/rawProviderStream'
import { DriverChunkEmitter } from './chunkEmitter'
import { buildSystemInstruction } from './hostCallOptions'
import type { ModelProvider } from './modelProvider'
import type { DriverHttpRequest, DriverStreamEvent } from './driverTypes'
import {
  providerRequestSeamFor,
  ProviderRequestFlow,
  ProviderSignInRequiredError,
  thinkingTierOf,
  type PreparedProviderRequest,
  type ProviderRequestParts,
  type ProviderRequestSeam,
} from './providerRequestSeam'
import { sessionWorkingDirOf } from './sessionWorkingDirs'
import { storedKeyProblemFromReason, withStoredKeyMarker } from '../../utils/storedKeyProblem'

// A non-2xx body is read whole for the error message; cap it.
const MAX_ERROR_BODY_BYTES = 64 * 1024

/**
 * A read that names no `waitMs` is answered at once by the host — and a
 * caller that polls that way (the compaction summarizer) spins. Against the
 * host every poll is an IPC round trip; against this in-realm stream it would
 * be a microtask loop that starves the very transport reads that feed it. So
 * such a read waits up to this long for something to arrive — and, unlike a
 * held read, never cancels the stream when the wait runs out.
 */
export const UNHELD_READ_POLL_MS = 250

type StreamReadResult = {
  chunks: BridgeModelStreamChunk[]
  done: boolean
  status: 'ok' | 'timeout' | 'done' | 'queued'
}

/**
 * A provider's concurrency pool: at most `limit` requests open, the rest started
 * FIFO; streams and blocking calls share one queue. Module-global per provider id,
 * shared by every caller in the realm. A slot is released when its pump ends.
 */
class ConcurrencyPool {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(public limit: number) {}

  /** Takes a slot now when one is free and nobody is waiting. */
  tryAcquire(): boolean {
    if (this.active >= this.limit || this.waiting.length > 0) return false
    this.active += 1
    return true
  }

  /** Queues `start` for the next free slot (the slot is taken for it).
   *  Returns a remover: true when the entry was still waiting. */
  enqueue(start: () => void): () => boolean {
    this.waiting.push(start)
    return () => {
      const index = this.waiting.indexOf(start)
      if (index < 0) return false
      this.waiting.splice(index, 1)
      return true
    }
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active += 1
      this.waiting.shift()!()
    }
  }

  get queued(): number {
    return this.waiting.length
  }
}

const pools = new Map<string, ConcurrencyPool>()

function poolFor(provider: ModelProvider): ConcurrencyPool | undefined {
  const limit = provider.spec.maxConcurrentStreams
  if (!limit || limit <= 0) return undefined
  let pool = pools.get(provider.id)
  if (!pool) {
    pool = new ConcurrencyPool(limit)
    pools.set(provider.id, pool)
  }
  pool.limit = limit
  return pool
}

/** Test hook: requests waiting for a slot of `providerId`'s pool. */
export function queuedDriverStreamCount(providerId: string): number {
  return pools.get(providerId)?.queued ?? 0
}

/** Test hook. */
export function resetDriverStreamPools(): void {
  pools.clear()
}

class DriverStream {
  private queue: BridgeModelStreamChunk[] = []
  private done = false
  private wake: (() => void) | undefined
  private raw: RawProviderStream | undefined
  private readonly abort = new AbortController()
  private readonly emitter = new DriverChunkEmitter()
  /** Waiting for a concurrency slot: nothing has gone upstream yet. */
  private queued = false

  constructor(
    private readonly transport: BrowserBridgeTransport,
    private readonly provider: ModelProvider,
    private readonly payload: BridgeModelRequestPayload,
    private readonly model: string,
  ) {}

  start(): void {
    void this.pump()
  }

  async read(waitMs: number | undefined): Promise<StreamReadResult> {
    if (waitMs === undefined) {
      if (this.queue.length === 0 && !this.done) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            this.wake = undefined
            resolve()
          }, UNHELD_READ_POLL_MS)
          this.wake = () => {
            clearTimeout(timer)
            this.wake = undefined
            resolve()
          }
        })
      }
      return this.drain()
    }
    if (this.queue.length === 0 && !this.done && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await new Promise<boolean>(resolve => {
        this.wake = () => resolve(false)
        timer = setTimeout(() => resolve(true), waitMs)
      })
      clearTimeout(timer)
      this.wake = undefined
      if (timedOut && this.queue.length === 0 && !this.done) {
        // Queue time is not provider silence (NexusLlmHost
        // OnStreamReadHoldTimeout): a request still waiting for a slot keeps
        // its place, and the read says `queued`.
        if (this.queued) return { chunks: [], done: false, status: 'queued' }
        // As in the C++ host: a read that expires on its deadline cancels upstream.
        await this.cancel()
        return { chunks: [], done: false, status: 'timeout' }
      }
    }
    return this.drain()
  }

  private drain(): StreamReadResult {
    const chunks = this.queue
    this.queue = []
    return { chunks, done: this.done, status: this.done ? 'done' : 'ok' }
  }

  async cancel(): Promise<void> {
    this.abort.abort()
    await this.raw?.cancel()
  }

  private push(events: readonly DriverStreamEvent[]): void {
    if (this.emitter.terminalEmitted || events.length === 0) return
    this.queue.push(...this.emitter.emit(events.map(withHostFinishUsage)))
    if (this.emitter.terminalEmitted) this.done = true
    this.wake?.()
  }

  private finishIfOpen(): void {
    if (!this.emitter.terminalEmitted) {
      this.queue.push(...this.emitter.finalizeIfOpen())
    }
    this.done = true
    this.wake?.()
  }

  private fail(message: string, extra: { httpStatus?: number; retryAfterSeconds?: number } = {}): void {
    this.push([{ type: 'error', message, ...extra }])
    this.done = true
    this.wake?.()
  }

  private async pump(): Promise<void> {
    // NexusLlmHost queues kMessageStart (model only) for every stream before
    // the provider sends anything — so it precedes even an HTTP error. Codecs
    // emit `message_start` only as a usage refresh.
    this.push([{ type: 'message_start', model: this.model }])
    let request: ReturnType<ModelProvider['buildRequest']>
    try {
      request = this.provider.buildRequest(this.payload, this.model)
    } catch (error) {
      this.fail(`Failed to build the ${this.provider.format} request: ${errorText(error)}`)
      return
    }
    const pool = poolFor(this.provider)
    if (pool && !(await this.waitForSlot(pool))) {
      // Cancelled while queued: it never reached the provider.
      this.finishIfOpen()
      return
    }
    try {
      // Looked up once per stream: a provider without a seam runs the plain
      // path, with nothing built for the seam.
      const seam = providerRequestSeamFor(this.provider.id)
      if (seam) await this.sendThroughSeam(seam, request)
      else await this.send(request)
    } finally {
      pool?.release()
    }
  }

  /**
   * The provider's seam (providerRequestSeam.ts) between the built request
   * and the wire: `request` and `sign` run once the slot is held, so a
   * signature is as fresh as the send; a failing hook fails closed — nothing
   * is sent.
   */
  private async sendThroughSeam(seam: ProviderRequestSeam, built: DriverHttpRequest): Promise<void> {
    const thinkingTier = thinkingTierOf(this.payload)
    const cwd = seam.requestNeeds?.includes('cwd') ? sessionWorkingDirOf(this.payload.requestContext?.sessionId) : undefined
    const flow = new ProviderRequestFlow(
      seam,
      {
        provider: this.provider.id,
        model: this.model,
        format: this.provider.format,
        baseUrl: this.provider.context(this.model).baseUrl,
        ...(this.payload.maxOutputTokens !== undefined ? { maxOutputTokens: this.payload.maxOutputTokens } : {}),
        ...(thinkingTier ? { thinkingTier } : {}),
        ...(this.payload.requestContext ? { requestContext: this.payload.requestContext } : {}),
        // Only a provider that declared the `cwd` need is shown the directory.
        ...(cwd !== undefined ? { cwd } : {}),
        parts: this.requestParts(),
        ...(this.provider.idSites ? { idSites: this.provider.idSites } : {}),
      },
      this.abort.signal,
    )
    let prepared: PreparedProviderRequest
    try {
      prepared = await flow.prepare(built)
    } catch (error) {
      if (this.abort.signal.aborted) return this.finishIfOpen()
      this.fail(errorText(error), signInFailure(error))
      return
    }
    await this.send(prepared.request, { flow, prepared })
  }

  /** The payload's system prompt and tools, and the request built again
   *  with either replaced: what a hook that declared `system` / `tools` sees
   *  and answers. The contexts the codec folds into the system prompt are
   *  part of the text a hook sees, so a replacement stands for all of it. */
  private requestParts(): ProviderRequestParts {
    const payload = this.payload
    return {
      system: () => buildSystemInstruction(payload),
      tools: () => [...(payload.tools ?? [])],
      rebuild: over => {
        const { userContext: _u, systemContext: _s, toolUseContext: _t, ...rest } = payload
        const next: BridgeModelRequestPayload = {
          ...(over.system !== undefined ? rest : payload),
          ...(over.system !== undefined ? { systemPrompt: over.system } : {}),
          ...(over.tools !== undefined ? { tools: over.tools as BridgeModelRequestPayload['tools'] } : {}),
        }
        return this.provider.buildRequest(next, this.model)
      },
    }
  }

  /** Resolves true once this stream holds a slot, false when it is cancelled
   *  while still waiting (its queue entry is removed). */
  private waitForSlot(pool: ConcurrencyPool): Promise<boolean> {
    if (pool.tryAcquire()) return Promise.resolve(true)
    if (this.abort.signal.aborted) return Promise.resolve(false)
    this.queued = true
    return new Promise<boolean>(resolve => {
      const onAbort = () => {
        if (remove()) {
          this.queued = false
          resolve(false)
        }
      }
      const remove = pool.enqueue(() => {
        this.queued = false
        this.abort.signal.removeEventListener('abort', onAbort)
        resolve(true)
      })
      this.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async send(request: DriverHttpRequest, seamed?: SeamedSend): Promise<void> {
    const idleTimeoutMs = seamed?.prepared.idleTimeoutMs ?? this.provider.spec.idleTimeoutMs
    try {
      this.raw = await openRawProviderStream(this.transport, {
        providerId: this.provider.id,
        url: request.url,
        method: request.method ?? 'POST',
        headers: request.headers,
        ...(request.queryParams ? { queryParams: request.queryParams } : {}),
        body: request.body,
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        signal: this.abort.signal,
      })
    } catch (error) {
      if (this.abort.signal.aborted) return this.finishIfOpen()
      this.fail(errorText(error))
      return
    }

    // The ids the provider's id mapper changed on the way out are put back
    // on the way in, so the engine's transcript keeps its own.
    const decodeIds = seamed?.flow.idDecoder()
    const decoded = (events: DriverStreamEvent[]): DriverStreamEvent[] => (decodeIds ? decodeIds(events) : events)
    let decoder: ReturnType<ModelProvider['createDecoder']> | undefined
    try {
      if (!this.provider.isStreamStatus(this.raw.status)) {
        const bodyText = await readText(this.raw.body, MAX_ERROR_BODY_BYTES)
        if (seamed) {
          // At most one re-send in all: after a refresh (a 401 of a signed-in
          // provider) or the `retry` the provider's seam asked for.
          const again = await seamed.flow.recoverAfter(
            { status: this.raw.status, headers: this.raw.headers, bodyText },
            seamed.prepared,
          )
          if (this.abort.signal.aborted) return this.finishIfOpen()
          if (again) {
            await this.raw.cancel()
            return this.send(again.request, { flow: seamed.flow, prepared: again })
          }
        }
        this.push([
          this.provider.errorFromResponse({
            status: this.raw.status,
            statusText: this.raw.statusText,
            headers: this.raw.headers,
            bodyText,
          }),
        ])
        this.finishIfOpen()
        return
      }
      decoder = this.provider.createDecoder(this.model)
      for await (const bytes of this.raw.body) {
        this.push(decoded(decoder.push(bytes)))
        if (this.emitter.terminalEmitted) break
      }
      this.push(decoded(decoder.end()))
      this.finishIfOpen()
    } catch (error) {
      if (this.abort.signal.aborted) return this.finishIfOpen()
      // The response broke off. C++ OnStreamComplete(success=false) may still
      // emit a buffered finish first; when it does, the stream is over and the
      // transport error is dropped by the host's terminal guard.
      if (decoder?.abort) this.push(decoded(decoder.abort()))
      if (!this.emitter.terminalEmitted) this.fail(errorText(error), signInFailure(error))
      else this.finishIfOpen()
    }
  }
}

/** A request that ended because the provider's sign-in is over is a refusal
 *  (401), not a broken connection: the engine must not retry it. */
function signInFailure(error: unknown): { httpStatus?: number } {
  return error instanceof ProviderSignInRequiredError ? { httpStatus: 401 } : {}
}

/** A send that went through the provider's seam: what a `retry` re-send needs. */
type SeamedSend = { flow: ProviderRequestFlow; prepared: PreparedProviderRequest }

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0 } as const

/**
 * The host refused an `{{oauth:NAME}}` request: the provider is not signed
 * in, or its token could not be refreshed / exchanged. The C++ path reports
 * that with this text (`NexusLlmHost::ContinueStreamStart`), so the user
 * reads the same sentence on either path.
 */
const OAUTH_UNAVAILABLE = 'OAUTH_UNAVAILABLE'
const SECRET_UNAVAILABLE = 'SECRET_UNAVAILABLE'
export const OAUTH_SIGN_IN_MESSAGE = 'Sign in to this provider in Settings to continue'

/**
 * NexusLlmHost `QueueFinishEvent` attaches usage to EVERY finish — the
 * provider's, else zeros (`BuildUsage(0, 0)`) — so the bridge's
 * `message_delta` always carries `usage`. Applied here, once, for every codec.
 */
function withHostFinishUsage(event: DriverStreamEvent): DriverStreamEvent {
  return event.type === 'finish' && !event.usage ? { ...event, usage: ZERO_USAGE } : event
}

/**
 * A transport failure as the error chunk words it. A dropped or refused
 * connection reads like the C++ OpenAI provider's — `Stream network error:
 * Request failed: net::ERR_CONNECTION_RESET`, not the transport's
 * `NETWORK_ERROR:` code — because the API-error card shows this text: the
 * user reads "network", and the classifier's verdict (network, retryable,
 * from `net::ERR_`) is the same either way. Other codes keep their name.
 */
function errorText(error: unknown): string {
  if (error instanceof RawProviderStreamError) {
    if (error.code === OAUTH_UNAVAILABLE) return OAUTH_SIGN_IN_MESSAGE
    // A refused secret carries its stored-key marker (utils/storedKeyProblem.ts).
    if (error.code === SECRET_UNAVAILABLE) {
      const problem = storedKeyProblemFromReason(error.data?.reason)
      if (problem) return withStoredKeyMarker(problem, error.message.slice(`${SECRET_UNAVAILABLE}: `.length))
    }
    return error.code === 'NETWORK_ERROR'
      ? `Stream network error: ${error.message.slice('NETWORK_ERROR: '.length)}`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

async function readText(body: AsyncIterable<Uint8Array>, limit: number): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for await (const bytes of body) {
    size += bytes.byteLength
    text += decoder.decode(bytes, { stream: true })
    if (size >= limit) break
  }
  return text + decoder.decode()
}

let nextStreamId = 0

/** The runtime-side stream table for one bridge transport. */
export class DriverStreamHost {
  private readonly streams = new Map<string, DriverStream>()

  constructor(private readonly transport: BrowserBridgeTransport) {}

  start(
    provider: ModelProvider,
    payload: BridgeModelRequestPayload,
    model: string,
  ): { streamId: string } {
    nextStreamId += 1
    const streamId = `driver-${provider.format}-${Date.now().toString(36)}-${nextStreamId}`
    const stream = new DriverStream(this.transport, provider, payload, model)
    this.streams.set(streamId, stream)
    stream.start()
    return { streamId }
  }

  has(streamId: string): boolean {
    return this.streams.has(streamId)
  }

  /** `waitMs` undefined = an unheld read (see `UNHELD_READ_POLL_MS`). */
  async read(streamId: string, waitMs: number | undefined): Promise<StreamReadResult> {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error(`Unknown driver stream: ${streamId}`)
    const result = await stream.read(waitMs)
    // A finished or timed-out stream is forgotten, as the host forgets it.
    if (result.done || result.status === 'timeout') this.streams.delete(streamId)
    return result
  }

  async cancel(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId)
    this.streams.delete(streamId)
    await stream?.cancel()
  }
}
