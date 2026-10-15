/**
 * Security: `BrowserBridgeTransport` over one `RuntimeConnection` (P-3). A
 * `capability.action` request becomes `conn.request("capability.action")`, which
 * the hub's host-proxy table forwards to C++ after its scope check. A denied route
 * fails with `forbidden_scope` and never falls back; `fs.*` is not proxied
 * (`unknown_route`). Errors come back in the bridge envelope, with a host code the
 * hub folded into `internal` (`data.code`) unfolded again. `host_unavailable` (no
 * C++ port yet during boot) is retried a few times. Host-pushed events still come
 * from the page's own C++ port. The page never runs a host call for the runtime.
 */
import type {
  BridgeEventHandler,
  BridgeEventUnsubscribe,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeError,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BrowserBridgeTransport,
} from '../bridge/protocol/core'
import type { RouteKey, WireError } from '../runtimeProtocol'
import { isRuntimeRequestError, type RuntimeConnection } from './RuntimeConnection'

export type HostBridgeOverConnectionOptions = {
  /** The page's one runtime connection; awaited per request so early callers queue behind the handshake. */
  connection: () => Promise<RuntimeConnection>
  /** Where host-pushed events come from: the page's C++ port. Never requested. */
  events?: BrowserBridgeTransport
  /** `host_unavailable` retry budget. Defaults: 5 attempts, 200 ms apart (≈1 s, the boot-order window). */
  retry?: HostUnavailableRetry
}

const DEFAULT_RETRY_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 200

/** Error code the legacy envelope uses when no transport could carry the request at all. */
export const BRIDGE_TRANSPORT_ERROR_CODE = 'bridge_transport_error'

/**
 * The inverse of the hub's `legacyBridgeErrorToWire`: a wire error back to
 * the `{code, message, data}` the bridge callers parse. `internal` carrying
 * the host's original code in `data.code` is unfolded; everything else keeps
 * the wire code, which for the mapped legacy codes (`not_found`, `conflict`,
 * `bad_payload`, `unknown_route`) is what the callers already compare against
 * or, more commonly, just log.
 */
export function wireErrorToLegacy(error: WireError): BrowserBridgeError {
  const data = error.data as { code?: unknown; data?: unknown } | undefined
  if (error.code === 'internal' && data && typeof data.code === 'string') {
    return {
      code: data.code,
      message: error.message,
      ...(data.data !== undefined ? { data: data.data } : {}),
    }
  }
  return {
    code: error.code,
    message: error.message,
    ...(error.data !== undefined ? { data: error.data } : {}),
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export type HostUnavailableRetry = { attempts?: number; delayMs?: number }

/**
 * `connection.request`, with `host_unavailable` — the runtime has no C++ port
 * at this instant, a boot-order window rather than a failure — retried a few
 * times before it surfaces. Every page request that ends at the host goes
 * through this: the host-bridge transport below and `fsx` (`fileAccess.ts`).
 */
export async function requestRetryingHostUnavailable<R = unknown>(
  connection: RuntimeConnection,
  route: RouteKey,
  payload: unknown,
  retry: HostUnavailableRetry = {},
): Promise<R> {
  const attempts = Math.max(1, retry.attempts ?? DEFAULT_RETRY_ATTEMPTS)
  const delayMs = retry.delayMs ?? DEFAULT_RETRY_DELAY_MS
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connection.request<R>(route, payload)
    } catch (error) {
      if (isRuntimeRequestError(error) && error.wire.code === 'host_unavailable' && attempt < attempts) {
        await sleep(delayMs)
        continue
      }
      throw error
    }
  }
}

export function createHostBridgeTransportOverConnection(
  options: HostBridgeOverConnectionOptions,
): BrowserBridgeTransport {
  async function request<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(req: BrowserBridgeRequest<C, A>): Promise<BrowserBridgeResponse<C, A>> {
    const { capability, action } = req.route
    const fail = (error: BrowserBridgeError): BrowserBridgeResponse<C, A> =>
      ({ id: req.id, route: req.route, ok: false, error }) as BrowserBridgeResponse<C, A>

    let connection: RuntimeConnection
    try {
      connection = await options.connection()
    } catch (error) {
      return fail({
        code: BRIDGE_TRANSPORT_ERROR_CODE,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    const routeKey: RouteKey = `${capability}.${String(action)}`
    try {
      const result = await requestRetryingHostUnavailable(connection, routeKey, req.payload, options.retry)
      return { id: req.id, route: req.route, ok: true, result } as BrowserBridgeResponse<C, A>
    } catch (error) {
      if (!isRuntimeRequestError(error)) {
        return fail({
          code: BRIDGE_TRANSPORT_ERROR_CODE,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return fail(wireErrorToLegacy(error.wire))
    }
  }

  const transport: BrowserBridgeTransport = { request }
  if (options.events?.subscribeEvents) {
    // Host-pushed events (`session.applyAgentConfig`, `browser.sessionTabsChanged`)
    // come from the page port, not a topic.
    const source = options.events
    transport.subscribeEvents = (handler: BridgeEventHandler): BridgeEventUnsubscribe =>
      source.subscribeEvents!(handler)
  }
  return transport
}
