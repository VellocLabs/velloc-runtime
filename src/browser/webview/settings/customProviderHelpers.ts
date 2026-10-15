/**
 * Form-layer helpers for the custom-provider connection page. The runtime half lives
 * in `config/customProviderRegistry.ts`; the pieces the form needs are re-exported.
 */

import {
  CUSTOM_BACKEND_IDS,
  isCustomModelComplete,
  type CustomApiCompatibility,
  type CustomProviderRecord,
} from '../../../config/customProviderRegistry'
import type {
  CustomModelDef,
  NexusProviderConfig,
} from '../../../settings/settingsTypes'
import type { ProviderTrust } from '../../../settings/providerTrust'
import { resolveProviderTrust } from '../../../settings/providerTrust'

export {
  CUSTOM_BACKEND_IDS,
  customModelLabel as modelLabel,
  generateCustomProviderId,
  isCustomBackendId,
  isCustomModelComplete as isModelComplete,
  listCustomProviderRecords,
  readCustomProviderRecord,
  resolveCustomProviderIconSvg,
  type CustomApiCompatibility,
  type CustomProviderRecord,
} from '../../../config/customProviderRegistry'

// ── Provider icon registry ──────────────────────────────────────────────────

export type ProviderIconKey =
  | 'generic'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'deepseek'
  | 'qwen'
  | 'grok'
  | 'ollama'
  | 'lmstudio'
  | 'azure'

/** Ordered list shown in the Provider-icon dropdown. */
export const PROVIDER_ICON_KEYS: ProviderIconKey[] = [
  'generic',
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'deepseek',
  'qwen',
  'grok',
  'ollama',
  'lmstudio',
  'azure',
]

/** Human-readable label for an icon key — no i18n; these are brand names. */
export const PROVIDER_ICON_LABELS: Record<ProviderIconKey, string> = {
  generic: 'Generic',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  grok: 'Grok',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  azure: 'Azure',
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Format a token count for display: 262144 → "256K", 1000000 → "1M". */
export function formatTokenCount(n: number | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) {
    const v = n / 1_048_576 >= 1 && n % 1_048_576 === 0 ? n / 1_048_576 : n / 1_000_000
    return `${Number.isInteger(v) ? v : Number(v.toFixed(1))}M`
  }
  if (n >= 1_000) {
    const v = n % 1024 === 0 ? n / 1024 : n / 1000
    return `${Number.isInteger(v) ? v : Number(v.toFixed(1))}K`
  }
  return String(n)
}

/** Capability chips for a model row, in the order the spec lists them. */
export function modelCapabilityBadges(
  m: CustomModelDef,
  labels: {
    tools: string
    reasoning: string
    vision: string
    imageGen: string
    structured: string
  },
): string[] {
  const caps = m.capabilities
  if (!caps) return []
  const out: string[] = []
  if (caps.toolCalling) out.push(labels.tools)
  if (caps.reasoning) out.push(labels.reasoning)
  if (caps.vision) out.push(labels.vision)
  if (caps.imageGeneration) out.push(labels.imageGen)
  if (caps.structuredOutput) out.push(labels.structured)
  return out
}

// ── URL handling ────────────────────────────────────────────────────────────

/**
 * Strip trailing slashes from a base URL so the user doesn't need to
 * understand internal URL-join rules.
 */
export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * Whether the entered base URL is a usable absolute http(s) endpoint. Empty
 * is NOT valid (the submit gate requires a base URL) but is reported as
 * "not yet filled" by the caller rather than as a format error.
 */
export function isValidBaseUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Provider-name uniqueness ────────────────────────────────────────────────

/**
 * Whether `name` collides with a built-in provider label or another custom
 * provider's name (case-insensitive, trimmed). `excludeId` skips the provider being
 * edited.
 */
export function isProviderNameTaken(
  name: string,
  allConfigs: Record<string, NexusProviderConfig>,
  builtInLabels: Map<string, string>,
  excludeId?: string,
): boolean {
  const lower = name.trim().toLowerCase()
  if (!lower) return false
  for (const [id, label] of builtInLabels) {
    if (id !== excludeId && label.trim().toLowerCase() === lower) return true
  }
  for (const [id, cfg] of Object.entries(allConfigs)) {
    if (id === excludeId) continue
    if (
      cfg.isCustomProvider
      && (cfg.displayName ?? '').trim().toLowerCase() === lower
    ) {
      return true
    }
  }
  return false
}

// ── Draft ↔ persisted config ────────────────────────────────────────────────

/** The editable state of the custom-provider form. */
export type CustomProviderDraft = {
  displayName: string
  providerIcon: string
  apiCompatibility: CustomApiCompatibility
  baseUrl: string
  apiKey: string
  defaultModel: string
  models: CustomModelDef[]
  /** Whether the connection runs to the provider's own endpoint ('trusted')
   *  or through a relay, proxy or gateway ('untrusted'). The draft always
   *  holds a CONCRETE value (`resolveProviderTrust`'s default for a new
   *  custom provider is 'untrusted'), so the toggle shows the value that is
   *  actually enforced rather than an empty "unset" state. */
  trust: ProviderTrust
}

export function emptyCustomProviderDraft(): CustomProviderDraft {
  return {
    displayName: '',
    providerIcon: 'generic',
    apiCompatibility: 'openai',
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
    // A user-added endpoint is a relay until the user says otherwise.
    trust: 'untrusted',
    models: [],
  }
}

export function draftFromRecord(record: CustomProviderRecord): CustomProviderDraft {
  return {
    displayName: record.displayName,
    providerIcon: record.providerIcon,
    apiCompatibility: record.apiCompatibility,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey,
    defaultModel: record.defaultModel,
    trust: resolveProviderTrust(
      { configs: { [record.id]: { isCustomProvider: true, ...(record.trust ? { trust: record.trust } : {}) } } },
      record.id,
    ),
    // Only load COMPLETE models into the draft. Legacy providers may carry
    // incomplete model rows persisted by the old "Discover models" flow —
    // those are junk that pollutes the pending-models filter and the save.
    // The next save cleans them out of settings.json.
    models: record.models.filter(isCustomModelComplete).map(m => ({ ...m })),
  }
}

/**
 * The `NexusProviderConfig` to persist for a draft. `enabledModels` holds the
 * COMPLETE model ids (the C++ catalog gate reads it); `lastVerification` carries
 * through from a successful "Test connection". An untested provider still saves.
 */
export function configFromDraft(
  draft: CustomProviderDraft,
  providerId: string,
  verifiedAtMs?: number,
): NexusProviderConfig {
  const complete = draft.models.filter(isCustomModelComplete)
  const config: NexusProviderConfig = {
    isCustomProvider: true,
    displayName: draft.displayName.trim(),
    providerIcon: draft.providerIcon,
    apiCompatibility: draft.apiCompatibility,
    baseUrl: normaliseBaseUrl(draft.baseUrl),
    defaultModel: draft.defaultModel,
    model: draft.defaultModel,
    trust: draft.trust,
    customModels: draft.models,
  }
  if (draft.apiKey) config.apiKey = draft.apiKey
  if (complete.length > 0) config.enabledModels = complete.map(m => m.modelId)
  if (verifiedAtMs !== undefined) {
    config.lastVerification = { providerId, verifiedAtMs }
  }
  return config
}

/** Deep-ish comparison for the unsaved-changes guard. A create
 *  form started from a preset passes that preset as `createBase`, so an
 *  untouched preset is not reported as dirty. */
export function isCustomDraftDirty(
  draft: CustomProviderDraft,
  record: CustomProviderRecord | undefined,
  createBase?: CustomProviderDraft,
): boolean {
  const base = record
    ? draftFromRecord(record)
    : (createBase ?? emptyCustomProviderDraft())
  return (
    draft.displayName.trim() !== base.displayName.trim()
    || draft.providerIcon !== base.providerIcon
    || draft.apiCompatibility !== base.apiCompatibility
    || normaliseBaseUrl(draft.baseUrl) !== normaliseBaseUrl(base.baseUrl)
    || draft.apiKey !== base.apiKey
    || draft.defaultModel !== base.defaultModel
    || draft.trust !== base.trust
    || JSON.stringify(draft.models) !== JSON.stringify(base.models)
  )
}

// ── Submit gate ─────────────────────────────────────────────────────────────

/**
 * Whether "Add provider" / "Save changes" is enabled: a unique name, a valid
 * absolute http(s) Base URL, at least one complete model, and a complete default.
 * Not required: an API key or a passing connection test (keyless gateways).
 */
export function canSubmitCustomProvider(args: {
  displayName: string
  nameTaken: boolean
  baseUrl: string
  models: CustomModelDef[]
  defaultModelId: string
}): boolean {
  const { displayName, nameTaken, baseUrl, models, defaultModelId } = args
  if (!displayName.trim()) return false
  if (nameTaken) return false
  if (!isValidBaseUrl(baseUrl)) return false
  if (models.length === 0) return false
  if (!defaultModelId) return false
  const defaultModel = models.find(m => m.modelId === defaultModelId)
  return isCustomModelComplete(defaultModel)
}

/** The backend slot id a draft's requests execute through. */
export function backendIdForCompatibility(
  compatibility: CustomApiCompatibility,
): string {
  return CUSTOM_BACKEND_IDS[compatibility]
}
