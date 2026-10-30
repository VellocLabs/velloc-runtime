/**
 * Client for the host's generic provider byte transport (P-4): the guest owns the
 * wire format; secrets appear only as `{{secret:NAME}}` placeholders, substituted
 * host-side. Half-duplex. The guest names the stream (`streamId`) so an abort can
 * cancel the request before its response head.
 */
import {
  createBridgeRoute,
  type BrowserBridgeTransport,
} from './browserBridgeProtocol'

export type RawProviderStreamRequest = {
  providerId: string
  url: string
  method?: string
  /** Values may contain `{{secret:NAME}}`. */
  headers?: Record<string, string>
  /** Appended after the domain check; values may contain `{{secret:NAME}}`. */
  queryParams?: Record<string, string>
  body?: Uint8Array
  /** Capture these JSON response fields as provider secrets (see protocol). */
  captureSecrets?: Array<{ pointer: string; secret: string }>
  /** No-bytes abort, ms. Clamped to 90_000 (the `model` route's 100s fallback). */
  idleTimeoutMs?: number
  maxResponseBytes?: number
  signal?: AbortSignal
}

export type RawProviderStream = {
  status: number
  statusText: string
  finalUrl: string
  headers: Record<string, string>
  /** Response bytes in arrival order. Throws `RawProviderStreamError` if the stream ended abnormally. */
  body: AsyncIterable<Uint8Array>
  /** Closes the upstream request. Safe to call more than once. */
  cancel: () => Promise<void>
  /** captureSecrets only: name -> sealed value, set once `body` is drained. */
  captured: () => Record<string, string> | undefined
}

export class RawProviderStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The refusal's structured detail (`error.data`), when the host sent one. */
    readonly data?: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}: ${message}`)
    this.name = 'RawProviderStreamError'
  }
}

export const RAW_STREAM_MAX_IDLE_TIMEOUT_MS = 90_000
// Below the host's 30s hold cap and the transport's 100s `model` fallback.
const READ_WAIT_MS = 25_000

let nextRequestId = 0
function requestId(): string {
  nextRequestId += 1
  return `raw-stream-${Date.now().toString(36)}-${nextRequestId}`
}

/** A fresh caller-chosen stream id: 8-64 chars of [A-Za-z0-9_-]. */
function mintStreamId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `raw-${uuid}`
  return `raw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Open failures that come from the guest transport, not from the host's
 * answer: the host may still be holding the request, so it is cancelled by
 * the caller-chosen id. A host refusal (`INVALID_ARGS`, `TARGET_NOT_ALLOWED`,
 * …) needs no cancel — and a cancel after "stream id in use" would hit the
 * other stream.
 */
const TRANSPORT_FAILURE_CODES = new Set(['bridge_timeout', 'bridge_binary_error', 'transport_disposed'])
function isTransportFailure(error: unknown): boolean {
  return !(error instanceof RawProviderStreamError) || TRANSPORT_FAILURE_CODES.has(error.code)
}

async function send<T>(
  transport: BrowserBridgeTransport,
  action: 'rawStreamOpen' | 'rawStreamRead' | 'rawStreamCancel',
  payload: Record<string, unknown>,
): Promise<T> {
  const response = (await transport.request({
    id: requestId(),
    route: createBridgeRoute('model', action),
    payload: payload as never,
  })) as { ok: true; result: T } | {
    ok: false
    error: { code: string; message: string; data?: unknown }
  }
  if (!response.ok) {
    const { data } = response.error
    throw new RawProviderStreamError(
      response.error.code,
      response.error.message,
      data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined,
    )
  }
  return response.result
}

export async function openRawProviderStream(
  transport: BrowserBridgeTransport,
  request: RawProviderStreamRequest,
): Promise<RawProviderStream> {
  request.signal?.throwIfAborted()
  const idleTimeoutMs = Math.min(
    request.idleTimeoutMs ?? RAW_STREAM_MAX_IDLE_TIMEOUT_MS,
    RAW_STREAM_MAX_IDLE_TIMEOUT_MS,
  )
  const clientId = mintStreamId()
  // One cancel per id, ever: the early one by `clientId` and — against an
  // older host that ignored it — the late one by the host's own id.
  const cancelledIds = new Set<string>()
  const cancelById = async (id: string): Promise<void> => {
    if (cancelledIds.has(id)) return
    cancelledIds.add(id)
    await send(transport, 'rawStreamCancel', { streamId: id }).catch(() => {})
  }
  // Set once the open resolves; until then an abort cancels by `clientId`.
  let streamId: string | undefined
  let captured: Record<string, string> | undefined
  let finished = false
  let cancelSent = false
  const cancel = async (): Promise<void> => {
    // Detach here too, not only in `body()`'s finally: a consumer that cancels
    // (or drops the stream) without ever iterating would otherwise leave the
    // listener on a caller-owned, possibly long-lived signal.
    request.signal?.removeEventListener('abort', onAbort)
    if (finished || cancelSent || streamId === undefined) return
    cancelSent = true
    finished = true
    await cancelById(streamId)
  }
  const onAbort = (): void => {
    // Before the head: the host knows the stream only by `clientId` (a new
    // host fails the pending open `CANCELLED`; an older one ignores it).
    if (streamId === undefined) void cancelById(clientId)
    else void cancel()
  }
  // Attached BEFORE the open is awaited, so a pre-head abort reaches the host.
  request.signal?.addEventListener('abort', onAbort, { once: true })

  let opened: {
    streamId: string
    status: number
    statusText: string
    finalUrl: string
    headers: Record<string, string>
  }
  try {
    opened = await send(transport, 'rawStreamOpen', {
      providerId: request.providerId,
      url: request.url,
      ...(request.method !== undefined ? { method: request.method } : {}),
      ...(request.headers !== undefined ? { headers: request.headers } : {}),
      ...(request.queryParams !== undefined ? { queryParams: request.queryParams } : {}),
      body: request.body ?? new Uint8Array(0),
      ...(request.captureSecrets !== undefined
        ? { captureSecrets: request.captureSecrets }
        : {}),
      idleTimeoutMs,
      ...(request.maxResponseBytes !== undefined
        ? { maxResponseBytes: request.maxResponseBytes }
        : {}),
      streamId: clientId,
    })
  } catch (error) {
    request.signal?.removeEventListener('abort', onAbort)
    // Aborted while opening: the cancel already went out; whatever the host
    // answered (a new host: `CANCELLED`), this is the abort.
    request.signal?.throwIfAborted()
    // The transport gave up (its `model` fallback, a port error) while the
    // host may still hold the request: without this it would run until the
    // host's idle timeout under an id the guest never learned.
    if (isTransportFailure(error)) void cancelById(clientId)
    throw error
  }

  // A reply that is not the host's shape (a test double answering every
  // route alike, a host speaking another protocol) is an error, not a stream:
  // reading on would loop forever on reads that never say `done`.
  if (typeof opened?.streamId !== 'string' || typeof opened.status !== 'number') {
    request.signal?.removeEventListener('abort', onAbort)
    throw new RawProviderStreamError('PROTOCOL', 'rawStreamOpen answered without a stream id and status.')
  }
  const openedId = opened.streamId
  streamId = openedId
  if (request.signal?.aborted) {
    if (cancelledIds.has(openedId)) {
      // The early cancel named this very stream (a new host; the head won the
      // race): the host drops it when that cancel lands. Nothing to read.
      request.signal.removeEventListener('abort', onAbort)
      cancelSent = true
      finished = true
    } else {
      // An older host ignored `clientId`: cancel by the id it minted.
      onAbort()
    }
  }

  async function* body(): AsyncGenerator<Uint8Array, void, unknown> {
    try {
      while (!finished) {
        const read = await send<{
          done: boolean
          errorCode?: string
          errorMessage?: string
          captured?: Record<string, string>
          chunk?: Uint8Array
        }>(transport, 'rawStreamRead', { streamId: openedId, waitMs: READ_WAIT_MS })
        if (typeof read?.done !== 'boolean') {
          finished = true
          throw new RawProviderStreamError('PROTOCOL', 'rawStreamRead answered without `done`.')
        }
        if (read.captured) captured = read.captured
        if (cancelSent) break
        if (read.chunk && read.chunk.byteLength > 0) yield read.chunk
        if (read.done) {
          finished = true
          if (read.errorCode) {
            throw new RawProviderStreamError(
              read.errorCode,
              read.errorMessage ?? 'Stream failed.',
            )
          }
        }
      }
      request.signal?.throwIfAborted()
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      // A consumer that stops iterating early must not leave the upstream open.
      if (!finished) await cancel()
    }
  }

  return {
    status: opened.status,
    statusText: opened.statusText,
    finalUrl: opened.finalUrl,
    headers: opened.headers,
    body: body(),
    cancel,
    captured: () => captured,
  }
}
