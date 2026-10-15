import type { PromptProfile } from '../../prompting/promptProfile'

export type NexusModelPattern = string | RegExp

export type NexusThinkingTier = string

/**
 * How a model's transport carries an @-mentioned PDF: `native` (a vendor document
 * part), `rasterize` (page images via `Read` with `pages`), or `none` (a reference).
 */
export type NexusDocumentInputMode = 'native' | 'rasterize' | 'none'

type VersionOverridable = Omit<
  NexusConfiguredModel,
  'model' | 'exclude' | 'family' | 'minVersion' | 'maxVersion' | 'versions'
>

/**
 * What a FAMILY row may restate for one of its versions (`versions`): the
 * per-model fields, never the row's identity or its range. A field written
 * `undefined` is TAKEN AWAY for that version — it has no tier list, it does
 * not opt out of the todo tools — where a field left out is the row's.
 */
export type NexusModelVersionOverride = {
  [K in keyof VersionOverridable]?: VersionOverridable[K] | undefined
} & {
  /**
   * The version's model id (`'claude-opus-5'`). With it the version is a
   * KNOWN one: offered like the verified version — in the curated view, to
   * the host, and so in the picker's Add models — even when the provider's
   * listing does not name it (no key yet, a failed fetch, a provider that
   * lists nothing). Without it the version exists only once it is listed.
   */
  id?: string
}

export type NexusConfiguredModel = {
  /**
   * The model this row is written for. On a FIXED row (no `family`) it is
   * the whole of the row's reach: the ids the pattern matches, nothing else,
   * and the model never changes under the user. On a FAMILY row it names the
   * family's VERIFIED version — the newest one these figures were checked
   * against; it is what the host and a listing-less boot see for the family.
   */
  model: NexusModelPattern
  /**
   * Makes this a FAMILY row (key compared case-insensitively): every version inside
   * `minVersion`..`maxVersion` reads THIS row, opt-in flags included; differences go
   * under `versions`. A matching FIXED row answers for its id instead.
   */
  family?: string
  /** The oldest version the row's figures hold for (`'4.8'`). An older one is
   *  not this row's: it reads a fixed row, or nothing. Absent = no floor. */
  minVersion?: string
  /** The newest version the row may be read for — the brake for a version
   *  that turns out to break the family's contract. Absent = no ceiling. */
  maxVersion?: string
  /** Per-version differences, keyed by version label (`'5'`, `'5.2-preview'`).
   *  Each wins over the listing and over the row, field by field. */
  versions?: Record<string, NexusModelVersionOverride>
  name?: string
  exclude?: NexusModelPattern[]
  defaultThinkingTier?: NexusThinkingTier
  availableThinkingTiers?: NexusThinkingTier[]
  /**
   * System-prompt profile (`lean` / `standard`). `lean` is opt-in and this field is
   * its ONLY source; omitted means `standard` (fails safe).
   */
  promptProfile?: PromptProfile
  /**
   * Whether this model is offered `TodoWrite` (tool, prose line and nudge together).
   * `false` is opt-out and this field its ONLY source; omitted means the tool is
   * offered. Not derived from `promptProfile`.
   */
  todoTools?: boolean
  /**
   * Hard-coded context window (total input tokens the model accepts) in
   * tokens. Source of truth for UI token meters and request-size gating.
   * Providers do not reliably expose this via `/v1/models` (only Google
   * returns `inputTokenLimit`), so we keep the table in one place here.
   */
  contextWindow?: number
  /**
   * Default tokens reserved for a single response when the caller does
   * not specify `max_tokens`. Smaller than `maxOutputTokens` so the
   * common case doesn't over-reserve slot capacity. The recovery branch
   * in `engine/turnLoop.ts` escalates to `maxOutputTokens` (the upperLimit) on
   * `stop_reason: 'max_tokens'`.
   */
  defaultMaxOutputTokens?: number
  /**
   * Hard upper ceiling — model max per the vendor docs. Used as the
   * recovery escalation target when the API truncates a response with
   * `stop_reason: 'max_tokens'`. NOT the initial-request default;
   * see `defaultMaxOutputTokens` for that.
   */
  maxOutputTokens?: number
  /**
   * Per-model character floor for LLM-driven history compaction. Unused:
   * autocompaction fires on token pressure.
   */
  compactionTriggerCharCount?: number
  /**
   * Opt into strict tool schemas (grammar-constrained sampling) for this model.
   * Default `false`: a provider rejects a strict schema with an unsupported keyword.
   */
  supportsStrictTools?: boolean
  /**
   * Whether the model accepts image input; gates composer attachments and replaces
   * stray image parts with a placeholder. Omitted = supported.
   */
  supportsImageInput?: boolean
  /**
   * Per-model override of the provider's `documentInput` — for a row whose
   * wire differs from its provider's (none do today). Omit = the provider's
   * value. See `NexusDocumentInputMode`.
   */
  documentInput?: NexusDocumentInputMode
}

export type NexusProviderFilterMode = 'curated' | 'passthrough'

import type { ProviderSpec } from '../../models/drivers/driverTypes'

export type NexusProviderModelConfig = {
  providerId: string
  filterMode?: NexusProviderFilterMode
  /**
   * The base URL when the user set none; the single source of truth, published to
   * the host. Absent for OAuth backends and custom endpoints. Security: every value's
   * host must be in `OFFICIAL_ENDPOINT_DOMAINS`.
   */
  defaultBaseUrl?: string
  /**
   * How this provider runs in the runtime: the `format` codec plus optional path,
   * User-Agent, headers (`{{secret:NAME}}`) and query. Absent = cannot serve a model
   * request. The `providerDrivers` URL override replaces it per session.
   */
  wire?: Omit<ProviderSpec, 'id'>
  models: NexusConfiguredModel[]
  /**
   * The provider's fast model for `queryFastModel`: a FAMILY key follows its
   * `latest`, a model id never moves; either resolves to ONE concrete id. Unset →
   * `mainLoopModel` with a breadcrumb.
   */
  fastModel?: string
  /**
   * Tier→model map for sub-session tiers, same contract as `fastModel` (`'fast'`
   * reuses it). Unset ⇒ a tier-requesting sub-session inherits the parent model.
   */
  balancedModel?: string
  bestModel?: string
  /**
   * Models a user-picked provider (a gateway) adds on its first verified connection.
   * Not a tier ladder; such a provider borrows one (borrowedTierLadder.ts).
   */
  starterModels?: string[]
  /**
   * SSE idle-timeout override (seconds): becomes the driver's `idleTimeoutMs`, which
   * `model.rawStreamOpen` enforces (clamped to 90 s; absent = 90 s).
   */
  streamIdleTimeoutSeconds?: number
  /**
   * Per-provider SSE concurrency cap (0 = unlimited). Over the cap, streams
   * queue FIFO. The ChatGPT-subscription (Codex) backend silently hangs
   * over-quota connections, so chatgpt-pro pins this to 1. Runs as the
   * driver stream host's per-provider FIFO (`DriverStreamHost`); the copy
   * `publishProviderConfigs` writes (`max_concurrent_streams`) is unread.
   */
  maxConcurrentStreams?: number
  /**
   * User-Agent the host sends on this provider's HTTP requests. Absent ⇒ the
   * host's own default. Code-owned like the stream guards above: never read
   * from settings.json, and injected into every `publishProviderConfigs`
   * payload by `withProviderUserAgents` (`config/providerUserAgent.ts`), so
   * changing it here reaches every profile on its next publish.
   */
  userAgent?: string
  /**
   * How this provider's wire carries a PDF (`NexusDocumentInputMode`); a
   * model row's own `documentInput` wins. A property of the WIRE, not the
   * model: the value is what the provider's request translator can emit
   * (verified against each vendor's API reference — F-12).
   * Resolution also looks at the endpoint and the model's image input —
   * read it through `resolveDocumentInputMode`, never directly.
   */
  documentInput?: NexusDocumentInputMode
  /**
   * The model catalog's provider keys (F-28), tried in order; a row's unset figures
   * read the first record found, a set value always wins. Every key must be in
   * `SNAPSHOT_PROVIDER_KEYS`. Absent = nothing from the catalog.
   */
  catalog?: {
    keys: string[]
    /**
     * Opt-in: a row that states no `availableThinkingTiers` takes the record's
     * effort list (runtime tier vocabulary). Only for a provider whose
     * `reasoning` mapper sends every tier the catalog can state.
     */
    thinkingTiers?: boolean
    /** The default for catalog-filled tiers when the list holds it; else `medium`,
     *  else the first non-`none` tier. */
    defaultThinkingTier?: NexusThinkingTier
  }
}

export type NexusModelConfig = {
  providers: NexusProviderModelConfig[]
}
