/**
 * `providers.setModBaseUrl`: the one writer of a provider mod's base URL.
 *
 * Security: the provider's requests and its stored key go to this URL, so the
 * rule (`judgeBaseUrl`) is applied HERE, from the registered manifest, never
 * from what the page sends. A host outside the manifest's `domains` is stored
 * only when the call names that same host as confirmed by the person, and it
 * is then kept on the plugin's record as the person's own addition.
 */
import type { NexusProviderConfig, ProvidersBridgeActionMap } from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import { getProviderDefinition } from '../../../config/nexusModelConfig/providers'
import { judgeBaseUrl } from '../../../mods/provider/providerBaseUrlRule'
import { isModProviderId, MOD_PROVIDER_ID_PREFIX } from '../../../mods/provider/providerManifest'
import { boundSettingName } from '../../../mods/provider/providerSettingBinds'
import { readPersonHosts, storePersonHost } from '../../../pluginHost/personWidening'
import { acquireProviderModUpdateService } from '../../../pluginHost/providerModUpdateHolder'
import { readUpdateStateFile } from '../../../pluginHost/providerModUpdateState'

type Payload = ProvidersBridgeActionMap['setModBaseUrl']['payload']
type Result = ProvidersBridgeActionMap['setModBaseUrl']['result']

export type ModBaseUrlDeps = {
  homeDir: string
  fs: RuntimeFs
  /** Rewrite the stored entry from itself, under the settings lock. */
  rewrite: (id: string, derive: (stored: NexusProviderConfig) => NexusProviderConfig) => Promise<unknown>
  /** The provider's listing is asked for again. Failures are the listing's own. */
  relist?: (id: string) => Promise<unknown>
  /** Test seam: keep a confirmed host. Default: the plugin's update record. */
  keepPersonHost?: (pluginId: string, providerKey: string, host: string) => Promise<void>
}

async function keepOnRecord(deps: ModBaseUrlDeps, pluginId: string, providerKey: string, host: string): Promise<void> {
  const service = await acquireProviderModUpdateService()
  if (service) await service.addPersonHost(pluginId, providerKey, host)
  else await storePersonHost({ homeDir: deps.homeDir }, deps.fs, pluginId, providerKey, host)
}

const sameUrl = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

export async function handleSetModBaseUrl(payload: Payload, deps: ModBaseUrlDeps): Promise<Result> {
  const id = payload?.id
  if (typeof id !== 'string' || !isModProviderId(id)) throw new Error('`id` must be the id of a provider mod')
  if (payload.baseUrl !== null && typeof payload.baseUrl !== 'string') {
    throw new Error('`baseUrl` must be text, or null for the default')
  }
  const mod = getProviderDefinition(id)?.catalogMod
  if (!mod || mod.state !== 'ready' || !mod.defaultBaseUrl || boundSettingName(mod.settings, 'baseUrl') === undefined) {
    return { ok: false, reason: 'refused', problem: 'not-editable' }
  }

  let next: string | undefined
  let confirmed: { pluginId: string; providerKey: string; host: string } | undefined
  if (payload.baseUrl !== null) {
    const pluginId = mod.configId
    const providerKey = mod.plugin ? id.slice(`${MOD_PROVIDER_ID_PREFIX}${mod.plugin}.`.length) : ''
    const personHosts =
      pluginId && providerKey ? await readPersonHosts({ homeDir: deps.homeDir }, deps.fs, pluginId, providerKey) : []
    const verdict = judgeBaseUrl(payload.baseUrl, { domains: mod.domains ?? [], personHosts })
    if (verdict.kind === 'refused') return { ok: false, reason: 'refused', problem: verdict.problem }
    if (verdict.kind === 'needs-confirmation') {
      if (payload.confirmedHost !== verdict.host) return { ok: false, reason: 'needs-confirmation', host: verdict.host }
      // Nowhere to keep the person's addition: nothing is stored.
      if (!pluginId || !providerKey) return { ok: false, reason: 'refused', problem: 'not-editable' }
      confirmed = { pluginId, providerKey, host: verdict.host }
      // The record must take the host before the address is stored.
      await readUpdateStateFile({ homeDir: deps.homeDir }, deps.fs, true)
    }
    if (!sameUrl(verdict.url, mod.defaultBaseUrl)) next = verdict.url
  }

  await deps.rewrite(id, stored => {
    const { baseUrl: _previous, ...rest } = stored
    return next === undefined ? rest : { ...rest, baseUrl: next }
  })
  // Kept only once the address is stored: a failed write leaves no host trusted.
  if (confirmed) {
    const keep = deps.keepPersonHost ?? ((plugin, key, host) => keepOnRecord(deps, plugin, key, host))
    await keep(confirmed.pluginId, confirmed.providerKey, confirmed.host)
  }
  // A listing reads the base URL in force: ask again against the new one.
  if (deps.relist) void deps.relist(id).catch(() => undefined)
  return { ok: true, baseUrl: next ?? mod.defaultBaseUrl, overridden: next !== undefined }
}
