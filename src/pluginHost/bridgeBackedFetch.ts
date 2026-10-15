/**
 * `fetch`-shaped adapter over the `network.httpGet` bridge route: the worker's
 * CSP blocks direct fetches, and the C++ loader is not subject to it. Supports
 * GET only, redirects, `signal`, and buffered bodies; no streaming, no
 * credentials.
 */

import type { BrowserBridgeTransport } from '../browser/bridge/protocol/core'
import { createBridgeRoute } from '../browser/bridge/protocol/core'

export type FetchLike = typeof fetch

/**
 * Cap on the response body of a bridge-backed fetch, in bytes; the host
 * enforces it. Sized for whole repo tarballs while bounding worker memory.
 */
export const BRIDGE_FETCH_MAX_RESPONSE_BYTES = 50 * 1024 * 1024

/**
 * The host's `timeoutMs` bounds the WHOLE request, body included — not an
 * idle gap. Sized to the cap above: 50 MiB at an ordinary 1 Mbit/s is about
 * seven minutes, so a minute (what this was when the cap was 5 MiB) failed a
 * large tarball on a slow link with a timeout instead of finishing it.
 */
export const BRIDGE_FETCH_TIMEOUT_MS = 10 * 60_000

/**
 * Create a `fetch`-compatible function that routes through the
 * `network.httpGet` bridge route. Only GET requests are supported.
 */
export function createBridgeBackedFetch(opts: {
  transport: BrowserBridgeTransport
  createRequestId: () => string
}): FetchLike {
  const { transport, createRequestId } = opts
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      throw new Error(
        `[bridgeBackedFetch] only GET is supported (got '${method}'); use the worker's directBridge for POST etc.`,
      )
    }
    const headers: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value
        })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v
      } else {
        Object.assign(headers, init.headers as Record<string, string>)
      }
    }
    const followRedirects = init?.redirect !== 'manual'
    void init?.signal
    const response = await transport.request({
      id: createRequestId(),
      route: createBridgeRoute('network', 'httpGet'),
      payload: {
        url,
        headers,
        followRedirects,
        maxResponseBytes: BRIDGE_FETCH_MAX_RESPONSE_BYTES,
        timeoutMs: BRIDGE_FETCH_TIMEOUT_MS,
      },
    })
    if (!response.ok) {
      throw new Error(
        `[bridgeBackedFetch] ${response.error.code}: ${response.error.message ?? '(no message)'}`,
      )
    }
    const result = response.result as {
      status: number
      statusText: string
      finalUrl: string
      headers: Record<string, string>
      body: Uint8Array
    }
    return buildFetchResponse(result, url)
  }) as FetchLike
}

function buildFetchResponse(
  result: {
    status: number
    statusText: string
    finalUrl: string
    headers: Record<string, string>
    body: Uint8Array
  },
  requestUrl: string,
): Response {
  const responseHeaders = new Headers(result.headers)
  const noBodyStatus = result.status === 204
    || result.status === 205
    || result.status === 304
    || (result.status >= 100 && result.status < 200)
  const body = noBodyStatus ? null : (result.body as BodyInit)
  const response = new Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers: responseHeaders,
  })
  // The URL the bytes came from after redirects, as a fetch response reports
  // it: the https source checks it (every hop must be https).
  if (typeof result.finalUrl === 'string' && result.finalUrl.length > 0) {
    Object.defineProperty(response, 'url', { value: result.finalUrl })
  }
  void requestUrl
  return response
}
