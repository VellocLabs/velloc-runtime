export const REVIEW_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Largest whole-file context read, and so the largest evidence excerpt the store accepts. */
export const CONTEXT_READ_BYTES = 512 * 1024
export const lineFeeds = (value: string) => value.replace(/\r\n?/g, '\n')
/** True when `quote` occurs in host-recorded `text`; line endings do not count, since a read keeps the file's own (F-38). */
export function quotedIn(text: string, quote: string): boolean { return lineFeeds(text).includes(lineFeeds(quote)) }
export type ReviewLevel = typeof REVIEW_LEVELS[number]
export type ExecutionMode = 'isolated' | 'inline'
export type OutputMode = 'terminal' | 'json' | 'panel'
export type FindingLimit = number | 'all' | 'default'
export type ReportLimit = number | 'unlimited'
export type CapabilityProfile = 'fallback' | 'context-specialist' | 'minimal-specialist' | 'delegation-specialist' | 'balanced-review' | 'fast-review'
export type RecipeId = 'quick-hunks' | 'quick-expand' | 'local-eight' | 'local-ten' | 'team-eight-precise' | 'team-eight-recall' | 'team-ten' | 'careful-pass'
export type ReviewAngle = 'lines' | 'removed' | 'calls' | 'reuse' | 'simplification' | 'efficiency' | 'root-cause' | 'guidance' | 'language' | 'wrappers'
export type InvocationSource = 'user' | 'model' | 'preload'

/** Contract: why one model run of a review ended; only `completed` counts as a full answer. */
export type ReviewRunEnd = {
  kind: 'completed' | 'cancelled' | 'step-limit' | 'output-cap' | 'context-overflow' | 'model-error' | 'failure-limit' | 'awaiting-user' | 'time-limit' | 'crash'
  detail?: string
}
export type ReviewTaskRole = 'coordinator' | 'finder' | 'verifier' | 'sweeper' | 'repair' | 'behavior' | 'reassessment' | 'mechanism' | 'publication'
/** One model task of a run as the client sees it; `taskId` is the drawer handle once the fork registered. */
export type ReviewTaskView = {
  key: string
  taskId?: string
  role: ReviewTaskRole
  /** Run content naming the task (a candidate title). */
  label?: string
  angles?: string[]
  status: 'running' | 'finished' | 'failed' | 'stopped'
  startedAt: number
  finishedAt?: number
  lastActivityAt: number
  lastAction?: string
  end?: ReviewRunEnd
}

export interface ReviewArguments {
  level?: ReviewLevel
  target?: string
  targetLiteral?: true
  /** `-C <dir>`: the repository folder to review, relative to the session's root. */
  directory?: string
  fix: boolean
  comment: boolean
  maxFindings?: FindingLimit
}

export interface ReviewPreferences {
  level?: ReviewLevel
  maxFindings?: number | 'all'
}

export interface ReviewCapabilities {
  agentAvailable: boolean
  agentPermitted: boolean
  remainingDepth: number
  outputToolAvailable: boolean
  coordinator?: boolean
  coordinatorCanExecuteSkill?: boolean
  coordinatorWorkerAvailable?: boolean
  workerConcurrency?: number
  supportedReasoningLevels?: readonly ReviewLevel[]
}

export type PolicyNotice =
  | { code: 'level-reused'; level: ReviewLevel }
  | { code: 'max-not-authorized'; level: ReviewLevel }
  | { code: 'panel-limit' | 'careful-pass-limit'; requested: ReportLimit; effective: number }
  | { code: 'quantity-ignored'; requested: FindingLimit }
  | { code: 'agent-unavailable' | 'agent-denied' | 'agent-depth-exhausted' }
  | { code: 'tests-fixtures-skipped' | 'tests-fixtures-reviewed' }
  | { code: 'output-tool-unavailable' }
  | { code: 'coordinator-worker-required' | 'coordinator-worker-unavailable' }
  | { code: 'reasoning-mapped'; requested: ReviewLevel; effective: ReviewLevel }
  | { code: 'committed-lines-only' }

export interface ReviewPolicyInput {
  arguments: ReviewArguments
  source: InvocationSource
  preferences?: ReviewPreferences
  sessionLevel?: ReviewLevel
  guidance?: { level: ReviewLevel; trusted: boolean; appliesToProject: boolean }
  canonicalModelId?: string
  profile?: CapabilityProfile
  capabilities: ReviewCapabilities
  output: OutputMode
  changedLines?: number
  changedLinesCommittedOnly?: boolean
  /** The skipping recipe would leave nothing: every changed file is a test or fixture. */
  testsOnly?: boolean
}

export interface ReviewPlan {
  readonly level: ReviewLevel
  readonly levelSource: 'user' | 'preference' | 'model' | 'guidance' | 'session' | 'default'
  readonly profile: CapabilityProfile
  readonly recipe: RecipeId
  readonly recipeRevision: number
  readonly execution: ExecutionMode
  readonly presentation: OutputMode
  readonly reportLimit: ReportLimit
  readonly reasoningLevel: ReviewLevel
  readonly angles: readonly ReviewAngle[]
  readonly candidatesPerAngle: number
  readonly sweepCandidateLimit: number
  readonly sweep: 'none' | 'same-context' | 'independent'
  readonly independentVerification: boolean
  readonly agentMode: 'none' | 'parallel' | 'sequential-fallback'
  readonly fallbackReason?: 'agent-unavailable' | 'agent-denied' | 'agent-depth-exhausted'
  readonly skipTestsAndFixtures: boolean
  readonly allowWholeFileReads: boolean
  readonly workerConcurrency: number
  readonly suggestedFinderTasks?: number
  readonly coordinatorWorkerRequired: boolean
  readonly blocked: boolean
  readonly automaticVerificationEligible: boolean
  readonly notices: readonly PolicyNotice[]
}

export type ReviewScope = {
  kind: 'workspace' | 'branch' | 'range' | 'paths' | 'change-request'
  workspaceKey: string
  repository: { platform?: 'github' | 'gitlab'; projectKey: string }
  revision: { base: string; head: string; workingCopyDigest?: string }
  pathFilter: string[]
  request?: { number: number; headRevision: string }
}

export type ReviewRun = {
  id: string
  conversationKey: string
  scope: ReviewScope
  policy: Pick<ReviewPlan, 'level' | 'recipe' | 'recipeRevision' | 'execution' | 'presentation' | 'reportLimit'>
  progress: {
    status: 'queued' | 'active' | 'finished' | 'partial' | 'cancelled' | 'failed'
    stage: 'scope' | 'inspect' | 'assess' | 'sweep' | 'report' | 'repair' | 'publish' | 'verify'
    coveredAngles: string[]
    unavailableAngles: string[]
    spawnedTasks: number
    verifiedCandidates: number
    omittedByLimit: number
  }
  reportRevision: number
  /** The model's Skill tool call that started the run, when one did; the conversation anchors its card to it. */
  toolCallId?: string
}

export type Diagnostic = {
  id: string
  runId: string
  anchor: {
    path: string
    revision: string
    side: 'before' | 'after' | 'working-copy'
    span?: { start: number; end: number }
    contextDigest?: string
  }
  claim: { title: string; explanation: string; trigger: string }
  classification: {
    kind: 'correctness' | 'security' | 'reuse' | 'simplicity' | 'efficiency' | 'root-cause' | 'guidance'
    impact: 'critical' | 'major' | 'minor'
  }
  evidenceKeys: string[]
  origin: { angle: string; taskKey?: string }
}

export type ReviewEvidence = {
  id: string
  runId: string
  diagnosticId: string
  source: { path?: string; revision?: string; toolCallKey?: string }
  excerpt: string
  reason: string
}

export type Assessment = {
  id: string
  diagnosticId: string
  disposition: 'proven' | 'plausible' | 'dismissed' | 'unchecked'
  rationale: string
  evidenceKeys: string[]
  sourceTaskKey?: string
}

type ReceiptDetails = {
  id: string
  diagnosticIds: string[]
  reason?: string
  executionRef?: string
  verification?: 'not-run' | 'passed' | 'failed'
  externalRef?: string
}

export type ActionReceipt = ReceiptDetails & (
  | { kind: 'repair'; state: 'requested' | 'running' | 'applied' | 'skipped' | 'unnecessary' | 'failed' | 'blocked' }
  | { kind: 'publication'; state: 'requested' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'uncertain' }
)

export type ReviewCandidate = {
  location: { anchorKey: string; path: string; line?: number; endLine?: number }
  statement: { headline: string; details: string; scenario: string }
  kind: Diagnostic['classification']['kind']
  impact: Diagnostic['classification']['impact']
  /** `source` is the host id of the recorded read or diff side the quote was taken from (F-38). */
  support: Array<{ source?: string; path?: string; quote: string; relevance: string }>
  assessment: { disposition: Assessment['disposition']; reason: string }
  angle: string
}

export type ReviewCoverage = { angles: string[]; limitations: string[]; complete: boolean }
export type ReviewActionObservation = {
  diagnosticId: string
  observation: 'edited' | 'not-needed' | 'left-open'
  explanation: string
  executionRefs: string[]
}

export type ReviewOutputInput =
  | { operation: 'record'; candidates: ReviewCandidate[]; coverage: ReviewCoverage }
  | { operation: 'reconcile'; updates: ReviewActionObservation[] }
