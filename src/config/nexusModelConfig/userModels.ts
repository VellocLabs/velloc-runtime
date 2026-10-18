/**
 * Models a person adds by hand to a provider mod's aggregated page
 * (`providers.setUserModels`). They are stored on the provider's config as
 * `userModels` and merged into the provider's listing wherever it is read, so
 * everything downstream (families, entries, figures, the picker) treats them
 * as listed models. A listed model with the same id wins: the provider's
 * statement is better than a hand-typed one.
 */
import type { ModelWire } from './providerDefinition'
import type { ProviderModelInfo } from './providerDefinition'

export const USER_MODEL_FORMATS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini'] as const
export type UserModelFormat = (typeof USER_MODEL_FORMATS)[number]

/** The group and tag names a hand-added model carries (`modelsUi` may label them). */
export const USER_MODEL_GROUP = 'custom'

export const USER_MODELS_MAX = 64
const ID_MAX = 200
const NAME_MAX = 120
const FIGURE_MAX = 100_000_000

export type UserModelDef = {
  /** The id sent to the provider. */
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsImageInput?: boolean
  /** The model reasons (offered the low / medium / high tiers). */
  reasoning?: boolean
  /** The wire format this model speaks, when not the provider's. */
  format?: UserModelFormat
}

function figure(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= FIGURE_MAX
    ? Math.floor(value)
    : undefined
}

/**
 * The well-formed part of whatever is stored or sent: unusable rows and
 * duplicate ids are dropped, strings are trimmed, figures are whole positive
 * numbers. `allowedFormats` (the manifest's `customModels.formats`) drops a
 * format the provider does not offer. Never throws.
 */
export function sanitizeUserModels(raw: unknown, allowedFormats?: readonly string[]): UserModelDef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: UserModelDef[] = []
  for (const row of raw) {
    if (out.length >= USER_MODELS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (id === '' || id.length > ID_MAX || /\s/.test(id) || seen.has(id)) continue
    seen.add(id)
    const def: UserModelDef = { id }
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (name !== '' && name.length <= NAME_MAX) def.name = name
    const contextWindow = figure(r.contextWindow)
    if (contextWindow !== undefined) def.contextWindow = contextWindow
    const maxOutputTokens = figure(r.maxOutputTokens)
    if (maxOutputTokens !== undefined) def.maxOutputTokens = maxOutputTokens
    if (typeof r.supportsImageInput === 'boolean') def.supportsImageInput = r.supportsImageInput
    if (typeof r.reasoning === 'boolean') def.reasoning = r.reasoning
    if (
      typeof r.format === 'string'
      && (USER_MODEL_FORMATS as readonly string[]).includes(r.format)
      && (allowedFormats === undefined || allowedFormats.includes(r.format))
    ) {
      def.format = r.format as UserModelFormat
    }
    out.push(def)
  }
  return out
}

/** What the provider's manifest says a hand-added model needs on the wire,
 *  by format (`modelsUi.customModels.wires`), and the provider's own format. */
export type UserModelWires = {
  wires?: Readonly<Record<string, Record<string, unknown>>>
  defaultFormat?: string
  /** The base URL the provider sends to, which a wire's `baseUrlTrim` is cut from. */
  providerBaseUrl?: string
}

/** A declared wire with `baseUrlTrim` resolved against the provider's base URL:
 *  the suffix cut off when the base ends with it, else no base of its own. */
function resolveDeclaredWire(
  declared: Record<string, unknown> | undefined,
  providerBaseUrl: string | undefined,
): Record<string, unknown> | undefined {
  if (!declared || typeof declared.baseUrlTrim !== 'string') return declared
  const { baseUrlTrim, ...wire } = declared
  const base = providerBaseUrl?.replace(/\/+$/, '')
  if (base && base.endsWith(baseUrlTrim)) wire.baseUrl = base.slice(0, base.length - baseUrlTrim.length)
  return wire
}

/** A hand-added model as a listing row. It is tool-capable by assertion: the
 *  agent needs function calling, and the person added it to use it. Its wire
 *  is the manifest's for its format (the provider's own when it names none),
 *  with the format the person chose laid over it. */
export function userModelToInfo(def: UserModelDef, facts: UserModelWires = {}): ProviderModelInfo {
  const declared = resolveDeclaredWire(facts.wires?.[def.format ?? facts.defaultFormat ?? ''], facts.providerBaseUrl)
  const wire: ModelWire | undefined =
    declared || def.format ? { ...(declared as ModelWire | undefined), ...(def.format ? { format: def.format } : {}) } : undefined
  return {
    id: def.id,
    ...(def.name ? { name: def.name } : {}),
    supportsTools: true,
    ...(def.contextWindow ? { contextWindow: def.contextWindow } : {}),
    ...(def.maxOutputTokens ? { maxOutputTokens: def.maxOutputTokens } : {}),
    ...(def.supportsImageInput !== undefined ? { supportsImageInput: def.supportsImageInput } : {}),
    ...(def.reasoning ? { thinkingTiers: ['low', 'medium', 'high'] } : {}),
    group: USER_MODEL_GROUP,
    tags: [USER_MODEL_GROUP],
    ...(wire ? { wire } : {}),
  }
}

/** The listing with the hand-added models appended (a listed id wins). */
export function withUserModels(
  listed: readonly ProviderModelInfo[],
  defs: readonly UserModelDef[] | undefined,
  facts: UserModelWires = {},
): ProviderModelInfo[] {
  if (!defs || defs.length === 0) return [...listed]
  const have = new Set(listed.map(model => model.id))
  return [...listed, ...defs.filter(def => !have.has(def.id)).map(def => userModelToInfo(def, facts))]
}
