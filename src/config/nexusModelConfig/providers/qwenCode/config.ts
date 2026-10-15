import type { NexusProviderModelConfig } from '../../types'

// Qwen Code (OAuth device-code sign-in with PKCE), the free OAuth quota on
// the Qwen Code portal. The token response names a per-account API host
// (`resource_url`), which the host's token store writes into the provider's
// `base_url` (oauth_token_store.cc `NormalizeResourceUrl`): the runtime reads
// it as the broker's base URL, ahead of the default below. The model list is
// the host's (discovery, else its curated qwen3-coder pair): `passthrough`.

export const QWEN_CODE_BASE_URL = 'https://portal.qwen.ai/v1'

/**
 * `OpenAiProvider` as the factory builds it for qwen-code
 * (llm_provider_factory.cc): chat/completions with `Authorization: Bearer
 * <access token>` and no extra headers. `{{oauth:access_token}}` is the
 * token after the host's refresh step.
 */
export const QWEN_CODE_WIRE: NonNullable<NexusProviderModelConfig['wire']> = {
  format: 'openai-chat',
  headers: { Authorization: 'Bearer {{oauth:access_token}}' },
}

export const QWEN_CODE_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'qwen-code',
  filterMode: 'passthrough',
  // The portal (`OAuthProviderConfig::backend_base_url`, oauth_providers.cc).
  defaultBaseUrl: QWEN_CODE_BASE_URL,
  // Runs on a runtime ModelProvider over `model.rawStream*`; a host without
  // the OAuth primitive cannot serve it (the native class is gone).
  wire: QWEN_CODE_WIRE,
  // PDF input: an OpenAI-compatible chat wire with no document part.
  documentInput: 'rasterize',
  // No `catalog`: the Qwen Code OAuth backend serves its own model ids and
  // limits, which no catalog provider describes.
  models: [],
}
