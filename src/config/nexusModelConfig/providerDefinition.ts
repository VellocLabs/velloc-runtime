/**
 * One provider, one directory: `providers/<id>/` holds everything specific to it,
 * and its `index.ts` exports one `ProviderDefinition`. Nothing outside it branches on
 * its id; consumers read only the uniform shapes below.
 */
import type { MessageKey } from '../../browser/webview/i18n/messages/en'
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type { BrowserLlmModProvider } from '../../browser/bridge/protocol/nexus_llm'
import type { LocalizedText } from '../localizedText'
import type { PlanUsageAmount, PlanUsageSnapshot } from '../../models/usage/planUsage'
import type { ModelVersionInfo } from './providers/shared/modelVersions'
import type { NexusProviderModelConfig } from './types'

/** The thinking tier → request-body fields, merged over the wire's body last
 *  (`providerBodyExtension`). Undefined = send nothing for this tier. */
export type ReasoningMapper = (
  tier: string,
  context: { maxOutputTokens: number },
) => Record<string, unknown> | undefined

/**
 * The closed set of codec switches a model row may pick (`ModelWire.compat`).
 * A mod chooses among them; it cannot add one. A codec that has no meaning
 * for a switch ignores it (each codec says which it implements). Absent =
 * the codec's own behaviour, byte for byte.
 */
export type CodecCompat = {
  /** Which key carries the completion cap in a chat-completions body. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** `true`: system text goes out under the `developer` role. `false`
   *  (or absent): the codec's own system / instructions channel. */
  developerRole?: boolean
  /** `false`: the effort / reasoning field is left out of the body. */
  reasoningEffortField?: boolean
  /** Whether, and under which assistant-message field, the earlier
   *  reasoning text is sent back. `none` sends none. */
  reasoningReplay?: 'none' | 'reasoning_content' | 'reasoning'
}

/**
 * Where, and in which wire format, one model's requests go — laid over the
 * provider's own wire. Every field is optional; a model without `wire` uses
 * the provider's unchanged.
 */
export type ModelWire = {
  /** A registered codec id (`openai-chat`, `anthropic-messages`, …). */
  format?: string
  /** Same ORIGIN (scheme + host + port) as the provider's base URL; only the
   *  path part may differ. */
  baseUrl?: string
  /** Replaces the codec's request path; a path, never a URL, no `..`. */
  path?: string
  /** Merged over the provider's headers, case-insensitively; `''` drops one;
   *  a value may use `{{secret:NAME}}`. */
  headers?: Record<string, string>
  compat?: CodecCompat
}

/**
 * One model a provider lists, normalized — what the picker, the settings
 * page and the request builder need, whatever shape the provider's own
 * listing has. Everything but `id` is optional: a listing that does not say
 * leaves the runtime's defaults in place.
 */
export type ProviderModelInfo = {
  id: string
  name?: string
  contextWindow?: number
  /** The largest completion the model may produce. */
  maxOutputTokens?: number
  /** Function calling. The agent needs it; a model without it is never
   *  offered. */
  supportsTools: boolean
  supportsImageInput?: boolean
  supportsPdfInput?: boolean
  /**
   * Thinking tiers the model accepts, in the runtime's tier vocabulary
   * (`none`, `minimal`, `low`, `medium`, `high`, `extra-high`, `max`). `none`
   * is present only when reasoning can be switched off. Absent = the model
   * has no reasoning control.
   */
  thinkingTiers?: string[]
  /** The provider's own default tier for the model, when it states one. */
  defaultThinkingTier?: string
  /**
   * How the id reads as family / version, when the provider states it
   * (a provider mod's listing does — it has no id-reading rule of its own to
   * register, and the page reads nothing from the registry). Absent = the
   * shared reading of the id (`providers/shared/modelVersions.ts`).
   */
  family?: string
  version?: string
  /** The provider's own names for the runtime's tiers, for display only
   *  (`thinkingTiers` stays the fixed vocabulary). */
  thinkingTierLabels?: Partial<Record<string, LocalizedText>>
  /** The listing prices input AND output at zero. Absent = not free (or the
   *  listing says nothing about price). */
  free?: boolean
  /** The listing's base price, USD per million tokens. Absent = the listing
   *  states none (or a variable one). */
  price?: { input: number; output: number }
  /** One line about the model, shown under its name on the Add models page. */
  description?: LocalizedText
  /** The provider has retired or is retiring the model: the page marks it. */
  deprecated?: boolean
  /** A group the Add models page lists the model under (a name the
   *  provider's manifest `modelsUi.groups` may label). Absent = by vendor. */
  group?: string
  /** Badges on the model's row (names `modelsUi.tags` may label). */
  tags?: string[]
  /** This model's own wire over the provider's (several formats under one
   *  provider, a different path, codec switches). Absent = the provider's. */
  wire?: ModelWire
}

/**
 * The outcome of a key probe. `code` is the host's `providerAuth.verify`
 * vocabulary, which the settings page maps to its own text; `message` is the
 * provider's, for logs.
 */
export type ProviderVerifyResult =
  | { ok: true }
  | {
      ok: false
      code:
        | 'auth_unauthorized'
        | 'auth_forbidden'
        | 'network_unreachable'
        | 'network_timeout'
        | 'system_unexpected'
      message: string
      httpStatus?: number
    }

/** A GET relative to the provider's base URL, and how to read its JSON. */
export type ProviderDocumentSource<T> = {
  path: string
  /** The document needs no key: it is asked for without one, so it opens
   *  before a key is entered (a gateway's public model listing). */
  public?: boolean
  /** Headers over the request's own, case-insensitively (`''` drops one) —
   *  a document read with a credential other than the API key
   *  (`Bearer {{secret:<name>}}`, one of the definition's `secrets`). */
  headers?: Record<string, string>
  /** Throws on a document of the wrong shape. `now` is epoch ms. */
  parse(document: unknown, now: number): T
}

/**
 * A model listing produced by running a provider mod's code (`provider.models`)
 * rather than by reading a document. The runtime never starts that code to
 * answer a catalog read: it refreshes such a listing in the background only
 * while the module is already loaded, and asks for it on enable, on Refresh
 * and on the first connection.
 */
export type ProviderCodeListing = {
  /** The module's worker is up now. A cold module is not refreshed behind
   *  the person's back. */
  isLoaded(): boolean
  /** Ask the module for its models. Rejects when it cannot. */
  list(
    transport: BrowserBridgeTransport,
    providerId: string,
    options: { signal?: AbortSignal; now?: number },
  ): Promise<ProviderModelInfo[]>
  /**
   * The connection check, through the module's `provider.verify` hook. `core`
   * is what the runtime does with no hook (a GET of the models path with the
   * stored credential): it runs when the module has no such hook, or its hook
   * did not answer. Never rejects.
   */
  verify?(
    transport: BrowserBridgeTransport,
    providerId: string,
    options: { signal?: AbortSignal; core: () => Promise<ProviderVerifyResult> },
  ): Promise<ProviderVerifyResult>
  /** Usage through the module's `provider.usage` hook. Absent hook = none. */
  usage?: {
    /** False once the loaded module is known not to hook usage. */
    reports(): boolean
    /** Undefined when there is nothing to show; rejects when the hook failed. */
    fetch(
      transport: BrowserBridgeTransport,
      providerId: string,
      options: { signal?: AbortSignal; now?: number },
    ): Promise<PlanUsageSnapshot | undefined>
  }
}

export type ProviderDefinition = {
  /** The catalog entry — pure data, serialized to the host. */
  config: NexusProviderModelConfig
  /** The name the catalog row shows (a brand name, the same in every
   *  language); absent = the id. A provider mod's is its manifest
   *  `displayName` in English — the page picks the person's language from
   *  `catalogMod.displayName`. */
  label?: string
  /** Set for a provider mod: what the page needs to draw the provider and
   *  its sign-in without reaching into the registry (published on the
   *  catalog row). */
  catalogMod?: BrowserLlmModProvider
  /** The listing comes from a mod's code, not a document (`models`). */
  codeListing?: ProviderCodeListing
  /** Names of the credentials a provider mod declares beyond the API key
   *  (the labels are the vendor's text, on `catalogMod`). */
  modSecretNames?: string[]
  /** Thinking tier mapping. Absent = the provider takes no thinking fields. */
  reasoning?: ReasoningMapper
  /**
   * The host has no native class for this provider: the runtime does
   * everything the host would — its catalog row, the user's picks from the
   * listing (with reconciliation), the key probe (OpenRouter, the Vercel AI
   * Gateway). Requires `models` and a catalog `wire`.
   */
  runtimeOnly?: boolean
  /**
   * The provider's brand mark (an SVG string, `currentColor` fill) for the
   * catalog row a `runtimeOnly` provider's runtime builds — the host ships
   * the marks of the providers it has a class for. Absent = the generic mark.
   */
  iconSvg?: string
  /**
   * The provider's model listing, fetched by the runtime
   * (`models/drivers/providerDocuments.ts`). On a `runtimeOnly`
   * provider the user picks from it; on a built-in with a host class it joins
   * the curated catalog the way the host's discovery did (newer versions of
   * a curated family, the "Other models" section of Add models).
   */
  models?: ProviderDocumentSource<ProviderModelInfo[]>
  /** Key probe: a GET that answers 2xx only for a valid key. Absent = the
   *  model listing stands in (useless on a gateway whose listing is public). */
  verify?: { path: string }
  /** Plan usage / credit balance for the composer and the settings page. */
  usage?: ProviderDocumentSource<PlanUsageSnapshot | undefined>
  /**
   * The ACCOUNT's credit balance, when the API key cannot read it and it
   * takes a document (and a credential) of its own — OpenRouter's `/credits`
   * answers only a management key. Read after `usage`; its amounts lead the
   * snapshot. A missing or failing credential never sinks the usage: the
   * snapshot carries `balanceNote` instead. Requires `usage`.
   */
  balance?: ProviderDocumentSource<PlanUsageAmount[]>
  /**
   * Credentials beyond the API key the user can store for this provider,
   * each a named host secret (`settings.json` `secrets.<name>`, sealed; a
   * request names it as `{{secret:<name>}}`). The settings page shows one
   * optional password field per entry.
   */
  secrets?: ProviderSecretField[]
  /**
   * How this provider's ids read as family / version / snapshot. Absent = the
   * shared reading (`providers/shared/modelVersions.ts`), which fits ids of
   * the `name-<version>[-variant][-<date>]` shape.
   */
  versions?: (id: string) => ModelVersionInfo
  /**
   * How the page shows this provider's models, where it differs from the
   * listing as read (`modelDisplay.ts` applies it; absent = as listed).
   */
  display?: ProviderModelDisplay
}

/** The names of the credentials beyond the API key a provider declares —
 *  a built-in's `secrets` or a mod's `modSecretNames`. */
export function declaredSecretNames(definition: ProviderDefinition | undefined): string[] {
  if (!definition) return []
  return [...(definition.secrets ?? []).map(field => field.name), ...(definition.modSecretNames ?? [])]
}

/** One optional credential field on the provider's settings page. */
export type ProviderSecretField = {
  /** The host secret name (`IsValidSecretName`: `[A-Za-z0-9_.-]{1,64}`). */
  name: string
  labelKey: MessageKey
  hintKey: MessageKey
}

/**
 * A provider's display rules. Every member is optional; the page reaches
 * them only through `modelDisplay.ts`.
 */
export type ProviderModelDisplay = {
  /** The name to show for a listed model — e.g. without a "(free)" the
   *  page already shows as the free mark. */
  modelLabel?(name: string, model: { free?: boolean }): string
  /** The part of the provider's usage that meters this model (a free model
   *  on a free-request quota, a paid one on the plan or balance). */
  usageFor?(usage: PlanUsageSnapshot, model: { free?: boolean }): PlanUsageSnapshot
  /** The usage as the one-line hover surfaces show it (the composer ring's
   *  tooltip, the model picker's detail): figures that answer the same
   *  question folded into one. The usage popover always shows it whole. */
  usageSummary?(usage: PlanUsageSnapshot): PlanUsageSnapshot
}
