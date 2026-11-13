import { declareTool, type ToolContract } from '../toolkit/toolContract'
import type { Message } from '../runtime/RuntimeTypes'
import { ReportStoreError, type ReviewReportStore } from './report-store'

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
  /** A read budget in model steps: at most `readSteps` distinct steps may call ReviewRead, a further step fails with `review-step-budget`, and each object a read returns carries `readStepsLeft`. A read that fails still spends its step. */
  readSteps?: number
  /** The run reads patches only: ReviewRead offers neither context nor search. */
  diffOnly?: boolean
  /** A worker's hand-in: `hand` records the answer and returns what the host refused. */
  submit?: { role: 'finder' | 'verifier' | 'sweeper'; hand(input: Record<string, unknown>): Promise<unknown> }
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
export const REVIEW_SUPPORT_SCHEMA = { type: 'array', items: shape({ source: text, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, path: text, quote: text, relevance: text }, ['relevance']) }
export const REVIEW_ASSESSMENT_SCHEMA = shape({ disposition: { type: 'string', enum: ['proven', 'plausible', 'dismissed', 'unchecked'] }, reason: text })
export const REVIEW_COVERAGE_SCHEMA = shape({ angles: stringList, limitations: stringList, complete: { type: 'boolean' } })
export const REVIEW_CANDIDATE_SCHEMA = shape({
  location: shape({ anchorKey: text, path: text, line: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, ['anchorKey', 'path', 'line']),
  statement: shape({ headline: text, details: text, scenario: text }),
  kind: { type: 'string', enum: ['correctness', 'security', 'reuse', 'simplicity', 'efficiency', 'root-cause', 'guidance'] },
  impact: { type: 'string', enum: ['critical', 'major', 'minor'] }, support: REVIEW_SUPPORT_SCHEMA, assessment: REVIEW_ASSESSMENT_SCHEMA, angle: text,
})
export const REVIEW_RESULT_SCHEMA = shape({ candidates: { type: 'array', items: REVIEW_CANDIDATE_SCHEMA }, coverage: REVIEW_COVERAGE_SCHEMA })
const updatesSchema = { type: 'array', maxItems: 32, items: shape({ diagnosticId: text, observation: { type: 'string', enum: ['edited', 'not-needed', 'left-open'] }, explanation: text, executionRefs: stringList }) }
/** The field each ReviewLedger operation reads its items from. */
const LEDGER_FIELDS: Record<string, string> = { 'append-candidates': 'candidates', assess: 'assessments', coverage: 'coverage', 'merge-duplicates': 'groups' }

/** How to correct an item the host refused, by reason code. */
const REFUSAL_HINTS: Record<string, string> = {
  'quote-not-in-source': 'quote must be copied character for character from the cited source; or drop quote and cite startLine and endLine',
  'unknown-evidence-source': 'source must be a source id carried by a patch or a ReviewRead result of this run',
  'evidence-source-path-mismatch': 'path differs from the path of the cited source; drop path or cite the right source',
  'evidence-lines-required': 'the source is longer than 40 lines; add a quote or startLine and endLine',
  'unsupported-evidence-path': 'path is not a file of this review; cite a source id instead',
  'missing-evidence': 'support needs at least one item with a quote or lines from a source',
  'invalid-anchor': 'location.anchorKey and location.path must both come from one anchor of the patch of that file',
  'missing-line': 'location.line is required: the line the defect is on, inside the span of its anchor',
  'invalid-span': 'line..endLine must lie inside the span of the anchor; support startLine..endLine must lie inside the source, at most 40 lines',
  'invalid-enum': 'kind, impact and disposition take only their listed values',
  'invalid-text': 'every text field must be a nonempty string',
  'invalid-integer': 'line numbers are integers from 1',
  'invalid-array': 'candidates, support, angles and limitations are arrays',
  'invalid-completeness': 'coverage.complete is the JSON boolean true or false, inside the coverage object beside angles and limitations',
  'invalid-object': 'location, statement, assessment and every support item are objects',
  'unknown-field': 'remove fields the schema does not list',
  'worker-candidate-limit': 'more candidates than this task allows; keep the strongest',
  'unstructured-worker-answer': 'candidates and support must each be a JSON array and coverage a JSON object; do not send them as text',
  'worker-angle-candidate-limit': 'too many candidates for one angle; keep the strongest of that angle',
  'worker-angle-not-assigned': 'every candidate angle and every coverage angle must be one of your assigned angles',
}
/** How to correct a refused coverage statement, where it differs from the hint for a refused item. */
const COVERAGE_REFUSAL_HINTS: Record<string, string> = {
  'invalid-object': 'coverage is an object with angles, limitations and complete',
  'invalid-array': 'coverage.angles and coverage.limitations are arrays of strings',
  'unknown-field': 'coverage takes only angles, limitations and complete',
  'unknown-angle': 'every coverage angle must be one of the angles of this review',
}
/** A refused item as a worker reads it: its code and how to correct it. */
export const withRefusalHint = <T extends { code: string }>(item: T): T & { hint?: string } => ({ ...item, ...(REFUSAL_HINTS[item.code] ? { hint: REFUSAL_HINTS[item.code] } : {}) })

/** The value a field spells when it arrived as JSON text of the wanted kind; any other value is returned unchanged. */
function spelled(value: unknown, kind: 'object' | 'array' | 'boolean'): unknown {
  if (typeof value !== 'string') return value
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return value }
  const found = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
  return found === kind ? parsed : value
}
/** A coverage statement with each field that arrived as JSON text read as the value it spells. */
function coverageStatement(fields: Record<string, unknown>): Record<string, unknown> {
  const statement = { ...fields }
  if ('angles' in statement) statement.angles = spelled(statement.angles, 'array')
  if ('limitations' in statement) statement.limitations = spelled(statement.limitations, 'array')
  if ('complete' in statement) statement.complete = spelled(statement.complete, 'boolean')
  return statement
}
/** A coverage call as the ledger takes it: the statement under `coverage`, also when its fields came beside `operation`, `operation` was repeated inside it, or the statement or its fields came as JSON text. */
function coverageCall(input: Record<string, unknown>): Record<string, unknown> {
  const { coverage: sent, angles, limitations, complete, ...rest } = input
  const coverage = spelled(sent, 'object')
  if (coverage && typeof coverage === 'object' && !Array.isArray(coverage)) {
    const { operation: _operation, ...statement } = coverage as Record<string, unknown>
    return { ...rest, coverage: coverageStatement(statement) }
  }
  if (coverage !== undefined || (angles === undefined && limitations === undefined && complete === undefined)) return input
  return { ...rest, coverage: coverageStatement({ ...(angles !== undefined ? { angles } : {}), ...(limitations !== undefined ? { limitations } : {}), ...(complete !== undefined ? { complete } : {}) }) }
}
export function createReviewTools(bindings: ReviewToolBindings): ToolContract[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], invoke: (input: Record<string, unknown>, id: string, row: Message) => Promise<unknown>) => declareTool({
    name, description: async () => description,
    argsSchema: { type: 'object' as const, properties, required, additionalProperties: false },
    readsOnly: () => true, parallelSafe: () => name === 'Agent',
    call: async (input: Record<string, unknown>, _context: unknown, _permission: unknown, row: Message) => {
      if (bindings.signal.aborted) throw new Error('review-cancelled')
      const data = await invoke(input, callId(row, name, input), row)
      bindings.changed()
      return { data }
    },
  })
  // One model step is one assistant row: its uuid, or the row itself when it has none.
  const readRows = new Set<string | Message>()
  const read = async (input: Record<string, unknown>, row: Message) => {
    if (bindings.readSteps === undefined) return bindings.read(input)
    readRows.add(row.uuid ?? row)
    if (readRows.size > bindings.readSteps) throw new Error('review-step-budget')
    const readStepsLeft = bindings.readSteps - readRows.size
    const result = await bindings.read(input)
    return result && typeof result === 'object' && !Array.isArray(result) ? { ...result, readStepsLeft } : result
  }
  const candidates = { type: 'array', maxItems: 32, items: REVIEW_CANDIDATE_SCHEMA }
  const tools: ToolContract[] = [
    tool('ReviewRead', bindings.diffOnly
      ? 'Read the patches under review; this run reads nothing else. diff without a path returns the scope index; diff with a path returns the patch of that file and its anchors; diff with paths (up to 50) returns several patches in one call. Every patch carries a source id that support items may cite. No context reads, no search, no shell or scripts.'
      : 'Read authorized review material. diff without a path returns the scope index; diff with a path returns that file\'s patch and anchors; diff with paths (up to 50) returns several patches in one call. context reads a permitted path, optionally only startLine..endLine. search finds a literal query across in-scope files. Patches, context results and search matches carry a source id that support items may cite. No shell or scripts.', bindings.diffOnly ? { operation: { type: 'string', enum: ['diff'] }, path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } } : {
      operation: { type: 'string', enum: ['diff', 'context', 'search'] }, path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }, query: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
    }, ['operation'], (input, _id, row) => read(input, row)),
    tool('ReviewLedger', 'Record review candidates, assessments, coverage, or explicit semantic duplicate merges in this run. Candidate IDs are host generated. assess uses assessments=[{candidateId,disposition,reason,support}]. To merge differently worded findings of the same root mechanism, use operation="merge-duplicates" with groups=[{keepId,duplicateIds,reason,support}]. Explain the shared trigger and mechanism with nonempty evidence; overlapping locations alone are not duplicates. keepId and duplicateIds are host candidate IDs, the candidateId of each finder candidate and verdict. Host requires the same revision, path and side, and line spans that overlap or lie within 10 lines of each other; kinds may differ, and the kind of keepId stands, so keepId must be a correctness or security candidate when any duplicate is one. Preserve distinct mechanisms. Merging preserves all diagnostic IDs and independent assessments, but only keepId counts toward the retained report cap. Existing representatives cannot be merged into another group. Each candidate or assessment is accepted or refused on its own; refused items are listed in rejected with their reason code, and the call fails only when every item is refused.', {
      operation: { type: 'string', enum: ['append-candidates', 'assess', 'coverage', 'merge-duplicates'] }, candidates,
      groups: { type: 'array', minItems: 1, maxItems: 32, items: shape({ keepId: text, duplicateIds: { ...stringList, minItems: 1, maxItems: 32, uniqueItems: true }, reason: text, support: { ...REVIEW_SUPPORT_SCHEMA, minItems: 1, maxItems: 128 } }) },
      assessments: { type: 'array', maxItems: 32, items: shape({ candidateId: text, ...REVIEW_ASSESSMENT_SCHEMA.properties, support: REVIEW_SUPPORT_SCHEMA }) }, coverage: REVIEW_COVERAGE_SCHEMA,
    }, ['operation'], (called, id) => {
      const input = called.operation === 'coverage' ? coverageCall(called) : called
      const field = LEDGER_FIELDS[String(input.operation)]
      if (field && input[field] === undefined) throw new Error(`missing-${field}: operation "${String(input.operation)}" takes "${field}" in the same call`)
      if (bindings.independentAssessments && input.operation === 'assess') throw new Error('independent-verifier-required')
      if (bindings.independentAssessments && input.operation === 'append-candidates' && Array.isArray(input.candidates) && input.candidates.some(candidate => candidate?.assessment?.disposition === 'dismissed' || candidate?.assessment?.disposition === 'proven')) throw new Error('independent-verifier-required')
      const written = bindings.store.submitLedger(bindings.runId, id, input)
      // A refused coverage statement names how to correct it, as a refused item does.
      return input.operation !== 'coverage' ? written : written.catch((error: unknown) => {
        const hint = error instanceof ReportStoreError ? COVERAGE_REFUSAL_HINTS[error.code] ?? REFUSAL_HINTS[error.code] : undefined
        if (hint) (error as ReportStoreError).message = `${(error as ReportStoreError).code}: ${hint}`
        throw error
      })
    }),
  ]
  if (bindings.submit) tools.push(bindings.submit.role === 'verifier'
    ? tool('ReviewSubmit', 'Hand in your verdict for the candidate. The host checks it at once: when the result lists `rejected`, correct what each hint names and call once more; the second call is final.', {
      ...REVIEW_ASSESSMENT_SCHEMA.properties, support: REVIEW_SUPPORT_SCHEMA, missingEvidence: stringList,
    }, ['disposition', 'reason', 'support'], input => bindings.submit!.hand(input))
    : tool('ReviewSubmit', 'Hand in your candidates and coverage. The host checks each candidate at once and keeps the valid ones: when the result lists `rejected`, call once more with only those candidates, corrected as each hint names; the second call is final.', {
      candidates, coverage: shape({ angles: stringList, limitations: stringList }),
    }, ['candidates', 'coverage'], input => bindings.submit!.hand(input)))
  if (bindings.allowOutput) tools.push(tool('ReviewOutput', 'Commit a final report from the ledger. Candidates and coverage must exactly match the retained ledger. reconcile requires real edit execution references.', {
    operation: { type: 'string', enum: ['record', 'reconcile'] }, candidates, coverage: REVIEW_COVERAGE_SCHEMA, updates: updatesSchema,
  }, ['operation'], (input, id) => input.operation === 'reconcile' && bindings.actions
    ? bindings.store.reconcile(bindings.runId, id, input, bindings.actionEpoch)
    : bindings.store.submitRecord(bindings.runId, id, input)))
  if (bindings.actions) tools.push(tool('ReviewActionLog', 'Propose repair reconciliation using actual execution references. No model assertion can mark an unobserved edit applied.', {
    updates: updatesSchema,
  }, ['updates'], (input, id) => bindings.store.reconcile(bindings.runId, id, { operation: 'reconcile', updates: input.updates }, bindings.actionEpoch)))
  if (bindings.launch) tools.push(tool('Agent', 'Launch a bounded read-only review worker. Only finder, verifier and sweeper roles are allowed. No parent conversation or further delegation is inherited. When the run verifies independently, launch every finder first, all in one turn. A verifier call without candidateId starts the run\'s verification: the host waits for running finders, gives each finder candidate that is not a merged duplicate one independent verifier, then runs the gap sweep with the verdicts when the recipe has one; the result carries `verification` and `sweep`, a repeated call retries only verifiers that failed or came back unchecked and a sweep that failed, and finders are refused from then on. A sweeper call starts the same step. A verifier call with candidateId verifies or retries that one candidate.', {
    role: { type: 'string', enum: ['finder', 'verifier', 'sweeper'] }, angles: { type: 'array', items: { type: 'string' } }, candidateId: { type: 'string' },
  }, ['role'], input => {
    if (input.role === 'finder' && (!Array.isArray(input.angles) || input.angles.length === 0)) throw new Error('missing-angles: a finder takes "angles", one or more of the angles this run assigns')
    return bindings.launch!(input)
  }))
  return tools
}
