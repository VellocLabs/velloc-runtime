import type { TranslateFn } from '../browser/webview/i18n/translate'

export type ReviewMessageNotice = { code: string; params?: Record<string, unknown>; level?: unknown; requested?: unknown; effective?: unknown; path?: unknown }
const groups = {
  removed: ['removed-option'],
  unknownOption: ['unknown-option', 'unknown-command'],
  missingValue: ['missing-value'],
  invalidLimit: ['invalid-limit'],
  invalidArguments: ['multiple-targets', 'multiple-directories', 'empty-target', 'unclosed-quote'],
  ambiguous: ['ambiguous-target', 'ambiguous-review-target', 'ambiguous-base', 'review-target-needs-selection'],
  invalidTarget: ['invalid-target', 'target-mismatch', 'invalid-range', 'missing-ref', 'missing-path', 'invalid-ref', 'invalid-oid', 'invalid-path', 'invalid-root', 'invalid-git-directory'],
  denied: ['action-not-authorized', 'review-read-not-authorized', 'read-denied', 'read-outside-review-scope', 'whole-file-read-not-authorized', 'edit-outside-review-grant', 'review-mutation-not-authorized', 'review-fs-operation-not-authorized', 'publication-not-authorized', 'publication-denied', 'forbidden_scope', 'repair-grant-expired'],
  unavailable: ['review-runtime-unavailable', 'review-context-unavailable', 'remote-context-unavailable', 'review-platform-adapter-required', 'repair-unavailable', 'publication-unavailable', 'review-plan-blocked', 'host_unavailable'],
  incomplete: ['scope-incomplete', 'independent-worker-coverage-incomplete', 'remote-diff-incomplete', 'report-candidates-rejected'],
  candidatesRefused: ['worker-candidates-rejected'],
  outputLimit: ['diff-output-limit', 'output-limit', 'response-limit'],
  interrupted: ['review-budget-or-model-interrupted', 'review-budget-exhausted', 'review-time-limit', 'review-task-budget', 'worker-interrupted', 'repair-interrupted'],
  gitTimeout: ['timeout'],
  stepLimit: ['review-step-limit'],
  verifiedAfterSummary: ['verified-after-summary'],
  outputCap: ['review-output-cap'],
  contextOverflow: ['review-context-overflow'],
  modelError: ['review-model-error'],
  failureLimit: ['review-failure-limit'],
  awaitingUser: ['review-awaiting-user'],
  crash: ['review-crash'],
  changed: ['snapshot-changed', 'head-changed', 'head-check-failed'],
  cancelled: ['review-cancelled', 'cancelled', 'repair-no-longer-active'],
  invalidReport: ['invalid-diff', 'invalid-anchor', 'invalid-response', 'invalid-publication', 'invalid-run-id', 'invalid-review-search', 'invalid-review-read', 'invalid-worker-role', 'invalid-worker-angles', 'worker-role-not-authorized', 'unknown-candidate', 'verifier-assignment-not-authorized', 'worker-candidate-limit', 'worker-angle-not-assigned', 'worker-angle-candidate-limit', 'unstructured-worker-answer'],
  failed: ['review-failed', 'query-failed', 'spawn-failed', 'http-failed', 'redirect-refused', 'secret-origin'],
  noTarget: ['publication-target-required', 'publication-target-unavailable', 'no-publish-target'],
  publicationFailed: ['publication-failed'],
  uncertain: ['write-outcome-unknown'],
  repairMismatch: ['repair-workspace-mismatch'],
  untracked: ['other-untracked-files-excluded'],
  initial: ['initial-commit-all-tracked-files'],
  patchUnavailable: ['remote-patch-unavailable'],
  fallback: ['agent-unavailable', 'agent-denied', 'agent-depth-exhausted'],
  testsSkipped: ['tests-fixtures-skipped'],
  testsReviewed: ['tests-fixtures-reviewed'],
  outputUnavailable: ['output-tool-unavailable'],
  coordinator: ['coordinator-worker-required', 'coordinator-worker-unavailable'],
  committedOnly: ['committed-lines-only'],
  binary: ['binary'], large: ['large'], skipped: ['skipped'], unreadable: ['unreadable'],
} as const
const parserCodes = new Set(['removed-option', 'unknown-command', 'unknown-option', 'missing-value', 'invalid-limit', 'multiple-targets', 'multiple-directories', 'empty-target', 'unclosed-quote'])
const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const level = (t: TranslateFn, value: unknown): string => typeof value === 'string' && levels.includes(value as typeof levels[number]) ? t(`reviewCard.value.${value}` as Parameters<TranslateFn>[0]) : t('reviewCard.notice.unspecified')
const count = (t: TranslateFn, value: unknown): string | number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : value === 'all' || value === 'unlimited' ? t('reviewCard.value.unlimited') : t('reviewCard.notice.unspecified')

/** Structured codes never become display text; only known scalar parameters are interpolated. */
export function reviewMessage(t: TranslateFn, notice: string | ReviewMessageNotice): string {
  const code = typeof notice === 'string' ? notice : notice.code
  const data: Record<string, unknown> = typeof notice === 'string' ? {} : { ...notice, ...notice.params }
  let message: string
  switch (code) {
    case 'level-reused': message = t('reviewCard.notice.levelReused', { level: level(t, data.level) }); break
    case 'max-not-authorized': message = t('reviewCard.notice.maxNotAuthorized', { level: level(t, data.level) }); break
    case 'panel-limit': case 'careful-pass-limit': message = t('reviewCard.notice.cap', { requested: count(t, data.requested), effective: count(t, data.effective) }); break
    case 'quantity-ignored': message = t('reviewCard.notice.quantityIgnored', { requested: count(t, data.requested) }); break
    case 'reasoning-mapped': message = t('reviewCard.notice.reasoningMapped', { requested: level(t, data.requested), effective: level(t, data.effective) }); break
    default: {
      const entry = Object.entries(groups).find(([, codes]) => (codes as readonly string[]).includes(code))
      message = t(entry ? `reviewCard.notice.${entry[0]}` as Parameters<TranslateFn>[0] : 'reviewCard.notice.unknown')
    }
  }
  return parserCodes.has(code) ? t('reviewCard.notice.arguments', { reason: message }) : message
}

/** Coverage may contain authored prose or a legacy reason code; prose remains report content. */
export function reviewDetailMessage(t: TranslateFn, text: string): string {
  return /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(text) || Object.values(groups).some(codes => (codes as readonly string[]).includes(text)) ? reviewMessage(t, text) : text
}

/** A review task's drawer summary: a known reason code reads as its catalogued message; other text is the task's own. */
export function reviewTaskSummaryMessage(t: TranslateFn, summary: string): string {
  return Object.values(groups).some(codes => (codes as readonly string[]).includes(summary)) ? reviewMessage(t, summary) : summary
}

const roles = ['coordinator', 'finder', 'verifier', 'sweeper', 'repair', 'behavior', 'reassessment', 'mechanism', 'publication'] as const
export function reviewTaskRoleMessage(t: TranslateFn, role: string): string {
  return roles.includes(role as typeof roles[number]) ? t(`reviewCard.task.role.${role}` as Parameters<TranslateFn>[0]) : t('reviewCard.notice.unspecified')
}
const taskStatuses = ['running', 'finished', 'failed', 'stopped'] as const
export function reviewTaskStatusMessage(t: TranslateFn, status: string): string {
  return taskStatuses.includes(status as typeof taskStatuses[number]) ? t(`reviewCard.task.status.${status}` as Parameters<TranslateFn>[0]) : t('reviewCard.notice.unspecified')
}
/** The end reason for people, with the run's own detail (a provider error, a crash message) when it carries one. */
export function reviewEndMessage(t: TranslateFn, end: { kind: string; detail?: string }): string | undefined {
  if (end.kind === 'completed') return undefined
  const message = reviewMessage(t, end.kind === 'cancelled' ? 'review-cancelled' : `review-${end.kind}`)
  return end.detail ? `${message} — ${end.detail.slice(0, 300)}` : message
}

const angles = ['lines', 'removed', 'calls', 'reuse', 'simplification', 'efficiency', 'root-cause', 'guidance', 'language', 'wrappers'] as const
export function reviewAngleMessage(t: TranslateFn, angle: string): string {
  return angles.includes(angle as typeof angles[number]) ? t(`reviewCard.angle.${angle}` as Parameters<TranslateFn>[0]) : t('reviewCard.notice.unspecified')
}

const values = new Set(['active', 'all', 'applied', 'assess', 'blocked', 'cancelled', 'careful-pass', 'cleanup', 'correctness', 'critical', 'dismissed', 'efficiency', 'failed', 'finished', 'guidance', 'high', 'inline', 'inspect', 'isolated', 'local-eight', 'local-ten', 'low', 'major', 'max', 'medium', 'merge', 'minor', 'not-run', 'open', 'partial', 'passed', 'plausible', 'proven', 'publication', 'publish', 'queued', 'quick-expand', 'quick-hunks', 'repair', 'report', 'requested', 'reuse', 'root-cause', 'running', 'scope', 'security', 'simplicity', 'skipped', 'succeeded', 'sweep', 'team-eight-precise', 'team-eight-recall', 'team-ten', 'uncertain', 'unchecked', 'unlimited', 'unnecessary', 'verified', 'verify', 'xhigh'])
export function reviewValueMessage(t: TranslateFn, value: string): string {
  return values.has(value) ? t(`reviewCard.value.${value}` as Parameters<TranslateFn>[0]) : t('reviewCard.notice.unspecified')
}
