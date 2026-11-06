import { describe, expect, it } from 'vitest'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { knownModelRows } from '../config/nexusModelConfig/familyRows'
import { versionParser } from '../config/nexusModelConfig/modelEntries'
import { deriveCanonicalModelId } from '../config/nexusModelConfig/patterns'
import { resolveReviewModelIdentity } from './modelProfiles'
import { resolveCapabilityProfile } from './recipes'

// Providers whose rows are user-pulled local models or user-configured
// endpoints: their models take the default review profile.
const DEFAULT_PROFILE_PROVIDERS = new Set(['ollama', 'custom-anthropic', 'custom-openai'])

// A pattern-only row names no concrete id; exact lookup never matches it, so
// its models take the default profile.
function catalogModelIds(): Array<{ providerId: string; modelId: string | undefined }> {
  return NEXUS_MODEL_CONFIG.providers
    .filter(provider => !DEFAULT_PROFILE_PROVIDERS.has(provider.providerId))
    .flatMap(provider => knownModelRows(provider.models, versionParser(provider.providerId)).map(row => ({
      providerId: provider.providerId,
      modelId: deriveCanonicalModelId(row.model),
    })))
}

describe('review profile coverage (F-38)', () => {
  it('gives every built-in catalog model an explicit review profile', () => {
    const missing = catalogModelIds()
      .filter(({ modelId }) => modelId && !resolveReviewModelIdentity(modelId))
      .map(({ providerId, modelId }) => `${providerId} / ${modelId}: no review profile in modelProfiles.ts (F-38)`)
    expect(missing).toEqual([])
  })

  it('lists catalog models for more than one provider', () => {
    expect(new Set(catalogModelIds().map(entry => entry.providerId)).size).toBeGreaterThan(5)
  })

  it('leaves default-profile providers and unknown ids on the no-team profile', () => {
    expect(NEXUS_MODEL_CONFIG.providers.some(provider => provider.providerId === 'ollama')).toBe(true)
    expect(resolveCapabilityProfile('qwen3.5')).toBe('fallback-no-team')
    expect(resolveCapabilityProfile(undefined)).toBe('fallback-no-team')
  })
})
