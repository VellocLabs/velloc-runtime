import type { ProviderDefinition } from '../../providerDefinition'
import { OPENAI_PROVIDER_MODEL_CONFIG } from './config'
import { openaiReasoning } from './reasoning'
import { dataModelListing } from '../shared/dataListing'

export const OPENAI_PROVIDER: ProviderDefinition = {
  config: OPENAI_PROVIDER_MODEL_CONFIG,
  reasoning: openaiReasoning,
  // Discovery in the runtime; the listing also serves as the key probe.
  models: dataModelListing('/models'),
}
