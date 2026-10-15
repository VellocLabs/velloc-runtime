import type { NexusProviderModelConfig } from '../../types'

// Vercel AI Gateway: a RUNTIME-ONLY OpenAI-Chat gateway like OpenRouter. Only
// `type: 'language'` rows tagged `tool-use` can drive the agent; `GET /v1/credits`
// is the key probe; reasoning is the unified `reasoning: {effort}` object.
export const VERCEL_AI_GATEWAY_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'vercel-ai-gateway',
  filterMode: 'passthrough',
  defaultBaseUrl: 'https://ai-gateway.vercel.sh/v1',
  wire: {
    format: 'openai-chat',
  },
  documentInput: 'rasterize',
  // Figures the listing leaves unset come from the catalog's `vercel`
  // records (same model ids).
  catalog: { keys: ['vercel'] },
  starterModels: [
    'anthropic/claude-haiku-4.5',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-opus-5.5',
  ],
  models: [],
}
