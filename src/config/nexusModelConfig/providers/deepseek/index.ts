import type { ProviderDefinition } from '../../providerDefinition'
import { DEEPSEEK_PROVIDER_MODEL_CONFIG } from './config'
import { deepseekReasoning } from './reasoning'

export const DEEPSEEK_PROVIDER: ProviderDefinition = {
  config: DEEPSEEK_PROVIDER_MODEL_CONFIG,
  reasoning: deepseekReasoning,
}
