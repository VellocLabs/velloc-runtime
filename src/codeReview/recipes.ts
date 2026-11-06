import { REVIEW_LEVELS, type CapabilityProfile, type InvocationSource, type PolicyNotice, type RecipeId, type ReportLimit, type ReviewAngle, type ReviewArguments, type ReviewLevel, type ReviewPlan, type ReviewPolicyInput, type ReviewPreferences } from './contracts'

import { resolveReviewModelIdentity } from './modelProfiles'
import { isReviewLevel } from './arguments'
import { effortOfTier } from '../config/nexusModelConfig/providers/shared/listing'

export const RECIPE_REVISION = 2
export const EIGHT_ANGLES: readonly ReviewAngle[] = Object.freeze(['lines', 'removed', 'calls', 'reuse', 'simplification', 'efficiency', 'root-cause', 'guidance'])
export const TEN_ANGLES: readonly ReviewAngle[] = Object.freeze([...EIGHT_ANGLES, 'language', 'wrappers'])

export function isTestOrFixturePath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\./i.test(path)
}

export type RecipeRoute = { recipe: RecipeId; defaultLimit: ReportLimit }
const route = (recipe: RecipeId, defaultLimit: ReportLimit): Readonly<RecipeRoute> => Object.freeze({ recipe, defaultLimit })
export const RECIPE_ROUTES: Readonly<Record<CapabilityProfile, Readonly<Record<ReviewLevel, Readonly<RecipeRoute>>>>> = Object.freeze({
  fallback: Object.freeze({ low: route('quick-hunks', 4), medium: route('local-eight', 10), high: route('local-eight', 10), xhigh: route('local-ten', 15), max: route('team-ten', 15) }),
  'fallback-no-team': Object.freeze({ low: route('quick-hunks', 4), medium: route('local-eight', 10), high: route('local-eight', 10), xhigh: route('local-ten', 15), max: route('local-ten', 15) }),
  'context-specialist': Object.freeze({ low: route('quick-expand', 8), medium: route('local-eight', 8), high: route('local-eight', 10), xhigh: route('local-ten', 15), max: route('team-ten', 15) }),
  'minimal-specialist': Object.freeze({ low: route('quick-hunks', 4), medium: route('careful-pass', 15), high: route('careful-pass', 15), xhigh: route('local-ten', 15), max: route('team-ten', 15) }),
  'delegation-specialist': Object.freeze({ low: route('quick-expand', 'unlimited'), medium: route('team-eight-precise', 8), high: route('team-eight-recall', 10), xhigh: route('team-ten', 15), max: route('team-ten', 15) }),
})

export function resolveCapabilityProfile(canonicalModelId?: string, explicitProfile?: CapabilityProfile): CapabilityProfile {
  return explicitProfile ?? resolveReviewModelIdentity(canonicalModelId)?.profile ?? 'fallback-no-team'
}

/** The review levels a model's thinking tiers offer; a tier is read by its wire word (`extra-high` is `xhigh`). */
export function reviewLevelsOfTiers(tiers: readonly string[] | undefined): ReviewLevel[] | undefined {
  return tiers?.map(tier => effortOfTier(tier)!).filter(isReviewLevel)
}

/** The model's own spelling of the thinking tier for a review level; the level itself when the model lists none. */
export function thinkingTierForLevel(level: string | undefined, tiers: readonly string[] | undefined): string | undefined {
  return level && (tiers?.find(tier => effortOfTier(tier) === level) ?? level)
}

export function selectReviewRecipe(profile: CapabilityProfile, level: ReviewLevel): Readonly<RecipeRoute> {
  return RECIPE_ROUTES[profile][level]
}

export function resolveReviewPreferences(input: {
  current: ReviewPreferences
  arguments: ReviewArguments
  source: InvocationSource
  targetAuthorized: boolean
}): ReviewPreferences {
  const next = { ...input.current }
  if (input.source !== 'user' || !input.targetAuthorized) return next
  if (input.arguments.level !== undefined) next.level = input.arguments.level
  if (input.arguments.maxFindings === 'default') delete next.maxFindings
  else if (input.arguments.maxFindings !== undefined) next.maxFindings = input.arguments.maxFindings
  return next
}

export function resolveReviewLevel(input: Pick<ReviewPolicyInput, 'arguments' | 'source' | 'preferences' | 'sessionLevel' | 'guidance'>): {
  level: ReviewLevel
  source: ReviewPlan['levelSource']
  notices: PolicyNotice[]
} {
  const notices: PolicyNotice[] = []
  const userLevel = input.source === 'user' ? input.arguments.level : undefined
  const preference = input.preferences?.level
  const guidance = input.guidance?.trusted && input.guidance.appliesToProject ? input.guidance.level : undefined
  const maxAuthorized = userLevel === 'max' || preference === 'max' || guidance === 'max'
  const modelLevel = input.source === 'model' ? input.arguments.level : undefined
  // An explicit level, typed or model-requested, outranks the saved one (F-38).
  const candidates: Array<{ level: ReviewLevel | undefined; source: ReviewPlan['levelSource'] }> = [
    { level: userLevel, source: 'user' },
    { level: modelLevel, source: 'model' },
    { level: preference, source: 'preference' },
    { level: guidance, source: 'guidance' },
    { level: input.sessionLevel, source: 'session' },
    { level: 'medium', source: 'default' },
  ]
  const selected = candidates.find(candidate => candidate.level !== undefined && (candidate.level !== 'max' || maxAuthorized))!
  const level = selected.level!
  const source = selected.source
  if (!maxAuthorized && (modelLevel === 'max' || candidates.find(candidate => candidate.level !== undefined)?.level === 'max')) {
    notices.push({ code: 'max-not-authorized', level })
  }
  if (userLevel === undefined && source === 'preference') notices.push({ code: 'level-reused', level })
  return { level, source, notices }
}

function finiteLimit(value: ReportLimit, maximum: number): boolean {
  return value === 'unlimited' || value > maximum
}

export function resolveReviewPolicy(input: ReviewPolicyInput): ReviewPlan {
  const resolved = resolveReviewLevel(input)
  const { level } = resolved
  const notices = [...resolved.notices]
  const profile = resolveCapabilityProfile(input.canonicalModelId, input.profile)
  const { recipe, defaultLimit } = selectReviewRecipe(profile, level)
  const requestedQuantity = input.source === 'preload' ? undefined : input.arguments.maxFindings
  const quantity = requestedQuantity === 'default' ? undefined : requestedQuantity ?? input.preferences?.maxFindings
  const delegationLow = profile === 'delegation-specialist' && level === 'low'
  let reportLimit: ReportLimit = quantity === 'all' ? 'unlimited' : quantity ?? defaultLimit
  if (delegationLow) {
    reportLimit = defaultLimit
    if (requestedQuantity !== undefined || quantity !== undefined) notices.push({ code: 'quantity-ignored', requested: requestedQuantity ?? quantity! })
  }
  if (recipe === 'careful-pass' && finiteLimit(reportLimit, 32)) {
    notices.push({ code: 'careful-pass-limit', requested: reportLimit, effective: 32 })
    reportLimit = 32
  }
  const caps = input.capabilities
  let presentation = input.output
  if (presentation === 'panel' && !caps.outputToolAvailable) {
    presentation = 'terminal'
    notices.push({ code: 'output-tool-unavailable' })
  }
  if (presentation === 'panel' && finiteLimit(reportLimit, 32)) {
    notices.push({ code: 'panel-limit', requested: reportLimit, effective: 32 })
    reportLimit = 32
  }
  const team = recipe.startsWith('team-')
  const ten = recipe === 'local-ten' || recipe === 'team-ten'
  const quick = recipe === 'quick-hunks' || recipe === 'quick-expand'
  const fallbackReason = !team ? undefined : !caps.agentAvailable ? 'agent-unavailable' : !caps.agentPermitted ? 'agent-denied' : !(caps.remainingDepth > 0) ? 'agent-depth-exhausted' : undefined
  if (fallbackReason) notices.push({ code: fallbackReason })
  const skipsTests = recipe === 'quick-hunks' || delegationLow
  const skipTestsAndFixtures = skipsTests && !input.testsOnly
  if (skipTestsAndFixtures) notices.push({ code: 'tests-fixtures-skipped' })
  else if (skipsTests) notices.push({ code: 'tests-fixtures-reviewed' })
  let reasoningLevel: ReviewLevel = delegationLow ? 'medium' : level
  const supported = caps.supportedReasoningLevels
  if (supported?.length && !supported.includes(reasoningLevel)) {
    const desired = REVIEW_LEVELS.indexOf(reasoningLevel)
    reasoningLevel = [...REVIEW_LEVELS].reverse().find(candidate => REVIEW_LEVELS.indexOf(candidate) <= desired && supported.includes(candidate)) ?? REVIEW_LEVELS.find(candidate => supported.includes(candidate))!
  }
  if (reasoningLevel !== level) notices.push({ code: 'reasoning-mapped', requested: level, effective: reasoningLevel })
  const workerConcurrency = Number.isSafeInteger(caps.workerConcurrency) && caps.workerConcurrency! > 0 ? caps.workerConcurrency! : 4
  let suggestedFinderTasks: number | undefined
  if (profile === 'delegation-specialist' && (level === 'high' || level === 'xhigh' || level === 'max') && Number.isSafeInteger(input.changedLines) && input.changedLines! >= 0) {
    suggestedFinderTasks = Math.max(2, Math.min(8, Math.ceil(input.changedLines! / 150)))
    if (input.changedLinesCommittedOnly) notices.push({ code: 'committed-lines-only' })
  }
  // Half the smaller of the effective and the recipe's default limit, at least one (F-38).
  const bound = (value: ReportLimit) => value === 'unlimited' ? Infinity : value
  const findingTarget = recipe === 'local-eight' || recipe === 'local-ten' ? Math.max(1, Math.floor(Math.min(bound(reportLimit), bound(defaultLimit)) / 2)) : undefined
  const execution = presentation === 'panel' || caps.coordinator ? 'inline' : 'isolated'
  const coordinatorWorkerRequired = Boolean(caps.coordinator && !caps.coordinatorCanExecuteSkill)
  const blocked = coordinatorWorkerRequired && !caps.coordinatorWorkerAvailable
  if (coordinatorWorkerRequired) notices.push({ code: blocked ? 'coordinator-worker-unavailable' : 'coordinator-worker-required' })
  const verificationRoute = profile === 'delegation-specialist' || (profile === 'context-specialist' ? level === 'max' : level === 'low' || level === 'max')
  return Object.freeze({
    level,
    levelSource: resolved.source,
    profile,
    recipe,
    recipeRevision: RECIPE_REVISION,
    execution,
    presentation,
    reportLimit,
    reasoningLevel,
    angles: ten ? TEN_ANGLES : recipe.includes('eight') ? EIGHT_ANGLES : Object.freeze([]),
    candidatesPerAngle: ten ? 8 : recipe.includes('eight') ? 6 : 0,
    sweepCandidateLimit: ten ? 8 : 0,
    sweep: ten ? team && !fallbackReason ? 'independent' : 'same-context' : 'none',
    independentVerification: team && !fallbackReason,
    agentMode: team ? fallbackReason ? 'sequential-fallback' : 'parallel' : 'none',
    fallbackReason,
    skipTestsAndFixtures,
    allowWholeFileReads: !quick,
    workerConcurrency,
    suggestedFinderTasks,
    ...(findingTarget ? { findingTarget } : {}),
    coordinatorWorkerRequired,
    blocked,
    automaticVerificationEligible: presentation === 'panel' && execution === 'inline' && !blocked && verificationRoute,
    notices: Object.freeze(notices.map(notice => Object.freeze(notice))),
  })
}

export function shouldRunAutomaticVerification(plan: ReviewPlan, context: {
  permitted: boolean
  adapterAvailable: boolean
  runtimeBehaviorChanged: boolean
  alreadyVerified: boolean
}): boolean {
  return plan.automaticVerificationEligible && context.permitted && context.adapterAvailable && context.runtimeBehaviorChanged && !context.alreadyVerified
}
