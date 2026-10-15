import type { ProviderDefinition } from '../../providerDefinition'
import { VERCEL_AI_GATEWAY_PROVIDER_MODEL_CONFIG } from './config'
import { VERCEL_ICON_SVG } from './icon'
import { reasoningObject } from '../shared/reasoningObject'
import { vercelModels } from './models'
import { vercelUsage } from './usage'

export const VERCEL_AI_GATEWAY_PROVIDER: ProviderDefinition = {
  config: VERCEL_AI_GATEWAY_PROVIDER_MODEL_CONFIG,
  runtimeOnly: true,
  iconSvg: VERCEL_ICON_SVG,
  reasoning: reasoningObject,
  models: vercelModels,
  verify: { path: '/credits' },
  usage: vercelUsage,
}
