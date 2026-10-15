import type { NexusProviderConfig } from '../../../settings/settingsTypes'
import type { LocalizedText } from '../../../config/localizedText'
import type {
  CredentialPrompt,
  ProviderCredentialMethod,
  ProviderModelsUi,
  ProviderSecretDecl,
  ProviderSettingField,
} from '../../../mods/provider/providerManifest'
import type { ManagedBinaryRegistryWire } from '../../../utils/binaryRegistry'
import {
  ROLE_SYSTEM,
  ROLE_USER,
  ROLE_ASSISTANT,
  ROLE_TOOL,
  PART_TEXT,
  PART_THINKING,
  PART_REDACTED_THINKING,
  PART_IMAGE,
  PART_DOCUMENT,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  TOOL_DEF_FUNCTION,
  STREAM_CONTENT_BLOCK_START,
  STREAM_CONTENT_BLOCK_DELTA,
  STREAM_CONTENT_BLOCK_STOP,
  STREAM_MESSAGE_START,
  STREAM_MESSAGE_DELTA,
  STREAM_MESSAGE_STOP,
  STREAM_ERROR,
} from '../../../runtime/VercelModelConstants'

export type BrowserLlmSelection = {
  providerId: string
  modelId: string
  /**
   * Reasoning-effort tier, one of the model's `availableThinkingTiers`; when the
   * provider supports it, spliced into the request as `providerBodyExtension`.
   */
  thinkingTier?: string
}

export type BrowserLlmModel = {
  id: string
  label: string
  enabled: boolean
  supportsStreaming?: boolean
  supportsTools?: boolean
  defaultThinkingTier?: string
  availableThinkingTiers?: string[]
  /**
   * Total input-token context window for the model. Sourced from the
   * hard-coded table in `NEXUS_MODEL_CONFIG` — providers do not reliably
   * expose this value via their APIs.
   */
  contextWindow?: number
  /**
   * Maximum output (completion) tokens produced in a single response.
   * Sourced from the same hard-coded table as `contextWindow`.
   */
  maxOutputTokens?: number
  /**
   * Webview-only display alias set by `createConfiguredProvider`, never by the host:
   * pickers skip rows carrying it and render the alias row instead.
   */
  pickerAliasId?: string
  /**
   * Whether the model accepts inline images, from the curated catalog only
   * (`CustomModelCapabilities.vision` is deliberately NOT consumed). Absent = supported.
   */
  supportsImageInput?: boolean
  /**
   * The listing's base price, USD per million tokens — set by the runtime on
   * a gateway's rows (`ProviderModelInfo.price`). Guest-internal — the host
   * never sets it.
   */
  price?: { input: number; output: number }
  /** The listing prices the model at zero (a gateway's free models).
   *  Guest-internal, like `price`. */
  free?: boolean
  /**
   * Set by the runtime on a MODEL ENTRY row (config/nexusModelConfig/
   * modelEntries.ts): the row's id is a virtual `<family>@<version>`, and this
   * says what it is and what it resolves to today. Guest-internal — the host
   * never sets it.
   */
  entry?: BrowserLlmModelEntryInfo
}

export type BrowserLlmModelEntryInfo = {
  kind: 'latest' | 'pinned'
  family: string
  /** `Claude Opus` — the family's name without a version. */
  familyLabel: string
  /** `latest`, or the pinned version label. */
  version: string
  /** The version it resolves to now (`5.1`); absent while unresolved. */
  resolvedVersion?: string
  /** The concrete model id it resolves to now. */
  resolvedId?: string
  /** That model's own name (`GPT-5.6 Terra`) — what a Latest selection
   *  shows once chosen. */
  resolvedLabel?: string
  preview: boolean
  /** The model is outside the provider's curated catalog (added from the
   *  Add models dialog's Other models): its figures are conservative
   *  defaults, not verified ones. */
  unverified?: boolean
}

/** One family of a provider's entries, for the quick picker's "⋯" menu. */
export type BrowserLlmEntryFamily = {
  family: string
  familyLabel: string
  /** Newest first, previews after the stable versions. `id` is the concrete
   *  model the version resolves to now; `pinned` = already an entry. */
  versions: Array<{ versionLabel: string; id: string; preview: boolean; pinned: boolean }>
}

/**
 * What the page needs to draw a provider mod and its sign-in, carried on the
 * catalog row (the worker-side registry is not in the page realm). Guest-internal.
 */
export type BrowserLlmModProvider = {
  /** `ready`; or `plugin-missing` — the config is kept but the plugin that
   *  provided the provider is not installed (data only). */
  state: 'ready' | 'plugin-missing'
  /** The plugin that adds the provider. */
  plugin?: string
  /** The plugin's version, as of the registration. */
  version?: string
  /** The plugin's id as settings.json `pluginConfigs` is keyed
   *  (`<name>@<marketplace>`, `<name>@inline`): where its options live. */
  configId?: string
  displayName?: LocalizedText
  defaultBaseUrl?: string
  credentialMethods?: ProviderCredentialMethod[]
  /** Credentials beyond the API key. */
  secrets?: ProviderSecretDecl[]
  /** Declared settings fields. */
  settings?: Record<string, ProviderSettingField>
  /** Declared sign-in fields. */
  prompts?: CredentialPrompt[]
  /** The module reads its own secrets in plain text (shown at consent). */
  readsSecrets?: boolean
  /** How the aggregated "Add models" page is drawn (manifest `modelsUi`). */
  modelsUi?: ProviderModelsUi
}

export type BrowserLlmProvider = {
  id: string
  label: string
  iconSvg: string
  enabled: boolean
  defaultModelId?: string
  models: BrowserLlmModel[]
  /** Set for a provider mod's row. Guest-internal. */
  mod?: BrowserLlmModProvider
  /** Set by the runtime when the rows are model entries: the families of
   *  those entries, with every version they list. Guest-internal. */
  entryFamilies?: BrowserLlmEntryFamily[]
}

export type BrowserLlmCatalog = {
  providers: BrowserLlmProvider[]
  defaultSelection?: BrowserLlmSelection
  rawCatalogs?: Record<string, string>
}

export type BridgeModelMessageRole =
  | typeof ROLE_SYSTEM
  | typeof ROLE_USER
  | typeof ROLE_ASSISTANT
  | typeof ROLE_TOOL

export type BridgeModelTextContentPart = {
  type: typeof PART_TEXT
  text: string
}

export type BridgeModelThinkingContentPart = {
  type: typeof PART_THINKING
  thinking: string
  signature?: string
}

export type BridgeModelRedactedThinkingContentPart = {
  type: typeof PART_REDACTED_THINKING
  data?: string
}

export type BridgeModelImageContentPart = {
  type: typeof PART_IMAGE
  image?: string
  data?: string
  url?: string
  mimeType?: string
  mime_type?: string
}

export type BridgeModelDocumentContentPart = {
  type: typeof PART_DOCUMENT
  data?: string
  document?: string
  mimeType?: string
  mime_type?: string
}

export type BridgeModelToolCallContentPart = {
  type: typeof PART_TOOL_CALL
  toolCallId: string
  toolName: string
  args?: unknown
}

export type BridgeModelCanonicalToolResultContentPart = {
  type: typeof PART_TOOL_RESULT_CANONICAL
  result: unknown
  toolCallId: string
  toolName?: string
  isError?: boolean
}

export type BridgeModelContentPart =
  | BridgeModelTextContentPart
  | BridgeModelThinkingContentPart
  | BridgeModelRedactedThinkingContentPart
  | BridgeModelImageContentPart
  | BridgeModelDocumentContentPart
  | BridgeModelToolCallContentPart
  | BridgeModelCanonicalToolResultContentPart
  | {
      type: string
      [key: string]: unknown
    }

export type BridgeModelMessagePayload = {
  role?: BridgeModelMessageRole | string
  content?: string | BridgeModelContentPart[]
}

export type BridgeModelInputMessage = {
  type?: string
  message?: BridgeModelMessagePayload
  role?: BridgeModelMessageRole | string
  content?: string | BridgeModelContentPart[]
  [key: string]: unknown
}

export type BridgeModelToolDefinition = {
  type: typeof TOOL_DEF_FUNCTION
  name: string
  description?: string
  parameters: Record<string, unknown>
  /**
   * Opt into grammar-constrained sampling (Anthropic "Strict tool use",
   * OpenAI "Structured Outputs"). Set by the JS query layer when the
   * active provider+model supports it; the C++ Anthropic and OpenAI
   * bridges forward it onto the wire payload. Other providers (Google,
   * Ollama) don't have an equivalent flag and ignore the field.
   */
  strict?: boolean
  /**
   * Optional canonical example calls. Forwarded to Anthropic as
   * `input_examples` on the wire (other providers silently drop).
   * Each entry is an `input` dict that validates against `parameters`;
   * Anthropic returns 400 on any violation.
   */
  inputExamples?: Array<Record<string, unknown>>
}

/**
 * Why a model request is made — the coarse kind a provider may act on (a
 * vendor that words compaction requests differently, or bills titles apart).
 * Derived from the raw `querySource` tag by `purposeOfQuerySource`
 * (models/drivers/requestContext.ts), the one place that maps them.
 */
export type BridgeModelRequestPurpose =
  | 'turn'
  | 'compaction'
  | 'title'
  | 'summary'
  | 'mod'
  | 'fork'
  | 'other'

/**
 * Who asked for a model request and why. Runtime-internal: the model routes
 * are served in the runtime (driverTransport.ts) and never reach the host, so
 * this field crosses no C++ boundary.
 */
export type BridgeModelRequestContext = {
  /** The top-level session: for a sub-agent or teammate, its root's id. */
  sessionId?: string
  /** The sub-agent / teammate the request runs for; absent on the root. */
  agentId?: string
  purpose: BridgeModelRequestPurpose
  /** The raw caller tag (`sdk`, `compact`, `rename_generate_name`, …), for logs. */
  querySource: string
}

export type BridgeModelRequestPayload = {
  messages: BridgeModelInputMessage[]
  /**
   * Every sender sets it (modelTransport.ts for every `callModel` request,
   * the compaction summarizer for its own); optional only so that a test's
   * hand-built payload need not.
   */
  requestContext?: BridgeModelRequestContext
  /** Finished sections, joined host-side with a blank line. */
  systemPrompt?: string | readonly string[]
  userContext?: Record<string, string>
  systemContext?: Record<string, string>
  providerId?: string
  model?: string
  maxOutputTokens?: number
  providerBodyExtension?: Record<string, unknown>
  /** Full definitions, strict-vs-regular schema already chosen per tool. */
  tools?: BridgeModelToolDefinition[]
  toolUseContext?: Record<string, unknown>
  /**
   * Absolute epoch-ms deadline (JS t0 + streamIdleTimeoutSeconds) by which
   * the native side must resolve a blocking `call`. On expiry the host
   * resolves `{status:'timeout'}` and cancels the upstream request.
   * Optional: absent = no native deadline (legacy behaviour).
   */
  deadlineMs?: number
}

export type BridgeModelStreamChunk = {
  type:
    | typeof STREAM_CONTENT_BLOCK_START
    | typeof STREAM_CONTENT_BLOCK_DELTA
    | typeof STREAM_CONTENT_BLOCK_STOP
    | typeof STREAM_MESSAGE_START
    | typeof STREAM_MESSAGE_DELTA
    | typeof STREAM_MESSAGE_STOP
    | typeof STREAM_ERROR
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  message?: Record<string, unknown>
  /**
   * Terminal error chunk. `message` is the display string; the typed fields let the
   * retry classifier read STRUCTURE. Absent on old hosts.
   */
  error?: {
    type: string
    message: string
    httpStatus?: number
    retryAfterSeconds?: number
  }
  [key: string]: unknown
}

/**
 * Provider detail for a `stop_reason: 'content_filter'`, beside `stop_reason`.
 * Informational: branch on `stop_reason`, never on this (open set, all optional).
 */
export type NexusStopDetails = {
  type?: string
  category?: string
  explanation?: string
  recommended_model?: string
}

export type BridgeModelCallResult = {
  message: {
    role: typeof ROLE_ASSISTANT
    content: Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      toolCallId?: string
      toolName?: string
      args?: unknown
      [key: string]: unknown
    }>
    model?: string
    stop_reason?: string
    /** Present only beside `stop_reason: 'content_filter'`. */
    stop_details?: NexusStopDetails
    usage?: Record<string, unknown>
    [key: string]: unknown
  }
  /**
   * 'ok' = normal; 'timeout' = the native deadline fired (JS should retry);
   * 'queued' = cancelled still in the concurrency FIFO — `message` is an EMPTY
   * placeholder, never a reply (JS re-issues). Absent ⇒ 'ok'.
   */
  status?: 'ok' | 'timeout' | 'queued'
  /** Wall-clock stamps (epoch ms) for each hop — see traceLine. */
  timeline?: Record<string, number>
}

/**
 * Wire-format mirror of `nexusModelConfig.ts` that the C++ side caches.
 * RegExp `model` patterns are expanded to their `source` string before send
 * so the catalog is pure JSON. The C++ side does not pattern-match — it
 * stores the dict verbatim, applies its default base URLs, and
 * `BuildCatalog` derives a curated model id from each `model`
 * (`DeriveTsModelId`).
 */
export type NexusConfiguredModelWire = {
  model: string
  name?: string
  exclude?: string[]
  defaultThinkingTier?: string
  availableThinkingTiers?: string[]
  contextWindow?: number
  /**
   * Initial-request output-token reservation. Optional — see the
   * matching field on `NexusConfiguredModel`. C++ side stores verbatim
   * and ignores when absent.
   */
  defaultMaxOutputTokens?: number
  maxOutputTokens?: number
  /**
   * Whether the JS query layer is allowed to opt into provider strict
   * tool use for this model. Mirror of `NexusConfiguredModel.
   * supportsStrictTools`. C++ side caches the catalog verbatim; the
   * runtime decision is made on the JS side.
   */
  supportsStrictTools?: boolean
  /**
   * Whether the model accepts inline image content blocks. Mirror of
   * `NexusConfiguredModel.supportsImageInput`. C++ stores the catalog
   * verbatim; the gating decisions (composer UI + query-layer image
   * downgrade) are made on the JS side.
   */
  supportsImageInput?: boolean
}

export type NexusProviderModelConfigWire = {
  providerId: string
  filterMode?: 'curated' | 'passthrough'
  /**
   * The provider's default base URL (`NexusProviderModelConfig.
   * defaultBaseUrl`). The host compiles none in for API-key vendors and
   * applies this one to the live provider whenever no user override is set.
   * Additive on interface 1: an older host ignores it and keeps its own
   * compiled-in default.
   */
  defaultBaseUrl?: string
  models: NexusConfiguredModelWire[]
}

export type NexusModelConfigWire = {
  providers: NexusProviderModelConfigWire[]
}

/**
 * Host-pushed event carrying the whole unified agent runtime config dict.
 * Fired on boot (optionally) and whenever the `nexus.agent_config` pref
 * changes. The transport is generic: the guest forwards `config` to the
 * worker, which applies only the keys it recognizes (maxTurns,
 * model, …). Adding a setting never changes this shape.
 */
export type SessionApplyAgentConfigEvent = {
  config: Record<string, unknown>
}

export type ModelBridgeCapabilityMap = {
  model: {
    catalog: {
      payload: Record<string, never>
      result: BrowserLlmCatalog
    }
    // `call` / `streamStart` / `streamRead` / `streamCancel`: the model
    // request routes. The RUNTIME serves them (`withModelProviders`,
    // models/drivers/driverTransport.ts) on each provider's driver;
    // they never reach the host, whose native inference was removed under
    // interface 1. The shapes — `deadlineMs`, the held read,
    // `status` — are the contract the C++ host defined and the driver stream
    // host keeps.
    call: {
      payload: BridgeModelRequestPayload
      result: BridgeModelCallResult
    }
    streamStart: {
      payload: BridgeModelRequestPayload
      result: { streamId: string }
    }
    streamRead: {
      payload: {
        streamId: string
        /**
         * Absolute epoch-ms deadline (JS t0 + streamIdleTimeoutSeconds) by
         * which the native side must resolve this read. On expiry the host
         * resolves `{status:'timeout'}` and cancels the stream. Optional:
         * absent = legacy immediate-poll behaviour.
         */
        deadlineMs?: number
        /**
         * How long the host may hold this read waiting for new chunks
         * before resolving. 0/absent = return the current queue immediately.
         */
        waitMs?: number
      }
      result: {
        chunks: BridgeModelStreamChunk[]
        done: boolean
        /**
         * 'ok' = normal; 'timeout' = no new data by the deadline (JS should cancel +
         * retry); 'done' = finished; 'queued' = still in the provider's FIFO, NOT
         * provider silence (JS re-issues the hold). Absent ⇒ 'ok'.
         */
        status?: 'ok' | 'timeout' | 'done' | 'queued'
        /** Wall-clock stamps (epoch ms) for each hop — see traceLine. */
        timeline?: Record<string, number>
      }
    }
    /**
     * Tear down an in-flight stream: the driver stream host cancels its raw
     * provider stream (`rawStreamCancel`), so the upstream socket actually
     * closes — without this, an abort in the query loop just stops polling
     * streamRead and lets the LLM keep generating tokens until natural
     * completion. Idempotent.
     */
    streamCancel: {
      payload: { streamId: string }
      result: { ok: true }
    }
    /**
     * Generic provider byte transport: the guest owns the wire format, the host the
     * network and secrets. `{{secret:NAME}}` in a header or query value is
     * substituted host-side and never returned; `url` must stay on the provider's
     * registrable domain (a redirect off it drops secret headers). Resolves at the
     * response head; errors `CANCELLED`, `INVALID_ARGS`. Use `openRawProviderStream`.
     */
    rawStreamOpen: {
      payload: {
        providerId: string
        url: string
        method?: string
        /** Values may contain `{{secret:NAME}}`, and for an OAuth-backed
         *  provider `{{oauth:access_token}}` / `{{oauth:account_id}}` — the
         *  host runs its token refresh / exchange first and substitutes them
         *  host-side (manifest primitive `model.rawStreamOpen.oauth`;
         *  OAUTH_UNAVAILABLE when not signed in). A header or query value
         *  carrying `{{oauth:account_id}}` that expands to nothing is
         *  omitted (`model.rawStreamOpen.oauthOptional`). Cookie / Host /
         *  Content-Length / Proxy-Authorization are refused. */
        headers?: Record<string, string>
        /** Appended URL-encoded after the domain check; values may contain
         *  `{{secret:NAME}}` (e.g. Google's `key`). */
        queryParams?: Record<string, string>
        /** Rides a transferred port (`request_port` policy). */
        body: Uint8Array
        /** Store these JSON fields of the response as provider secrets and
         *  redact them from the body (buffered, <= 1 MB). `secret` is not
         *  `api_key`. The final read carries the sealed copies. */
        captureSecrets?: Array<{ pointer: string; secret: string }>
        /** Default 90_000; keep <= 90_000 (the `model` route fallback is 100s). */
        idleTimeoutMs?: number
        maxResponseBytes?: number
        /** Caller-chosen id, 8-64 chars `[A-Za-z0-9_-]`. The host keys the
         *  stream by it, so `rawStreamCancel` can cancel the request before
         *  the response head (the pending open then fails `CANCELLED`).
         *  Omitted: the host mints one. Additive on interface 1: an older host
         *  ignores it and answers its own id. */
        streamId?: string
      }
      result: {
        /** Echoes the caller's `streamId`, or the id the host minted. */
        streamId: string
        status: number
        statusText: string
        finalUrl: string
        headers: Record<string, string>
      }
    }
    rawStreamRead: {
      payload: { streamId: string; waitMs?: number; maxBytes?: number }
      result: {
        /** Response ended and every byte was delivered; the host forgot the id. */
        done: boolean
        errorCode?: string
        errorMessage?: string
        /** captureSecrets only, on the `done` read: secret name -> sealed
         *  (OS-keystore) value, for the guest to persist in settings.json. */
        captured?: Record<string, string>
        /** Stitched from the response port (`response_port` policy). */
        chunk: Uint8Array
      }
    }
    /** Idempotent; unknown ids succeed. Also cancels an open still waiting
     *  for its head, and an id not seen yet is remembered briefly so an open
     *  arriving after its own cancel is refused `CANCELLED`. */
    rawStreamCancel: {
      payload: { streamId: string }
      result: { ok: true }
    }
    setDefaultSelection: {
      payload: BrowserLlmSelection
      result: { ok: true }
    }
    // Pushes the curated NEXUS_MODEL_CONFIG snapshot to the C++ side at
    // boot (and on hot reloads of the online TS bundle). The browser
    // caches it: the default base URLs the providers need, and the curated
    // models `BuildCatalog` grafts into `model.catalog`.
    publishCatalog: {
      payload: { catalog: NexusModelConfigWire }
      result: { ok: true }
    }
    // Pushes the effective provider configs (api keys + base url + default
    // model, sourced from settings.json `providers.configs`) to the C++ LLM
    // broker. Mirrors `publishCatalog`: the worker calls this at boot and on
    // every providers write so the broker can configure its providers from
    // settings.json instead of (only) the legacy `nexus.provider_configs`
    // pref — the cred path that makes ModelsSection saves reach LLM calls
    // once the credential constraint is relaxed. The broker also writes the
    // configs back to the pref as a cold-boot cache.
    publishProviderConfigs: {
      payload: {
        configs: Record<string, NexusProviderConfig>
        activeProviderId?: string
      }
      result: { ok: true }
    }
    // Seals a provider api key with the OS keystore; returns `NEXUSENC1:` + base64.
    // The plaintext crosses the bridge exactly once, here, and never comes back.
    // Empty returns empty; an already-sealed value returns unchanged.
    encryptSecret: {
      payload: { plaintext: string }
      result: { value: string }
    }
    // Publishes the managed-binary download registry (pinned URLs + SHA-256
    // per platform/arch) the guest fetched SAME-ORIGIN from
    // managed-binaries.json, so the host's pinned set can be updated online
    // without a rebuild. The C++ `NexusBinaryConfigRegistry` validates each
    // asset and keeps the previous good config on a malformed publish, so
    // this is best-effort fire-and-forget. Reuses the `model` capability
    // (same publish-to-host transport as the catalog) — there's no separate
    // `binaries` capability.
    publishBinaryRegistry: {
      payload: ManagedBinaryRegistryWire
      result: { ok: true }
    }
  }
}

// Phase 12f: `SessionBridgeCapabilityMap` moved to its own file
// (`./session.ts`) alongside the new `onStop` and
// `setAgentLoopSettings` actions. It re-exports from there so existing
// imports keep working through the protocol/index barrel; new callers
// should import directly from './session'.
