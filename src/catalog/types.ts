/**
 * Model catalog (F-28) shapes. Everything the catalog hands out is in these
 * types; the source's own field names never leave `modelsDevAdapter.ts`.
 */

export type CatalogModel = {
  name: string
  contextWindow?: number
  maxInput?: number
  maxOutput?: number
  toolCall?: boolean
  reasoning?: boolean
  /** Effort names the source states, lower-case, source order. */
  reasoningEfforts?: string[]
  inputModalities: string[]
  /** Field that replays earlier reasoning text. */
  interleavedField?: string
  /** The API style marker the source gives. */
  npm?: string
  /** e.g. 'deprecated'. */
  status?: string
  /** USD per 1M tokens. */
  cost?: { input: number; output: number; cacheRead?: number }
  /** A cost is present and input and output are both 0. */
  free: boolean
}

export type CatalogProviderRecords = Record<string, CatalogModel>

export type CatalogSource = 'live' | 'cache' | 'snapshot' | 'none'

export type CatalogStatus = {
  source: CatalogSource
  fetchedAt?: number
  generatedAt?: number
  models: number
  lastError?: string
}

/** `index.json`, in the local cache and in the bundle snapshot alike. */
export type CatalogIndex = {
  version: 1
  /** Entity tag of the fetched document (cache only). */
  etag?: string
  /** ms since epoch of the last successful fetch or 304 (cache only). */
  fetchedAt?: number
  /** ms since epoch the records were produced. */
  generatedAt: number
  contentHash: string
  /** provider key -> hash of that provider's records. */
  providers: Record<string, string>
  /** Total models across providers. */
  modelCount: number
  /**
   * Set when the file holds only some of the source's providers (the bundle
   * snapshot). It is then not current for a provider it does not list.
   */
  partial?: true
}

export type CatalogMatch = 'exact' | 'normalized' | 'borrowed'

/**
 * What a lookup answers: the record plus how it was found. A borrowed record
 * carries model facts only: `cost`, `free` and `status` are absent from it.
 */
export type CatalogHit = Omit<CatalogModel, 'free'> & {
  free?: boolean
  match: CatalogMatch
  /** The provider the record was borrowed from (match 'borrowed'). */
  from?: string
}

/** `ids.json`: normalized model id -> provider keys that list it. */
export type CatalogIdIndex = {
  version: 1
  ids: Record<string, string[]>
}
