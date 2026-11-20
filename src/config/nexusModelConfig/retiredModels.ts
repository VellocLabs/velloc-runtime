/**
 * Model ids a provider has shut down, each with the model a stored selection
 * of it now names. Applied where a stored selection is read (settings.json, a
 * session's saved pick), so a shut-down id never reaches a request.
 */
import { GOOGLE_RETIRED_MODELS } from './providers/google/retired'

export type RetiredModel = {
  /** The concrete ids, snapshots included. */
  ids: RegExp
  /** The picker entry ids (`<family>@<version>`) that pin them. */
  entries: readonly string[]
  successor: { id: string; family: string; version: string }
}

const RETIRED: Readonly<Record<string, readonly RetiredModel[]>> = {
  google: GOOGLE_RETIRED_MODELS,
}

const successorEntryId = (retired: RetiredModel): string =>
  `${retired.successor.family}@${retired.successor.version}`

function retiredModel(providerId: string, modelId: string): RetiredModel | undefined {
  return RETIRED[providerId]?.find(r => r.entries.includes(modelId) || r.ids.test(modelId))
}

/** The id a stored `modelId` now names: a retired entry id becomes its
 *  successor's entry id, a retired concrete id its successor's id; any other
 *  id is returned unchanged. */
export function successorModelId(providerId: string, modelId: string): string {
  const retired = retiredModel(providerId, modelId)
  if (!retired) return modelId
  return retired.entries.includes(modelId) ? successorEntryId(retired) : retired.successor.id
}

export function withSuccessorModel<T extends { providerId: string; modelId: string }>(selection: T): T {
  const modelId = successorModelId(selection.providerId, selection.modelId)
  return modelId === selection.modelId ? selection : { ...selection, modelId }
}

/** Stored model ids with each retired one replaced; the first of any
 *  duplicates is kept. */
export function withSuccessorIds(providerId: string, ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => successorModelId(providerId, id)))]
}

/** Stored picker entries with each retired pinned entry replaced by its
 *  successor; the first of any duplicates is kept. */
export function withSuccessorEntries(
  providerId: string,
  entries: ReadonlyArray<{ family: string; version: string; id?: string }>,
): Array<{ family: string; version: string; id?: string }> {
  const out: Array<{ family: string; version: string; id?: string }> = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const retired = retiredModel(providerId, `${entry.family}@${entry.version}`)
    const next = retired ? { ...retired.successor } : entry
    const key = `${next.family}@${next.version}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(next)
  }
  return out
}
