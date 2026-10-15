import type { ProviderDefinition } from '../../providerDefinition'
import { ANTHROPIC_PROVIDER_MODEL_CONFIG } from './config'
import { anthropicReasoning } from './reasoning'
import { anthropicModels } from './models'

export const ANTHROPIC_PROVIDER: ProviderDefinition = {
  config: ANTHROPIC_PROVIDER_MODEL_CONFIG,
  reasoning: anthropicReasoning,
  // Discovery in the runtime; the listing also serves as the key probe.
  // `limit=1000`: the endpoint pages at 20 by default (the host's discovery
  // read only that first page). Unlike OpenAI's, the rows state context,
  // output cap and effort levels (./models.ts).
  models: anthropicModels,
}
