/**
 * "OpenCode Zen" preset for the custom-provider page: an OpenAI-compatible gateway,
 * so the preset only pre-fills a custom-provider draft. With no key of its own it
 * sends the literal key `public` (anonymous: free models only, rate-limited per IP).
 * Seeded models are the free `/chat/completions` rows with known limits.
 */

import type {
  CustomModelDef,
  NexusProviderConfig,
} from '../../../settings/settingsTypes'
import {
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_PROVIDER_ID,
  OPENCODE_ZEN_PUBLIC_API_KEY,
} from '../../../config/opencodeZen'
import {
  configFromDraft,
  emptyCustomProviderDraft,
  type CustomProviderDraft,
} from './customProviderHelpers'

export {
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_PROVIDER_ID,
  OPENCODE_ZEN_PUBLIC_API_KEY,
  OPENCODE_ZEN_USER_AGENT,
  isOpencodeZenBaseUrl,
  resolveOpencodeZenApiKey,
} from '../../../config/opencodeZen'

export const OPENCODE_ZEN_DISPLAY_NAME = 'OpenCode Zen'

export const OPENCODE_ZEN_DEFAULT_MODEL = 'big-pickle'

export const OPENCODE_ZEN_FREE_MODELS: readonly CustomModelDef[] = [
  {
    // Stealth model. models.dev lists a 200K context with a 160K input cap;
    // the input cap is what a request can actually carry.
    modelId: 'big-pickle',
    displayName: 'Big Pickle (free)',
    contextWindow: 160_000,
    maxOutputTokens: 32_000,
    capabilities: { toolCalling: true, reasoning: true },
  },
  {
    // NVIDIA free endpoint — trial use only, requests are logged by NVIDIA.
    modelId: 'nemotron-3-ultra-free',
    displayName: 'Nemotron 3 Ultra (free)',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: { toolCalling: true, reasoning: true },
  },
  {
    modelId: 'mimo-v2.5-free',
    displayName: 'MiMo-V2.5 (free)',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: { toolCalling: true, reasoning: true, vision: true },
  },
]

/** A create-mode draft pre-filled for OpenCode Zen. */
export function opencodeZenDraft(): CustomProviderDraft {
  return {
    ...emptyCustomProviderDraft(),
    displayName: OPENCODE_ZEN_DISPLAY_NAME,
    apiCompatibility: 'openai',
    baseUrl: OPENCODE_ZEN_BASE_URL,
    defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
    // Zen is a gateway in front of other vendors, never their own endpoint.
    trust: 'untrusted',
    models: OPENCODE_ZEN_FREE_MODELS.map(m => ({
      ...m,
      capabilities: { ...m.capabilities },
    })),
  }
}

/** The persisted config for a Zen provider seeded on first run. */
export function opencodeZenSeedConfig(): NexusProviderConfig {
  return configFromDraft(
    { ...opencodeZenDraft(), apiKey: OPENCODE_ZEN_PUBLIC_API_KEY },
    OPENCODE_ZEN_PROVIDER_ID,
  )
}
