import { declareTool, type ToolContract } from '../toolkit/toolContract'
import type { Message } from '../runtime/RuntimeTypes'
import type { ReviewReportStore } from './report-store'

export interface ReviewToolBindings {
  runId: string
  store: ReviewReportStore
  signal: AbortSignal
  read(input: Record<string, unknown>): Promise<unknown>
  launch?(input: Record<string, unknown>): Promise<unknown>
  changed(): void
  allowOutput: boolean
  actions?: boolean
  actionEpoch?: string
  independentAssessments?: boolean
}
function callId(row: Message, name: string, input: unknown): string {
  const content = (row as Message & { message?: { content?: unknown } }).message?.content
  if (Array.isArray(content)) {
    const match = content.find(part => part?.type === 'tool_use' && part.name === name && JSON.stringify(part.input) === JSON.stringify(input))
    if (match?.id) return match.id
  }
  return crypto.randomUUID()
}
const text = { type: 'string' }
const stringList = { type: 'array', items: text }
const shape = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
export const REVIEW_SUPPORT_SCHEMA = { type: 'array', items: shape({ path: text, quote: text, relevance: text }, ['quote', 'relevance']) }
export const REVIEW_ASSESSMENT_SCHEMA = shape({ disposition: { type: 'string', enum: ['proven', 'plausible', 'dismissed', 'unchecked'] }, reason: text })
export const REVIEW_COVERAGE_SCHEMA = shape({ angles: stringList, limitations: stringList, complete: { type: 'boolean' } })
export const REVIEW_CANDIDATE_SCHEMA = shape({
  location: shape({ anchorKey: text, path: text, line: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, ['anchorKey', 'path']),
  statement: shape({ headline: text, details: text, scenario: text }),
  kind: { type: 'string', enum: ['correctness', 'security', 'reuse', 'simplicity', 'efficiency', 'root-cause', 'guidance'] },
  impact: { type: 'string', enum: ['critical', 'major', 'minor'] }, support: REVIEW_SUPPORT_SCHEMA, assessment: REVIEW_ASSESSMENT_SCHEMA, angle: text,
})
export const REVIEW_RESULT_SCHEMA = shape({ candidates: { type: 'array', items: REVIEW_CANDIDATE_SCHEMA }, coverage: REVIEW_COVERAGE_SCHEMA })
const updatesSchema = { type: 'array', maxItems: 32, items: shape({ diagnosticId: text, observation: { type: 'string', enum: ['edited', 'not-needed', 'left-open'] }, explanation: text, executionRefs: stringList }) }
export function createReviewTools(bindings: ReviewToolBindings): ToolContract[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], invoke: (input: Record<string, unknown>, id: string) => Promise<unknown>) => declareTool({
    name, description: async () => description,
    argsSchema: { type: 'object' as const, properties, required, additionalProperties: false },
    readsOnly: () => true, parallelSafe: () => name === 'Agent',
    call: async (input: Record<string, unknown>, _context: unknown, _permission: unknown, row: Message) => {
      if (bindings.signal.aborted) throw new Error('review-cancelled')
      const data = await invoke(input, callId(row, name, input))
      bindings.changed()
      return { data }
    },
  })
  const candidates = { type: 'array', maxItems: 32, items: REVIEW_CANDIDATE_SCHEMA }
  const tools: ToolContract[] = [
    tool('ReviewRead', 'Read authorized review material. Use diff to inspect selected hunks; context reads require a permitted path. No shell or scripts.', {
      operation: { type: 'string', enum: ['diff', 'context', 'search'] }, path: { type: 'string' }, query: { type: 'string' },
    }, ['operation'], input => bindings.read(input)),
    tool('ReviewLedger', 'Record review candidates, assessments, coverage, or explicit semantic duplicate merges in this run. Candidate IDs are host generated. assess uses assessments=[{candidateId,disposition,reason,support}]. To merge differently worded findings of the same root mechanism, use operation="merge-duplicates" with groups=[{keepId,duplicateIds,reason,support}]. Explain the shared trigger and mechanism with nonempty evidence; overlapping locations alone are not duplicates. Host requires the same revision, path, side, classification kind, and overlapping line spans. Preserve distinct mechanisms. Merging preserves all diagnostic IDs and independent assessments, but only keepId counts toward the retained report cap. Existing representatives cannot be merged into another group. Final output must include the combined support from the retained ledger.', {
      operation: { type: 'string', enum: ['append-candidates', 'assess', 'coverage', 'merge-duplicates'] }, candidates,
      groups: { type: 'array', minItems: 1, maxItems: 32, items: shape({ keepId: text, duplicateIds: { ...stringList, minItems: 1, maxItems: 32, uniqueItems: true }, reason: text, support: { ...REVIEW_SUPPORT_SCHEMA, minItems: 1, maxItems: 128 } }) },
      assessments: { type: 'array', maxItems: 32, items: shape({ candidateId: text, ...REVIEW_ASSESSMENT_SCHEMA.properties, support: REVIEW_SUPPORT_SCHEMA }) }, coverage: REVIEW_COVERAGE_SCHEMA,
    }, ['operation'], (input, id) => {
      if (bindings.independentAssessments && input.operation === 'assess') throw new Error('independent-verifier-required')
      if (bindings.independentAssessments && input.operation === 'append-candidates' && Array.isArray(input.candidates) && input.candidates.some(candidate => candidate?.assessment?.disposition === 'dismissed' || candidate?.assessment?.disposition === 'proven')) throw new Error('independent-verifier-required')
      return bindings.store.submitLedger(bindings.runId, id, input)
    }),
  ]
  if (bindings.allowOutput) tools.push(tool('ReviewOutput', 'Commit a final report from the ledger. Candidates and coverage must exactly match the retained ledger. reconcile requires real edit execution references.', {
    operation: { type: 'string', enum: ['record', 'reconcile'] }, candidates, coverage: REVIEW_COVERAGE_SCHEMA, updates: updatesSchema,
  }, ['operation'], (input, id) => input.operation === 'reconcile' && bindings.actions
    ? bindings.store.reconcile(bindings.runId, id, input, bindings.actionEpoch)
    : bindings.store.submitRecord(bindings.runId, id, input)))
  if (bindings.actions) tools.push(tool('ReviewActionLog', 'Propose repair reconciliation using actual execution references. No model assertion can mark an unobserved edit applied.', {
    updates: updatesSchema,
  }, ['updates'], (input, id) => bindings.store.reconcile(bindings.runId, id, { operation: 'reconcile', updates: input.updates }, bindings.actionEpoch)))
  if (bindings.launch) tools.push(tool('Agent', 'Launch a bounded read-only review worker. Only finder, verifier and sweeper roles are allowed. No parent conversation or further delegation is inherited.', {
    role: { type: 'string', enum: ['finder', 'verifier', 'sweeper'] }, angles: { type: 'array', items: { type: 'string' } }, candidateId: { type: 'string' },
  }, ['role'], input => bindings.launch!(input)))
  return tools
}
