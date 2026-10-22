/**
 * Worker-side handlers for the `providers` bridge namespace; sole writer of the
 * `providers` section in `~/.velloc/settings.json`. Every successful write
 * broadcasts `providers.changed` (the C++ LLM broker subscribes too).
 */

import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  NexusProviderConfig,
  ProvidersBridgeActionMap,
} from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import type { NexusSettingsV1 } from '../../../settings/settingsTypes'
import {
  readUserLayer,
  normaliseProviderOrder,
  updateProvidersSettings,
} from '../../../settings/settingsStore'
// Endpoint-trust view of the same write: a vendor provider with a baseUrl
// override classifies as unofficial, so every publish point that pushes
// configs to the broker also refreshes the trust map.
// Resident-tiny import (no heavy deps) — see services/endpoints/endpointTrust.
import { publishProviderBaseUrlsFromConfigs } from '../../../models/endpoints/endpointTrust'
import { isSealedSecret } from '../../../settings/secretValue'
import { getPluginConfigsMap, setPluginOptions } from '../../../pluginHost/pluginConfigs'
import { isKnownProvider } from '../../../settings/providerTrust'
import { traceLine } from '../../../utils/debugLog'
import { createBridgeRoute } from '../protocol'
import type { ProviderVerifyResult } from '../../../config/nexusModelConfig/providerDefinition'
import type { ProviderModelFamilies } from '../../../models/drivers/modelFamilies'
import { sanitizeUserModels } from '../../../config/nexusModelConfig/userModels'
import { getProviderDefinition, modProviderDefinitions } from '../../../config/nexusModelConfig/providers'
import { declaredSecretNames } from '../../../config/nexusModelConfig/providerDefinition'
import { isModProviderId } from '../../../mods/provider/providerManifest'
import {
  entryForModelId,
  entryId,
  parseEntryId,
  versionParser,
} from '../../../config/nexusModelConfig/modelEntries'

type ProvidersSection = NonNullable<NexusSettingsV1['providers']>

/**
 * Seals one plaintext secret with the OS keystore and resolves the sealed
 * form (`NEXUSENC1:…`). Rejects when the host cannot seal (older binary
 * without `model.encryptSecret` → `NOT_IMPLEMENTED`, or an OS-crypto
 * failure). Callers degrade by keeping the value as entered — see
 * `sealProviderApiKeys`.
 */
export type SecretSealer = (plaintext: string) => Promise<string>

/**
 * Build a `SecretSealer` over a direct-bridge `request` function. Shared by
 * the providers write path (`initBuiltinHandlers`) and the boot migration
 * (`ManagerBootServices`) so both seal through the one host route.
 */
export function makeBridgeSecretSealer(
  request: (req: {
    id: string
    route: ReturnType<typeof createBridgeRoute<'model', 'encryptSecret'>>
    payload: { plaintext: string }
  }) => Promise<
    | { ok: true; result: { value: string } }
    | { ok: false; error: { code: string; message: string } }
  >,
  createId: () => string,
): SecretSealer {
  return async plaintext => {
    const res = await request({
      id: createId(),
      route: createBridgeRoute('model', 'encryptSecret'),
      payload: { plaintext },
    })
    if (!res.ok) {
      throw new Error(`${res.error.code}: ${res.error.message}`)
    }
    return res.result.value
  }
}

/**
 * Seal every plaintext `apiKey` and named `secrets` value in `configs`; empty or
 * sealed values ride through. With no sealer the key is kept AS ENTERED and a
 * warning logged. `changed` reports whether anything was sealed.
 */
export async function sealProviderApiKeys(
  configs: Record<string, NexusProviderConfig>,
  seal: SecretSealer | undefined,
): Promise<{ configs: Record<string, NexusProviderConfig>; changed: boolean }> {
  if (!seal) return { configs, changed: false }
  let changed = false
  const out: Record<string, NexusProviderConfig> = {}
  // One value: sealed, or as entered when the host cannot seal it.
  const sealOne = async (id: string, value: string): Promise<string> => {
    try {
      const sealed = await seal(value)
      if (isSealedSecret(sealed)) {
        changed = true
        return sealed
      }
      traceLine(
        `[providers] host returned an unsealed value for ${id}; keeping the key as entered`,
        { level: 'warn' },
      )
    } catch (err) {
      traceLine(
        `[providers] secret sealing unavailable for ${id} (${
          err instanceof Error ? err.message : String(err)
        }); keeping the key as entered`,
        { level: 'warn' },
      )
    }
    return value
  }
  const needsSeal = (value: string | undefined) => !!value && !isSealedSecret(value)
  for (const [id, config] of Object.entries(configs)) {
    const plainSecrets = Object.entries(config.secrets ?? {}).filter(([, v]) => needsSeal(v))
    if (!needsSeal(config.apiKey) && plainSecrets.length === 0) {
      out[id] = config
      continue
    }
    const next: NexusProviderConfig = { ...config }
    if (needsSeal(config.apiKey)) next.apiKey = await sealOne(id, config.apiKey!)
    if (plainSecrets.length > 0) {
      next.secrets = { ...config.secrets }
      for (const [name, value] of plainSecrets) next.secrets[name] = await sealOne(id, value)
    }
    out[id] = next
  }
  // Hand back the caller's own map when nothing was sealed, so an unchanged
  // read costs no copy and callers can compare by identity.
  return { configs: changed ? out : configs, changed }
}

/**
 * Boot migration: seal plaintext keys still on disk and persist BEFORE the
 * configs are published. A key is replaced only if it still equals the sealed
 * plaintext (a concurrent upsert wins). A failed write is logged and the current
 * configs are returned; the next boot retries.
 */
export async function sealPersistedProviderApiKeys(ctx: {
  homeDir: string
  fs: RuntimeFs
  encryptSecret: SecretSealer | undefined
}): Promise<Record<string, NexusProviderConfig>> {
  const { settings } = await readUserLayer(ctx.homeDir, ctx.fs)
  const current = settings.providers?.configs ?? {}
  const { configs: sealed, changed } = await sealProviderApiKeys(
    current,
    ctx.encryptSecret,
  )
  if (!changed) return current
  let updated: NexusSettingsV1
  try {
    updated = await updateProvidersSettings(ctx.homeDir, ctx.fs, prev => {
    const nextConfigs: Record<string, NexusProviderConfig> = {}
    for (const [id, config] of Object.entries(prev?.configs ?? {})) {
      let next = config
      const replacement = sealed[id]?.apiKey
      if (
        replacement !== undefined
        && config.apiKey === current[id]?.apiKey
        && replacement !== config.apiKey
      ) {
        next = { ...next, apiKey: replacement }
      }
      // Named secrets are sealed the same way, each on the same "still the
      // plaintext that was sealed" condition.
      for (const [name, value] of Object.entries(config.secrets ?? {})) {
        const sealedValue = sealed[id]?.secrets?.[name]
        if (
          sealedValue !== undefined
          && value === current[id]?.secrets?.[name]
          && sealedValue !== value
        ) {
          next = { ...next, secrets: { ...next.secrets, [name]: sealedValue } }
        }
      }
      nextConfigs[id] = next
    }
    return {
      ...(prev?.activeProviderId
        ? { activeProviderId: prev.activeProviderId }
        : {}),
      configs: nextConfigs,
      ...(prev?.order ? { order: prev.order } : {}),
    }
    })
  } catch (err) {
    traceLine(
      `[providers] boot migration could not rewrite settings.json (${
        err instanceof Error ? err.message : String(err)
      }); keys stay as stored until the next boot`,
      { level: 'warn' },
    )
    return current
  }
  return updated.providers?.configs ?? {}
}

export type ProvidersAdapterContext = {
  homeDir: string
  fs: RuntimeFs
  /** Push the new effective `{configs, activeProviderId}` to every
   *  attached WebUI port. Optional so unit tests can omit it. */
  broadcastChanged?: (payload: {
    configs: Record<string, NexusProviderConfig>
    activeProviderId?: string
    /** The display order after the write — every write carries it, so a
     *  listener can take the payload whole. */
    order: string[]
    /** `'order'` when the write changed the display order only — no
     *  provider was configured, so a listener can skip re-fetching the model
     *  catalog. Absent on every other write. */
    reason?: 'order' | 'listing'
    /** With `reason: 'listing'`: the providers whose model listing was
     *  replaced (the model catalog changed). No config changed. */
    listedProviderIds?: string[]
  }) => void
  /** Push the effective configs to the C++ LLM broker
   *  (`model.publishProviderConfigs`). Awaited, bounded, BEFORE `broadcastChanged`
   *  so a refreshed catalog sees the just-saved provider. Optional. */
  publishToBroker?: (payload: {
    configs: Record<string, NexusProviderConfig>
    activeProviderId?: string
  }) => void | Promise<void>
  /** Seal a plaintext api key with the OS keystore (`model.encryptSecret`)
   *  before it is written to settings.json. The plaintext exists in the
   *  guest only between the form and this call; what is persisted, listed,
   *  broadcast and published afterwards is the sealed `NEXUSENC1:` form,
   *  which only native code can open. Optional so unit tests + hosts
   *  without the route degrade to storing the key as entered. */
  encryptSecret?: SecretSealer
  /** Called with the effective configs after every successful write, BEFORE
   *  the broker publish and the WebUI broadcast. The worker wires this to
   *  `setCustomProviderRecords` so a just-created custom provider is routable
   *  (and present in the catalog) by the time the UI refreshes. Synchronous
   *  and best-effort; optional so unit tests can omit it. */
  onConfigsChanged?: (configs: Record<string, NexusProviderConfig>) => void
  /** Probe the stored key of a provider verified in the runtime (`verifyRuntimeProvider`,
   *  over the worker's direct bridge). Absent = no host transport: `verify`
   *  answers `system_unexpected`. */
  verifyRuntimeProvider?: (id: string) => Promise<ProviderVerifyResult & { verifiedAtMs?: number }>
  /** A provider's model families for the settings page's "Add models"
   *  dialog (`providerModelFamilies`). Absent = no host transport. */
  modelFamilies?: (id: string, force: boolean) => Promise<ProviderModelFamilies>
  /** Entry ids a gateway's last reconciliation removed that its listing still
   *  cannot resolve (`staleEntryIds`) — `setModelEntries` drops them, so a
   *  write from a page copy older than the removal never brings one back.
   *  Absent = no guard (no runtime providers). */
  staleEntryIds?: (id: string) => string[]
  /** Forget a runtime-only provider's "models removed" notice. */
  dismissRemovedNotice?: (id: string) => void
  /** Any provider's model ids as it lists them now (`fetchFreshModelIds`). */
  freshModelIds?: (id: string) => Promise<{ ok: true; ids: string[] } | { ok: false; error: string }>
  /** Reload every session's plugins after a provider mod's options or its
   *  stored key changed (`WebUiBridgeContext.reloadPluginsOnAllSessions`), so
   *  its module and its plugin's MCP servers (`${provider_key.KEY}`) load
   *  again with them. Absent: the values apply the next time it loads. */
  reloadPluginsOnAllSessions?: () => void
  /** Clock for the `verifiedAtMs` stamp; tests pin it. */
  now?: () => number
}

export type ProvidersAction = keyof ProvidersBridgeActionMap

// ---------------------------------------------------------------------------
// Validation. Light-touch — the on-disk normaliser drops malformed
// fields silently, but the WebUI client is the user-facing contract,
// so a clear error envelope beats "wrote nothing, returned ok."
// ---------------------------------------------------------------------------

function validateId(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) {
    return '`id` must be a non-empty string'
  }
  // Provider ids are well-known short tokens; keep them URL-safe so
  // the same id rides through every settings surface unmangled.
  if (/[\s/\\]/.test(id)) {
    return '`id` must not contain whitespace, `/`, or `\\`'
  }
  return null
}

function validateConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object') {
    return 'config must be an object'
  }
  const c = config as Record<string, unknown>
  // Every recognised field is optional; reject only on TYPE mismatch
  // (strings where strings are expected, etc.) so a future addition
  // can land without breaking existing writers.
  for (const k of [
    'apiKey',
    'baseUrl',
    'defaultModel',
    'model',
    'oauthDeviceCode',
    'oauthUserCode',
    'oauthVerificationUri',
    // Custom-provider metadata (user-created providers only).
    'displayName',
    'providerIcon',
    // Provider-mod metadata.
    'modVersion',
    'modOwner',
    'account',
  ] as const) {
    if (c[k] !== undefined && typeof c[k] !== 'string') {
      return `\`${k}\` must be a string`
    }
  }
  if (c.secrets !== undefined) {
    if (!c.secrets || typeof c.secrets !== 'object' || Array.isArray(c.secrets)) {
      return '`secrets` must be an object'
    }
    for (const [name, value] of Object.entries(c.secrets as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return `invalid secret name \`${name}\``
      if (typeof value !== 'string') return `\`secrets.${name}\` must be a string`
    }
  }
  if (
    c.apiCompatibility !== undefined
    && c.apiCompatibility !== 'openai'
    && c.apiCompatibility !== 'anthropic'
  ) {
    return '`apiCompatibility` must be "openai" or "anthropic"'
  }
  if (c.isCustomProvider !== undefined && typeof c.isCustomProvider !== 'boolean') {
    return '`isCustomProvider` must be a boolean'
  }
  if (
    c.tokenExpiresAt !== undefined
    && !(typeof c.tokenExpiresAt === 'number' && Number.isFinite(c.tokenExpiresAt) && c.tokenExpiresAt > 0)
  ) {
    return '`tokenExpiresAt` must be a positive number'
  }
  if (c.source !== undefined && c.source !== 'mod') {
    return '`source` must be "mod"'
  }
  if (c.signedIn !== undefined && c.signedIn !== true) {
    return '`signedIn` must be true'
  }
  if (c.credentialMode !== undefined && c.credentialMode !== 'anonymous') {
    return '`credentialMode` must be "anonymous"'
  }
  if (
    c.trust !== undefined
    && c.trust !== 'trusted'
    && c.trust !== 'untrusted'
  ) {
    return '`trust` must be "trusted" or "untrusted"'
  }
  if (
    c.documentInput !== undefined
    && c.documentInput !== 'native'
    && c.documentInput !== 'rasterize'
    && c.documentInput !== 'none'
  ) {
    return '`documentInput` must be "native", "rasterize" or "none"'
  }
  if (c.customModels !== undefined) {
    if (!Array.isArray(c.customModels)) {
      return '`customModels` must be an array'
    }
    for (const entry of c.customModels) {
      if (!entry || typeof entry !== 'object') {
        return '`customModels` entries must be objects'
      }
      const m = entry as Record<string, unknown>
      if (typeof m.modelId !== 'string' || m.modelId.length === 0) {
        return '`customModels` entries must have a non-empty `modelId`'
      }
      for (const k of ['contextWindow', 'maxOutputTokens'] as const) {
        if (m[k] !== undefined && typeof m[k] !== 'number') {
          return `\`customModels[].${k}\` must be a number`
        }
      }
    }
  }
  if (c.userModels !== undefined && !Array.isArray(c.userModels)) {
    return '`userModels` must be an array'
  }
  if (c.modelEntries !== undefined) {
    if (
      !Array.isArray(c.modelEntries)
      || !c.modelEntries.every(e =>
        !!e && typeof e.family === 'string' && e.family.length > 0
        && typeof e.version === 'string' && e.version.length > 0
        && (e.id === undefined || typeof e.id === 'string'))
    ) {
      return '`modelEntries` must be an array of {family, version, id?}'
    }
  }
  if (c.enabledModels !== undefined) {
    if (!Array.isArray(c.enabledModels)) return '`enabledModels` must be an array of strings'
    if (!c.enabledModels.every(m => typeof m === 'string')) {
      return '`enabledModels` must be an array of strings'
    }
  }
  if (c.lastVerification !== undefined) {
    if (
      !c.lastVerification
      || typeof c.lastVerification !== 'object'
    ) {
      return '`lastVerification` must be an object'
    }
    const lv = c.lastVerification as Record<string, unknown>
    if (typeof lv.providerId !== 'string'
        || typeof lv.verifiedAtMs !== 'number') {
      return '`lastVerification` must have { providerId, verifiedAtMs }'
    }
  }
  return null
}

/**
 * The WebUI-facing view of the configs: the stored (sealed) `apiKey` is
 * replaced by `hasApiKey`, and named `secrets` by `storedSecrets` (their
 * names), so no ciphertext ever reaches the web module.
 * Applied to every result and broadcast the WebUI sees; NOT to the broker
 * publish or the worker-internal registry, which need the sealed value.
 */
export function redactProviderConfigsForUi(
  configs: Record<string, NexusProviderConfig>,
): Record<string, NexusProviderConfig> {
  const out: Record<string, NexusProviderConfig> = {}
  for (const [id, config] of Object.entries(configs)) {
    const { apiKey, secrets, ...rest } = config
    const names = Object.keys(secrets ?? {})
    out[id] = {
      ...rest,
      ...(apiKey ? { hasApiKey: true } : {}),
      ...(names.length > 0 ? { storedSecrets: names } : {}),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleList(
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['list']['result']> {
  const { settings, source } = await readUserLayer(ctx.homeDir, ctx.fs)
  const providers = settings.providers
  return {
    configs: redactProviderConfigsForUi(providers?.configs ?? {}),
    activeProviderId: providers?.activeProviderId,
    source,
    order: providers?.order ?? [],
  }
}

async function handleUpsert(
  payload: ProvidersBridgeActionMap['upsert']['payload'],
  ctx: ProvidersAdapterContext,
  /**
   * Build the incoming config from the STORED one, inside the settings
   * lock, instead of taking `payload.config`: a caller that edits one field
   * of what is stored (`setModelEntries`) must not compute the rest from a
   * copy read before the lock, or a write landing in between (a verification
   * stamp, a reconciliation) is overwritten. The result carries no new
   * secret, so it skips sealing.
   */
  derive?: (stored: NexusProviderConfig) => NexusProviderConfig,
): Promise<ProvidersBridgeActionMap['upsert']['result']> {
  const idError = validateId(payload.id)
  if (idError) throw new Error(idError)
  const configError = validateConfig(payload.config)
  if (configError) throw new Error(configError)
  // `hasApiKey` is the worker's own UI-view field; a form echoing it back
  // must not write it. Seal the incoming key BEFORE anything is persisted
  // or fanned out: the file and the broker publish carry the sealed form,
  // the WebUI-facing result and broadcast carry `hasApiKey` only.
  const { hasApiKey: _ignored, storedSecrets: _names, ...rawIncoming } =
    payload.config as NexusProviderConfig
  const { configs: sealedIncoming } = derive
    ? { configs: {} as Record<string, NexusProviderConfig> }
    : await sealProviderApiKeys({ [payload.id]: rawIncoming }, ctx.encryptSecret)
  let keyBefore: string | undefined
  let secretsBefore: Readonly<Record<string, string>> = {}
  let ownerBefore: string | undefined
  const updated = await updateProvidersSettings(ctx.homeDir, ctx.fs, prev => {
    keyBefore = prev?.configs?.[payload.id]?.apiKey
    secretsBefore = prev?.configs?.[payload.id]?.secrets ?? {}
    ownerBefore = prev?.configs?.[payload.id]?.modOwner
    const incoming = derive
      ? derive(prev?.configs?.[payload.id] ?? {})
      : sealedIncoming[payload.id]!
    const next: ProvidersSection = {
      // Auto-promote the first configured provider to active — the same rule as the
      // C++ `HandleUpdateProviderConfig` ("first configured provider
      // auto-promotes to activeProviderId", asserted by
      // nexus-provider-settings.spec.ts). Only when none is set yet, so a
      // user's explicit active selection survives an unrelated upsert. Without
      // this the quick model picker stays empty after the very first provider
      // save (no active provider → no default selection to seed).
      activeProviderId: prev?.activeProviderId ?? payload.id,
      configs: { ...(prev?.configs ?? {}) },
      ...(prev?.order ? { order: prev.order } : {}),
    }
    // The WebUI never holds the key, so its form cannot echo it back:
    // absent `apiKey` = keep the stored one, `""` = clear it (the explicit
    // "remove saved key" affordance), non-empty = replace (already sealed).
    const stored = prev?.configs?.[payload.id]?.apiKey
    const merged: NexusProviderConfig = { ...incoming }
    if (incoming.apiKey === undefined) {
      if (stored) merged.apiKey = stored
    } else if (incoming.apiKey === '') {
      delete merged.apiKey
    }
    // Named secrets, name by name, the same three-way rule; an absent map
    // (every form that only edits other fields) keeps them all.
    const storedSecrets = prev?.configs?.[payload.id]?.secrets
    const secrets: Record<string, string> = { ...storedSecrets }
    for (const [name, value] of Object.entries(incoming.secrets ?? {})) {
      if (value === '') delete secrets[name]
      else secrets[name] = value
    }
    if (Object.keys(secrets).length > 0) merged.secrets = secrets
    else delete merged.secrets
    next.configs[payload.id] = merged
    return next
  })
  const configs = updated.providers?.configs ?? {}
  const activeProviderId = updated.providers?.activeProviderId
  // Refresh the endpoint-trust baseUrl view on the SAME write that reaches
  // the broker, so it reclassifies before the next model call.
  publishProviderBaseUrlsFromConfigs(configs)
  // Push to the broker FIRST (awaited) so it has the new config before the
  // WebUI is told to refresh; broadcasting first lets the shell's
  // `providers.changed` → refreshModelCatalog race ahead of the broker update.
  ctx.onConfigsChanged?.(configs)
  await ctx.publishToBroker?.({ configs, activeProviderId })
  const uiConfigs = redactProviderConfigsForUi(configs)
  ctx.broadcastChanged?.({
    configs: uiConfigs,
    activeProviderId,
    order: updated.providers?.order ?? [],
  })
  const after = configs[payload.id]
  const secretsAfter = after?.secrets ?? {}
  const secretsChanged = [...new Set([...Object.keys(secretsBefore), ...Object.keys(secretsAfter)])]
    .some(name => secretsBefore[name] !== secretsAfter[name])
  const ownershipChanged = ownerBefore !== after?.modOwner
    && (!!keyBefore || !!after?.apiKey || Object.keys(secretsBefore).length > 0 || Object.keys(secretsAfter).length > 0)
  if (isModProviderId(payload.id) && ((keyBefore ?? '') !== (after?.apiKey ?? '') || secretsChanged || ownershipChanged)) {
    ctx.reloadPluginsOnAllSessions?.()
  }
  return { ok: true, configs: uiConfigs, activeProviderId }
}

async function handleRemove(
  payload: ProvidersBridgeActionMap['remove']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['remove']['result']> {
  const idError = validateId(payload.id)
  if (idError) throw new Error(idError)
  // No-op short-circuit — same pattern as mcpSettings, so an
  // idempotent remove doesn't spam re-renders to every open tab.
  const { settings: current } = await readUserLayer(ctx.homeDir, ctx.fs)
  const currentConfigs = current.providers?.configs
  let hadCredentials = false
  const wasActive = current.providers?.activeProviderId === payload.id
  if (
    (!currentConfigs || !(payload.id in currentConfigs))
    && !wasActive
  ) {
    return {
      ok: true,
      configs: redactProviderConfigsForUi(currentConfigs ?? {}),
      activeProviderId: current.providers?.activeProviderId,
    }
  }
  const updated = await updateProvidersSettings(ctx.homeDir, ctx.fs, prev => {
    const nextConfigs = { ...(prev?.configs ?? {}) }
    const removed = nextConfigs[payload.id]
    hadCredentials = !!removed?.apiKey || Object.keys(removed?.secrets ?? {}).length > 0
    delete nextConfigs[payload.id]
    // Clear activeProviderId if it was pointing at the removed id so
    // the UI doesn't surface a dangling selection.
    const nextActive = prev?.activeProviderId === payload.id
        ? undefined
        : prev?.activeProviderId
    // The order is kept whole: it names providers, not configs, and a
    // removed built-in that is re-added returns to where the user put it.
    const order = prev?.order
    if (
      Object.keys(nextConfigs).length === 0
      && nextActive === undefined
      && !order?.length
    ) {
      return undefined
    }
    return {
      activeProviderId: nextActive,
      configs: nextConfigs,
      ...(order ? { order } : {}),
    }
  })
  const configs = updated.providers?.configs ?? {}
  const activeProviderId = updated.providers?.activeProviderId
  // A removed override must revert the provider to official classification.
  publishProviderBaseUrlsFromConfigs(configs)
  // Push to the broker FIRST (awaited) so it has the new config before the
  // WebUI is told to refresh; broadcasting first lets the shell's
  // `providers.changed` → refreshModelCatalog race ahead of the broker update.
  ctx.onConfigsChanged?.(configs)
  // The broker merges a publish per provider and keeps one the publish leaves
  // out, so a removed provider's named secrets (an OpenRouter management key)
  // would outlive the removal. Name it with no secrets: the publish's secret
  // mirror (config/providerSecrets.ts) turns that into `''` for each one it
  // declares, which removes them.
  const publishConfigs: Record<string, NexusProviderConfig> =
    declaredSecretNames(getProviderDefinition(payload.id)).length > 0
      ? { ...configs, [payload.id]: { secrets: {} } }
      : configs
  await ctx.publishToBroker?.({ configs: publishConfigs, activeProviderId })
  const uiConfigs = redactProviderConfigsForUi(configs)
  ctx.broadcastChanged?.({
    configs: uiConfigs,
    activeProviderId,
    order: updated.providers?.order ?? [],
  })
  if (hadCredentials && isModProviderId(payload.id)) ctx.reloadPluginsOnAllSessions?.()
  return { ok: true, configs: uiConfigs, activeProviderId }
}

async function handleSetActive(
  payload: ProvidersBridgeActionMap['setActive']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['setActive']['result']> {
  const idError = validateId(payload.id)
  if (idError) throw new Error(idError)
  // A built-in id is accepted without a config (an OAuth sign-in or broker-pref key
  // lives only in the broker); any other unknown id is refused. Checked inside the
  // locked update so it judges the configs being written.
  const updated = await updateProvidersSettings(ctx.homeDir, ctx.fs, prev => {
    if (!isKnownProvider(prev, payload.id)) {
      throw new Error(
        `activeProviderId "${payload.id}" is not a configured provider`,
      )
    }
    return {
      activeProviderId: payload.id,
      configs: { ...(prev?.configs ?? {}) },
      ...(prev?.order ? { order: prev.order } : {}),
    }
  })
  const effectiveConfigs = updated.providers?.configs ?? {}
  const activeProviderId = updated.providers?.activeProviderId
  publishProviderBaseUrlsFromConfigs(effectiveConfigs)
  // Publish to the broker FIRST (awaited), THEN notify the WebUI — see the
  // upsert handler + publishToBroker doc for the refresh-race rationale.
  ctx.onConfigsChanged?.(effectiveConfigs)
  await ctx.publishToBroker?.({ configs: effectiveConfigs, activeProviderId })
  const uiConfigs = redactProviderConfigsForUi(effectiveConfigs)
  ctx.broadcastChanged?.({
    configs: uiConfigs,
    activeProviderId,
    order: updated.providers?.order ?? [],
  })
  return { ok: true, configs: uiConfigs, activeProviderId }
}

/**
 * Replace the display order. Nothing reaches the broker: order is display
 * only (the home list and the quick picker), it configures no provider. The
 * WebUI is still told, so every open surface — the picker included — re-sorts.
 */
async function handleSetOrder(
  payload: ProvidersBridgeActionMap['setOrder']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['setOrder']['result']> {
  if (!Array.isArray(payload?.order)) {
    throw new Error('order must be an array of provider ids')
  }
  const order = normaliseProviderOrder(payload.order)
  const updated = await updateProvidersSettings(ctx.homeDir, ctx.fs, prev => ({
    ...(prev?.activeProviderId
      ? { activeProviderId: prev.activeProviderId }
      : {}),
    configs: { ...(prev?.configs ?? {}) },
    ...(order.length > 0 ? { order } : {}),
  }))
  const stored = updated.providers?.order ?? []
  ctx.broadcastChanged?.({
    configs: redactProviderConfigsForUi(updated.providers?.configs ?? {}),
    activeProviderId: updated.providers?.activeProviderId,
    order: stored,
    reason: 'order',
  })
  return { ok: true, order: stored }
}

/**
 * `providers.verify` — probe a runtime-only provider's STORED key. On success
 * the runtime stamps `lastVerification` itself and refreshes the model
 * listing (picking the tier models on a first connection) — the caller writes
 * nothing afterwards, so it cannot overwrite either with a stale copy.
 */
export async function handleVerify(
  payload: ProvidersBridgeActionMap['verify']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['verify']['result']> {
  const idError = validateId(payload?.id)
  if (idError) throw new Error(idError)
  if (!ctx.verifyRuntimeProvider) {
    return { ok: false, errorCode: 'system_unexpected', message: 'no host transport' }
  }
  const result = await ctx.verifyRuntimeProvider(payload.id)
  if (result.ok) return { ok: true, verifiedAtMs: result.verifiedAtMs ?? (ctx.now ?? Date.now)() }
  return {
    ok: false,
    errorCode: result.code,
    message: result.message,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
  }
}

/**
 * `providers.modelFamilies` — a provider's model families, each with its
 * versions, for the settings page's "Add models" dialog (`force` re-fetches
 * the provider's listing first). A failed fetch still answers, with what is
 * known and the error.
 */
export async function handleModelFamilies(
  payload: ProvidersBridgeActionMap['modelFamilies']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['modelFamilies']['result']> {
  const idError = validateId(payload?.id)
  if (idError) throw new Error(idError)
  if (!ctx.modelFamilies) return { ok: false, error: 'no host transport', families: [] }
  return ctx.modelFamilies(payload.id, payload.force === true)
}

/**
 * `providers.setModelEntries` — replace one provider's model entries, merged
 * into the STORED config. The default moves to the first entry when its entry is
 * gone; `enabledModels` is dropped; `staleEntryIds` are dropped from the write.
 */
export async function handleSetModelEntries(
  payload: ProvidersBridgeActionMap['setModelEntries']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['setModelEntries']['result']> {
  const idError = validateId(payload?.id)
  if (idError) throw new Error(idError)
  const entriesError = validateConfig({ modelEntries: payload.entries } as NexusProviderConfig)
  if (entriesError) throw new Error(entriesError)
  const stale = new Set(ctx.staleEntryIds?.(payload.id) ?? [])
  const entries = payload.entries
    .filter(e => !stale.has(entryId(e)))
    .map(e => ({
      family: e.family,
      version: e.version,
      ...(e.id ? { id: e.id } : {}),
    }))
  const ids = entries.map(entryId)
  const parse = versionParser(payload.id)
  const requested = payload.defaultModel && ids.includes(payload.defaultModel) ? payload.defaultModel : undefined
  // Built from the config as stored at write time (see `derive`).
  return handleUpsert({ id: payload.id, config: {} }, ctx, stored => {
    const { apiKey: _key, hasApiKey: _flag, enabledModels: _legacy, ...rest } = stored
    const next: NexusProviderConfig = { ...modMarker(payload.id), ...rest, modelEntries: entries }
    const current = stored.defaultModel ?? stored.model
    const kept = current
      ? (() => {
          const entry = parseEntryId(current) ?? entryForModelId(current, entries, parse)
          return entry && ids.includes(entryId(entry)) ? entryId(entry) : undefined
        })()
      : undefined
    const defaultModel = requested ?? kept ?? ids[0]
    if (defaultModel) {
      next.defaultModel = defaultModel
      next.model = defaultModel
    } else {
      delete next.defaultModel
      delete next.model
    }
    return next
  })
}

/** A provider mod's config carries its marker even when the first write to it
 *  is a model edit made before any key (the stored config, when there is one,
 *  already has it and wins). */
function modMarker(id: string): Pick<NexusProviderConfig, 'source'> {
  return getProviderDefinition(id)?.catalogMod ? { source: 'mod' } : {}
}

/**
 * `providers.setUserModels` — replace the models a person added by hand to a
 * provider mod (its manifest's `modelsUi.customModels` must allow it). Rows
 * are sanitized here (the manifest's formats bound `format`), merged into the
 * STORED config like `setModelEntries`; the key stays stored. A model removed
 * here that was also a picked entry leaves the entries at the next
 * reconciliation (the listing no longer has it).
 */
export async function handleSetUserModels(
  payload: ProvidersBridgeActionMap['setUserModels']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['setUserModels']['result']> {
  const idError = validateId(payload?.id)
  if (idError) throw new Error(idError)
  const allowed = getProviderDefinition(payload.id)?.catalogMod?.modelsUi?.customModels
  if (!allowed) throw new Error(`${payload.id} does not accept models added by hand`)
  if (!Array.isArray(payload.models)) throw new Error('`models` must be an array')
  const models = sanitizeUserModels(payload.models, allowed.formats)
  return handleUpsert({ id: payload.id, config: {} }, ctx, stored => {
    const { apiKey: _key, hasApiKey: _flag, userModels: _old, ...rest } = stored
    const base = { ...modMarker(payload.id), ...rest }
    return models.length > 0 ? { ...base, userModels: models } : base
  })
}

/** `providers.dismissRemoved` — the user read the "models removed" notice. */
export async function handleDismissRemoved(
  payload: ProvidersBridgeActionMap['dismissRemoved']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['dismissRemoved']['result']> {
  const idError = validateId(payload?.id)
  if (idError) throw new Error(idError)
  ctx.dismissRemovedNotice?.(payload.id)
  return { ok: true }
}

/**
 * `providers.freshModelIds` — a provider's model ids as it lists them now, for
 * the home page's availability count. Answers `ok: false` (never throws) when
 * the listing cannot be fetched: the page then keeps an unconfirmed count.
 */
export async function handleFreshModelIds(
  payload: ProvidersBridgeActionMap['freshModelIds']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['freshModelIds']['result']> {
  const idError = validateId(payload?.id)
  if (idError) throw new Error(idError)
  if (!ctx.freshModelIds) return { ok: false, error: 'no host transport' }
  return ctx.freshModelIds(payload.id)
}

/** A plugin's id as `pluginConfigs` is keyed (`<name>@<marketplace>`). */
function validatePluginId(plugin: unknown): string | null {
  if (typeof plugin !== 'string' || plugin.length === 0 || plugin.length > 200 || !plugin.includes('@')) {
    return '`plugin` must be a plugin id such as `name@marketplace`'
  }
  return null
}

const isOptionValue = (value: unknown): value is string | number | boolean | string[] =>
  typeof value === 'string'
  || typeof value === 'number'
  || typeof value === 'boolean'
  || (Array.isArray(value) && value.every(entry => typeof entry === 'string'))

/** Non-secret sign-in answers are plugin options under this prefix
 *  (the page's `SIGNIN_OPTION_PREFIX`). */
const SIGNIN_OPTION_PREFIX = 'signin.'

/**
 * The settings the registered provider mods of one plugin declare, by name.
 * What the manifest does not declare is not the page's to read or write; an
 * unknown plugin declares nothing.
 */
function declaredModSettings(plugin: string): Map<string, { sensitive: boolean }> | null {
  let known = false
  const declared = new Map<string, { sensitive: boolean }>()
  for (const definition of modProviderDefinitions()) {
    if (definition.catalogMod?.configId !== plugin) continue
    known = true
    for (const [name, field] of Object.entries(definition.catalogMod.settings ?? {})) {
      declared.set(name, { sensitive: field.sensitive === true })
    }
  }
  return known ? declared : null
}

/**
 * `providers.modOptions` - the options stored for a provider mod's plugin.
 * Which ones may be read is decided HERE from the plugin's declared settings,
 * never from the caller: a declared non-sensitive setting and the `signin.*`
 * answers go back; a declared sensitive one is withheld (only the fact that a
 * value is stored is reported); an option the manifest does not declare, or
 * anything for an unknown plugin, is not returned.
 */
export async function handleModOptions(
  payload: ProvidersBridgeActionMap['modOptions']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['modOptions']['result']> {
  const pluginError = validatePluginId(payload?.plugin)
  if (pluginError) throw new Error(pluginError)
  const declared = declaredModSettings(payload.plugin)
  if (!declared) return { ok: true, options: {}, storedSensitive: [] }
  const stored = (await getPluginConfigsMap({ homeDir: ctx.homeDir }, ctx.fs))[payload.plugin]?.options ?? {}
  const options: Record<string, string | number | boolean | string[]> = {}
  const storedSensitive: string[] = []
  for (const [name, value] of Object.entries(stored)) {
    const setting = declared.get(name)
    if (setting?.sensitive) {
      if (value !== '' && !(Array.isArray(value) && value.length === 0)) storedSensitive.push(name)
      continue
    }
    if (!setting && !name.startsWith(SIGNIN_OPTION_PREFIX)) continue
    options[name] = Array.isArray(value) ? [...value] : (value as string | number | boolean)
  }
  return { ok: true, options, storedSensitive }
}

/**
 * `providers.setModOptions` - store the owned options of a provider mod's
 * plugin. The plugin's other options stay as they are; `setPluginOptions`
 * (the one writer of `pluginConfigs`) keeps the `keep` names' stored values.
 */
export async function handleSetModOptions(
  payload: ProvidersBridgeActionMap['setModOptions']['payload'],
  ctx: ProvidersAdapterContext,
): Promise<ProvidersBridgeActionMap['setModOptions']['result']> {
  const pluginError = validatePluginId(payload?.plugin)
  if (pluginError) throw new Error(pluginError)
  if (!Array.isArray(payload.owned) || !payload.owned.every(n => typeof n === 'string' && n.length > 0)) {
    throw new Error('`owned` must be an array of option names')
  }
  const values = payload.values
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.values(values).every(isOptionValue)) {
    throw new Error('`values` must map option names to text, numbers, booleans or lists of text')
  }
  const declared = declaredModSettings(payload.plugin) ?? new Map<string, { sensitive: boolean }>()
  for (const name of payload.owned) {
    if (!declared.has(name) && !name.startsWith(SIGNIN_OPTION_PREFIX)) {
      throw new Error(`\`${name}\` is not an option this plugin's providers declare`)
    }
  }
  const owned = new Set(payload.owned)
  const keep = (payload.keep ?? []).filter(name => owned.has(name))
  const current = (await getPluginConfigsMap({ homeDir: ctx.homeDir }, ctx.fs))[payload.plugin]?.options ?? {}
  const next: Record<string, string | number | boolean | readonly string[]> = {}
  for (const [name, value] of Object.entries(current)) if (!owned.has(name)) next[name] = value
  for (const [name, value] of Object.entries(values)) if (owned.has(name)) next[name] = value
  await setPluginOptions({ homeDir: ctx.homeDir }, ctx.fs, payload.plugin, next, keep)
  ctx.reloadPluginsOnAllSessions?.()
  return { ok: true }
}

export const providersHandlers = {
  list: handleList,
  upsert: handleUpsert,
  remove: handleRemove,
  setActive: handleSetActive,
  setOrder: handleSetOrder,
  verify: handleVerify,
  modelFamilies: handleModelFamilies,
  setModelEntries: handleSetModelEntries,
  setUserModels: handleSetUserModels,
  dismissRemoved: handleDismissRemoved,
  freshModelIds: handleFreshModelIds,
  modOptions: handleModOptions,
  setModOptions: handleSetModOptions,
}

export async function handleProvidersBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: ProvidersAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as ProvidersAction
  try {
    let result: unknown
    switch (action) {
      case 'list':
        result = await handleList(ctx)
        break
      case 'upsert':
        result = await handleUpsert(
          request.payload as ProvidersBridgeActionMap['upsert']['payload'],
          ctx,
        )
        break
      case 'remove':
        result = await handleRemove(
          request.payload as ProvidersBridgeActionMap['remove']['payload'],
          ctx,
        )
        break
      case 'setActive':
        result = await handleSetActive(
          request.payload as ProvidersBridgeActionMap['setActive']['payload'],
          ctx,
        )
        break
      case 'setOrder':
        result = await handleSetOrder(
          request.payload as ProvidersBridgeActionMap['setOrder']['payload'],
          ctx,
        )
        break
      case 'verify':
        result = await handleVerify(
          request.payload as ProvidersBridgeActionMap['verify']['payload'],
          ctx,
        )
        break
      case 'modelFamilies':
        result = await handleModelFamilies(
          request.payload as ProvidersBridgeActionMap['modelFamilies']['payload'],
          ctx,
        )
        break
      case 'setModelEntries':
        result = await handleSetModelEntries(
          request.payload as ProvidersBridgeActionMap['setModelEntries']['payload'],
          ctx,
        )
        break
      case 'setUserModels':
        result = await handleSetUserModels(
          request.payload as ProvidersBridgeActionMap['setUserModels']['payload'],
          ctx,
        )
        break
      case 'dismissRemoved':
        result = await handleDismissRemoved(
          request.payload as ProvidersBridgeActionMap['dismissRemoved']['payload'],
          ctx,
        )
        break
      case 'freshModelIds':
        result = await handleFreshModelIds(
          request.payload as ProvidersBridgeActionMap['freshModelIds']['payload'],
          ctx,
        )
        break
      case 'modOptions':
        result = await handleModOptions(
          request.payload as ProvidersBridgeActionMap['modOptions']['payload'],
          ctx,
        )
        break
      case 'setModOptions':
        result = await handleSetModOptions(
          request.payload as ProvidersBridgeActionMap['setModOptions']['payload'],
          ctx,
        )
        break
      default: {
        const _exhaustive: never = action
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'unknown_action',
            message: `Unknown providers action: ${String(_exhaustive)}`,
          },
        }
      }
    }
    return {
      id: request.id,
      route: request.route,
      ok: true,
      result,
    } as BrowserBridgeResponse
  } catch (e) {
    return {
      id: request.id,
      route: request.route,
      ok: false,
      error: {
        code: 'providers_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}
