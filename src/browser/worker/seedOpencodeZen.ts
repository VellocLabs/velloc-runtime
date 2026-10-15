import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { ProviderAuthProviderInfo } from '../bridge/protocol/providerAuth'
import {
  readUserLayer,
  updateFeatures,
  updateProvidersSettings,
} from '../../settings/settingsStore'
import {
  OPENCODE_ZEN_PROVIDER_ID,
  opencodeZenSeedConfig,
} from '../webview/settings/opencodeZenPreset'
import { OPENCODE_ZEN_ENABLED } from '../../config/opencodeZen'

/**
 * `features` flag recording that the first-run Zen seed has been decided for
 * this profile. Lives in `features` because `providers` is dropped from
 * settings.json when its last entry is removed — a flag there would vanish
 * exactly when it is needed.
 */
export const OPENCODE_ZEN_SEED_FLAG = 'seed.opencodeZen'

/**
 * Whether `providerAuth.list` shows a provider set up outside settings.json, counting stored user
 * input only (not `isConfigured`, `baseUrl` or `model` defaults).
 */
export function hostListShowsProviderSetUp(
  providers: readonly ProviderAuthProviderInfo[],
): boolean {
  return providers.some(
    p =>
      p.hasStoredApiKey === true ||
      p.connected === true ||
      p.isVerified === true ||
      Boolean(p.defaultModel) ||
      (p.enabledModels?.length ?? 0) > 0,
  )
}

/**
 * First-run default: a profile with NO provider (in settings.json or on the host) gets the OpenCode
 * Zen provider on the anonymous `public` key, made active. A failed host probe decides nothing. Once
 * per profile (flag written after the provider). Runs before key sealing. True when one was added.
 */
export async function seedOpencodeZenProvider(
  homeDir: string,
  fs: RuntimeFs,
  hostHasProviderSetUp: () => Promise<boolean>,
  { enabled = OPENCODE_ZEN_ENABLED }: { enabled?: boolean } = {},
): Promise<boolean> {
  // Zen switched off: decide nothing, not even the flag, so the profile is
  // still a first-run candidate if Zen is switched back on while it has no
  // provider.
  if (!enabled) return false
  const { settings } = await readUserLayer(homeDir, fs)
  if (settings.features?.[OPENCODE_ZEN_SEED_FLAG]) return false

  let seeded = false
  if (Object.keys(settings.providers?.configs ?? {}).length === 0) {
    let hostSetUp: boolean
    try {
      hostSetUp = await hostHasProviderSetUp()
    } catch {
      return false
    }
    if (!hostSetUp) {
      await updateProvidersSettings(homeDir, fs, prev => {
        // Re-checked inside the write: another surface may have added a
        // provider since the read above.
        if (Object.keys(prev?.configs ?? {}).length > 0) return prev
        seeded = true
        return {
          activeProviderId: OPENCODE_ZEN_PROVIDER_ID,
          configs: { [OPENCODE_ZEN_PROVIDER_ID]: opencodeZenSeedConfig() },
          ...(prev?.order ? { order: prev.order } : {}),
        }
      })
    }
  }
  await updateFeatures(homeDir, fs, prev => ({
    ...prev,
    [OPENCODE_ZEN_SEED_FLAG]: true,
  }))
  return seeded
}
