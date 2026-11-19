/**
 * Contract: where a model request is seen for the request log (F-27), around
 * the transport that serves the model routes, so every provider's requests
 * pass here whether or not its module hooks anything. An observer. Every request and response passes through
 * unchanged; nothing here delays, fails or alters one, and a fault in the
 * observation is swallowed. One row per stream (`model.streamStart` to its
 * end) and one per blocking `model.call`: the retry ladder's attempts are
 * streams of their own, so each is a row; a re-send inside one stream is not
 * seen here and is part of that stream's row. A request that was refused
 * before it could leave (no driver, no model) writes no row. A request made
 * to a router provider writes none here: its sends are recorded where its
 * targets are chosen.
 */
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { classifyProviderConnectivityIssue, ProviderApiError } from '../../utils/providerConnectivity'
import { providerRouterFor } from '../drivers/providerRouter'
import type { RequestLogRow, RequestLogUsage } from './requestLogStore'
import { attachRequestLogBridge, recordRequest } from './requestLogWriter'

/** Streams watched at once; past it the oldest is recorded as abandoned. */
export const OPEN_STREAMS_MAX = 512

type Open = {
  startedMs: number
  provider: string
  model: string
  sessionId?: string
  usage: RequestLogUsage
}

type Fields = Record<string, unknown>

function fields(value: unknown): Fields {
  return value && typeof value === 'object' ? (value as Fields) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const USAGE_FIELDS: ReadonlyArray<[keyof RequestLogUsage, string]> = [
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_input_tokens'],
  ['cacheWriteTokens', 'cache_creation_input_tokens'],
]

/** A later report replaces a figure only when it carries one. */
function foldUsage(into: RequestLogUsage, reported: unknown): void {
  const usage = fields(reported)
  for (const [key, wire] of USAGE_FIELDS) {
    const value = usage[wire]
    if (typeof value === 'number' && value > 0) into[key] = value
  }
}

function failure(error: Fields): Pick<RequestLogRow, 'outcome' | 'failureKind' | 'httpStatus'> {
  const status = typeof error.httpStatus === 'number' ? error.httpStatus : undefined
  const prefix = text(error.type) ? `${String(error.type)}: ` : ''
  const verdict = classifyProviderConnectivityIssue(
    new ProviderApiError(`${prefix}${text(error.message) ?? ''}`, status !== undefined ? { httpStatus: status } : {}),
  )
  const httpStatus = status ?? verdict?.status
  return {
    outcome: 'failed',
    failureKind: verdict?.kind ?? 'error',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  }
}

/**
 * `served` with every model request it serves recorded. `base` is the bridge
 * the log is written through. A transport that scripts the model routes
 * itself has no host behind it and is returned as it is.
 */
export function withRequestLog(
  served: BrowserBridgeTransport,
  base: BrowserBridgeTransport,
  runtimeConfig?: RuntimeConfig,
): BrowserBridgeTransport {
  if (base.servesModelRoutes) return served
  attachRequestLogBridge(base, runtimeConfig)
  const open = new Map<string, Open>()

  const finish = (streamId: string, ending: Pick<RequestLogRow, 'outcome' | 'failureKind' | 'httpStatus'>): void => {
    const stream = open.get(streamId)
    if (!stream) return
    open.delete(streamId)
    recordRequest(
      {
        startedMs: stream.startedMs,
        durationMs: Date.now() - stream.startedMs,
        ...(stream.sessionId ? { sessionId: stream.sessionId } : {}),
        provider: stream.provider,
        model: stream.model,
        usage: stream.usage,
        ...ending,
      },
      base,
    )
  }

  const started = (payload: Fields, startedMs: number): Open | undefined => {
    const provider = text(payload.providerId)
    const model = text(payload.model)
    if (!provider || !model || providerRouterFor(provider)) return undefined
    const sessionId = text(fields(payload.requestContext).sessionId)
    return { startedMs, provider, model, ...(sessionId ? { sessionId } : {}), usage: {} }
  }

  const observe = (action: string, payload: Fields, response: Fields, startedMs: number): void => {
    const result = fields(response.result)
    if (action === 'streamStart') {
      const streamId = text(result.streamId)
      const stream = response.ok === true && streamId ? started(payload, startedMs) : undefined
      if (!stream || !streamId) return
      if (open.size >= OPEN_STREAMS_MAX) finish(open.keys().next().value as string, { outcome: 'aborted' })
      open.set(streamId, stream)
      return
    }
    if (action === 'call') {
      const stream = started(payload, startedMs)
      if (!stream) return
      const error = fields(response.error)
      // A refused request never left.
      if (response.ok !== true && error.code === 'provider_error') return
      const message = fields(result.message)
      foldUsage(stream.usage, message.usage)
      stream.model = text(message.model) ?? stream.model
      open.set('call', stream)
      finish(
        'call',
        response.ok !== true
          ? failure(error)
          : result.status === 'timeout'
            ? { outcome: 'failed', failureKind: 'timeout' }
            : { outcome: 'ok' },
      )
      return
    }
    const streamId = text(payload.streamId)
    const stream = streamId ? open.get(streamId) : undefined
    if (!stream || !streamId) return
    if (action === 'streamCancel') {
      finish(streamId, { outcome: 'aborted' })
      return
    }
    if (response.ok !== true) return
    let failed: Fields | undefined
    for (const chunk of Array.isArray(result.chunks) ? result.chunks : []) {
      const part = fields(chunk)
      if (part.type === 'message_start') {
        const message = fields(part.message)
        stream.model = text(message.model) ?? stream.model
        foldUsage(stream.usage, message.usage)
      } else if (part.type === 'message_delta') foldUsage(stream.usage, part.usage)
      else if (part.type === 'error') failed = fields(part.error)
    }
    if (failed) finish(streamId, failure(failed))
    else if (result.status === 'timeout') finish(streamId, { outcome: 'failed', failureKind: 'timeout' })
    else if (result.done === true) finish(streamId, { outcome: 'ok' })
  }

  const wrapped: BrowserBridgeTransport = {
    async request(request) {
      const { capability, action } = request.route as { capability: string; action: string }
      if (capability !== 'model') return served.request(request)
      const startedMs = Date.now()
      const response = await served.request(request)
      try {
        observe(String(action), fields(request.payload), fields(response), startedMs)
      } catch {
        // An observer: a request is never failed for its row.
      }
      return response
    },
  }
  if (served.subscribeEvents) wrapped.subscribeEvents = handler => served.subscribeEvents!(handler)
  return wrapped
}
