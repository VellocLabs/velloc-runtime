import type {
  BridgeHttpGetResult,
  BridgeHttpRequestPayload,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'

/**
 * Typed wrapper around the `network` bridge capability: fetches URLs through the
 * Chromium net stack, without renderer CORS gating.
 */
export type CreateBrowserNetworkOperationsOptions = {
  transport: BrowserBridgeTransport
  createRequestId: () => string
}

export type HttpGetOptions = {
  /**
   * Optional request headers map. Do NOT include `Authorization`
   * here — reserved for the LLM-provider path. `User-Agent` is
   * auto-populated as `Mozilla/5.0 (Velloc WebFetch)` C++-side if
   * omitted.
   */
  headers?: Record<string, string>
  /**
   * Hard timeout in ms; the C++ loader is cancelled past this and
   * the call rejects with a `TIMEOUT:` error. Default 60_000.
   */
  timeoutMs?: number
  /**
   * Cap on response-body size; C++ aborts past this many bytes.
   * Default 50_000_000 (50 MB).
   */
  maxResponseBytes?: number
  /**
   * If false (default), 3xx responses come back AS-IS so the caller
   * can apply its own redirect policy (WebFetch uses this mode to
   * enforce same-host-only redirects). If true, the C++ loader
   * follows redirects up to `maxRedirects` hops.
   */
  followRedirects?: boolean
  /**
   * Max redirect hops when `followRedirects=true`. Default 10.
   */
  maxRedirects?: number
  /**
   * Cooperative cancellation: the signal is checked once on send (rejects if
   * already aborted); otherwise the C++ side runs to completion.
   */
  signal?: AbortSignal
}

export type BrowserNetworkOperations = {
  /**
   * Issue an HTTP GET. Returns the full response envelope (status,
   * headers, body). Rejects with `${code}: ${message}` on any C++
   * side error (`INVALID_URL`, `TIMEOUT`, `NETWORK_ERROR`,
   * `REDIRECT_LIMIT_EXCEEDED`).
   */
  httpGet(
    url: string,
    options?: HttpGetOptions,
  ): Promise<BridgeHttpGetResult>
  /**
   * Any-method HTTP request (`network.httpRequest`). Same envelope and errors as
   * `httpGet`, plus `INVALID_METHOD`, `INVALID_REQUEST` (a body on GET / HEAD),
   * `REQUEST_TOO_LARGE` and `EGRESS_BLOCKED` (only publicly routable hosts).
   * Absent on an older host; callers check before use.
   */
  httpRequest?(
    request: BridgeHttpRequestPayload,
    options?: { signal?: AbortSignal },
  ): Promise<BridgeHttpGetResult>
}

export function createBrowserNetworkOperations(
  options: CreateBrowserNetworkOperationsOptions,
): BrowserNetworkOperations {
  async function send<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = (await options.transport.request({
      id: options.createRequestId(),
      route,
      payload,
    })) as
      | { ok: true; result: BrowserBridgeResult<C, A> }
      | { ok: false; error: { code: string; message: string } }

    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }
    return response.result
  }

  return {
    async httpGet(url, callerOptions = {}) {
      if (callerOptions.signal?.aborted) {
        throw new Error('AbortError: httpGet aborted before send')
      }

      // Strip `signal` before forwarding to the bridge — the rest of
      // the keys map 1:1 onto the payload shape declared in
      // `protocol/network.ts`. (When the bridge gains native
      // cancellation, this is where we'd wire the abort handler.)
      const { signal: _signal, ...rest } = callerOptions

      return send(createBridgeRoute('network', 'httpGet'), {
        url,
        ...rest,
      })
    },
    async httpRequest(request, callerOptions = {}) {
      if (callerOptions.signal?.aborted) {
        throw new Error('AbortError: httpRequest aborted before send')
      }
      return send(createBridgeRoute('network', 'httpRequest'), request)
    },
  }
}
