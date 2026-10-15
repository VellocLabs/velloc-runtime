/**
 * The provider catalog a team lead reads before delegating (shared by the
 * `TeamProviders` tool and the team skills): providers, models, effort tiers
 * and trust (`resolveProviderTrust`, the value the spawn enforces;
 * `trustReasons` explains it). Security: no API keys or base URLs; the output
 * reaches the lead's provider.
 */
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { hostModelIdsFor } from '../config/hostModelCatalog'
import { entryId } from '../config/nexusModelConfig/modelEntries'
import { classifyEndpoint } from '../models/endpoints/endpointTrust'
import type { EndpointTrustReason } from '../models/endpoints/endpointTrust'
import { fsForContext } from '../utils/fs/runtimeFs'
import { readUserLayer } from '../settings/settingsStore'
import { wipeSettingsMemos } from '../settings/storeCache'
import { isKnownProvider, resolveProviderTrust } from '../settings/providerTrust'
import type { ProviderTrust } from '../settings/providerTrust'
import type { NexusProviderConfig } from '../settings/settingsTypes'

export type CatalogModel = {
  modelId: string
  displayName?: string
  /**
   * Reasoning-effort tiers this model accepts, from the curated catalog
   * (`availableThinkingTiers`). Empty when the catalog has no entry for the
   * pair — which is normal for a passthrough endpoint, and means "do not pin
   * an effort", not "effort is unsupported".
   */
  efforts: string[]
  defaultEffort?: string
  contextWindow?: number
}

/** Where a provider's reported model ids came from (see `catalogModelIds`). */
export type CatalogModelsSource = 'enabled' | 'custom' | 'host' | 'none'

export type CatalogProvider = {
  id: string
  displayName: string
  /** The one trust value: user-declared, domain-seeded, spawn-enforced. */
  trust: ProviderTrust
  /** Why this provider reads as untrusted; empty when it does not. */
  trustReasons: EndpointTrustReason[]
  /** Plaintext, non-loopback endpoint — key and transcript travel in clear. */
  insecure: boolean
  /** False => the host would silently run this id on the ACTIVE provider. */
  known: boolean
  models: CatalogModel[]
  /**
   * Where `models` came from: `enabled` (user subset), `custom` (custom provider),
   * `host` (broker catalog, pickable but not curated), or `none` (not usable for
   * a teammate).
   */
  modelsSource: CatalogModelsSource
  defaultModel?: string
}

export type ProviderCatalog = {
  providers: CatalogProvider[]
  /** The provider the LEAD session itself runs on, when known: its pinned
   *  provider, else the active one (where an unpinned session's requests go). */
  leadProviderId?: string
  /** The lead's trust, FAIL-CLOSED: `untrusted` when the lead's provider is
   *  unknown to the user's settings or cannot be resolved at all. Both team
   *  surfaces refuse on it, so it must never be absent when there is doubt. */
  leadTrust?: ProviderTrust
  /** True when at least one configured provider is untrusted for spawning. */
  hasUntrusted: boolean
}

/**
 * The model ids to report for a provider: the enabled subset, then custom
 * models, then the host catalog (the curated config holds patterns, not ids).
 */
function catalogModelIds(
  providerId: string,
  config: NexusProviderConfig,
): { ids: string[]; source: CatalogModelsSource } {
  const entries = config.modelEntries?.map(entryId)
  if (entries && entries.length > 0) return { ids: entries, source: 'enabled' }
  const enabled = config.enabledModels?.filter(id => id?.trim().length > 0)
  if (enabled && enabled.length > 0) return { ids: enabled, source: 'enabled' }
  const custom = (config.customModels ?? [])
    .map(m => m.modelId)
    .filter(id => typeof id === 'string' && id.trim().length > 0)
  if (custom.length > 0) return { ids: custom, source: 'custom' }
  const host = hostModelIdsFor(providerId)
  if (host.length > 0) return { ids: host, source: 'host' }
  return { ids: [], source: 'none' }
}

function describeModel(providerId: string, modelId: string): CatalogModel {
  // `findConfiguredModel` covers custom providers too: the settings layer
  // overlays their records onto NEXUS_MODEL_CONFIG (`setCustomProviderRecords`,
  // run at worker boot and after every providers write), so one lookup answers
  // for both built-in and user-defined models.
  const entry = findConfiguredModel(providerId, modelId)
  const model: CatalogModel = {
    modelId,
    efforts: entry?.availableThinkingTiers ? [...entry.availableThinkingTiers] : [],
  }
  if (entry?.name) model.displayName = entry.name
  if (entry?.defaultThinkingTier) model.defaultEffort = entry.defaultThinkingTier
  if (typeof entry?.contextWindow === 'number') model.contextWindow = entry.contextWindow
  return model
}

/** Read settings and describe every configured provider. */
export async function surveyProviderCatalog(
  context: ToolCallContext,
): Promise<ProviderCatalog> {
  const homeDir = (context.options as { homeDir?: string }).homeDir
  // No settings to read: nothing can be shown to be trusted (see `leadTrust`).
  if (!homeDir) return { providers: [], leadTrust: 'untrusted', hasUntrusted: false }
  wipeSettingsMemos()
  const { settings } = await readUserLayer(homeDir, fsForContext(context))
  const configs = settings.providers?.configs ?? {}

  const providers: CatalogProvider[] = Object.entries(configs).map(([id, config]) => {
    // `''` is the "no override" sentinel, so the verdict describes what is on disk,
    // not a stale publish.
    const endpoint = classifyEndpoint(id, config.baseUrl ?? '')
    const { ids, source } = catalogModelIds(id, config)
    return {
      id,
      displayName: config.displayName?.trim() || id,
      // The user's declaration — which is also what `classifyEndpoint` above
      // answers with once they have made one, so the verdict and the reasons
      // beside it cannot disagree.
      trust: resolveProviderTrust(settings.providers, id),
      trustReasons: endpoint.reasons,
      insecure: endpoint.insecure,
      known: isKnownProvider(settings.providers, id),
      models: ids.map(modelId => describeModel(id, modelId)),
      modelsSource: source,
      ...(config.defaultModel || config.model
        ? { defaultModel: config.defaultModel || config.model }
        : {}),
    }
  })
  providers.sort((a, b) => a.id.localeCompare(b.id))

  // The lead's provider, resolved as the spawn resolves it (pinned, else active).
  // Fails closed: an unknown id, or no provider at all, is untrusted.
  const leadProviderId =
    (context.options as { userSpecifiedProviderId?: string })
      .userSpecifiedProviderId ?? settings.providers?.activeProviderId
  const leadTrust: ProviderTrust =
    leadProviderId && isKnownProvider(settings.providers, leadProviderId)
      ? resolveProviderTrust(settings.providers, leadProviderId)
      : 'untrusted'
  return {
    providers,
    ...(leadProviderId ? { leadProviderId } : {}),
    leadTrust,
    hasUntrusted: providers.some(p => p.trust === 'untrusted'),
  }
}

const REASON_TEXT: Record<EndpointTrustReason, string> = {
  'custom-endpoint-provider': 'endpoint supplies its own model catalog',
  'local-provider': 'serves local weights, not a vendor endpoint',
  'base-url-override': 'base URL points off the vendor official domains',
  'insecure-base-url': 'plaintext http:// to a non-loopback host',
  'user-marked-untrusted': 'the user marked this provider untrusted',
}

function describeTrust(provider: CatalogProvider): string {
  if (provider.trust === 'trusted') return 'trusted'
  if (provider.trustReasons.length === 0) return 'untrusted'
  return `untrusted — ${provider.trustReasons.map(r => REASON_TEXT[r]).join('; ')}`
}

const SOURCE_NOTE: Record<CatalogModelsSource, string> = {
  enabled: 'the subset the user enabled',
  custom: 'the models defined on this custom provider',
  host: 'every model the picker offers for it — the user set no curated subset',
  none: 'no enabled models — not usable for a teammate',
}

/** The catalog as text for the model. No keys, no base URLs (module docs). */
export function renderProviderCatalog(catalog: ProviderCatalog): string {
  if (catalog.providers.length === 0) {
    return 'No providers are configured. Ask the user to add one in Settings → Models.'
  }
  const lines: string[] = [
    `Providers configured for this user (${catalog.providers.length}):`,
    '',
    '| Provider | Name | Trust | Models |',
    '| --- | --- | --- | --- |',
  ]
  for (const p of catalog.providers) {
    const models =
      p.models.length > 0
        ? `${p.models.map(m => `\`${m.modelId}\``).join(', ')} (${SOURCE_NOTE[p.modelsSource]})`
        : '(no enabled models — not usable; the user must set it up in Settings → Models)'
    lines.push(
      `| \`${p.id}\` | ${p.displayName} | ${describeTrust(p)} | ${models} |`,
    )
  }

  const withModels = catalog.providers.filter(p => p.models.length > 0)
  if (withModels.length > 0) {
    lines.push(
      '',
      'Reasoning effort you may pin per teammate (SpawnTeammate `effort`, beside `model`; only a listed tier is accepted — pass `effort: \"\"` where none is listed):',
    )
    for (const p of withModels) {
      for (const m of p.models) {
        const efforts =
          m.efforts.length > 0
            ? m.efforts.join(', ') +
              (m.defaultEffort ? ` (default: ${m.defaultEffort})` : ' (no default)')
            : 'not published for this model — do not pin an effort'
        const window = m.contextWindow
          ? `, ${Math.round(m.contextWindow / 1000)}K context`
          : ''
        lines.push(`- \`${p.id}\` / \`${m.modelId}\` — ${efforts}${window}`)
      }
    }
  } else {
    lines.push(
      '',
      'No provider has an enabled model, so no teammate can be spawned. Ask the',
      'user to set one up in Settings → Models (connect the provider and enable',
      'at least one model), then call this tool again.',
    )
  }

  const insecure = catalog.providers.filter(p => p.insecure)
  if (insecure.length > 0) {
    lines.push(
      '',
      'Plaintext http:// endpoint (API key and full transcript travel in clear): ' +
        `${insecure.map(p => `\`${p.id}\``).join(', ')}.`,
    )
  }

  const unknown = catalog.providers.filter(p => !p.known)
  if (unknown.length > 0) {
    lines.push(
      '',
      `Not registered with the host: ${unknown.map(p => `\`${p.id}\``).join(', ')}.`,
      'A spawn naming one of these is REFUSED — the host would otherwise run it',
      'on whatever provider is active, which may be a relay.',
    )
  }

  if (catalog.leadProviderId) {
    lines.push(
      '',
      `This session (the lead) runs on \`${catalog.leadProviderId}\` — ${catalog.leadTrust ?? 'trusted'}.`,
    )
  }
  return lines.join('\n')
}
