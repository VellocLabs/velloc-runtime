import type { ReviewMessageNotice } from './messages'
import type { ReportVerification } from './report-store'
import type { TopicId } from '../browser/runtimeProtocol'
import type { ActionReceipt, Assessment, Diagnostic, OutputMode, ReviewCoverage, ReviewEvidence, ReviewRun, ReviewRunEnd, ReviewTaskView } from './contracts'

export type ReviewReportView = {
  run: ReviewRun
  diagnostics: Diagnostic[]
  evidence: ReviewEvidence[]
  assessments: Assessment[]
  actions: ActionReceipt[]
  coverage: ReviewCoverage
  verifications?: ReportVerification[]
  notices?: ReviewMessageNotice[]
  targetLabel?: string
  emptyScope?: boolean
  finishedTasks?: number
  /** The run's model tasks, coordinator first; absent on a cold projection. */
  tasks?: ReviewTaskView[]
  /** The coordinating task's end when the run did not complete normally. */
  end?: ReviewRunEnd
  permissions?: { cancel?: boolean; repair?: boolean; publish?: boolean; rerun?: boolean; verify?: boolean; locate?: boolean; publishConfirmation?: boolean }
  publicationPreview?: string
  /** Exact runtime presenter output; the client never reconstructs report JSON. */
  exportJson?: string
  /** Only runtime-validated working-copy anchors may open the current file. */
  currentAnchors?: string[]
}
export type ReviewSessionSnapshot = { sessionId: string; sequence: number; reports: ReviewReportView[] }
export const REVIEW_ACTION_SCOPES = { cancel: 'control', repair: 'control', publish: 'control', rerun: 'control', verify: 'control', locate: 'control' } as const
export type ReviewAction = keyof typeof REVIEW_ACTION_SCOPES
export type ReviewActionPayload = { sessionId: string; runId: string; diagnosticIds?: string[]; diagnosticId?: string; preview?: boolean; confirmed?: boolean; discussions?: boolean; presentation?: OutputMode }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isReviewId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,300}$/.test(value)
export const reviewTopic = (sessionId: string): TopicId => {
  if (!isReviewId(sessionId)) throw new RangeError('Invalid review session id')
  return `review/${sessionId}` as TopicId
}
export const sessionOfReviewTopic = (topic: string): string | null => topic.startsWith('review/') && isReviewId(topic.slice(7)) ? topic.slice(7) : null
export const sessionOfReviewPayload = (value: unknown): string | undefined => record(value) && isReviewId(value.sessionId) ? value.sessionId : undefined
export function isReviewActionPayload(action: ReviewAction, value: unknown): value is ReviewActionPayload {
  if (!record(value) || !isReviewId(value.sessionId) || !isReviewId(value.runId)) return false
  const keys = ['sessionId', 'runId', ...(action === 'locate' ? ['diagnosticId'] : action === 'repair' ? ['diagnosticIds'] : action === 'publish' ? ['preview', 'confirmed', 'discussions'] : action === 'rerun' ? ['presentation'] : [])]
  if (Object.keys(value).some(key => !keys.includes(key))) return false
  if (action === 'locate') return isReviewId(value.diagnosticId)
  if (action === 'repair') return Array.isArray(value.diagnosticIds) && value.diagnosticIds.length > 0 && value.diagnosticIds.length <= 32 && value.diagnosticIds.every(isReviewId) && new Set(value.diagnosticIds).size === value.diagnosticIds.length
  if (action === 'rerun') return value.presentation === undefined || value.presentation === 'terminal' || value.presentation === 'json' || value.presentation === 'panel'
  if (action === 'publish') return (value.discussions === undefined || typeof value.discussions === 'boolean') && typeof value.preview === 'boolean' && typeof value.confirmed === 'boolean' && !(value.preview && value.confirmed)
  return true
}

/** The run a Skill tool result anchors its card to; null for any other result. */
export function reviewRunIdOfSkillResult(result: unknown): string | null {
  if (typeof result !== 'string' || !result.startsWith('{"reviewRunId":')) return null
  try {
    const value = JSON.parse(result) as { reviewRunId?: unknown }
    return isReviewId(value.reviewRunId) ? value.reviewRunId : null
  } catch { return null }
}

/** Only a persisted system row's structured metadata can select a report card. */
export function reviewNoticeRunId(message: unknown): string | null {
  if (!record(message) || message.type !== 'system' || message.subtype !== 'code-review' || !record(message.review)) return null
  return isReviewId(message.review.runId) ? message.review.runId : null
}

export type ReviewFileLocation = { path: string; line?: number }
export function isReviewFileLocation(value: unknown): value is ReviewFileLocation {
  if (!record(value) || Object.keys(value).some(key => key !== 'path' && key !== 'line')) return false
  if (typeof value.path !== 'string' || value.path.length > 4096 || !(/^[A-Za-z]:[\\/]/.test(value.path) || /^\/(?!\/)/.test(value.path))) return false
  if (/[\x00-\x1f\x7f]/.test(value.path) || value.path.split(/[\\/]/).some(part => part === '.' || part === '..')) return false
  return value.line === undefined || (Number.isSafeInteger(value.line) && Number(value.line) > 0)
}
