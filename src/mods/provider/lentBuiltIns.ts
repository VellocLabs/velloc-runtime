/**
 * Contract: built-in definitions a router may borrow (F-27 RP-24). A router
 * that lists one in `borrows` gets instances of it, `<built-in id>.<slot>`,
 * each with its own key, served by the built-in's own wire, catalog figures
 * and thinking mapping. The instance's entry names the definition and the
 * router (`definition`, `managedBy`) and carries no `source` or `modOwner`.
 *
 * Security: only the definitions in `LENDABLE` are lent. A lent instance is
 * registered only while a registered router lists its definition in
 * `borrows` (the caller's `borrows`), and its base URL is the definition's
 * own (the settings write path holds it there).
 */

import { getProviderDefinition } from '../../config/nexusModelConfig/providers'
import { GOOGLE_PROVIDER } from '../../config/nexusModelConfig/providers/google'
import { geminiModels } from '../../config/nexusModelConfig/providers/google/models'
import type { ProviderDefinition, ProviderDocumentSource, ProviderModelInfo } from '../../config/nexusModelConfig/providerDefinition'
import type { NexusProviderConfig } from '../../settings/settingsTypes'
import { lentTo } from './providerBorrows'
import { BUILT_IN_LENDER, instanceSlotOf, storedInstanceIds } from './providerInstances'
import type { ManagedDefinition } from './providerInstanceCalls'
import type { ProviderManifest, ProviderWireFormat } from './providerManifest'

type Lendable = {
  base: ProviderDefinition
  /** The brand name, the same in every language. */
  label: string
  /** The listing an instance is served from: the host has no class for its id. */
  models: ProviderDocumentSource<ProviderModelInfo[]>
}

const LENDABLE: ReadonlyMap<string, Lendable> = new Map([
  ['google', { base: GOOGLE_PROVIDER, label: 'Google Gemini', models: geminiModels }],
])

/** Whether `definitionId` is a built-in a router may borrow. */
export function isLendableBuiltIn(definitionId: string): boolean {
  return LENDABLE.has(definitionId)
}

/** The lendable built-in `id` is shaped as an instance of, if any. */
export function lentBuiltInDefinitionOf(id: string): string | undefined {
  for (const definitionId of LENDABLE.keys()) {
    if (instanceSlotOf(definitionId, id) !== undefined) return definitionId
  }
  return undefined
}

/** The base URL a lent instance of `definitionId` is stored with. */
export function lentBuiltInBaseUrl(definitionId: string): string | undefined {
  return LENDABLE.get(definitionId)?.base.config.defaultBaseUrl
}

/** A lendable built-in as the instance calls read a definition; undefined for any other id. */
export function lendableBuiltIn(definitionId: string): ManagedDefinition | undefined {
  const lendable = LENDABLE.get(definitionId)
  const baseUrl = lendable?.base.config.defaultBaseUrl
  const format = lendable?.base.config.wire?.format as ProviderWireFormat | undefined
  if (!lendable || !baseUrl || !format) return undefined
  const manifest: ProviderManifest = {
    providerApi: 1,
    displayName: lendable.label,
    defaultBaseUrl: baseUrl,
    domains: [new URL(baseUrl).hostname],
    format,
    credentials: { methods: ['apiKey'] },
    // No module: the built-in's own wire serves its instances.
    module: '',
  }
  return { provider: { id: definitionId, key: definitionId, manifest }, owner: BUILT_IN_LENDER }
}

/** One stored lent instance of a built-in. */
export type LentBuiltIn = { id: string; definition: string; router: string }

/**
 * The stored instances of lendable built-ins whose router `borrows` their
 * definition now, ordered by id. An entry counts only when it is shaped as
 * an instance of the definition it names, carries no plugin owner and is
 * lent to a router.
 */
export function storedLentBuiltIns(
  configs: Readonly<Record<string, NexusProviderConfig>>,
  borrows: (routerId: string, definitionId: string) => boolean,
): LentBuiltIn[] {
  const out: LentBuiltIn[] = []
  for (const definition of LENDABLE.keys()) {
    for (const id of storedInstanceIds(definition, BUILT_IN_LENDER, configs, 'any')) {
      const router = lentTo(configs[id])
      if (router !== undefined && borrows(router, definition)) out.push({ id, definition, router })
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The registry definition of a lent instance: the built-in's catalog entry
 * under the instance's id, listed by the runtime, managed by its router.
 * The one already registered for the same instance and router is reused, so
 * an unchanged set registers nothing again.
 */
export function lentBuiltInProviderDefinition(lent: LentBuiltIn): ProviderDefinition {
  const registered = getProviderDefinition(lent.id)
  if (registered?.catalogMod?.managedBy === lent.router && registered.catalogMod.definition === lent.definition) return registered
  const lendable = LENDABLE.get(lent.definition)
  if (!lendable) throw new Error(`${lent.definition} is not a built-in a router may borrow`)
  const { base } = lendable
  return {
    ...base,
    label: lendable.label,
    // The host has no class for this id: the runtime builds its row and lists it.
    // Security: the wire names the base URL, so no stored value moves it.
    config: { ...base.config, providerId: lent.id, models: [], ...(base.config.wire ? { wire: { ...base.config.wire, ...(base.config.defaultBaseUrl ? { baseUrl: base.config.defaultBaseUrl } : {}) } } : {}) },
    runtimeOnly: true,
    models: lendable.models,
    catalogMod: {
      state: 'ready',
      definition: lent.definition,
      displayName: lendable.label,
      ...(base.config.defaultBaseUrl ? { defaultBaseUrl: base.config.defaultBaseUrl } : {}),
      credentialMethods: ['apiKey'],
      managedBy: lent.router,
      borrowed: true,
    },
  }
}

/**
 * `configs` as the host is told them: each entry shaped as an instance of a
 * lendable built-in carries that built-in's base URL, whatever settings.json
 * holds (a hand edit included). Security: the host anchors its domain rule
 * and the key's destination on this value.
 */
export function withLentBuiltInBaseUrls(
  configs: Record<string, NexusProviderConfig>,
): Record<string, NexusProviderConfig> {
  const out: Record<string, NexusProviderConfig> = { ...configs }
  for (const [id, config] of Object.entries(configs)) {
    const definition = lentBuiltInDefinitionOf(id)
    const baseUrl = definition === undefined ? undefined : lentBuiltInBaseUrl(definition)
    if (baseUrl !== undefined && config.baseUrl !== baseUrl) out[id] = { ...config, baseUrl }
  }
  return out
}
