/**
 * Provider trust read from settings.json at the point of use; the cache is
 * dropped first, since it misses writes from other windows or hand edits.
 */
import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { readUserLayer } from '../settings/settingsStore'
import { entryId } from '../config/nexusModelConfig/modelEntries'
import { wipeSettingsMemos } from '../settings/storeCache'
import {
  isKnownProvider,
  resolveProviderTrust,
} from '../settings/providerTrust'
import type { ProviderTrust } from '../settings/providerTrust'

/**
 * A snapshot lookup: provider id → effective trust. Snapshot, not a live
 * view, so one spawn decision is made against one consistent read of the
 * file — but it is cheap to take a new one, and callers should, rather than
 * holding one for the life of the worker.
 */
export async function loadProviderTrustMap(
  homeDir: string,
  fs: RuntimeFs = processFs(),
): Promise<(providerId: string) => ProviderTrust> {
  wipeSettingsMemos()
  const { settings } = await readUserLayer(homeDir, fs)
  return providerId => resolveProviderTrust(settings.providers, providerId)
}

/**
 * Security: the trust of a SESSION's provider, resolved like
 * `resolveChildProvider` (unpinned → active). An unknown id, or no provider at
 * all, is untrusted.
 */
export async function loadSessionTrustResolver(
  homeDir: string,
  fs: RuntimeFs = processFs(),
): Promise<(pinnedProviderId: string | undefined) => ProviderTrust> {
  wipeSettingsMemos()
  const { settings } = await readUserLayer(homeDir, fs)
  const providers = settings.providers
  return pinnedProviderId => {
    const providerId = pinnedProviderId ?? providers?.activeProviderId
    if (!providerId || !isKnownProvider(providers, providerId)) return 'untrusted'
    return resolveProviderTrust(providers, providerId)
  }
}

/**
 * Security: the model ids the user enabled for a provider, checked by the
 * teammate spawn. Null when the provider is unknown or has no curated list.
 */
export async function enabledModelsFor(
  homeDir: string,
  providerId: string,
  /** THIS session's fs; omitted -> the realm-global slot. */
  fs: RuntimeFs = processFs(),
): Promise<string[] | null> {
  wipeSettingsMemos()
  const { settings } = await readUserLayer(homeDir, fs)
  const config = settings.providers?.configs?.[providerId]
  if (!config) return null
  // Model entries (`claude-opus-*@latest`) are what the picker offers and
  // what a selection holds; the child resolves one like any session.
  const enabled =
    config.modelEntries?.map(entryId) ??
    config.enabledModels ??
    (config.customModels ?? []).map(m => m.modelId).filter(Boolean)
  return enabled.length > 0 ? enabled : null
}

/**
 * Security: the provider a spawned child will ACTUALLY run on, and its trust;
 * the caller stamps the returned id onto the spawn. Order: explicit
 * `provider_id`, the session's pinned provider, `activeProviderId`. Nothing
 * resolved → `'untrusted'`. An id the host does not know comes back
 * `known: false` and must be refused, not isolated against.
 */
export async function resolveChildProvider(
  homeDir: string | undefined,
  explicitProviderId: string | undefined,
  sessionProviderId: string | undefined,
  /** THIS session's fs; omitted -> the realm-global slot. */
  fs: RuntimeFs = processFs(),
): Promise<{
  providerId: string | undefined
  trust: ProviderTrust
  /** False when `providerId` names no provider the user has (or is absent). */
  known: boolean
}> {
  if (!homeDir) {
    // No settings to read: nothing can be shown to be trusted.
    return {
      providerId: explicitProviderId ?? sessionProviderId,
      trust: 'untrusted',
      known: false,
    }
  }
  wipeSettingsMemos()
  const { settings } = await readUserLayer(homeDir, fs)
  const providerId =
    explicitProviderId ?? sessionProviderId ?? settings.providers?.activeProviderId
  if (!providerId) return { providerId: undefined, trust: 'untrusted', known: false }
  if (!isKnownProvider(settings.providers, providerId)) {
    return { providerId, trust: 'untrusted', known: false }
  }
  return {
    providerId,
    trust: resolveProviderTrust(settings.providers, providerId),
    known: true,
  }
}
