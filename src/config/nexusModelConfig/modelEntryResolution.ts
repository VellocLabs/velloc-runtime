/**
 * Virtual entry ids → the concrete model ids they currently mean, per provider;
 * recorded where entry rows are built, read by the transport and metadata lookups.
 * A concrete id passes through unchanged.
 */
import { isEntryId, type EntryResolution } from './modelEntries'

const resolutions = new Map<string, EntryResolution>()
const key = (providerId: string, id: string): string => `${providerId}\n${id}`

export function recordEntryResolution(
  providerId: string,
  entryId: string,
  resolution: EntryResolution | undefined,
): void {
  if (resolution) resolutions.set(key(providerId, entryId), resolution)
  else resolutions.delete(key(providerId, entryId))
}

export function entryResolution(providerId: string | undefined, id: string | undefined): EntryResolution | undefined {
  return providerId && id ? resolutions.get(key(providerId, id)) : undefined
}

/**
 * The concrete id for `modelId`: an entry's current resolution, else the id
 * itself. Without a provider id every provider's resolutions are searched
 * (a metadata lookup that does not say which provider).
 */
export function resolveModelId(providerId: string | undefined, modelId: string): string {
  if (!isEntryId(modelId)) return modelId
  if (providerId) return resolutions.get(key(providerId, modelId))?.id ?? modelId
  for (const [k, resolution] of resolutions) {
    if (k.endsWith(`\n${modelId}`)) return resolution.id
  }
  return modelId
}

/** Test hook. */
export function resetEntryResolutions(): void {
  resolutions.clear()
}
