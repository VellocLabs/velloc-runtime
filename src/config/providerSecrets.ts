/**
 * Security: the broker merges `secrets` NAME BY NAME and keeps an omitted name, so
 * every publish names each DECLARED secret, `''` when not stored, or a removed
 * secret would keep authenticating. Undeclared names (host-captured OAuth tokens)
 * are never cleared.
 */
import type { NexusProviderConfig } from '../settings/settingsTypes'
import { declaredSecretNames } from './nexusModelConfig/providerDefinition'
import { getProviderDefinition } from './nexusModelConfig/providers'

export function withProviderSecretMirror(
  configs: Record<string, NexusProviderConfig>,
): Record<string, NexusProviderConfig> {
  const out: Record<string, NexusProviderConfig> = {}
  for (const [id, config] of Object.entries(configs)) {
    const declared = declaredSecretNames(getProviderDefinition(id))
    if (declared.length === 0) {
      out[id] = config
      continue
    }
    const secrets: Record<string, string> = { ...config.secrets }
    for (const name of declared) secrets[name] = config.secrets?.[name] ?? ''
    out[id] = { ...config, secrets }
  }
  return out
}
