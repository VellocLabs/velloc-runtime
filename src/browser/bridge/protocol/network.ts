/**
 * `network` bridge capability — an HTTP GET primitive in the browser process (NOT
 * subject to renderer CORS). C++-side defaults: timeoutMs 60_000, maxResponseBytes
 * 50 MB (a larger value is honoured), followRedirects false, maxRedirects 10.
 */

/**
 * Response envelope for `network.httpGet`. `body` is a fully-populated
 * `Uint8Array` (empty with no body); multi-value headers are comma-joined;
 * `finalUrl` differs from the request only when a redirect was followed.
 */
export type BridgeHttpGetResult = {
  status: number
  statusText: string
  finalUrl: string
  headers: Record<string, string>
  body: Uint8Array
}

/**
 * Payload of `network.httpRequest` — any method, an optional body (F-25).
 * Security: under the C++ egress policy the connected IP must be publicly
 * routable at the first response and every redirect, else `EGRESS_BLOCKED`
 * (through a proxy only the literal-host check applies). `allowPrivateNetwork`
 * opts out, exposed only where a person asked for a local server. The policy is
 * the DEFAULT here and opt-in on `httpGet`.
 */
export type BridgeHttpRequestPayload = {
  url: string
  /** Upper-cased HTTP method token. Default GET; CONNECT / TRACE / TRACK refused. */
  method?: string
  /** Request headers; the hop-by-hop / forbidden ones (Host, Cookie, …) are dropped. */
  headers?: Record<string, string>
  /** Request body; refused on GET / HEAD; capped at 16 MiB (`REQUEST_TOO_LARGE`). */
  body?: Uint8Array
  timeoutMs?: number
  maxResponseBytes?: number
  followRedirects?: boolean
  maxRedirects?: number
  allowPrivateNetwork?: boolean
  /** Appended after the URL is validated. Values may carry
   *  `{{secret:NAME}}` (manifest primitive `network.secretTemplates`). */
  queryParams?: Record<string, string>
  /** An x-www-form-urlencoded body the host builds (Content-Type set unless
   *  given). Values may carry `{{secret:NAME}}` for the URL's origin; refused
   *  with `body`, on GET / HEAD, and — when a secret went in — with
   *  `followRedirects`. Manifest primitive `network.secretFormBody`. */
  formParams?: Record<string, string>
  /** An OAuth-backed provider (chatgpt-pro, github-copilot, qwen-code) whose
   *  `{{oauth:access_token}}` / `{{oauth:account_id}}` header / query values
   *  this request uses: the host refreshes / exchanges the token first, the
   *  URL must stay on the provider's domain (TARGET_NOT_ALLOWED), and the
   *  values never come back (OAUTH_UNAVAILABLE when not signed in). Manifest
   *  primitive `network.oauthTemplates`. A value carrying
   *  `{{oauth:account_id}}` that expands to nothing is omitted
   *  (`model.rawStreamOpen.oauthOptional`). */
  providerId?: string
}

/** `network.streamOpen` — general streaming HTTP (the `model.rawStream*`
 *  shapes, not provider-scoped), under the egress policy by default and
 *  with no response cap unless `maxResponseBytes`. */
export type BridgeNetworkStreamOpenPayload = {
  url: string
  method?: string
  /** Reserved headers are refused. Values may carry `{{secret:NAME}}`. */
  headers?: Record<string, string>
  /** Appended after validation. Values may carry `{{secret:NAME}}`. */
  queryParams?: Record<string, string>
  /** Rides a transferred port (`request_port`); empty for none. */
  body: Uint8Array
  /** 8-64 chars [A-Za-z0-9_-]: lets `streamCancel` cancel before the head. */
  streamId?: string
  idleTimeoutMs?: number
  maxResponseBytes?: number
  allowPrivateNetwork?: boolean
  /** See `BridgeHttpRequestPayload.providerId` ({{oauth:NAME}}). */
  providerId?: string
}

export type BridgeNetworkStreamHead = {
  streamId: string
  status: number
  statusText: string
  finalUrl: string
  headers: Record<string, string>
}

export type BridgeNetworkStreamReadResult = {
  done: boolean
  errorCode?: string
  errorMessage?: string
  /** Stitched from the response port (`response_port`). */
  chunk: Uint8Array
}

export type BridgeNetworkWsOpenPayload = {
  /** ws:// or wss:// */
  url: string
  protocols?: string[]
  /** Values may carry `{{secret:NAME}}` (matched against the https twin). */
  headers?: Record<string, string>
  socketId?: string
  allowPrivateNetwork?: boolean
}

/** Host-pushed `network.onWsMessage`: exactly one of text / dataBase64. */
export type BridgeNetworkOnWsMessagePayload = {
  socketId: string
  text?: string
  dataBase64?: string
}

/** Host-pushed `network.onWsClose`, once per socket. */
export type BridgeNetworkOnWsClosePayload = {
  socketId: string
  code: number
  reason: string
  wasClean: boolean
}

export type NetworkBridgeActionMap = {
  httpRequest: {
    payload: BridgeHttpRequestPayload
    result: BridgeHttpGetResult
  }
  // ---- Additive native primitives (P-3) -----------------
  streamOpen: {
    payload: BridgeNetworkStreamOpenPayload
    result: BridgeNetworkStreamHead
  }
  streamRead: {
    payload: { streamId: string; waitMs?: number; maxBytes?: number }
    result: BridgeNetworkStreamReadResult
  }
  streamCancel: {
    payload: { streamId: string }
    result: { ok: true }
  }
  wsOpen: {
    payload: BridgeNetworkWsOpenPayload
    result: { socketId: string; protocol: string }
  }
  wsSend: {
    payload: { socketId: string; text?: string; dataBase64?: string }
    result: { sent: boolean }
  }
  wsClose: {
    payload: { socketId: string; code?: number; reason?: string }
    result: { found: boolean }
  }
  /** Host-pushed EVENTS (never requested). */
  onWsMessage: {
    payload: BridgeNetworkOnWsMessagePayload
    result: never
  }
  onWsClose: {
    payload: BridgeNetworkOnWsClosePayload
    result: never
  }
  httpGet: {
    payload: {
      /**
       * Absolute http(s) URL. Caller is responsible for any
       * length-cap / scheme-allow-list / credentials-stripping
       * BEFORE the call — the bridge runs the same checks defensively
       * and rejects with `INVALID_URL` if any fail, but a clean
       * error message at the caller is friendlier.
       */
      url: string
      /**
       * Optional request headers. Map of string→string. Do NOT
       * include `Authorization` here — that's reserved for the LLM
       * provider path. `User-Agent` is auto-populated as
       * `Mozilla/5.0 (Velloc WebFetch)` when omitted; passing it
       * explicitly overrides.
       */
      headers?: Record<string, string>
      /**
       * Hard timeout in milliseconds. Default 60_000 when omitted.
       * Past the deadline the loader is cancelled at the network
       * layer; the call resolves with a `TIMEOUT` error envelope.
       */
      timeoutMs?: number
      /**
       * Cap on response-body size, default 50 MB; a larger value is honoured, with a
       * typed `RESPONSE_TOO_LARGE` past it. For unbounded streaming, use `network.streamOpen`.
       */
      maxResponseBytes?: number
      /**
       * `false` (default): 3xx responses come back AS-IS for the caller to decide.
       * `true`: the loader follows up to `maxRedirects` hops.
       */
      followRedirects?: boolean
      /**
       * Maximum redirect hops when `followRedirects=true`. Default 10.
       * Past this count the loader aborts with
       * `REDIRECT_LIMIT_EXCEEDED`.
       */
      maxRedirects?: number
      /**
       * `false` runs this request under the egress policy (publicly
       * routable endpoints only). Default TRUE on this route: httpGet keeps
       * its pre-policy reach (WebFetch, marketplace / skill downloads may
       * name a local or LAN server). See
       * `BridgeHttpRequestPayload`.
       */
      allowPrivateNetwork?: boolean
    }
    result: BridgeHttpGetResult
  }
}
