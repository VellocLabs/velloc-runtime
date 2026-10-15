import type { ProviderDefinition } from '../../providerDefinition'
import { CHATGPT_PRO_PROVIDER_MODEL_CONFIG } from './config'
import { chatgptProReasoning } from './reasoning'

export const CHATGPT_PRO_PROVIDER: ProviderDefinition = {
  config: CHATGPT_PRO_PROVIDER_MODEL_CONFIG,
  reasoning: chatgptProReasoning,
}
