import { z } from 'zod'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { dirnameRuntimePath, isAbsoluteRuntimePath, joinRuntimePath, pathCompareKey } from '../utils/runtimePaths'
import { isFsNotFoundError } from '../utils/fsTransportFailure'
import type { ReviewReportView, ReviewSessionSnapshot } from './review-protocol'
import { REVIEW_STAGES } from './contracts'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,300}$/)
const text = z.string().max(100_000).refine(value => !value.includes('\0'))
const positive = z.number().int().safe().positive()
const count = z.number().int().safe().nonnegative()
const strings = z.array(text).max(10_000)
const path = text.refine(value => !!value && !value.startsWith('/') && !/[\\:]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
const span = z.object({ start: positive, end: positive }).refine(value => value.end >= value.start)
const anchor = z.object({ path, revision: text, side: z.enum(['before', 'after', 'working-copy']), span: span.optional(), contextDigest: text.optional() })
const disposition = z.enum(['proven', 'plausible', 'dismissed', 'unchecked'])
const run = z.object({
  id, conversationKey: id,
  scope: z.object({ kind: z.enum(['workspace', 'branch', 'range', 'paths', 'change-request']), workspaceKey: text,
    repository: z.object({ platform: z.enum(['github', 'gitlab']).optional(), projectKey: text, name: text.optional() }),
    revision: z.object({ base: text, head: text, workingCopyDigest: text.optional() }), pathFilter: z.array(path).max(1000),
    request: z.object({ number: positive, headRevision: text }).optional(),
  }),
  policy: z.object({ level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    recipe: z.enum(['quick-hunks', 'quick-expand', 'local-eight', 'local-ten', 'team-eight-precise', 'team-eight-recall', 'team-ten', 'careful-pass']),
    recipeRevision: positive, execution: z.enum(['isolated', 'inline']), presentation: z.enum(['terminal', 'json', 'panel']), reportLimit: z.union([positive, z.literal('unlimited')]),
  }),
  progress: z.object({ status: z.enum(['queued', 'active', 'finished', 'partial', 'cancelled', 'failed']), stage: z.enum(REVIEW_STAGES),
    coveredAngles: strings, unavailableAngles: strings, spawnedTasks: count, verifiedCandidates: count, omittedByLimit: count }), reportRevision: count,
})
const diagnostic = z.object({ id, runId: id, anchor,
  claim: z.object({ title: text, explanation: text, trigger: text }),
  classification: z.object({ kind: z.enum(['correctness', 'security', 'reuse', 'simplicity', 'efficiency', 'root-cause', 'guidance']), impact: z.enum(['critical', 'major', 'minor']) }),
  evidenceKeys: z.array(id).max(1000), origin: z.object({ angle: text, taskKey: id.optional() }),
})
const evidence = z.object({ id, runId: id, diagnosticId: id, source: z.object({ path: path.optional(), revision: text.optional(), toolCallKey: text.optional() }), excerpt: text, reason: text })
const assessment = z.object({ id, diagnosticId: id, disposition, rationale: text, evidenceKeys: z.array(id).max(1000), sourceTaskKey: id.optional() })
const receiptDetails = { id, diagnosticIds: z.array(id).max(10_000), reason: text.optional(), executionRef: text.optional(), verification: z.enum(['not-run', 'passed', 'failed']).optional(), externalRef: text.optional() }
const action = z.discriminatedUnion('kind', [
  z.object({ ...receiptDetails, kind: z.literal('repair'), state: z.enum(['requested', 'running', 'applied', 'skipped', 'unnecessary', 'failed', 'blocked']) }),
  z.object({ ...receiptDetails, kind: z.literal('publication'), state: z.enum(['requested', 'running', 'succeeded', 'failed', 'blocked', 'uncertain']) }),
])
const stored = z.object({ version: z.literal(1), run,
  diagnostics: z.array(diagnostic).max(10_000), evidence: z.array(evidence).max(50_000), assessments: z.array(assessment).max(50_000), actions: z.array(action).max(10_000),
  retainedIds: z.array(id).max(10_000), coverage: z.object({ angles: strings, limitations: strings, complete: z.boolean() }), structured: z.boolean(),
  events: z.array(z.object({ runId: id, sequence: positive, time: z.number().finite(), type: text })).max(100_000),
  publications: z.array(z.object({ receiptId: id, state: z.enum(['pending', 'succeeded', 'uncertain', 'failed']) })).max(10_000),
  executions: z.array(z.object({ ref: text, kind: z.enum(['edit', 'verification', 'evidence']), diagnosticIds: z.array(id).max(10_000), paths: z.array(path).max(10_000), succeeded: z.boolean(),
    sequence: positive, time: z.number().finite(), checkedThroughSequence: count.optional(), command: text.optional(), codeRevision: text.optional(),
    evidence: z.array(z.object({ path: path.optional(), quote: text, relevance: text })).max(1000).optional(), missingCases: strings.optional(),
  })).max(50_000),
})
const presentation = z.object({ emptyScope: z.boolean().optional(), target: text.optional(),
  notices: z.array(z.object({ code: text, level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(), requested: z.union([text, positive]).optional(), effective: z.union([text, positive]).optional() })).max(1000).optional(),
})

/** Security: recursive allowlist projection, bound to the requested session and filename; internal records never leave storage. */
export function projectStoredReview(serialized: string, sessionId: string, runId: string, display?: string): ReviewReportView {
  const value = stored.parse(JSON.parse(serialized))
  if (value.run.id !== runId || value.run.conversationKey !== sessionId) throw new Error('review-session-mismatch')
  const diagnosticIds = new Set(value.diagnostics.map(item => item.id))
  const evidenceIds = new Set(value.evidence.map(item => item.id))
  if (diagnosticIds.size !== value.diagnostics.length || evidenceIds.size !== value.evidence.length || new Set(value.retainedIds).size !== value.retainedIds.length
    || value.retainedIds.some(key => !diagnosticIds.has(key))
    || value.diagnostics.some(item => item.runId !== runId || item.evidenceKeys.some(key => !evidenceIds.has(key)))
    || value.evidence.some(item => item.runId !== runId || !diagnosticIds.has(item.diagnosticId))
    || value.assessments.some(item => !diagnosticIds.has(item.diagnosticId) || item.evidenceKeys.some(key => !evidenceIds.has(key)))
    || value.actions.some(item => item.diagnosticIds.some(key => !diagnosticIds.has(key)))
    || value.events.some(item => item.runId !== runId)
    || value.executions.some(item => item.diagnosticIds.some(key => !diagnosticIds.has(key)))) throw new Error('invalid-stored-review')
  const interrupted = value.run.progress.status === 'active' || value.run.progress.status === 'queued'
  if (interrupted) {
    value.run.progress.status = 'partial'
    value.coverage.complete = false
    value.coverage.limitations = [...new Set([...value.coverage.limitations, 'interrupted-run'])]
  }
  const pending = new Set(value.publications.filter(item => item.state === 'pending' || item.state === 'uncertain').map(item => item.receiptId))
  for (const receipt of value.actions) {
    if (receipt.kind === 'publication' && (pending.has(receipt.id) || receipt.state === 'running')) receipt.state = 'uncertain'
    if (interrupted && receipt.kind === 'repair' && receipt.state === 'running') { receipt.state = 'blocked'; receipt.reason = 'interrupted-run' }
  }
  const verifications = value.executions.filter(event => event.kind === 'verification').map(event => {
    const checkedThroughSequence = event.checkedThroughSequence ?? event.sequence
    const edits = value.executions.filter(edit => edit.kind === 'edit' && edit.succeeded && (!event.diagnosticIds.length || edit.diagnosticIds.some(key => event.diagnosticIds.includes(key)) || edit.paths.some(path => event.paths.includes(path))))
    return { ref: event.ref, diagnosticIds: event.diagnosticIds, paths: event.paths, succeeded: event.succeeded, sequence: event.sequence, time: event.time,
      checkedThroughSequence, afterLatestEdit: edits.every(edit => edit.sequence <= checkedThroughSequence),
      ...(event.command === undefined ? {} : { command: event.command }), ...(event.codeRevision === undefined ? {} : { codeRevision: event.codeRevision }), evidence: event.evidence ?? [], missingCases: event.missingCases ?? [] }
  })
  const retained = new Set(value.retainedIds)
  const ui = display === undefined ? undefined : presentation.parse(JSON.parse(display))
  return { run: value.run, diagnostics: value.diagnostics.filter(item => retained.has(item.id)),
    evidence: value.evidence.filter(item => retained.has(item.diagnosticId)), assessments: value.assessments.filter(item => retained.has(item.diagnosticId)),
    actions: value.actions, coverage: value.coverage, verifications, finishedTasks: value.events.filter(event => event.type === 'worker-finished').length,
    ...(ui?.emptyScope !== undefined ? { emptyScope: ui.emptyScope } : {}), ...(ui?.target !== undefined ? { targetLabel: ui.target } : {}),
    ...(ui?.notices ? { notices: ui.notices } : {}),
    permissions: { cancel: false, repair: false, publish: false, rerun: false, verify: false, locate: false },
  }
}

type SnapshotFs = Pick<RuntimeFs, 'realpath' | 'stat' | 'readdir' | 'readFileBytes'>
/** Read-only cold view. sessionBase must come from the runtime's persisted session routing, never client input. */
export async function readStoredReviewSnapshot(input: { fs: SnapshotFs; sessionBase: string; sessionId: string }): Promise<ReviewSessionSnapshot> {
  const { fs, sessionBase, sessionId } = input
  id.parse(sessionId)
  if (!isAbsoluteRuntimePath(sessionBase) || !fs.realpath) throw new Error('review-storage-unavailable')
  const base = joinRuntimePath(sessionBase, sessionId, 'code-review')
  const samePath = (left: string, right: string) => pathCompareKey(left) === pathCompareKey(right)
  const guard = async (candidate: string) => {
    let current = candidate
    for (;;) {
      const stat = await fs.stat(current)
      if (stat.isSymbolicLink()) throw new Error('review-storage-not-authorized')
      const actual = await fs.realpath!(current, { resolveLinks: true })
      if (!samePath(actual, current)) throw new Error('review-storage-not-authorized')
      const parent = dirnameRuntimePath(current)
      if (samePath(parent, current) || !parent) break
      current = parent
    }
  }
  let totalBytes = 0
  const read = async (file: string, maxBytes: number) => {
    await guard(file)
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > maxBytes || totalBytes + stat.size > 32 * 1024 * 1024) throw new Error('invalid-stored-review')
    const bytes = await fs.readFileBytes(file, maxBytes)
    totalBytes += bytes.length
    if (bytes.length > maxBytes || totalBytes > 32 * 1024 * 1024) throw new Error('invalid-stored-review')
    await guard(file)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  try { await guard(base) } catch (error) { if (isFsNotFoundError(error)) return { sessionId, sequence: 0, reports: [] }; throw error }
  const entries = await fs.readdir(base)
  const files = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() && /^[A-Za-z0-9_-]{1,300}\.json$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
  if (files.length > 1000) throw new Error('review-storage-limit')
  const reports: ReviewReportView[] = []
  for (const entry of files) {
    const runId = entry.name.slice(0, -5)
    const serialized = await read(joinRuntimePath(base, entry.name), 16 * 1024 * 1024)
    let display: string | undefined
    try { display = await read(joinRuntimePath(base, 'presentation', entry.name), 256 * 1024) }
    catch (error) { if (!isFsNotFoundError(error)) throw error }
    reports.push(projectStoredReview(serialized, sessionId, runId, display))
  }
  return { sessionId, sequence: 0, reports }
}
