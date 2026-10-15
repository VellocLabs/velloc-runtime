/**
 * How many of a provider's picker models are still in its FRESH listing
 * (`providers.freshModelIds`). CONFIRMED only when the listing was fetched and is
 * non-empty; otherwise the picker's own count stands, unconfirmed.
 */
import type { BrowserLlmCatalog } from '../../bridge/browserBridgeProtocol'

export type FreshModelIds = { ok: true; ids: string[] } | { ok: false; error?: string }

export type ModelAvailability = {
  count: number
  /** The count was checked against a fresh, non-empty listing. */
  confirmed: boolean
}

/** The model ids the quick picker offers for one provider — an entry row
 *  (`claude-opus-*@latest`) counts as the concrete model it resolves to. */
export function pickerModelIds(
  catalog: BrowserLlmCatalog | null | undefined,
  providerId: string,
): string[] {
  const provider = catalog?.providers.find(p => p.id === providerId)
  if (!provider) return []
  return provider.models
    .filter(model => model.enabled && !model.pickerAliasId)
    .map(model => model.entry?.resolvedId ?? model.id)
}

const normalize = (id: string): string => id.trim().toLowerCase().replace(/^models\//, '')

/**
 * Whether a listing contains the model. `exact` providers need the id verbatim; a
 * built-in id also matches a dated or versioned snapshot or a `models/` prefix (a
 * snapshot suffix starts with a digit, so `gpt-6` never matches `gpt-6-astra`).
 */
export function listingHasModel(modelId: string, listed: ReadonlySet<string>, exact: boolean): boolean {
  if (exact) return listed.has(modelId)
  const want = normalize(modelId)
  for (const raw of listed) {
    const id = normalize(raw)
    if (id === want) return true
    if (id.startsWith(`${want}-`) && /^[0-9]/.test(id.slice(want.length + 1))) return true
  }
  return false
}

export function modelAvailability(
  pickerIds: readonly string[],
  fresh: FreshModelIds | undefined,
  exact: boolean,
): ModelAvailability {
  // Anything but a well-formed, non-empty listing — a failed fetch, a
  // provider that lists nothing, an older runtime's answer — confirms nothing.
  if (!fresh || fresh.ok !== true || !Array.isArray(fresh.ids) || fresh.ids.length === 0) {
    return { count: pickerIds.length, confirmed: false }
  }
  const listed = exact ? new Set(fresh.ids) : new Set(fresh.ids.map(normalize))
  return {
    count: pickerIds.filter(id => listingHasModel(id, listed, exact)).length,
    confirmed: true,
  }
}
