import type { NexusProviderModelConfig } from '../../types'

// User-configured custom OpenAI-compatible endpoint — Settings → Models →
// "Custom endpoint" with the OpenAI wire format (backend id `custom-openai`).
// The endpoint's catalog is unknown ahead of time, so `passthrough` surfaces
// whatever the provider's `/v1/models` discovery returns (plus any model id
// the user pins in the form). No curated rows: cursor-api-proxy, LM Studio, an
// internal gateway, etc. all expose their own model ids.
export const CUSTOM_OPENAI_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'custom-openai',
  filterMode: 'passthrough',
  // Runs on a runtime ModelProvider: the chat codec the host's
  // `OpenAiProvider` (requires_api_key=false) speaks; keyless when no key is
  // stored. User-created providers of this dialect get the same wire
  // (customProviderRegistry `CUSTOM_PROVIDER_WIRES`).
  wire: { format: 'openai-chat', apiKeyOptional: true },
  // PDF input: OpenAI-compatible relays have no reliable document part, and a custom
  // provider stays `rasterize` even on OpenAI's own domain (`resolveDocumentInputMode`;
  // F-12's dated entry "A custom OpenAI-compatible provider is never native").
  documentInput: 'rasterize',
  // No `catalog`: a custom endpoint's models are whatever its server says.
  models: [],
}
