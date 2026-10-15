import type { NexusProviderModelConfig } from '../../types'

// User-configured custom Anthropic-compatible endpoint — Settings → Models →
// "Custom endpoint" with the Anthropic wire format (backend id
// `custom-anthropic`). Like its OpenAI twin, `passthrough` surfaces whatever
// the endpoint's `/v1/models` discovery returns rather than a curated list.
export const CUSTOM_ANTHROPIC_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'custom-anthropic',
  filterMode: 'passthrough',
  // Runs on a runtime ModelProvider: the Messages codec the host's
  // `AnthropicProvider` (requires_api_key=false) speaks; keyless when no key
  // is stored. User-created providers of this dialect get the same wire
  // (customProviderRegistry `CUSTOM_PROVIDER_WIRES`).
  wire: { format: 'anthropic-messages', apiKeyOptional: true },
  // PDF input: Anthropic wire: the `document` block. A relay that strips it gets the
  // translator's visible "document unavailable" marker, not silence.
  documentInput: 'native',
  // No `catalog`: a custom endpoint's models are whatever its server says.
  models: [],
}
