import type { ProviderDefinition } from '../../providerDefinition'
import { KIMI_PROVIDER_MODEL_CONFIG } from './config'
import { kimiReasoning } from './reasoning'
import { kimiUsage } from './usage'
import { dataModelListing } from '../shared/dataListing'

export const KIMI_PROVIDER: ProviderDefinition = {
  config: KIMI_PROVIDER_MODEL_CONFIG,
  reasoning: kimiReasoning,
  // Discovery in the runtime; the listing also serves as the key probe.
  models: dataModelListing('/models'),
  usage: kimiUsage,
}
