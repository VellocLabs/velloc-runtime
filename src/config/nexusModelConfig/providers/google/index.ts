import type { ProviderDefinition } from '../../providerDefinition'
import { GOOGLE_PROVIDER_MODEL_CONFIG } from './config'
import { googleReasoning } from './reasoning'

export const GOOGLE_PROVIDER: ProviderDefinition = {
  config: GOOGLE_PROVIDER_MODEL_CONFIG,
  reasoning: googleReasoning,
}
