/**
 * A bridge transport that serves the model routes (`model.call` / `streamStart` /
 * `streamRead` / `streamCancel`) on each provider's driver and passes everything
 * else through. Terminal here: no driver is a `provider_error`, an unknown stream id
 * `STREAM_NOT_FOUND`. Wrapping the transport reaches every caller.
 */
import type {
  BridgeModelRequestPayload,
  BrowserBridgeTransport,
} from '../../browser/bridge/browserBridgeProtocol'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
// The codecs register as a side effect: every caller that can reach a
// driver-backed provider goes through this module.
import './builtinDrivers'
import { resolveModelId } from '../../config/nexusModelConfig/modelEntryResolution'
import { runBlockingCall } from './blockingCall'
import { DriverStreamHost } from './driverStreamHost'
import { createModelProvider, ProviderConfigError, type ModelProvider } from './modelProvider'
import { resolveDriverBaseUrl, resolveProviderSpec } from './driverRegistry'
import type { ProviderSpec } from './driverTypes'


type Envelope = { id: string; route: unknown; ok: boolean; result?: unknown; error?: unknown }

function errorCode(error: unknown): string {
  if (error instanceof StreamNotFoundError) return 'STREAM_NOT_FOUND'
  return error instanceof ProviderConfigError ? 'provider_error' : 'LLM_ERROR'
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // ProviderConfigError already carries its `provider_error: ` prefix; the
  // envelope's code restates it, and the caller prints `code: message`.
  return message.replace(/^provider_error: /, '')
}

/**
 * A model request that names a model ENTRY (`claude-opus-*@latest` —
 * config/nexusModelConfig/modelEntries.ts) carries the concrete id it resolves
 * to now: neither a provider nor a codec knows entries. Every other request
 * is returned as is.
 */
function withConcreteModel<T extends { route: { capability: string; action: string }; payload?: unknown }>(request: T): T {
  if (request.route.capability !== 'model') return request
  const payload = request.payload as { model?: unknown; providerId?: unknown } | undefined
  if (!payload || typeof payload.model !== 'string') return request
  const providerId = typeof payload.providerId === 'string' ? payload.providerId : undefined
  const model = resolveModelId(providerId, payload.model)
  return model === payload.model ? request : { ...request, payload: { ...payload, model } }
}

/** The routes this wrapper owns; every other `model.*` action is the host's. */
const MODEL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  'call', 'streamStart', 'streamRead', 'streamCancel',
])

class StreamNotFoundError extends Error {}

/** More distinct wires than any provider set has; past it the cache starts over. */
const MODEL_PROVIDER_CACHE_LIMIT = 64

/**
 * The `ModelProvider` for a spec, one per distinct wire: keyed by provider, format,
 * EFFECTIVE base URL (so a changed override never hits a stale instance), path and
 * the rest of the spec.
 */
export function createModelProviderCache(): (spec: ProviderSpec) => ModelProvider {
  const cache = new Map<string, ModelProvider>()
  return spec => {
    const { id, format, baseUrl, path, ...rest } = spec
    const key = JSON.stringify([id, format, baseUrl ?? resolveDriverBaseUrl(id) ?? '', path ?? '', rest])
    let provider = cache.get(key)
    if (!provider) {
      if (cache.size >= MODEL_PROVIDER_CACHE_LIMIT) cache.clear()
      provider = createModelProvider(spec)
      cache.set(key, provider)
    }
    return provider
  }
}

export function withModelProviders(
  transport: BrowserBridgeTransport,
  runtimeConfig?: RuntimeConfig,
): BrowserBridgeTransport {
  // A transport that answers the model routes itself (a unit test's scripted
  // stream) is used as is.
  if (transport.servesModelRoutes) return transport
  const host = new DriverStreamHost(transport)
  const providerFor = createModelProviderCache()

  async function serve(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<{ result: unknown } | undefined> {
    if (!MODEL_REQUEST_ACTIONS.has(action)) return undefined
    if (action === 'streamStart' || action === 'call') {
      const request = payload as unknown as BridgeModelRequestPayload & { deadlineMs?: number }
      const spec = resolveProviderSpec(request.providerId, runtimeConfig, request.model)
      if (!spec) {
        throw new ProviderConfigError(`no runtime driver serves the provider ${request.providerId ?? '(none)'}`)
      }
      if (!request.model || request.model === 'inherit') {
        throw new ProviderConfigError(`the ${spec.format} provider ${spec.id} needs an explicit model`)
      }
      const provider = providerFor(spec)
      // The blocking route (the fallback for a stream that produced nothing)
      // is served here too: a fresh stream, read whole (blockingCall.ts).
      return action === 'call'
        ? { result: await runBlockingCall(host, provider, request, request.model) }
        : { result: host.start(provider, request, request.model) }
    }
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    if (action === 'streamCancel') {
      // Idempotent: a stream already gone is cancelled.
      if (host.has(streamId)) await host.cancel(streamId)
      return { result: { ok: true } }
    }
    if (!host.has(streamId)) throw new StreamNotFoundError(`no model stream ${streamId}`)
    const waitMs = typeof payload.waitMs === 'number' ? payload.waitMs : undefined
    return { result: await host.read(streamId, waitMs) }
  }

  const wrapped: BrowserBridgeTransport = {
    async request(original) {
      const request = withConcreteModel(original)
      if (request.route.capability === 'model') {
        try {
          const served = await serve(
            String(request.route.action),
            (request.payload ?? {}) as Record<string, unknown>,
          )
          if (served) {
            return { id: request.id, route: request.route, ok: true, result: served.result } as never
          }
        } catch (error) {
          const envelope: Envelope = {
            id: request.id,
            route: request.route,
            ok: false,
            error: { code: errorCode(error), message: errorMessage(error) },
          }
          return envelope as never
        }
      }
      return transport.request(request)
    },
  }
  if (transport.subscribeEvents) {
    wrapped.subscribeEvents = handler => transport.subscribeEvents!(handler)
  }
  return wrapped
}
