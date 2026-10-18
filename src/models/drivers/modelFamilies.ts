/**
 * A provider's model families for the settings page's "Add models" dialog
 * (`providers.modelFamilies`): every family it offers, each with its versions
 * (newest first, previews after) and what the page shows beside them. A
 * gateway's come from its listing; a built-in provider's from its curated
 * rows plus discovered versions of those families (modelEntryCatalog.ts).
 */
import {
  createBridgeRoute,
  type BrowserBridgeTransport,
  type BrowserLlmCatalog,
} from '../../browser/bridge/browserBridgeProtocol'
import {
  groupFamilies,
  versionParser,
  type ModelFamily,
} from '../../config/nexusModelConfig/modelEntries'
import { pickVersionId, type ModelVersionInfo } from '../../config/nexusModelConfig/providers/shared/modelVersions'
import type { LocalizedText } from '../../config/localizedText'
import { builtInFamilies, uncuratedModels, usesModelEntries } from './modelEntryCatalog'
import { USER_MODEL_GROUP } from '../../config/nexusModelConfig/userModels'
import { isRuntimeOnlyProvider, listsModelsInRuntime } from './driverRegistry'
import {
  listRuntimeProviderModels,
  overlayBuiltInListings,
  refreshRuntimeProviderModels,
  runtimeProviderConfigs,
} from './runtimeProviders'

export type ProviderFamilyVersion = {
  versionLabel: string
  /** The concrete id the version resolves to now (stored with an added
   *  entry as its fallback). */
  id: string
  preview: boolean
  contextWindow?: number
  reasoning: boolean
  vision?: boolean
  /** Priced at zero by the provider (the Free models view). */
  free?: boolean
  /** The listing's base price, USD per million tokens (a gateway's only). */
  price?: { input: number; output: number }
  /** One line about the version (a provider mod's listing). */
  description?: LocalizedText
  /** The provider retired or is retiring it. */
  deprecated?: boolean
  /** Badge names the provider's listing gave the model (a provider mod's). */
  tags?: string[]
  /** The model was added by hand (a provider mod's `userModels`). */
  userAdded?: boolean
}

export type ProviderFamilyDetail = {
  family: string
  familyLabel: string
  /** The group the page lists the family under (a provider mod's listing). */
  group?: string
  versions: ProviderFamilyVersion[]
}

export type ProviderModelFamilies =
  | {
      ok: true
      families: ProviderFamilyDetail[]
      /** A gateway's last removal: display names (`ids`) and entry ids. */
      removed?: { ids: string[]; entryIds?: string[]; at: number }
      /** A built-in provider's models outside its curated catalog (chat
       *  models only) — offered, unverified, under "Other models". */
      others?: ProviderFamilyDetail[]
    }
  | { ok: false; error: string; families: ProviderFamilyDetail[] }

function details(
  families: ReadonlyMap<string, ModelFamily>,
  parse: (id: string) => ModelVersionInfo,
  figuresOf: (id: string) => Omit<ProviderFamilyVersion, 'versionLabel' | 'id' | 'preview'>,
  groupOfId: (id: string) => string | undefined = () => undefined,
): ProviderFamilyDetail[] {
  const groupOf = (family: ModelFamily): { group?: string } => {
    const group = groupOfId(family.versions[0]?.ids[0] ?? '')
    return group ? { group } : {}
  }
  return [...families.values()]
    .map(family => ({
      family: family.family,
      familyLabel: family.label,
      ...groupOf(family),
      versions: family.versions.map(version => {
        const id = pickVersionId(version.ids, parse) ?? version.ids[0]!
        return {
          versionLabel: version.versionLabel,
          id,
          preview: version.preview,
          ...figuresOf(id),
        }
      }),
    }))
    .sort((a, b) => a.familyLabel.localeCompare(b.familyLabel))
}

async function hostCatalog(transport: BrowserBridgeTransport): Promise<BrowserLlmCatalog> {
  const response = (await transport.request({
    id: `model-families-${crypto.randomUUID()}`,
    route: createBridgeRoute('model', 'catalog'),
    payload: {},
  })) as { ok: true; result: BrowserLlmCatalog } | { ok: false; error: { code: string; message: string } }
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response.result
}

/** Never rejects: a failure answers `ok: false` with whatever is known. */
export async function providerModelFamilies(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { force?: boolean } = {},
): Promise<ProviderModelFamilies> {
  if (!usesModelEntries(providerId)) {
    return { ok: false, error: `${providerId} defines its own models`, families: [] }
  }
  const parse = versionParser(providerId)
  if (isRuntimeOnlyProvider(providerId)) {
    const listing = await listRuntimeProviderModels(transport, providerId, options)
    const byId = new Map(listing.models.map(m => [m.id, m]))
    const families = details(
      groupFamilies(listing.models.map(m => ({ id: m.id, ...(m.name ? { label: m.name } : {}) })), parse),
      parse,
      id => {
        const info = byId.get(id)
        return {
          ...(info?.tags?.length ? { tags: [...info.tags] } : {}),
          ...(info?.description ? { description: info.description } : {}),
          ...(info?.deprecated ? { deprecated: true } : {}),
          ...(info?.group === USER_MODEL_GROUP ? { userAdded: true } : {}),
          ...(info?.contextWindow ? { contextWindow: info.contextWindow } : {}),
          reasoning: !!info?.thinkingTiers?.some(tier => tier !== 'none'),
          ...(info?.supportsImageInput !== undefined ? { vision: info.supportsImageInput } : {}),
          ...(info?.free ? { free: true } : {}),
          ...(info?.price ? { price: { ...info.price } } : {}),
        }
      },
      id => byId.get(id)?.group,
    )
    return listing.ok
      ? { ok: true, families, ...(listing.removed ? { removed: listing.removed } : {}) }
      : { ok: false, error: listing.error, families }
  }
  try {
    if (options.force) {
      // Re-run the discovery first — the runtime's listing for a provider
      // whose definition has one, else the host's; a provider without a
      // listing still answers from its curated rows. Never rejects.
      if (listsModelsInRuntime(providerId)) {
        await refreshRuntimeProviderModels(transport, providerId, { force: true })
      } else {
        await transport
          .request({
            id: `model-families-refresh-${crypto.randomUUID()}`,
            route: createBridgeRoute('providerAuth', 'refresh'),
            payload: { providerId },
          })
          .catch(() => undefined)
      }
    }
    const catalog = (await overlayBuiltInListings(transport, await hostCatalog(transport)))!
    const provider = catalog.providers.find(p => p.id === providerId)
    if (!provider) return { ok: false, error: `the host lists no ${providerId}`, families: [] }
    // With the stored entries, as the catalog build passes them: the call also
    // re-grafts the conservative rules of the uncurated models the user added
    // (modelEntryCatalog.ts), and without the entries it would drop them.
    const { families, byId } = builtInFamilies(
      provider,
      runtimeProviderConfigs()[providerId]?.modelEntries ?? [],
    )
    const otherRows = uncuratedModels(provider)
    const otherById = new Map(otherRows.map(m => [m.id, m]))
    const others = details(
      groupFamilies(otherRows.map(m => ({ id: m.id, label: m.label })), parse),
      parse,
      id => ({
        ...(otherById.get(id)?.contextWindow ? { contextWindow: otherById.get(id)!.contextWindow! } : {}),
        reasoning: false,
      }),
    )
    return {
      ok: true,
      ...(others.length > 0 ? { others } : {}),
      families: details(families, parse, id => {
        const model = byId.get(id)
        return {
          ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}),
          reasoning: !!model?.availableThinkingTiers?.some(tier => tier !== 'none'),
          ...(model?.supportsImageInput !== undefined ? { vision: model.supportsImageInput } : {}),
        }
      }),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), families: [] }
  }
}
