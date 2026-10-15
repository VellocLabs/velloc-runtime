import {
  NEXUS_MODEL_CONFIG,
  type NexusConfiguredModel,
  type NexusModelConfig,
} from '../config/nexusModelConfig'
import { catalogFiguresRead, catalogKeysOf } from '../config/nexusModelConfig/catalogFigures'
import { findConfiguredModelIn } from '../config/nexusModelConfig/findConfiguredModel'
import { entryId, LATEST } from '../config/nexusModelConfig/modelEntries'
import { resolveModelId } from '../config/nexusModelConfig/modelEntryResolution'
import { deriveCanonicalModelId } from '../config/nexusModelConfig/patterns'
import {
  THINKING_TIER_ORDER,
  tierFromEffort,
} from '../config/nexusModelConfig/providers/shared/listing'
import { borrowTierModel } from '../models/borrowedTierLadder'
import {
  getModelTierPin,
  getSessionModelPolicySetting,
} from '../models/tierSettingsSnapshot'
import type { SessionModelPolicy } from '../settings/settingsTypes'

export const FALLBACK_CONTEXT_WINDOW = 200_000
export const MODEL_CONTEXT_WINDOW_1M = 1_000_000

function findConfiguredModel(
  rawModelId: string,
  providerId: string | undefined,
  config: NexusModelConfig,
): NexusConfiguredModel | undefined {
  return findConfiguredModelIn(config, providerId, rawModelId)
}

/**
 * Resolves the context window for a given model id. Primary source is the
 * hard-coded `NEXUS_MODEL_CONFIG` table. Legacy `[1m]` suffix handling and
 * a 200K fallback remain so uncatalogued models still render sensibly.
 */
export function contextWindowOf(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): number {
  if (!modelId) return FALLBACK_CONTEXT_WINDOW
  if (/\[1m\]/i.test(modelId)) return MODEL_CONTEXT_WINDOW_1M

  const configured = findConfiguredModel(modelId, providerId, config)
  if (configured?.contextWindow) return configured.contextWindow

  if (configured) warnCatalogWindowMissing(modelId, providerId, config)
  return FALLBACK_CONTEXT_WINDOW
}

const warnedWindowFallback = new Set<string>()

/**
 * A developer-console note (never shown to the user) when a built-in row
 * that takes its window from the model catalog still has none after the
 * catalog was read: the snapshot guarantee (`builtinCatalogCoverage.ts`)
 * should have made that impossible. Once per model.
 */
function warnCatalogWindowMissing(
  modelId: string,
  providerId: string | undefined,
  config: NexusModelConfig,
): void {
  if (!providerId || catalogKeysOf(config, providerId).length === 0) return
  if (!catalogFiguresRead(providerId)) return
  const key = `${providerId}/${modelId}`
  if (warnedWindowFallback.has(key)) return
  warnedWindowFallback.add(key)
  console.warn(
    `[model-config] ${key}: no context window in its row or the model catalog; using the ${FALLBACK_CONTEXT_WINDOW} default`,
  )
}

export function outputBudgetOf(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): number | undefined {
  if (!modelId) return undefined
  const configured = findConfiguredModel(modelId, providerId, config)
  return configured?.maxOutputTokens
}

/**
 * The initial-request max output tokens for a model (`defaultMaxOutputTokens`); max-tokens recovery
 * escalates to `getMaxOutputTokensForModel`. `undefined` for uncatalogued models (caller's floor applies).
 */
export function getDefaultMaxOutputTokensForModel(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): number | undefined {
  if (!modelId) return undefined
  const configured = findConfiguredModel(modelId, providerId, config)
  return configured?.defaultMaxOutputTokens
}

/**
 * The curated `availableThinkingTiers` for a model, or `undefined` (no curated entry or no field).
 * Callers drop a stale persisted tier with it: effort vocabularies differ per model family.
 */
export function getAvailableThinkingTiersForModel(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): readonly string[] | undefined {
  if (!modelId) return undefined
  const configured = findConfiguredModel(modelId, providerId, config)
  return configured?.availableThinkingTiers
}

/**
 * Whether the provider's catalog is the authority on its models' thinking
 * tiers (`filterMode: 'curated'`). Under such a provider a model with no
 * tier list — a row without one, or a model no row speaks for — takes no
 * reasoning control: a tier remembered from another model is not sent. A
 * passthrough provider (custom endpoints, gateways, Copilot) states nothing
 * here, so its tiers stay the user's to pick.
 */
export function providerCuratesThinkingTiers(
  providerId: string | undefined,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): boolean {
  if (!providerId) return false
  return config.providers.find(p => p.providerId === providerId)?.filterMode === 'curated'
}

/**
 * Whether the model accepts inline image blocks: `true` unless its catalog row is verified text-only.
 * Gates composer attachments and the model-call downgrade of image parts.
 */
export function getSupportsImageInputForModel(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): boolean {
  if (!modelId) return true
  const configured = findConfiguredModel(modelId, providerId, config)
  return configured?.supportsImageInput !== false
}

/**
 * Resolves the per-model character-floor that the retired character-count
 * compaction trigger used. **Currently unused** — autocompaction
 * now fires on token pressure (`context/compaction/`),
 * not a char floor. Dead scaffolding from the old trigger, retained with the
 * `compactionTriggerCharCount` field pending removal. Returns `undefined` for
 * uncatalogued models.
 */
export function getCompactionTriggerCharCountForModel(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): number | undefined {
  if (!modelId) return undefined
  const configured = findConfiguredModel(modelId, providerId, config)
  return configured?.compactionTriggerCharCount
}

/** Model tier a sub-session can request (the Agent tool's `model` param). */
export type SubagentModelTier = 'fast' | 'balanced' | 'best'

/**
 * Which child session asks for a tier model; mapped to a tier by {@link getModelForSessionType}.
 * All but `'other'` are user-routable via `sessionModelPolicy` (keep aligned with `SessionModelPolicyType`).
 */
export type TierModelSessionType =
  | 'agent_tool'
  | 'session_title'
  | 'memory_recall'
  | 'web_fetch'
  | 'prompt_hook'
  | 'compact'
  | 'memory_extract'
  | 'memory_consolidate'
  | 'skill_fork'
  | 'hook_agent'
  | 'other'

/**
 * One tier-resolution candidate. `providerId` + `modelId` are always paired —
 * never a bare id string — so a candidate can point at a DIFFERENT provider
 * than the parent session's (a cross-provider user pin does exactly that).
 * `thinkingTier` is set only when a user pin declares one; consumers validate
 * it against the model's `availableThinkingTiers` (silent-drop contract).
 */
export interface TierModelCandidate {
  providerId: string
  modelId: string
  thinkingTier?: string
}

/**
 * Per-provider tier field lookup (`fastModel`/`balancedModel`/`bestModel`),
 * as the concrete model id the tier means now. A field that names a FAMILY
 * row's family (`claude-haiku-*`) follows that family's `latest` — the
 * resolution the catalog recorded (`builtInEntryRow`), else, before any
 * catalog was built, the row's verified version. A field that names an id is
 * that id, as ever.
 */
function getProviderTierField(
  providerId: string | undefined,
  tier: SubagentModelTier,
  config: NexusModelConfig,
): string | undefined {
  if (!providerId) return undefined
  const provider = config.providers.find(p => p.providerId === providerId)
  if (!provider) return undefined
  const field =
    tier === 'fast' ? provider.fastModel : tier === 'balanced' ? provider.balancedModel : provider.bestModel
  if (!field) return undefined
  const row = provider.models.find(r => r.family && r.family.toLowerCase() === field.toLowerCase())
  if (!row) {
    // A family key no row declares names nothing: the tier is unavailable
    // (and `familyRowProblems` fails the catalog test).
    return field.includes('*') ? undefined : field
  }
  const entry = entryId({ family: row.family!, version: LATEST })
  const resolved = resolveModelId(providerId, entry)
  return resolved !== entry ? resolved : deriveCanonicalModelId(row.model)
}

/**
 * The settings seam, now live: the user's GLOBAL cross-provider pin for a
 * tier (Settings → Session models → Model tiers, `modelTiers` in
 * settings.json). A pin defines what the tier MEANS everywhere — any parent
 * provider, any session type — so it deliberately takes no providerId. Reads
 * the realm's snapshot (`models/tierSettingsSnapshot.ts`); every tier
 * consumer picks it up without caller changes.
 */
function getTierSettingsOverride(
  tier: SubagentModelTier,
): TierModelCandidate | undefined {
  const pin = getModelTierPin(tier)
  if (!pin) return undefined
  return {
    providerId: pin.providerId,
    modelId: pin.modelId,
    ...(pin.thinkingTier ? { thinkingTier: pin.thinkingTier } : {}),
  }
}

function sameCandidatePair(
  a: { providerId: string; modelId: string },
  b: { providerId: string; modelId: string },
): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}

/**
 * The effort a tier runs at when Auto has no model to name: the session's own model across its efforts —
 * fast = lowest, best = highest, balanced = `medium` if offered else the middle; never `none`.
 * Undefined when the model states no efforts (the tier inherits the session's).
 */
export function autoTierThinkingTier(
  tier: SubagentModelTier,
  availableThinkingTiers: readonly string[] | undefined,
): string | undefined {
  if (!availableThinkingTiers) return undefined
  // Ranked by the house order, but returned in the MODEL's own spelling: a
  // row may write the wire's `xhigh` for `extra-high` (the OpenAI and
  // ChatGPT Pro rows), and that is the tier id its picker and request use.
  const rank = (t: string): number => {
    const tier = tierFromEffort(t)
    return tier ? THINKING_TIER_ORDER.indexOf(tier as (typeof THINKING_TIER_ORDER)[number]) : -1
  }
  const efforts = availableThinkingTiers
    .filter(t => rank(t) >= 0 && tierFromEffort(t) !== 'none')
    .sort((a, b) => rank(a) - rank(b))
  if (efforts.length === 0) return undefined
  switch (tier) {
    case 'fast':
      return efforts[0]
    case 'best':
      return efforts[efforts.length - 1]
    case 'balanced':
      return efforts.includes('medium')
        ? 'medium'
        : efforts[Math.floor((efforts.length - 1) / 2)]
  }
}

function resolveTierCandidates(
  tier: SubagentModelTier,
  parentProviderId: string,
  parentModelId: string,
  _sessionType: TierModelSessionType,
  config: NexusModelConfig,
): TierModelCandidate[] {
  const parent: TierModelCandidate = {
    providerId: parentProviderId,
    modelId: parentModelId,
  }
  // Head precedence: global user pin (cross-provider) → the parent
  // provider's built-in ladder field → for a provider with no ladder of its
  // own (a gateway, a custom endpoint), the ladder of the vendor whose model
  // the session runs, looked up under the same provider
  // (`borrowTierModel`). None of them → the parent's own model at the tier's
  // effort (`autoTierThinkingTier`), or plain inherit when the model states
  // no efforts.
  const ladderId = getAutoTierModel(parentProviderId, parentModelId, tier, config)
  const head =
    getTierSettingsOverride(tier)
    ?? (ladderId
      ? { providerId: parentProviderId, modelId: ladderId }
      : undefined)
  if (!head) {
    const thinkingTier = autoTierThinkingTier(
      tier,
      getAvailableThinkingTiersForModel(parentModelId, parentProviderId, config),
    )
    return [thinkingTier ? { ...parent, thinkingTier } : parent]
  }
  // The head is a CONCRETE id (a family's resolved latest, a pool id); the
  // parent may be a model ENTRY (`claude-haiku-*@latest`). Compare what each
  // runs, so a session already on the tier's model stays the parent.
  if (
    sameCandidatePair(head, parent)
    || sameCandidatePair(
      { providerId: head.providerId, modelId: resolveModelId(head.providerId, head.modelId) },
      { providerId: parentProviderId, modelId: resolveModelId(parentProviderId, parentModelId) },
    )
  ) {
    return [parent]
  }
  // Ordered first-to-last: the resolved model, then the parent as the
  // runtime failure-fallback tail ("failed override degrades to the model
  // the user is looking at — never a third model").
  return [head, parent]
}

/**
 * Shared tier→model resolvers for child sessions. Priority: settings override → per-provider config →
 * the parent's model. Returns an ORDERED candidate list (currently one entry; callers take `[0]`).
 */
export function getFastModel(
  parentProviderId: string,
  parentModelId: string,
  sessionType: TierModelSessionType,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): TierModelCandidate[] {
  return resolveTierCandidates('fast', parentProviderId, parentModelId, sessionType, config)
}

/** See `getFastModel` — identical contract for the 'balanced' tier. */
export function getBalancedModel(
  parentProviderId: string,
  parentModelId: string,
  sessionType: TierModelSessionType,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): TierModelCandidate[] {
  return resolveTierCandidates('balanced', parentProviderId, parentModelId, sessionType, config)
}

/** See `getFastModel` — identical contract for the 'best' tier. */
export function topTierModel(
  parentProviderId: string,
  parentModelId: string,
  sessionType: TierModelSessionType,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): TierModelCandidate[] {
  return resolveTierCandidates('best', parentProviderId, parentModelId, sessionType, config)
}

/**
 * Per-session-type model policy — which tier each child session runs on.
 * Each row is the product's behaviour for that feature (F-26 behaviour
 * spec); `'inherit'` = the parent's model, untouched.
 */
const SESSION_TYPE_TIER: Record<TierModelSessionType, SubagentModelTier | 'inherit'> = {
  // The Agent tool's tier comes from its explicit `model` param; with no
  // param the child inherits the parent's model.
  agent_tool: 'inherit',
  // Session titles and names are generated on the fast tier.
  session_title: 'fast',
  // Memory-relevance selection is pinned to the balanced rung, not the fast
  // one: the recall pick quality matters more than the pennies.
  memory_recall: 'balanced',
  // WebFetch's secondary pass over the fetched page runs on the fast tier.
  web_fetch: 'fast',
  // A prompt hook runs on its own `model` when it names one — applied by the
  // caller OUTSIDE this policy; the default is the fast tier.
  prompt_hook: 'fast',
  // The compaction summarizer uses the session's main-loop model.
  compact: 'inherit',
  // The end-of-turn memory forks (extract + tidy) and the fork-backed
  // skill/hook runners all inherit (a fork keeps the parent's model so the
  // prompt cache is reused) — the census entries exist so
  // the user ROUTER can re-route them; the default changes nothing.
  memory_extract: 'inherit',
  memory_consolidate: 'inherit',
  skill_fork: 'inherit',
  hook_agent: 'inherit',
  // Unattributed queryFastModel one-shots: fast by construction.
  other: 'fast',
}

/** The tier {@link getModelForSessionType} resolves for a session type —
 *  exported so callers can phrase warn/breadcrumb checks ("is this tier
 *  configured for the provider at all?") against the same policy. */
export function getSessionTypeTier(
  sessionType: TierModelSessionType,
): SubagentModelTier | 'inherit' {
  return SESSION_TYPE_TIER[sessionType]
}

/**
 * The user's routing policy for a session type. A feature's static `model:` is honored only under
 * `default`/absent; the Agent tool's call-time tier loses only to `specific` / `same-as-parent`.
 */
export function getSessionModelPolicyFor(
  sessionType: TierModelSessionType,
): SessionModelPolicy | undefined {
  if (sessionType === 'other') return undefined
  return getSessionModelPolicySetting(sessionType)
}

/**
 * THE common entry for a child session's model: the user ROUTER
 * (`sessionModelPolicy`) first, then the census tier through the tier
 * DICTIONARY (global pin → provider ladder → inherit). Same ordered
 * candidate-list contract as `getFastModel`: `[resolved, parent]` when a
 * non-parent model resolved (callers try first-to-last on failure),
 * `[parent]` for inherit — never a third model.
 */
export function getModelForSessionType(
  sessionType: TierModelSessionType,
  parentProviderId: string,
  parentModelId: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): TierModelCandidate[] {
  const parent: TierModelCandidate = {
    providerId: parentProviderId,
    modelId: parentModelId,
  }
  const policy = getSessionModelPolicyFor(sessionType)
  switch (policy?.mode) {
    case 'same-as-parent':
      return [parent]
    case 'specific': {
      const pin: TierModelCandidate = {
        providerId: policy.providerId,
        modelId: policy.modelId,
        ...(policy.thinkingTier ? { thinkingTier: policy.thinkingTier } : {}),
      }
      if (sameCandidatePair(pin, parent)) return [parent]
      return [pin, parent]
    }
    case 'tier':
      return resolveTierCandidates(
        policy.tier,
        parentProviderId,
        parentModelId,
        sessionType,
        config,
      )
    default: {
      const tier = SESSION_TYPE_TIER[sessionType]
      if (tier === 'inherit') return [parent]
      return resolveTierCandidates(
        tier,
        parentProviderId,
        parentModelId,
        sessionType,
        config,
      )
    }
  }
}

/**
 * The provider's declared fast model (for `queryFastModel`), or `undefined` when none is declared.
 * Raw field accessor, no parent fallback.
 */
export function getFastModelForProvider(
  providerId: string | undefined,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): string | undefined {
  return getProviderTierField(providerId, 'fast', config)
}

/**
 * The model Auto means for `tier` in a session on (`providerId`,
 * `sessionModelId`) — the provider's own ladder field, else a ladder borrowed
 * from the session model's vendor (`models/borrowedTierLadder.ts`) —
 * or undefined when neither names one: the tier then runs on the session's
 * own model. A user pin is not Auto and is not consulted here.
 */
export function getAutoTierModel(
  providerId: string | undefined,
  sessionModelId: string | undefined,
  tier: SubagentModelTier,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): string | undefined {
  if (!providerId) return undefined
  return (
    getProviderTierField(providerId, tier, config)
    ?? (sessionModelId ? borrowTierModel(providerId, sessionModelId, tier, config) : undefined)
  )
}

/** `getFastModelForProvider`'s counterpart for the 'balanced'/'best' tiers. */
export function getTierModelForProvider(
  providerId: string | undefined,
  tier: SubagentModelTier,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): string | undefined {
  return getProviderTierField(providerId, tier, config)
}

/**
 * Whether the model's context window is KNOWN (catalogued, or the `[1m]` id), not the 200K default.
 * Pre-launch window gates check this first; unknown ⇒ skip the gate.
 */
export function isContextWindowKnown(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): boolean {
  if (!modelId) return false
  if (/\[1m\]/i.test(modelId)) return true
  return findConfiguredModel(modelId, providerId, config)?.contextWindow != null
}

/** The manual-compact buffer of the turn loop's blocking check — the safety
 *  margin under the hard window edge. Lives here so the pre-launch fork gate
 *  and the in-loop blocking check share one formula and can never drift. */
export const BLOCKING_LIMIT_BUFFER_TOKENS = 3_000

/**
 * The token count at which a conversation can no longer be sent to `modelId`:
 * context window minus the reserved output budget (capped at 20K, the same
 * reservation the autocompact threshold uses) minus the manual-compact safety
 * buffer. One formula, so the fork window-fit gate compares against EXACTLY
 * the limit the turn loop enforces.
 */
export function getBlockingLimitTokens(
  modelId: string | undefined,
  providerId?: string,
  config: NexusModelConfig = NEXUS_MODEL_CONFIG,
): number {
  const contextWindow = contextWindowOf(modelId, providerId, config)
  const reserved = Math.min(
    outputBudgetOf(modelId, providerId, config) ?? 20_000,
    20_000,
  )
  return contextWindow - reserved - BLOCKING_LIMIT_BUFFER_TOKENS
}

export type ContextPercentages = {
  usedPercentage: number
  remainingPercentage: number
}

export function contextUsageShares(
  usedTokens: number,
  contextWindow: number,
): ContextPercentages {
  if (contextWindow <= 0) {
    return { usedPercentage: 0, remainingPercentage: 100 }
  }
  const raw = (usedTokens / contextWindow) * 100
  const usedPercentage = Math.max(0, Math.min(100, raw))
  return {
    usedPercentage,
    remainingPercentage: Math.max(0, 100 - usedPercentage),
  }
}
