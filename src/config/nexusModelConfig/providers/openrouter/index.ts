import type { ProviderDefinition } from '../../providerDefinition'
import { OPENROUTER_PROVIDER_MODEL_CONFIG } from './config'
import { OPENROUTER_ICON_SVG } from './icon'
import { reasoningObject } from '../shared/reasoningObject'
import { openrouterModels } from './models'
import { OPENROUTER_MANAGEMENT_KEY_SECRET, openrouterBalance, openrouterUsage } from './usage'
import { openrouterDisplay } from './display'

export const OPENROUTER_PROVIDER: ProviderDefinition = {
  config: OPENROUTER_PROVIDER_MODEL_CONFIG,
  runtimeOnly: true,
  iconSvg: OPENROUTER_ICON_SVG,
  reasoning: reasoningObject,
  models: openrouterModels,
  verify: { path: '/key' },
  usage: openrouterUsage,
  balance: openrouterBalance,
  secrets: [
    {
      name: OPENROUTER_MANAGEMENT_KEY_SECRET,
      labelKey: 'settings.models.openrouterManagementKey',
      hintKey: 'settings.models.openrouterManagementKeyHint',
    },
  ],
  display: openrouterDisplay,
}
