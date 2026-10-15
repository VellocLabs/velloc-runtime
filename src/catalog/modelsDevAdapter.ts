/**
 * The only file that knows the models.dev field names. Pure: a raw document
 * in, per-provider normalized records out. A different source later changes
 * this file only.
 */
import type { CatalogModel, CatalogProviderRecords } from './types'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function posInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

function price(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

const EFFORT_LIST_KEYS = ['efforts', 'levels', 'values', 'options', 'effort'] as const
const EFFORT_NAME_KEYS = ['effort', 'id', 'value', 'name'] as const

/**
 * Effort names the source states for a model, lower-case, in source order.
 * The source has spelled this several ways (a list of names, a list of option
 * objects, an object holding a list); anything else yields nothing.
 */
function collectEfforts(v: unknown, depth: number, out: string[]): void {
  if (depth > 3) return
  if (typeof v === 'string') {
    const name = v.trim().toLowerCase()
    if (name.length > 0 && !out.includes(name)) out.push(name)
    return
  }
  if (Array.isArray(v)) {
    for (const item of v) collectEfforts(item, depth + 1, out)
    return
  }
  if (!isObj(v)) return
  const before = out.length
  for (const key of EFFORT_LIST_KEYS) {
    if (Array.isArray(v[key])) collectEfforts(v[key], depth + 1, out)
  }
  if (out.length > before) return
  for (const key of EFFORT_NAME_KEYS) {
    if (typeof v[key] === 'string') {
      collectEfforts(v[key], depth + 1, out)
      return
    }
  }
}

export function adaptReasoningEfforts(raw: unknown): string[] | undefined {
  const out: string[] = []
  collectEfforts(raw, 0, out)
  return out.length > 0 ? out : undefined
}

/** One source model entry -> our record, or undefined when unusable. */
export function adaptModel(
  id: string,
  raw: unknown,
  providerNpm?: string,
): CatalogModel | undefined {
  if (!isObj(raw)) return undefined
  const limit = isObj(raw.limit) ? raw.limit : {}
  const modalities = isObj(raw.modalities) ? raw.modalities : {}
  const inputs = Array.isArray(modalities.input)
    ? modalities.input.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : []
  const model: CatalogModel = {
    name: str(raw.name) ?? id,
    inputModalities: inputs,
    free: false,
  }
  const contextWindow = posInt(limit.context)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxInput = posInt(limit.input)
  if (maxInput !== undefined) model.maxInput = maxInput
  const maxOutput = posInt(limit.output)
  if (maxOutput !== undefined) model.maxOutput = maxOutput
  if (typeof raw.tool_call === 'boolean') model.toolCall = raw.tool_call
  if (typeof raw.reasoning === 'boolean') model.reasoning = raw.reasoning
  const efforts = adaptReasoningEfforts(raw.reasoning_options)
  if (efforts !== undefined) model.reasoningEfforts = efforts
  if (isObj(raw.interleaved)) {
    const field = str(raw.interleaved.field)
    if (field !== undefined) model.interleavedField = field
  }
  const ownProvider = isObj(raw.provider) ? str(raw.provider.npm) : undefined
  const npm = ownProvider ?? providerNpm
  if (npm !== undefined) model.npm = npm
  const status = str(raw.status)
  if (status !== undefined) model.status = status
  if (isObj(raw.cost)) {
    const input = price(raw.cost.input)
    const output = price(raw.cost.output)
    if (input !== undefined && output !== undefined) {
      model.cost = { input, output }
      const cacheRead = price(raw.cost.cache_read)
      if (cacheRead !== undefined) model.cost.cacheRead = cacheRead
      model.free = input === 0 && output === 0
    }
  }
  return model
}

/**
 * The whole document -> records per provider. `undefined` when the document is
 * not shaped like the source at all. Providers without a single usable model
 * are omitted. Nothing in the result references the input.
 */
export function adaptDocument(
  doc: unknown,
): Record<string, CatalogProviderRecords> | undefined {
  if (!isObj(doc)) return undefined
  const out: Record<string, CatalogProviderRecords> = {}
  for (const [providerKey, rawProvider] of Object.entries(doc)) {
    if (!isObj(rawProvider) || !isObj(rawProvider.models)) continue
    const providerNpm = str(rawProvider.npm)
    const records: CatalogProviderRecords = {}
    let count = 0
    for (const [modelId, rawModel] of Object.entries(rawProvider.models)) {
      const model = adaptModel(modelId, rawModel, providerNpm)
      if (model) {
        records[modelId] = model
        count++
      }
    }
    if (count > 0) out[providerKey] = records
  }
  return out
}
