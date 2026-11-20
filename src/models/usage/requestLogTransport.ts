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
import { resolveModelId } from '../../config/nexusModelConfig/modelEntryResolution'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { classifyProviderConnectivityIssue, ProviderApiError } from '../../utils/providerConnectivity'
import type { DeclaredVerdict } from '../../utils/providerVerdict'
import { providerRouterFor } from '../drivers/providerRouter'
import { foldUsage, type RequestLogRow, type RequestLogUsage } from './requestLogStore'
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

function failure(error: Fields): Pick<RequestLogRow, 'outcome' | 'failureKind' | 'httpStatus'> {
  const status = typeof error.httpStatus === 'number' ? error.httpStatus : undefined
  const retryAfter = typeof error.retryAfterSeconds === 'number' && error.retryAfterSeconds >= 0
    ? error.retryAfterSeconds
    : undefined
  const declared = error.verdict && typeof error.verdict === 'object' ? (error.verdict as DeclaredVerdict) : undefined
  const prefix = text(error.type) ? `${String(error.type)}: ` : ''
  // The same reading the turn gives the failure: the provider's declared verdict over the platform's.
  const verdict = classifyProviderConnectivityIssue(
    new ProviderApiError(`${prefix}${text(error.message) ?? ''}`, {
      ...(status !== undefined ? { httpStatus: status } : {}),
      ...(retryAfter !== undefined ? { retryAfterMs: retryAfter * 1000 } : {}),
      ...(declared ? { declared } : {}),
    }),
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

  const write = (stream: Open, ending: Pick<RequestLogRow, 'outcome' | 'failureKind' | 'httpStatus'>): void => {
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

  const finish = (streamId: string, ending: Pick<RequestLogRow, 'outcome' | 'failureKind' | 'httpStatus'>): void => {
    const stream = open.get(streamId)
    if (!stream) return
    open.delete(streamId)
    write(stream, ending)
  }

  const started = (payload: Fields, startedMs: number): Open | undefined => {
    const provider = text(payload.providerId)
    const requested = text(payload.model)
    if (!provider || !requested || providerRouterFor(provider)) return undefined
    // The concrete id the request was sent for, so a send that never reports its model is counted with the rest.
    const model = resolveModelId(provider, requested)
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
      write(
        stream,
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
    // A read the bridge refused ends the stream for its reader.
    if (response.ok !== true) {
      finish(streamId, failure(fields(response.error)))
      return
    }
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
      const response = await served.request(request).catch((error: unknown) => {
        try {
          const streamId = text(fields(request.payload).streamId)
          if (streamId && action !== 'streamStart') finish(streamId, { outcome: 'aborted' })
        } catch {
          // An observer: a request is never failed for its row.
        }
        throw error
      })
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
