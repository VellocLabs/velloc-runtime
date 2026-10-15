/**
 * Provider drivers: wire formats implemented in the runtime (P-4). A driver owns two
 * translations: the bridge payload → one HTTP request (`{{secret:NAME}}`
 * placeholders), and the response bytes → `DriverStreamEvent`s. Everything else is
 * shared: chunkEmitter.ts, the host's `model.rawStream*` transport (which
 * substitutes the secrets), and driverStreamHost.ts.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import type { CodecCompat } from '../../config/nexusModelConfig/providerDefinition'

/** Token usage, in the host's own units (`LlmUsage`). */
export type DriverUsage = {
  promptTokens: number
  completionTokens: number
  promptCacheHits?: number
  promptCacheWrites?: number
}

/** The host's `FinishReason` vocabulary (`ParseFinishReasonString`). */
export type DriverFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'error'
  | 'other'
  | 'unknown'

export type DriverStreamEvent =
  | { type: 'message_start'; model?: string; usage?: DriverUsage }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  /**
   * `kReasoningSignature`: an opaque replay payload for this message's
   * reasoning — today the host's `velloc-replay-v1:` envelope
   * (`encodeReasoningReplaySignature`, hostCallOptions.ts). Surfaces on the
   * bridge as a `signature_delta` on the message's last thinking block, or on
   * a thinking block of its own when the reasoning streamed no text. An empty
   * signature emits nothing.
   */
  | { type: 'reasoning_signature'; signature: string }
  /** A tool call began streaming; its arguments follow as deltas. */
  | { type: 'tool_call_start'; id?: string; name?: string }
  /** Incremental argument JSON text (and/or a late name) for a tool call. */
  | { type: 'tool_call_delta'; id?: string; name?: string; argsTextDelta?: string }
  /** A complete tool call (a provider that sends whole calls, or the close
   *  of a streamed one — `input` overrides the accumulated argument text). */
  | { type: 'tool_call'; id?: string; name?: string; input?: unknown }
  | {
      type: 'finish'
      finishReason?: DriverFinishReason
      usage?: DriverUsage
      /** Anthropic-shaped `stop_details`, passed through unchanged. */
      stopDetails?: Record<string, unknown>
    }
  /** Terminal. `message` is the display string (the host's canonical
   *  provider-error text), passed through unchanged — even `""` (the host's
   *  `error_message` is always engaged); the typed fields drive retry
   *  classification. */
  | { type: 'error'; message: string; httpStatus?: number; retryAfterSeconds?: number }

/** One HTTP request, in the shape `openRawProviderStream` takes. Secrets
 *  appear only as `{{secret:NAME}}` in header / query values. */
export type DriverHttpRequest = {
  url: string
  method?: string
  headers: Record<string, string>
  queryParams?: Record<string, string>
  body: Uint8Array
}

export type DriverRequestContext = {
  /** The provider id the host resolves secrets and the base URL for. */
  providerId: string
  /** The provider's effective base URL (settings override, else the
   *  host's), without a trailing slash. */
  baseUrl: string
  /** The model the request is for (already resolved; never 'inherit'). */
  model: string
  /** The model's codec switches (`ProviderSpec.compat`); a codec reads only
   *  the ones that mean something on its wire and ignores the rest. */
  compat?: CodecCompat
}

/**
 * One id a request body carries, as the codec that wrote the body sees it
 * (the id mapper, mods/provider/ids, finds, maps and rewrites these).
 */
export type IdSite = {
  /** A tool call's id or a tool result's reference to it (`toolCall`), a
   *  message / item id (`message`), a reasoning item's id (`reasoning`). */
  kind: 'toolCall' | 'message' | 'reasoning'
  /** The id as the body holds it. */
  value: string
  /** Where it is in the parsed JSON body: object keys and array indexes. */
  path: ReadonlyArray<string | number>
  /** The position of the message (or input item) that holds it, in the
   *  request's own order. */
  index: number
  /** That message's role as the wire names it (`assistant`, `tool`, `user`…). */
  role: string
  /** Where that message is in the parsed body; its content is what
   *  `contentSha256` digests. */
  messagePath: ReadonlyArray<string | number>
}

/** Incremental response decoder for one request. */
export interface DriverResponseDecoder {
  /** Feed response bytes as they arrive; returns the events they complete. */
  push(bytes: Uint8Array): DriverStreamEvent[]
  /** The response ended normally; flush what is buffered. Must end with a
   *  `finish` (or an `error`) event. */
  end(): DriverStreamEvent[]
  /**
   * Optional. The response broke off: return what the provider would still emit
   * BEFORE the error. Called instead of `end()`. If the events end with a terminal
   * (`finish` / `error`), the caller's transport error must NOT follow; otherwise
   * the caller appends it.
   */
  abort?(): DriverStreamEvent[]
}

export interface ProviderDriver {
  /** Stable id referenced by provider configuration (`wireDriver`). */
  readonly id: string
  /**
   * How this format authenticates, as `{{secret:NAME}}` templates — the
   * headers / query parameters `buildRequest` puts on every call. A request
   * that is not a model call (the model listing, the key probe:
   * `ModelProvider.get`) is sent with these, then the spec's overrides.
   */
  readonly auth: { headers?: Record<string, string>; queryParams?: Record<string, string> }
  /**
   * Optional. True when these (already merged) request headers carry the
   * credential themselves, so the format's own `auth.queryParams` entry for it
   * must not be sent as well (a header-authenticated endpoint of a format that
   * authenticates by query). Absent = the format's auth is always sent.
   */
  authCarriedByHeaders?(headers: Record<string, string>): boolean
  buildRequest(
    payload: BridgeModelRequestPayload,
    context: DriverRequestContext,
  ): DriverHttpRequest
  createDecoder(context: DriverRequestContext): DriverResponseDecoder
  /**
   * Optional. Where this wire carries ids in the parsed body `buildRequest` wrote, in
   * the request's own order. Pure. The mapper rewrites the strings at these paths.
   */
  idSites?(body: unknown): IdSite[]
  /**
   * Whether the C++ provider decodes a response with this HTTP status as a
   * stream; any other status goes to `errorFromResponse`. Absent = any 2xx.
   * (C++ OpenAI streams everything below 400; C++ Anthropic only 200.)
   */
  isStreamStatus?(status: number): boolean
  /**
   * A response the provider does not stream (see `isStreamStatus`), fully
   * read. Returns the terminal `error` event in the
   * host's canonical provider-error format so the agent loop's retry
   * classifier treats it exactly like a C++ provider's error.
   */
  errorFromResponse(response: {
    status: number
    statusText: string
    headers: Record<string, string>
    bodyText: string
  }): Extract<DriverStreamEvent, { type: 'error' }>
}

/**
 * A runtime model provider: WHICH wire format it speaks and HOW it is
 * reached. The runtime creates a `ModelProvider` (modelProvider.ts) from one
 * of these — every provider shares the format codecs, the chunk emitter and
 * the host transport; only this configuration differs.
 */
export type ProviderSpec = {
  /** Provider id: the host scopes secrets and the base URL to it. */
  id: string
  /** Wire format codec id (`openai-chat`, `openai-responses`,
   *  `anthropic-messages`, …) — a registered `ProviderDriver`. */
  format: string
  /** Endpoint base URL. Absent = the settings override, else the host's,
   *  else the catalog default. */
  baseUrl?: string
  /** Replaces the codec's request path (the part after the base URL, e.g.
   *  `/v1/chat/completions` for a relay that keeps the `/v1`). */
  path?: string
  /** Sent as User-Agent. Absent = the host applies the provider's preset. */
  userAgent?: string
  /**
   * Header overrides, merged case-insensitively. A value may use `{{secret:NAME}}`,
   * and an OAuth-backed provider `{{oauth:access_token}}` / `{{oauth:account_id}}`
   * (host-resolved; an empty account_id expansion omits the header). An empty string
   * REMOVES the codec's header of that name.
   */
  headers?: Record<string, string>
  /** Query parameters added to every request; values may use
   *  `{{secret:NAME}}`. */
  queryParams?: Record<string, string>
  /** No-bytes abort for a stream, ms (clamped by the host to 90 000).
   *  Absent = the host default. */
  idleTimeoutMs?: number
  /**
   * At most this many of the provider's requests (streams and blocking calls
   * alike) are open at once; the rest wait FIFO — what the removed C++ stream
   * guard did (`LlmStreamGuard`, `max_concurrent_streams`). Absent or 0 =
   * unlimited.
   * Filled from the catalog's `maxConcurrentStreams` (`resolveProviderSpec`).
   */
  maxConcurrentStreams?: number
  /**
   * The provider may run without an API key — a custom endpoint, which the
   * host class builds with `requires_api_key=false` (cursor-api-proxy, LM
   * Studio, a local gateway). With no key stored
   * (`providerHasStoredApiKey`), `{{secret:api_key}}` is sent as the empty
   * credential that class sends (`Bearer `, an empty `x-api-key`) instead of
   * a template the host would refuse. Absent = a key is required.
   */
  apiKeyOptional?: boolean
  /** Codec switches for this spec (a model's `wire.compat`, merged by
   *  `resolveProviderSpec`). Absent = every codec's own behaviour. */
  compat?: CodecCompat
}

// The provider-neutral shapes a provider's own directory produces live with
// the provider definitions (config/nexusModelConfig/providerDefinition.ts).
export type {
  CodecCompat,
  ModelWire,
  ProviderModelInfo,
  ProviderVerifyResult,
} from '../../config/nexusModelConfig/providerDefinition'
