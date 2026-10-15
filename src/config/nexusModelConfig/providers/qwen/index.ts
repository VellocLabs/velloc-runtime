import type { ProviderDefinition } from '../../providerDefinition'
import { QWEN_PROVIDER_MODEL_CONFIG } from './config'
import { qwenReasoning } from './reasoning'

export const QWEN_PROVIDER: ProviderDefinition = {
  config: QWEN_PROVIDER_MODEL_CONFIG,
  reasoning: qwenReasoning,
}
