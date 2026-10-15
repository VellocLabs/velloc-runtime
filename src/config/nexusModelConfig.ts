import { BUILTIN_PROVIDER_DEFINITIONS } from './nexusModelConfig/providers'
import type { NexusModelConfig } from './nexusModelConfig/types'

export type {
  NexusConfiguredModel,
  NexusDocumentInputMode,
  NexusModelConfig,
  NexusModelPattern,
  NexusProviderFilterMode,
  NexusProviderModelConfig,
  NexusThinkingTier,
} from './nexusModelConfig/types'

export { buildThinkingBodyExtension } from './nexusModelConfig/thinkingTierParams'

// Every built-in provider's catalog entry, from its own directory
// (nexusModelConfig/providers/<id>/config.ts, listed in providers/index.ts).
// A fresh array: the custom-provider overlay splices it in place — and, on
// the same splice, the enabled provider mods' entries
// (customProviderRegistry.ts).
export const NEXUS_MODEL_CONFIG: NexusModelConfig = {
  providers: BUILTIN_PROVIDER_DEFINITIONS.map(definition => definition.config),
}
