import type { NexusProviderModelConfig } from '../../types'

// OpenRouter: a RUNTIME-ONLY OpenAI-Chat gateway (P-4). `GET /models` needs no key
// (rows without `tools` are never offered); `GET /key` is the key probe. The user
// picks models; `starterModels` must be concrete listed ids. No tier ladder: auto
// tiers are borrowed (borrowedTierLadder.ts).
export const OPENROUTER_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'openrouter',
  filterMode: 'passthrough',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  wire: {
    format: 'openai-chat',
    headers: {
      'http-referer': 'https://velloc.app',
      'x-openrouter-title': 'Velloc',
    },
  },
  // PDF input: the chat `file` part is OpenRouter's own extension (a PDF
  // plugin chooses the parser); rasterized pages work for every upstream.
  documentInput: 'rasterize',
  // Figures the listing leaves unset come from the catalog's `openrouter`
  // records (same model ids).
  catalog: { keys: ['openrouter'] },
  starterModels: [
    'anthropic/claude-haiku-4.5',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-opus-5.5',
  ],
  models: [],
}
