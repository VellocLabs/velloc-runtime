// How a PDF the user @-mentions reaches the model (F-12): the declared mode (model
// row, user declaration, provider catalog, else `rasterize`); the `openai` provider
// is `native` only while its EFFECTIVE base URL is OpenAI's own domain (a custom
// provider never is); `rasterize` on a text-only model becomes `none`.

import { isCustomBackendId } from '../customProviderRegistry'
import { NEXUS_MODEL_CONFIG } from '../nexusModelConfig'
import { endpointHostname } from '../../models/endpoints/officialEndpoints'
import { getBrokerProviderBaseUrl } from '../../models/endpoints/endpointTrust'
import { getSupportsImageInputForModel } from '../../engine/contextWindow'
import type { NexusProvidersSettings } from '../../settings/settingsTypes'
import { patternMatches } from './findConfiguredModel'
import type {
  NexusConfiguredModel,
  NexusDocumentInputMode,
  NexusModelConfig,
  NexusProviderModelConfig,
} from './types'

export type { NexusDocumentInputMode } from './types'

/**
 * Anything nobody declared: page images are the one PDF shape every current
 * vision wire accepts, so an unknown provider is not trusted with a document
 * part it may silently drop.
 */
const UNDECLARED_DOCUMENT_INPUT: NexusDocumentInputMode = 'rasterize'

/** The one provider whose `native` document part depends on its endpoint. */
const OPENAI_RESPONSES_PROVIDER_ID = 'openai'

const DOCUMENT_INPUT_MODES: ReadonlySet<string> = new Set(['native', 'rasterize', 'none'])

export function isDocumentInputMode(value: unknown): value is NexusDocumentInputMode {
  return typeof value === 'string' && DOCUMENT_INPUT_MODES.has(value)
}

/**
 * True when `baseUrl` reaches OpenAI itself — the condition for trusting
 * the `openai` provider's `input_file` part. Empty / absent means "no
 * override" (the host uses the provider's `defaultBaseUrl`, OpenAI itself).
 * Deliberately narrower than `isOfficialEndpointUrl`: that list also
 * blesses `chatgpt.com` and other vendors' domains, and only OpenAI's API
 * reads an OpenAI file part.
 */
export function isOfficialOpenAiBaseUrl(baseUrl: string | undefined | null): boolean {
  if (baseUrl === undefined || baseUrl === null || baseUrl.trim() === '') return true
  const host = endpointHostname(baseUrl)
  return host === 'openai.com' || (!!host && host.endsWith('.openai.com'))
}

/**
 * The wire family a provider id runs on. A user-created provider
 * (`custom-<slug>`, `isCustomProvider`) runs on one of the two custom
 * backend slots, chosen by its `apiCompatibility`.
 */
function catalogProviderIdFor(
  providers: NexusProvidersSettings | undefined,
  providerId: string,
): string {
  const settings = providers?.configs?.[providerId]
  if (settings?.isCustomProvider && !isCustomBackendId(providerId)) {
    return settings.apiCompatibility === 'anthropic' ? 'custom-anthropic' : 'custom-openai'
  }
  return providerId
}

/**
 * How a PDF reaches `modelId` on `providerId` — see the module comment for
 * the order. `providers` is the settings `providers` section (base URLs,
 * custom-provider records, a user's `documentInput`); `undefined` resolves
 * from the catalog alone, as if every provider sat on its default endpoint.
 */
export function resolveDocumentInputMode(
  providers: NexusProvidersSettings | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): NexusDocumentInputMode {
  if (!providerId) return UNDECLARED_DOCUMENT_INPUT
  const settings = providers?.configs?.[providerId]
  const wireProviderId = catalogProviderIdFor(providers, providerId)
  const catalogProvider = config.providers.find(p => p.providerId === wireProviderId)
  const row = modelId ? findCatalogRow(catalogProvider, modelId) : undefined

  const declared: NexusDocumentInputMode =
    row?.documentInput
    ?? (isDocumentInputMode(settings?.documentInput) ? settings.documentInput : undefined)
    ?? catalogProvider?.documentInput
    ?? UNDECLARED_DOCUMENT_INPUT

  let mode = declared
  // On `openai` the ENDPOINT decides, unless a model row or the user
  // declared a mode: its Responses `input_file` part is read by OpenAI's API
  // and nothing else, so `openai` moved onto a relay loses it. A custom
  // OpenAI-compatible provider keeps its catalog `rasterize` wherever it
  // points — the host's chat/completions path turns a document part into a
  // "cannot be shown" marker (openai_provider.cc), api.openai.com included.
  const explicit = !!row?.documentInput || isDocumentInputMode(settings?.documentInput)
  if (!explicit && wireProviderId === OPENAI_RESPONSES_PROVIDER_ID) {
    mode = isOfficialOpenAiBaseUrl(effectiveBaseUrl(settings?.baseUrl, providerId))
      ? 'native'
      : 'rasterize'
  }
  if (mode === 'rasterize' && !getSupportsImageInputForModel(modelId, wireProviderId, config)) {
    mode = 'none'
  }
  return mode
}

/**
 * The base URL the host really sends to: settings.json's override when it
 * has one, else what the broker holds — a relay set through launch prefs or
 * the legacy path lives only in the broker's pref, and settings.json without
 * a `baseUrl` leaves that pref value in force. Reading settings.json alone
 * called such a relay "OpenAI's default" and sent it an `input_file` part.
 */
function effectiveBaseUrl(
  settingsBaseUrl: string | undefined,
  providerId: string,
): string | undefined {
  if (settingsBaseUrl && settingsBaseUrl.trim().length > 0) return settingsBaseUrl
  return getBrokerProviderBaseUrl(providerId)
}

/** The provider's own row for `modelId` — never another provider's, so a
 *  `claude-*` alias on a relay does not pick up the Anthropic row. */
function findCatalogRow(
  provider: NexusProviderModelConfig | undefined,
  modelId: string,
): NexusConfiguredModel | undefined {
  return provider?.models.find(
    entry =>
      patternMatches(entry.model, modelId)
      && !entry.exclude?.some(pattern => patternMatches(pattern, modelId)),
  )
}
