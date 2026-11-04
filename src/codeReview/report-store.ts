import {
  CONTEXT_READ_BYTES, lineFeeds, quotedIn, type ActionReceipt, type Assessment, type Diagnostic, type ReviewCandidate, type ReviewCoverage,
  type ReviewEvidence, type ReviewRun, type ReviewScope,
} from './contracts'

import { reassessmentTouches, validateReassessmentUpdates, type ReassessmentEvidence, type ReassessmentUpdate } from './reassessment'

export interface ExternalEditReceipt {
  ref: string
  runId: string
  workspaceKey: string
  headRevision: string
  paths: string[]
  beforeDigest: string
  afterDigest: string
  expectedSequence: number
  evidence: ReassessmentEvidence[]
  /** Security: host closure re-reads the authorized code and checks afterDigest immediately before saving. */
  verifyCurrent: () => Promise<boolean>
}

export type ReportDisposition = Assessment['disposition']
export type ReportKind = Diagnostic['classification']['kind']
export type ReportImpact = Diagnostic['classification']['impact']
export type ReportStatus = ReviewRun['progress']['status']
export type ReportStage = ReviewRun['progress']['stage']
export type ReportScope = ReviewScope
export type ReportPolicy = ReviewRun['policy']
export type ReportRun = ReviewRun
export type ReportAnchor = Diagnostic['anchor']
export type ReportSupport = ReviewCandidate['support'][number]
export type ReportCandidateInput = ReviewCandidate
export type ReportCoverage = ReviewCoverage
export type ReportDiagnostic = Diagnostic
export type ReportEvidence = ReviewEvidence
export type ReportAssessment = Assessment
export type ReportActionState = ActionReceipt['state']
export type ReportActionReceipt = ActionReceipt
export interface ReportEvent { runId: string; sequence: number; time: number; type: string }
export interface ReportVerification {
  ref: string; diagnosticIds: string[]; paths: string[]; succeeded: boolean
  sequence: number; time: number; checkedThroughSequence: number; afterLatestEdit: boolean
  command?: string; codeRevision?: string; evidence: ReportSupport[]; missingCases: string[]
}
export interface ReportDuplicateMerge {
  keepId: string
  duplicateIds: string[]
  reason: string
  support: ReportSupport[]
}
export interface ReportSnapshot {
  run: ReportRun
  diagnostics: ReportDiagnostic[]
  evidence: ReportEvidence[]
  assessments: ReportAssessment[]
  actions: ReportActionReceipt[]
  retainedIds: string[]
  /** Duplicate diagnostic ID to its explicitly selected representative; original ledger facts remain intact. */
  duplicateIds?: Record<string, string>
  coverage: ReportCoverage
  events: ReportEvent[]
  structured: boolean
  verifications: ReportVerification[]
}
export interface ReportWriteResult {
  reportRevision: number
  accepted: Array<{ index: number; diagnosticId: string }>
  notices: string[]
}
// Contract: save atomically replaces one run. One store owns each adapter namespace.
export interface ReportStorageAdapter {
  listRunIds(): Promise<string[]>
  load(runId: string): Promise<string | null>
  save(runId: string, serialized: string): Promise<void>
}
export interface ReportStoreOptions {
  // Security: use the host's secret scrubber before any excerpt is persisted.
  sanitizeExcerpt: (text: string) => string
  id?: () => string
  now?: () => number
  onChange?: (snapshot: ReportSnapshot) => void
}
export interface ReportGrant {
  id: string; kind: 'repair' | 'publication' | 'verification'
  workspaceKey: string; headRevision: string; diagnosticIds: string[]
  expiresAt: number; paths?: string[]
}
export interface ReportExecution {
  ref: string; kind: 'edit' | 'verification' | 'evidence'
  diagnosticIds: string[]; paths: string[]; succeeded: boolean
  grantId?: string; evidence?: ReportSupport[]; actionEpoch?: string
  command?: string; codeRevision?: string; missingCases?: string[]; checkedThroughSequence?: number
}
export interface ReportActionPhase {
  epoch: string
  kind: 'repair' | 'verification' | 'publication'
  grantId: string
  previousStatus: Exclude<ReportStatus, 'queued' | 'active'>
  previousStage: ReportStage
}
export interface IndependentVerificationReceipt {
  ref: string; diagnosticId: string; assessmentId: string
  finderTaskKey: string; verifierTaskKey: string
}
interface StoredExecution extends ReportExecution { sequence: number; time: number }
export interface PublicationRequest {
  grantId: string
  diagnosticIds: string[]
  remoteHead: string
  kind: 'inline' | 'note' | 'summary' | 'discussion'
  normalizedContent: string
}
export interface PublicationOperation {
  id: string; key: string; rootKeys: string[]; receiptId: string
  state: 'pending' | 'succeeded' | 'uncertain' | 'failed'
  externalRef?: string
}
export interface ReportEvidenceSource {
  path: string; revision: string; toolCallKey?: string; excerpt?: string
}
interface StoredCandidate { diagnosticId: string; input: ReportCandidateInput; mechanism: string }
interface StoredCall { id: string; input: string; result?: ReportWriteResult; error?: string }
interface RawResult { toolCallId: string; raw: string; code: string }
interface RunState extends Omit<ReportSnapshot, 'verifications'> {
  version: 1
  expectedAngles: string[]
  anchors: Array<{ key: string; anchor: ReportAnchor }>
  candidates: StoredCandidate[]
  calls: StoredCall[]
  grants: ReportGrant[]
  executions: StoredExecution[]
  publications: PublicationOperation[]
  rawResults: RawResult[]
  actionPhase?: ReportActionPhase
  usedActionGrants?: string[]
  independentVerifications?: IndependentVerificationReceipt[]
  evidenceSources?: ReportEvidenceSource[]
  externalEdits?: Array<{ ref: string; fingerprint: string; actionIds: string[] }>
  duplicateMerges?: ReportDuplicateMerge[]
}
export class ReportStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ReportStoreError' }
}
const fail = (code: string): never => { throw new ReportStoreError(code) }
const clone = <T>(value: T): T => structuredClone(value)
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-object')
  if (Object.keys(value).some(key => !keys.includes(key))) return fail('unknown-field')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000 || value.includes('\0')) return fail('invalid-text')
  return value
}
// Contract: a host read excerpt may be as long as the context-read cap.
function excerptText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > CONTEXT_READ_BYTES || value.includes('\0')) return fail('invalid-text')
  return value
}
/** End index of the balanced object opening at `start`, or -1 when it never closes. */
function objectEnd(raw: string, start: number): number {
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < raw.length; index++) {
    const character = raw[index]
    if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue }
    if (character === '"') quoted = true
    else if (character === '{') depth++
    else if (character === '}' && --depth === 0) return index
  }
  return -1
}
/** Report-shaped objects in the model's final text, last first: the whole text, fenced blocks, then balanced top-level spans. */
function finalJsonObjects(raw: string): Record<string, unknown>[] {
  const texts = [{ at: -1, text: raw }, ...[...raw.matchAll(/```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi)].map(match => ({ at: match.index!, text: match[1] }))]
  for (let index = raw.indexOf('{'); index >= 0;) {
    const end = objectEnd(raw, index)
    if (end >= 0) texts.push({ at: index, text: raw.slice(index, end + 1) })
    index = raw.indexOf('{', end >= 0 ? end + 1 : index + 1)
  }
  const found: Array<{ at: number; value: Record<string, unknown> }> = []
  for (const { at, text } of texts) {
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value) && 'candidates' in value && 'coverage' in value) found.push({ at, value })
    } catch { /* not JSON; try the next candidate */ }
  }
  return found.sort((a, b) => (a.at < 0 ? 1 : b.at < 0 ? -1 : b.at - a.at)).map(item => item.value)
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return fail('invalid-integer')
  return value
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail('invalid-enum')
  return value as T
}
function array(value: unknown, max = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail('invalid-array')
  return value
}
function strings(value: unknown): string[] { return array(value).map(text) }
function relativePath(value: unknown): string {
  const path = text(value)
  if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..')) return fail('invalid-path')
  return path
}
const dispositions = ['proven', 'plausible', 'dismissed', 'unchecked'] as const
const kinds = ['correctness', 'security', 'reuse', 'simplicity', 'efficiency', 'root-cause', 'guidance'] as const
const impacts = ['critical', 'major', 'minor'] as const
const terminal = (status: ReportStatus) => !['queued', 'active'].includes(status)
const unique = <T>(items: T[]): T[] => [...new Set(items)]
const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
function overlap(a: ReportAnchor, b: ReportAnchor): boolean {
  if (!a.span || !b.span) return !a.span && !b.span && a.contextDigest === b.contextDigest
  return a.span.start <= b.span.end && b.span.start <= a.span.end
}
function lastAssessment(state: RunState, id: string): ReportAssessment {
  return state.assessments.filter(item => item.diagnosticId === id).at(-1)!
}
function rank(state: RunState): string[] {
  const impact = { critical: 0, major: 1, minor: 2 }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return state.diagnostics.filter(d => !Object.hasOwn(state.duplicateIds ?? {}, d.id) && lastAssessment(state, d.id).disposition !== 'dismissed').sort((a, b) => {
    const category = (d: ReportDiagnostic) => ['correctness', 'security'].includes(d.classification.kind) ? 0 : 1
    return category(a) - category(b) || impact[a.classification.impact] - impact[b.classification.impact]
      || compare(a.anchor.path, b.anchor.path) || (a.anchor.span?.start ?? 0) - (b.anchor.span?.start ?? 0)
      || compare(a.id, b.id)
  }).map(d => d.id)
}
function select(state: RunState): void {
  const ranked = rank(state)
  const policy = state.run.policy
  const cap = Math.min(policy.reportLimit === 'unlimited' ? Infinity : policy.reportLimit,
    policy.presentation === 'panel' || policy.recipe === 'careful-pass' ? 32 : Infinity)
  state.retainedIds = ranked.slice(0, cap)
  state.run.progress.omittedByLimit = ranked.length - state.retainedIds.length
}
/** The revision a quote found in several recorded sources is attributed to: the only one, else the one under review (F-38). */
function quoteRevision(state: RunState, revisions: string[]): string | undefined {
  const candidates = unique(revisions)
  if (candidates.length === 1) return candidates[0]
  const { workingCopyDigest, head } = state.run.scope.revision
  return [workingCopyDigest, head].find(revision => revision !== undefined && candidates.includes(revision))
}
function effectiveCoverage(state: RunState): ReportCoverage {
  return { ...state.coverage, complete: state.coverage.complete
    && state.expectedAngles.every(angle => state.coverage.angles.includes(angle))
    && state.run.progress.unavailableAngles.length === 0 }
}

export class ReviewReportStore {
  private readonly states = new Map<string, RunState>()
  /** Per-run hunk sources: derived from the manifest, held only while the run is live and never persisted. */
  private readonly diffSources = new Map<string, ReportEvidenceSource[]>()
  private readonly listeners = new Set<(snapshot: ReportSnapshot) => void>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private publicationTail: Promise<unknown> = Promise.resolve()
  private readonly id: () => string
  private readonly now: () => number
  constructor(private readonly adapter: ReportStorageAdapter, private readonly options: ReportStoreOptions) {
    this.id = options.id ?? (() => crypto.randomUUID())
    this.now = options.now ?? Date.now
    if (options.onChange) this.listeners.add(options.onChange)
  }
  // Contract: synchronous notification after durable save; observers cannot roll it back.
  subscribe(listener: (snapshot: ReportSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private snapshot(state: RunState): ReportSnapshot {
    const { run, diagnostics, evidence, assessments, actions, retainedIds, events, structured } = state
    return immutable(clone({ run, diagnostics, evidence, assessments, actions, retainedIds, events, structured, ...(state.duplicateIds ? { duplicateIds: state.duplicateIds } : {}), verifications: this.verifications(state), coverage: effectiveCoverage(state) }))
  }
  private verifications(state: RunState): ReportVerification[] {
    return state.executions.filter(event => event.kind === 'verification').map(event => {
      const edits = state.executions.filter(edit => edit.kind === 'edit' && edit.succeeded
        && (!event.diagnosticIds.length || edit.diagnosticIds.some(id => event.diagnosticIds.includes(id)) || edit.paths.some(path => event.paths.includes(path))))
      const checkedThroughSequence = event.checkedThroughSequence ?? event.sequence
      return {
        ref: event.ref, diagnosticIds: event.diagnosticIds, paths: event.paths, succeeded: event.succeeded,
        sequence: event.sequence, time: event.time, checkedThroughSequence,
        afterLatestEdit: edits.every(edit => edit.sequence <= checkedThroughSequence),
        ...(event.command === undefined ? {} : { command: event.command }),
        ...(event.codeRevision === undefined ? {} : { codeRevision: event.codeRevision }),
        evidence: event.evidence ?? [], missingCases: event.missingCases ?? [],
      }
    })
  }
  private refreshRepairVerification(state: RunState): void {
    const verifications = this.verifications(state)
    for (const id of state.retainedIds) {
      const receipt = state.actions.filter(action => action.kind === 'repair' && action.diagnosticIds.includes(id)).at(-1)
      if (!receipt || receipt.state !== 'applied') continue
      const verification = verifications.filter(event => event.diagnosticIds.includes(id) && event.afterLatestEdit).at(-1)
      receipt.verification = verification ? verification.succeeded ? 'passed' : 'failed' : 'not-run'
    }
  }
  private serial<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const promise = (this.tails.get(runId) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.tails.set(runId, promise)
    void promise.finally(() => { if (this.tails.get(runId) === promise) this.tails.delete(runId) }).catch(() => undefined)
    return promise
  }
  private event(state: RunState, type: string): void {
    const previous = state.events.at(-1)
    state.events.push({ runId: state.run.id, sequence: (previous?.sequence ?? 0) + 1,
      time: Math.max(this.now(), previous?.time ?? 0), type })
  }
  private async save(state: RunState): Promise<void> {
    const serialized = JSON.stringify(state)
    if (this.states.has(state.run.id) && serialized === JSON.stringify(this.states.get(state.run.id))) return
    await this.adapter.save(state.run.id, serialized)
    this.states.set(state.run.id, state)
    if (this.listeners.size) {
      const snapshot = this.snapshot(state)
      for (const listener of this.listeners) {
        try { listener(snapshot) } catch { /* Observers do not control durable writes. */ }
      }
    }
  }
  private async load(runId: string): Promise<RunState> {
    const cached = this.states.get(runId)
    if (cached) return cached
    const serialized = await this.adapter.load(runId)
    if (!serialized) return fail('run-not-found')
    let state: RunState
    try { state = JSON.parse(serialized) as RunState } catch { return fail('invalid-storage') }
    if (state.version !== 1 || state.run?.id !== runId || !Array.isArray(state.calls) || !Array.isArray(state.publications)) return fail('invalid-storage')
    if (!terminal(state.run.progress.status)) {
      state.run.progress.status = 'partial'
      state.coverage.complete = false
      state.coverage.limitations = unique([...state.coverage.limitations, 'interrupted-run'])
      this.event(state, 'run-ended')
    }
    for (const operation of state.publications) {
      if (operation.state === 'pending') {
        operation.state = 'uncertain'
        const receipt = state.actions.find(action => action.id === operation.receiptId)!
        receipt.state = 'uncertain'
        this.event(state, 'publication-updated')
      }
    }
    // Security: restored grants never authorize new side effects.
    state.grants = []
    state.actionPhase = undefined
    await this.save(state)
    return state
  }
  private async mutate<T>(runId: string, work: (state: RunState) => T): Promise<T> {
    return this.serial(runId, async () => {
      const draft = clone(await this.load(runId))
      const result = work(draft)
      await this.save(draft)
      return immutable(clone(result))
    })
  }
  async createRun(input: { conversationKey: string; scope: ReportScope; policy: ReportPolicy; expectedAngles?: string[]; toolCallId?: string }): Promise<string> {
    const runId = text(this.id())
    text(input.conversationKey)
    if (input.toolCallId !== undefined && !/^[A-Za-z0-9_.:-]{1,300}$/.test(input.toolCallId)) return fail('invalid-text')
    text(input.scope.workspaceKey); text(input.scope.repository.projectKey)
    text(input.scope.revision.base); text(input.scope.revision.head)
    if (input.policy.reportLimit !== 'unlimited') integer(input.policy.reportLimit)
    return this.serial(runId, async () => {
      if (this.states.has(runId) || await this.adapter.load(runId)) return fail('duplicate-host-id')
      const state: RunState = {
        version: 1,
        run: { id: runId, conversationKey: input.conversationKey, scope: clone(input.scope), policy: clone(input.policy),
          progress: { status: 'queued', stage: 'scope', coveredAngles: [], unavailableAngles: [], spawnedTasks: 0, verifiedCandidates: 0, omittedByLimit: 0 }, reportRevision: 0,
          ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}) },
        expectedAngles: unique(input.expectedAngles ?? []), anchors: [], candidates: [], calls: [], grants: [], executions: [], publications: [], rawResults: [],
        diagnostics: [], evidence: [], assessments: [], actions: [], retainedIds: [], events: [],
        coverage: { angles: [], limitations: [], complete: false }, structured: false,
      }
      await this.save(state)
      return runId
    })
  }
  async registerAnchor(runId: string, anchor: ReportAnchor): Promise<string> {
    const value: ReportAnchor = {
      path: relativePath(anchor.path), revision: text(anchor.revision),
      side: enumeration(anchor.side, ['before', 'after', 'working-copy']),
      ...(anchor.span ? { span: { start: integer(anchor.span.start), end: integer(anchor.span.end) } } : {}),
      ...(anchor.contextDigest === undefined ? {} : { contextDigest: text(anchor.contextDigest) }),
    }
    if (value.span && integer(value.span.end) < integer(value.span.start)) fail('invalid-span')
    return this.mutate(runId, state => {
      if (terminal(state.run.progress.status)) return fail('run-terminated')
      const revision = state.run.scope.revision
      const expected = value.side === 'before' ? revision.base : value.side === 'after' ? revision.head : revision.workingCopyDigest
      if (!expected || value.revision !== expected) return fail('anchor-revision-mismatch')
      const key = text(this.id())
      if (state.anchors.some(item => item.key === key)) return fail('duplicate-host-id')
      state.anchors.push({ key, anchor: value })
      return key
    })
  }
  async start(runId: string): Promise<void> {
    return this.mutate(runId, state => {
      if (state.run.progress.status !== 'queued') return fail('invalid-lifecycle')
      state.run.progress.status = 'active'
      state.run.progress.stage = 'inspect'
      this.event(state, 'run-started')
    })
  }
  async setStage(runId: string, stage: ReportStage): Promise<void> {
    enumeration(stage, ['scope', 'inspect', 'assess', 'sweep', 'report', 'repair', 'publish', 'verify'])
    return this.mutate(runId, state => {
      if (state.run.progress.status !== 'active') return fail('run-not-active')
      if (state.actionPhase) {
        const allowed = state.actionPhase.kind === 'publication' ? ['publish'] : state.actionPhase.kind === 'verification' ? ['verify'] : ['repair', 'verify']
        if (!allowed.includes(stage)) return fail('action-phase-only')
      }
      state.run.progress.stage = stage
      this.event(state, 'stage-changed')
    })
  }
  async finish(runId: string, status: Exclude<ReportStatus, 'queued' | 'active'>): Promise<void> {
    enumeration(status, ['finished', 'partial', 'cancelled', 'failed'])
    return this.mutate(runId, state => {
      if (terminal(state.run.progress.status)) {
        if (state.run.progress.status === status) return
        return fail('run-terminated')
      }
      state.run.progress.status = status === 'finished' && (!state.structured || !effectiveCoverage(state).complete) ? 'partial' : status
      if (state.run.progress.status !== 'finished') state.coverage.complete = false
      if (!state.structured) select(state)
      state.actionPhase = undefined
      this.event(state, 'run-ended')
      this.diffSources.delete(runId)
    })
  }
  // Contract: bind the returned repair/verification epoch in host closures and call endActionPhase in finally.
  async beginActionPhase(runId: string, grantId: string): Promise<string> {
    return this.mutate(runId, state => {
      if (!terminal(state.run.progress.status) || state.actionPhase) return fail('action-phase-already-active')
      if (!state.structured) return fail('report-required')
      const kind = state.grants.find(grant => grant.id === grantId)?.kind
      if (kind !== 'repair' && kind !== 'verification' && kind !== 'publication') return fail('action-not-authorized')
      const grant = this.grant(state, grantId, kind, [])
      if ((state.usedActionGrants ?? []).includes(grantId)) return fail('action-grant-consumed')
      this.diagnosticIds(state, grant.diagnosticIds)
      const epoch = text(this.id())
      state.actionPhase = { epoch, grantId, kind, previousStatus: state.run.progress.status as ReportActionPhase['previousStatus'], previousStage: state.run.progress.stage }
      state.usedActionGrants = [...state.usedActionGrants ?? [], grantId]
      state.run.progress.status = 'active'
      state.run.progress.stage = kind === 'publication' ? 'publish' : kind === 'verification' ? 'verify' : 'repair'
      this.event(state, 'action-phase-started')
      return epoch
    })
  }
  async endActionPhase(runId: string, epoch: string): Promise<void> {
    return this.mutate(runId, state => {
      const phase = state.actionPhase
      if (!phase || phase.epoch !== epoch) return fail('invalid-action-epoch')
      state.run.progress.status = phase.previousStatus
      state.run.progress.stage = phase.previousStage
      state.grants = state.grants.filter(grant => grant.id !== phase.grantId)
      state.actionPhase = undefined
      this.event(state, 'action-phase-ended')
    })
  }
  // Security: call only for a completed independent verifier task observed by the host.
  // ref is the host completion receipt; both task keys must be actual distinct task IDs.
  // Runtime tests/verification commands and model-written assessments never increment this count.
  async noteIndependentVerification(runId: string, receipt: IndependentVerificationReceipt): Promise<void> {
    const input = clone(receipt)
    return this.mutate(runId, state => {
      if (state.run.progress.status !== 'active' || state.actionPhase) return fail('run-not-active')
      text(input.ref); text(input.finderTaskKey); text(input.verifierTaskKey)
      if (input.finderTaskKey === input.verifierTaskKey) return fail('verifier-not-independent')
      const assessment = state.assessments.find(item => item.id === input.assessmentId && item.diagnosticId === input.diagnosticId)
      if (!assessment || assessment.disposition === 'unchecked') return fail('assessment-required')
      const receipts = state.independentVerifications ?? []
      const existing = receipts.find(item => item.ref === input.ref)
      if (existing) {
        if (canonical(existing) !== canonical(input)) return fail('verification-receipt-conflict')
        return
      }
      state.independentVerifications = [...receipts, input]
      assessment.sourceTaskKey = input.verifierTaskKey
      state.run.progress.verifiedCandidates = unique(state.independentVerifications.map(item => item.diagnosticId)).length
      this.event(state, 'candidate-verified')
    })
  }
  async noteWorker(runId: string, event: 'started' | 'finished', unavailableAngles: string[] = []): Promise<void> {
    return this.mutate(runId, state => {
      if (state.run.progress.status !== 'active') return fail('run-not-active')
      if (event === 'started') state.run.progress.spawnedTasks++
      state.run.progress.unavailableAngles = unique([...state.run.progress.unavailableAngles, ...unavailableAngles])
      this.event(state, `worker-${event}`)
    })
  }
  // Security: register only host-authorized reads; context sources never authorize diagnostic anchors.
  async registerEvidenceSource(runId: string, source: ReportEvidenceSource): Promise<void> {
    return this.registerEvidenceSources(runId, [source])
  }
  /** Registers several host-authorized sources in one write; any invalid source rejects them all. */
  async registerEvidenceSources(runId: string, input: readonly ReportEvidenceSource[]): Promise<void> {
    const values = input.map(source => this.evidenceSourceValue(source))
    if (!values.length) return
    return this.mutate(runId, state => {
      if (terminal(state.run.progress.status)) return fail('run-terminated')
      const sources = [...(state.evidenceSources ?? [])]
      const keys = new Set(sources.map(canonical))
      for (const value of values) {
        const key = canonical(value)
        if (!keys.has(key)) { keys.add(key); sources.push(value) }
      }
      state.evidenceSources = sources
    })
  }
  // Security: only the host's own diff for this run; the sources live in memory until the run finishes (F-38).
  async attachDiffSources(runId: string, input: readonly ReportEvidenceSource[]): Promise<void> {
    const values = input.map(source => this.evidenceSourceValue(source))
    return this.serial(runId, async () => {
      if (terminal((await this.load(runId)).run.progress.status)) return fail('run-terminated')
      this.diffSources.set(runId, values)
    })
  }
  private evidenceSourceValue(source: ReportEvidenceSource): ReportEvidenceSource {
    return {
      path: relativePath(source.path), revision: text(source.revision),
      ...(source.toolCallKey === undefined ? {} : { toolCallKey: text(source.toolCallKey) }),
      ...(source.excerpt === undefined ? {} : { excerpt: lineFeeds(this.options.sanitizeExcerpt(excerptText(source.excerpt))) }),
    }
  }
  private evidenceSource(state: RunState, diagnostic: ReportDiagnostic, support: ReportSupport, callKey: string): ReportEvidence['source'] {
    if (!support.path) return { toolCallKey: callKey }
    const sources = [...state.evidenceSources ?? [], ...this.diffSources.get(state.run.id) ?? []].filter(source => source.path === support.path)
    const quote = lineFeeds(support.quote)
    const quoted = sources.filter(source => source.excerpt?.includes(quote))
    const matching = quoted.length ? quoted : sources.filter(source => source.excerpt === undefined)
    if (matching.length) {
      const revision = quoted.length ? quoteRevision(state, matching.map(source => source.revision)) : unique(matching.map(source => source.revision)).length === 1 ? matching[0].revision : undefined
      if (revision === undefined) return fail('ambiguous-evidence-source')
      const source = matching.find(item => item.revision === revision)!
      return { path: source.path, revision: source.revision, toolCallKey: source.toolCallKey ?? callKey }
    }
    const anchors = state.anchors.filter(item => item.anchor.path === support.path)
    if (support.path === diagnostic.anchor.path) return { path: support.path, revision: diagnostic.anchor.revision, toolCallKey: callKey }
    const revisions = unique(anchors.map(item => item.anchor.revision))
    if (revisions.length !== 1) return fail(revisions.length ? 'ambiguous-evidence-source' : 'unsupported-evidence-source')
    return { path: support.path, revision: revisions[0], toolCallKey: callKey }
  }
  private support(state: RunState, value: unknown): ReportSupport[] {
    return array(value, 128).map(item => {
      const support = object(item, ['path', 'quote', 'relevance'])
      const path = support.path === undefined ? undefined : relativePath(support.path)
      if (path && !state.anchors.some(item => item.anchor.path === path) && !(state.evidenceSources ?? []).some(item => item.path === path)) return fail('unsupported-evidence-path')
      return { ...(path ? { path } : {}), quote: this.options.sanitizeExcerpt(text(support.quote)), relevance: text(support.relevance) }
    })
  }
  private candidate(state: RunState, value: unknown): ReportCandidateInput {
    const item = object(value, ['location', 'statement', 'kind', 'impact', 'support', 'assessment', 'angle'])
    const location = object(item.location, ['anchorKey', 'path', 'line', 'endLine'])
    const key = text(location.anchorKey)
    const anchor = state.anchors.find(item => item.key === key)?.anchor
    if (!anchor || relativePath(location.path) !== anchor.path) return fail('invalid-anchor')
    if (location.line === undefined && location.endLine !== undefined) return fail('invalid-span')
    const line = location.line === undefined ? undefined : integer(location.line)
    const end = location.endLine === undefined ? line : integer(location.endLine)
    if (line !== undefined && (!anchor.span || line < anchor.span.start || end! > anchor.span.end || end! < line)) return fail('invalid-span')
    const statement = object(item.statement, ['headline', 'details', 'scenario'])
    const assessment = object(item.assessment, ['disposition', 'reason'])
    const support = this.support(state, item.support)
    if (!support.length) return fail('missing-evidence')
    return {
      location: { anchorKey: key, path: anchor.path, ...(line === undefined ? {} : { line, endLine: end! }) },
      statement: { headline: text(statement.headline), details: text(statement.details), scenario: text(statement.scenario) },
      kind: enumeration(item.kind, kinds), impact: enumeration(item.impact, impacts), support,
      assessment: { disposition: enumeration(assessment.disposition, dispositions), reason: text(assessment.reason) }, angle: text(item.angle),
    }
  }
  private coverage(value: unknown): ReportCoverage {
    const coverage = object(value, ['angles', 'limitations', 'complete'])
    if (typeof coverage.complete !== 'boolean') return fail('invalid-completeness')
    return { angles: unique(strings(coverage.angles)), limitations: unique(strings(coverage.limitations)), complete: coverage.complete }
  }
  private addEvidence(state: RunState, id: string, support: ReportSupport[], toolCallKey: string): string[] {
    const diagnostic = state.diagnostics.find(item => item.id === id)!
    return support.map(item => {
      const excerpt = this.options.sanitizeExcerpt(item.quote)
      const source = this.evidenceSource(state, diagnostic, { ...item, quote: excerpt }, toolCallKey)
      const existing = state.evidence.find(e => e.diagnosticId === id && e.source.path === source.path && e.source.revision === source.revision && e.excerpt === excerpt && e.reason === item.relevance)
      if (existing) return existing.id
      const evidence: ReportEvidence = { id: this.id(), runId: state.run.id, diagnosticId: id,
        source, excerpt, reason: item.relevance }
      state.evidence.push(evidence)
      diagnostic.evidenceKeys.push(evidence.id)
      return evidence.id
    })
  }
  private mergeSupport(state: RunState, id: string, support: ReportSupport[], callId: string): string[] {
    const candidate = state.candidates.find(item => item.diagnosticId === id)
    if (!candidate) return fail('unknown-diagnostic')
    const evidenceKeys = this.addEvidence(state, id, support, callId)
    const combined = [...candidate.input.support, ...support]
    const merged = combined.filter((item, index) => combined.findIndex(other => canonical(item) === canonical(other)) === index)
    if (merged.length > 128) return fail('evidence-limit')
    candidate.input.support = merged
    const keepId = Object.hasOwn(state.duplicateIds ?? {}, id) ? state.duplicateIds![id] : undefined
    if (keepId) this.mergeSupport(state, keepId, support, callId)
    return evidenceKeys
  }
  private mergeDuplicates(state: RunState, value: unknown, callId: string): string {
    const item = object(value, ['keepId', 'duplicateIds', 'reason', 'support'])
    const keepId = text(item.keepId), duplicateIds = array(item.duplicateIds, 32).map(text)
    const reason = this.options.sanitizeExcerpt(text(item.reason)), support = this.support(state, item.support)
    if (!duplicateIds.length || unique(duplicateIds).length !== duplicateIds.length || duplicateIds.includes(keepId)) return fail('invalid-duplicate-group')
    if (!support.length || support.some(item => !item.quote.trim())) return fail('missing-evidence')
    const kept = state.diagnostics.find(item => item.id === keepId)
    if (!kept) return fail('unknown-diagnostic')
    const mapping = state.duplicateIds ?? {}
    if (Object.hasOwn(mapping, keepId)) return fail('duplicate-merge-conflict')
    for (const id of duplicateIds) {
      const diagnostic = state.diagnostics.find(item => item.id === id)
      if (!diagnostic) return fail('unknown-diagnostic')
      if ((Object.hasOwn(mapping, id) && mapping[id] !== keepId) || Object.values(mapping).includes(id)) return fail('duplicate-merge-conflict')
      if (diagnostic.anchor.revision !== kept.anchor.revision || diagnostic.anchor.path !== kept.anchor.path || diagnostic.anchor.side !== kept.anchor.side ||
          diagnostic.classification.kind !== kept.classification.kind || !diagnostic.anchor.span || !kept.anchor.span || !overlap(diagnostic.anchor, kept.anchor)) return fail('duplicate-anchor-mismatch')
    }
    this.mergeSupport(state, keepId, [...duplicateIds.flatMap(id => state.candidates.find(item => item.diagnosticId === id)!.input.support), ...support], callId)
    state.duplicateIds = Object.fromEntries([...Object.entries(mapping), ...duplicateIds.map(id => [id, keepId])])
    state.duplicateMerges = [...state.duplicateMerges ?? [], { keepId, duplicateIds, reason, support }]
    this.event(state, 'duplicates-merged')
    return keepId
  }
  private assess(state: RunState, id: string, disposition: ReportDisposition, rationale: string, support: ReportSupport[], callId: string): void {
    const candidate = state.candidates.find(item => item.diagnosticId === id)
    if (!candidate) return fail('unknown-diagnostic')
    const evidenceKeys = this.mergeSupport(state, id, support, callId)
    state.assessments.push({ id: this.id(), diagnosticId: id, disposition, rationale, evidenceKeys })
    candidate.input.assessment = { disposition, reason: rationale }
  }
  private append(state: RunState, input: ReportCandidateInput, callId: string): string {
    const trusted = state.anchors.find(item => item.key === input.location.anchorKey)!.anchor
    const anchor: ReportAnchor = { ...trusted, span: input.location.line === undefined ? undefined : { start: input.location.line, end: input.location.endLine! } }
    const mechanism = canonical([anchor.revision, anchor.path, anchor.side, normalized(input.statement.details)])
    const existing = state.candidates.find(candidate => candidate.mechanism === mechanism && candidate.input.kind === input.kind
      && overlap(state.diagnostics.find(item => item.id === candidate.diagnosticId)!.anchor, anchor))
    if (existing) {
      this.mergeSupport(state, existing.diagnosticId, input.support, callId)
      return existing.diagnosticId
    }
    const id = text(this.id())
    if (state.diagnostics.some(item => item.id === id)) return fail('duplicate-host-id')
    state.diagnostics.push({ id, runId: state.run.id, anchor,
      claim: { title: input.statement.headline, explanation: input.statement.details, trigger: input.statement.scenario },
      classification: { kind: input.kind, impact: input.impact }, evidenceKeys: [], origin: { angle: input.angle } })
    state.candidates.push({ diagnosticId: id, input, mechanism })
    this.assess(state, id, input.assessment.disposition, input.assessment.reason, input.support, callId)
    return id
  }
  // Security: all model writes are bound by the caller to one active run.
  private async modelWrite(runId: string, toolCallId: string, input: unknown,
    apply: (state: RunState) => ReportWriteResult, actionEpoch?: string): Promise<ReportWriteResult> {
    text(toolCallId)
    const callKey = canonical([actionEpoch ?? null, toolCallId])
    return this.serial(runId, async () => {
      const fingerprint = await digest(canonical(input))
      const original = await this.load(runId)
      const previous = original.calls.find(call => call.id === callKey)
      if (previous) {
        if (previous.input !== fingerprint) return fail('tool-call-conflict')
        if (previous.error) return fail(previous.error)
        return immutable(clone(previous.result!))
      }
      let draft = clone(original)
      try {
        if (draft.run.progress.status !== 'active') return fail('run-not-active')
        if (draft.actionPhase) {
          if (!actionEpoch || draft.actionPhase.epoch !== actionEpoch) return fail('invalid-action-epoch')
          if (draft.actionPhase.kind === 'verification') return fail('verification-host-only')
          if (draft.actionPhase.kind === 'publication') return fail('publication-host-only')
          this.grant(draft, draft.actionPhase.grantId, 'repair', [])
        } else if (actionEpoch) return fail('invalid-action-epoch')
        const result = apply(draft)
        draft.calls.push({ id: callKey, input: fingerprint, result })
        await this.save(draft)
        return immutable(clone(result))
      } catch (error) {
        if (!(error instanceof ReportStoreError)) throw error
        draft = clone(original)
        draft.calls.push({ id: callKey, input: fingerprint, error: error.code })
        draft.rawResults.push({ toolCallId, raw: this.options.sanitizeExcerpt(typeof input === 'string' ? input : canonical(input)), code: error.code })
        this.event(draft, 'write-rejected')
        await this.save(draft)
        throw error
      }
    })
  }
  async submitLedger(runId: string, toolCallId: string, input: unknown): Promise<ReportWriteResult> {
    const submitted = clone(input)
    return this.modelWrite(runId, toolCallId, submitted, state => {
      const operation = object(submitted, ['operation', 'candidates', 'assessments', 'coverage', 'groups'])
      const accepted: ReportWriteResult['accepted'] = []
      if (operation.operation === 'append-candidates') {
        object(submitted, ['operation', 'candidates'])
        const candidates = array(operation.candidates, 32).map(item => this.candidate(state, item))
        candidates.forEach((item, index) => accepted.push({ index, diagnosticId: this.append(state, item, toolCallId) }))
      } else if (operation.operation === 'assess') {
        object(submitted, ['operation', 'assessments'])
        array(operation.assessments, 32).forEach((value, index) => {
          const item = object(value, ['candidateId', 'disposition', 'reason', 'support'])
          const id = text(item.candidateId)
          const support = this.support(state, item.support)
          if (!support.length) return fail('missing-evidence')
          this.assess(state, id, enumeration(item.disposition, dispositions), text(item.reason), support, toolCallId)
          accepted.push({ index, diagnosticId: id })
        })
      } else if (operation.operation === 'merge-duplicates') {
        object(submitted, ['operation', 'groups'])
        const groups = array(operation.groups, 32)
        if (!groups.length) return fail('invalid-duplicate-group')
        groups.forEach((group, index) => accepted.push({ index, diagnosticId: this.mergeDuplicates(state, group, toolCallId) }))
      } else if (operation.operation === 'coverage') {
        object(submitted, ['operation', 'coverage'])
        this.recordCoverage(state, operation.coverage)
      } else return fail('invalid-operation')
      select(state)
      return { reportRevision: state.run.reportRevision, accepted, notices: [] }
    })
  }
  /** Merges a coverage statement into the ledger: angles and limitations accumulate, `complete` is the latest claim. */
  private recordCoverage(state: RunState, value: unknown): void {
    const coverage = this.coverage(value)
    if (state.expectedAngles.length && coverage.angles.some(angle => !state.expectedAngles.includes(angle))) return fail('unknown-angle')
    state.coverage = { angles: unique([...state.coverage.angles, ...coverage.angles]), limitations: unique([...state.coverage.limitations, ...coverage.limitations]), complete: coverage.complete }
    state.run.progress.coveredAngles = [...state.coverage.angles]
  }
  /**
   * Contract: commits the record when its candidates equal the retained ledger. `coverage: 'exact'` also requires the
   * record's coverage to equal the ledger's; `'merge'` records it through the coverage operation first (F-38).
   */
  private commitRecord(state: RunState, record: Record<string, unknown>, coverage: 'exact' | 'merge'): ReportWriteResult {
    const cap = state.run.policy.presentation === 'panel' ? 32 : 10_000
    const candidates = array(record.candidates, cap).map(item => this.candidate(state, item))
    select(state)
    const expected = state.retainedIds.map(id => state.candidates.find(item => item.diagnosticId === id)!.input)
    if (canonical(expected) !== canonical(candidates)) return fail('ledger-mismatch')
    if (coverage === 'merge') this.recordCoverage(state, record.coverage)
    else if (canonical(this.coverage(record.coverage)) !== canonical(effectiveCoverage(state))) return fail('ledger-mismatch')
    state.run.reportRevision++
    state.structured = true
    this.event(state, 'report-committed')
    return { reportRevision: state.run.reportRevision, accepted: state.retainedIds.map((diagnosticId, index) => ({ index, diagnosticId })), notices: [] }
  }
  async submitRecord(runId: string, toolCallId: string, input: unknown): Promise<ReportWriteResult> {
    const submitted = clone(input)
    return this.modelWrite(runId, toolCallId, submitted, state => {
      const record = object(submitted, ['operation', 'candidates', 'coverage'])
      if (record.operation !== 'record') return fail('invalid-operation')
      return this.commitRecord(state, record, 'exact')
    })
  }
  /** A final-text report object: `candidates` and `coverage`, optionally tagged `operation: 'record'`. */
  private finalRecord(value: Record<string, unknown>): Record<string, unknown> {
    const record = object(value, ['operation', 'candidates', 'coverage'])
    if ('operation' in record && record.operation !== 'record') return fail('invalid-operation')
    return record
  }
  /** True when `value` would commit as the final record; `exact` also requires its coverage to equal the ledger's. */
  private matchesLedger(state: RunState, value: Record<string, unknown>, exact: boolean): boolean {
    try {
      this.commitRecord(clone(state), this.finalRecord(value), exact ? 'exact' : 'merge')
      return true
    } catch (error) { if (error instanceof ReportStoreError) return false; throw error }
  }
  /**
   * Contract: commits the final-text report. `coverage: 'merge'` merges the report's coverage into the ledger and takes
   * the last object in the text whose candidates match; `'exact'` (a caller with no review tools, such as the format
   * correction) commits only when the coverage equals the ledger's, so it cannot add angles or raise `complete` (F-38).
   */
  async submitFinalJson(runId: string, toolCallId: string, raw: string, coverage: 'exact' | 'merge' = 'merge'): Promise<ReportWriteResult> {
    const found = finalJsonObjects(raw)
    if (!found.length) return this.modelWrite(runId, toolCallId, raw, () => fail('malformed-json'))
    const state = await this.serial(runId, () => this.load(runId))
    let value: Record<string, unknown>
    try {
      value = this.finalRecord(found.find(item => this.matchesLedger(state, item, coverage === 'exact')) ?? found[0])
    } catch (error) {
      const code = error instanceof ReportStoreError ? error.code : 'malformed-json'
      return this.modelWrite(runId, toolCallId, raw, () => fail(code))
    }
    try {
      const submitted = { operation: 'record', candidates: value.candidates, coverage: value.coverage }
      return await this.modelWrite(runId, toolCallId, clone(submitted), draft => this.commitRecord(draft, submitted, coverage))
    } catch (error) {
      if (!(error instanceof ReportStoreError)) throw error
      await this.captureMalformed(runId, toolCallId, raw, error.code)
      throw error
    }
  }
  async captureMalformed(runId: string, toolCallId: string, raw: string, code = 'unstructured-result'): Promise<void> {
    return this.mutate(runId, state => {
      if (!state.rawResults.some(item => item.toolCallId === toolCallId && item.raw === this.options.sanitizeExcerpt(raw))) {
        state.rawResults.push({ toolCallId, raw: this.options.sanitizeExcerpt(raw), code })
      }
    })
  }
  async expectedRecord(runId: string): Promise<{ operation: 'record'; candidates: ReportCandidateInput[]; coverage: ReportCoverage }> {
    return this.serial(runId, async () => {
      const state = await this.load(runId)
      return immutable(clone({ operation: 'record' as const, candidates: state.retainedIds.map(id => state.candidates.find(item => item.diagnosticId === id)!.input), coverage: effectiveCoverage(state) }))
    })
  }
  async getSnapshot(runId: string): Promise<ReportSnapshot> {
    return this.serial(runId, async () => {
      const state = await this.load(runId)
      return this.snapshot(state)
    })
  }
  async getRawResults(runId: string): Promise<ReadonlyArray<RawResult>> {
    return this.serial(runId, async () => immutable(clone((await this.load(runId)).rawResults)))
  }
  async grantAction(runId: string, grant: Omit<ReportGrant, 'id'>): Promise<string> {
    const input = clone(grant)
    return this.mutate(runId, state => {
      if (input.workspaceKey !== state.run.scope.workspaceKey || input.headRevision !== state.run.scope.revision.head || (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.now())) return fail('invalid-grant')
      enumeration(input.kind, ['repair', 'publication', 'verification'])
      this.diagnosticIds(state, input.diagnosticIds)
      input.paths?.forEach(relativePath)
      const id = this.id()
      state.grants.push({ ...input, id })
      return id
    })
  }
  // Security: call before invoking an edit, verification, or publication adapter, not after it.
  // The returned grant is a snapshot; adapters must still enforce their execution-time scope.
  async assertActionAuthorized(runId: string, grantId: string, kind: ReportGrant['kind'], diagnosticIds: string[], paths?: string[]): Promise<ReportGrant> {
    const ids = clone(diagnosticIds)
    const requestedPaths = paths === undefined ? undefined : clone(paths)
    enumeration(kind, ['repair', 'publication', 'verification'])
    return this.serial(runId, async () => {
      const state = await this.load(runId)
      if (!state.structured) return fail('report-required')
      this.diagnosticIds(state, ids)
      const grant = this.grant(state, grantId, kind, ids)
      if (kind === 'publication') this.authorizePublication(state, grantId, ids)
      if (kind !== 'publication' && state.run.progress.status !== 'active') return fail('run-not-active')
      if (state.actionPhase) {
        if (kind === 'publication' && state.actionPhase.kind !== 'publication') return fail('action-phase-only')
        if (state.actionPhase.kind !== 'repair' && kind !== state.actionPhase.kind) return fail('action-phase-only')
        this.grant(state, state.actionPhase.grantId, state.actionPhase.kind, ids)
        if ((kind === 'repair' || state.actionPhase.kind !== 'repair') && grantId !== state.actionPhase.grantId) return fail('action-grant-mismatch')
      }
      if (requestedPaths !== undefined) {
        requestedPaths.forEach(relativePath)
        if (!grant.paths || requestedPaths.some(path => !grant.paths!.includes(path))) return fail('action-outside-grant')
      }
      if (kind === 'repair' && (!ids.length || !requestedPaths?.length)) return fail('repair-scope-required')
      return immutable(clone(grant))
    })
  }
  // Contract: only negative/skipped host outcomes; success requires observed execution receipts.
  async recordActionReceipt(runId: string, input: {
    kind: 'repair' | 'publication'; state: 'blocked' | 'failed' | 'skipped'
    diagnosticIds: string[]; reason: string; actionEpoch?: string
  }): Promise<ReportActionReceipt> {
    const receipt = clone(input)
    enumeration(receipt.kind, ['repair', 'publication'])
    enumeration(receipt.state, receipt.kind === 'repair' ? ['blocked', 'failed', 'skipped'] : ['blocked', 'failed'])
    text(receipt.reason)
    return this.mutate(runId, state => {
      if (!state.structured) return fail('report-required')
      this.diagnosticIds(state, receipt.diagnosticIds)
      if (state.actionPhase) {
        if (receipt.actionEpoch !== state.actionPhase.epoch || receipt.kind !== state.actionPhase.kind) return fail('invalid-action-epoch')
        const grant = state.grants.find(grant => grant.id === state.actionPhase!.grantId)
        if (!grant || receipt.diagnosticIds.some(id => !grant.diagnosticIds.includes(id))) return fail('action-not-authorized')
      } else if (receipt.actionEpoch) return fail('invalid-action-epoch')
      const saved: ReportActionReceipt = receipt.kind === 'repair'
        ? { id: this.id(), kind: 'repair', state: receipt.state, diagnosticIds: receipt.diagnosticIds, reason: receipt.reason, verification: 'not-run' }
        : { id: this.id(), kind: 'publication', state: receipt.state as 'blocked' | 'failed', diagnosticIds: receipt.diagnosticIds, reason: receipt.reason }
      state.actions.push(saved)
      this.event(state, receipt.kind === 'repair' ? 'repair-updated' : 'publication-updated')
      return saved
    })
  }
  private diagnosticIds(state: RunState, ids: string[]): void {
    strings(ids)
    if (new Set(ids).size !== ids.length || ids.some(id => !state.retainedIds.includes(id))) return fail('unknown-diagnostic')
  }
  private grant(state: RunState, grantId: string | undefined, kind: ReportGrant['kind'], ids: string[]): ReportGrant {
    const grant = state.grants.find(item => item.id === grantId && item.kind === kind)
    if (!grant || grant.expiresAt <= this.now() || ids.some(id => !grant.diagnosticIds.includes(id))) return fail('action-not-authorized')
    return grant
  }
  // Contract: verification checkedThroughSequence captures the last store event before the host starts the check.
  async recordExecution(runId: string, execution: ReportExecution): Promise<void> {
    const input = clone(execution)
    return this.mutate(runId, state => {
      text(input.ref)
      if (state.run.progress.status !== 'active') return fail('run-not-active')
      if (state.actionPhase) {
        if (input.actionEpoch !== state.actionPhase.epoch) return fail('invalid-action-epoch')
        if (state.actionPhase.kind === 'publication' || (state.actionPhase.kind === 'verification' && input.kind !== 'verification')) return fail('action-phase-only')
        this.grant(state, state.actionPhase.grantId, state.actionPhase.kind, input.diagnosticIds)
        if ((input.kind === 'edit' || state.actionPhase.kind === 'verification') && input.grantId !== state.actionPhase.grantId) return fail('action-grant-mismatch')
      } else if (input.actionEpoch) return fail('invalid-action-epoch')
      this.diagnosticIds(state, input.diagnosticIds)
      input.paths.forEach(relativePath)
      enumeration(input.kind, ['edit', 'verification', 'evidence'])
      if (!state.structured) return fail('report-required')
      if (state.executions.some(item => item.ref === input.ref)) return fail('duplicate-execution-ref')
      if (input.kind !== 'evidence') {
        const grant = this.grant(state, input.grantId, input.kind === 'edit' ? 'repair' : 'verification', input.diagnosticIds)
        if (input.kind === 'edit' && (!input.paths.length || !grant.paths || input.paths.some(path => !grant.paths!.includes(path)))) return fail('edit-outside-grant')
        if (input.kind === 'verification' && input.paths.length && (!grant.paths || input.paths.some(path => !grant.paths!.includes(path)))) return fail('verification-outside-grant')
      }
      if (input.kind === 'edit' && input.diagnosticIds.some(id => !input.paths.includes(state.diagnostics.find(item => item.id === id)!.anchor.path))) return fail('edit-diagnostic-mismatch')
      if (typeof input.succeeded !== 'boolean') return fail('invalid-execution-result')
      if (input.evidence) input.evidence = this.support(state, input.evidence)
      if (input.command !== undefined) input.command = this.options.sanitizeExcerpt(text(input.command))
      if (input.codeRevision !== undefined) text(input.codeRevision)
      if (input.missingCases !== undefined) input.missingCases = strings(input.missingCases).map(value => this.options.sanitizeExcerpt(value))
      if (input.kind === 'verification') {
        const sequence = state.events.at(-1)?.sequence ?? 0
        input.checkedThroughSequence ??= sequence
        if (!Number.isSafeInteger(input.checkedThroughSequence) || input.checkedThroughSequence < 0 || input.checkedThroughSequence > sequence) return fail('invalid-verification-sequence')
      }
      this.event(state, 'execution-observed')
      state.executions.push({ ...input, sequence: state.events.at(-1)!.sequence, time: this.now() })
      if (input.kind === 'edit' || input.kind === 'verification') this.refreshRepairVerification(state)
    })
  }
  /** Security: host-only; a receipt records an already authorized edit, never grants permission to edit. */
  async reconcileExternalEdit(runId: string, receipt: ExternalEditReceipt, updates: readonly ReassessmentUpdate[]): Promise<ReportActionReceipt[]> {
    const { verifyCurrent, ...data } = receipt
    const input = clone(data)
    const proposed = clone(updates)
    text(input.ref); text(input.beforeDigest); text(input.afterDigest)
    if (input.runId !== runId) return fail('external-edit-run-mismatch')
    if (input.beforeDigest === input.afterDigest) return fail('external-edit-unchanged')
    if (typeof verifyCurrent !== 'function') return fail('external-edit-verification-required')
    if (!input.paths.length || input.paths.length > 128 || unique(input.paths).length !== input.paths.length) return fail('invalid-path')
    input.paths.forEach(relativePath)
    if (!input.evidence.length || input.evidence.length > 128) return fail('missing-evidence')
    input.evidence.forEach(source => { relativePath(source.path); text(source.revision); excerptText(source.excerpt) })
    const fingerprint = await digest(canonical({ input, proposed }))
    return this.serial(runId, async () => {
      const state = clone(await this.load(runId))
      const existing = state.externalEdits?.find(item => item.ref === input.ref)
      if (existing) {
        if (existing.fingerprint !== fingerprint) return fail('external-edit-receipt-conflict')
        return immutable(clone(state.actions.filter(action => existing.actionIds.includes(action.id))))
      }
      if (!terminal(state.run.progress.status) || state.actionPhase) return fail('external-edit-terminal-required')
      if (!state.structured) return fail('report-required')
      if (!['workspace', 'paths'].includes(state.run.scope.kind)) return fail('external-edit-local-required')
      if (state.run.scope.workspaceKey !== input.workspaceKey || state.run.scope.revision.head !== input.headRevision) return fail('external-edit-scope-mismatch')
      if (input.expectedSequence !== (state.events.at(-1)?.sequence ?? 0)) return fail('external-edit-stale-report')
      if (state.executions.some(item => item.ref === input.ref)) return fail('duplicate-execution-ref')
      const affected = state.retainedIds.filter(id => reassessmentTouches(this.snapshot(state), id, input.paths))
      if (!affected.length) return fail('edit-diagnostic-mismatch')
      const validated = validateReassessmentUpdates(this.snapshot(state), [{ ref: input.ref, paths: input.paths }], input.evidence, proposed)
      const support = validated.flatMap(update => update.evidence.map(item => ({ ...item,
        quote: this.options.sanitizeExcerpt(item.quote), relevance: this.options.sanitizeExcerpt(item.relevance) })))
      this.event(state, 'external-edit-observed')
      state.executions.push({ ref: input.ref, kind: 'edit', diagnosticIds: affected, paths: input.paths, succeeded: true,
        codeRevision: input.afterDigest, evidence: support, sequence: state.events.at(-1)!.sequence, time: this.now() })
      const actions: ReportActionReceipt[] = []
      for (const update of validated) {
        for (const item of update.evidence) {
          const source = input.evidence.find(source => source.path === item.path && quotedIn(source.excerpt, item.quote))!
          state.evidence.push({ id: this.id(), runId, diagnosticId: update.diagnosticId,
            source: { path: item.path, revision: source.revision, toolCallKey: input.ref },
            excerpt: this.options.sanitizeExcerpt(item.quote), reason: this.options.sanitizeExcerpt(item.relevance) })
        }
        const action: ReportActionReceipt = { id: this.id(), kind: 'repair', state: update.outcome === 'resolved' ? 'applied' : 'skipped',
          diagnosticIds: [update.diagnosticId], executionRef: input.ref, verification: 'not-run', reason: this.options.sanitizeExcerpt(update.explanation) }
        state.actions.push(action)
        actions.push(action)
      }
      this.refreshRepairVerification(state)
      state.externalEdits = [...state.externalEdits ?? [], { ref: input.ref, fingerprint, actionIds: actions.map(action => action.id) }]
      this.event(state, 'repair-updated')
      if (!await verifyCurrent()) return fail('external-edit-stale-evidence')
      await this.save(state)
      return immutable(clone(actions))
    })
  }
  async reconcile(runId: string, toolCallId: string, input: unknown, actionEpoch?: string): Promise<ReportWriteResult> {
    const submitted = clone(input)
    return this.modelWrite(runId, toolCallId, submitted, state => {
      const proposal = object(submitted, ['operation', 'updates'])
      if (proposal.operation !== 'reconcile') return fail('invalid-operation')
      if (!state.structured) return fail('report-required')
      const accepted: ReportWriteResult['accepted'] = []
      array(proposal.updates, 32).forEach((value, index) => {
        const update = object(value, ['diagnosticId', 'observation', 'explanation', 'executionRefs'])
        const id = text(update.diagnosticId)
        this.diagnosticIds(state, [id])
        if (state.actionPhase) this.grant(state, state.actionPhase.grantId, 'repair', [id])
        const observation = enumeration(update.observation, ['edited', 'not-needed', 'left-open'])
        const reason = text(update.explanation)
        const refs = unique(strings(update.executionRefs))
        const events = refs.map(ref => state.executions.find(event => event.ref === ref && event.diagnosticIds.includes(id) && event.actionEpoch === actionEpoch) ?? fail('invalid-execution-ref'))
        const receipt: ReportActionReceipt = { id: this.id(), diagnosticIds: [id], kind: 'repair', state: 'skipped', reason, verification: 'not-run' }
        if (observation === 'edited') {
          const edits = events.filter(event => event.kind === 'edit' && event.succeeded)
          if (!edits.length) return fail('edit-evidence-required')
          for (const edit of edits) this.grant(state, edit.grantId, 'repair', [id])
          const latestEdit = Math.max(...state.executions.filter(event => event.kind === 'edit' && event.succeeded && event.diagnosticIds.includes(id)).map(event => event.sequence))
          const verification = events.filter(event => event.kind === 'verification' && event.sequence > latestEdit).at(-1)
          receipt.state = 'applied'
          receipt.executionRef = edits.at(-1)!.ref
          if (verification) receipt.verification = verification.succeeded ? 'passed' : 'failed'
        } else if (observation === 'not-needed') {
          const evidence = events.filter(event => event.kind === 'evidence' && event.succeeded).flatMap(event => event.evidence ?? [])
          if (!evidence.length || !evidence.some(item => !state.evidence.some(old => old.diagnosticId === id && old.excerpt === this.options.sanitizeExcerpt(item.quote) && old.reason === item.relevance))) return fail('new-evidence-required')
          this.assess(state, id, 'dismissed', reason, evidence, toolCallId)
          receipt.state = 'unnecessary'
          receipt.executionRef = events.find(event => event.kind === 'evidence')!.ref
        }
        state.actions.push(receipt)
        accepted.push({ index, diagnosticId: id })
      })
      this.refreshRepairVerification(state)
      this.event(state, 'repair-updated')
      return { reportRevision: state.run.reportRevision, accepted, notices: [] }
    }, actionEpoch)
  }
  // Contract: reconcile persisted successful edit events even when an editing adapter subsequently throws.
  async reconcileObservedEdits(runId: string, grantId: string, diagnosticIds: string[], actionEpoch?: string): Promise<ReportActionReceipt[]> {
    const ids = clone(diagnosticIds)
    return this.mutate(runId, state => {
      if (!state.structured) return fail('report-required')
      if (state.run.progress.status !== 'active') return fail('run-not-active')
      this.diagnosticIds(state, ids)
      this.grant(state, grantId, 'repair', ids)
      if (state.actionPhase) {
        if (state.actionPhase.kind !== 'repair') return fail('action-phase-only')
        if (state.actionPhase.epoch !== actionEpoch) return fail('invalid-action-epoch')
        if (state.actionPhase.grantId !== grantId) return fail('action-grant-mismatch')
      } else if (actionEpoch) return fail('invalid-action-epoch')
      const receipts: ReportActionReceipt[] = []
      let changed = false
      for (const id of ids) {
        const edit = state.executions.filter(event => event.kind === 'edit' && event.succeeded && event.grantId === grantId
          && event.actionEpoch === actionEpoch && event.diagnosticIds.includes(id)).at(-1)
        if (!edit) continue
        const existing = state.actions.find(action => action.kind === 'repair' && action.state === 'applied'
          && action.executionRef === edit.ref && action.diagnosticIds.includes(id))
        if (existing) { receipts.push(existing); continue }
        const receipt: ReportActionReceipt = { id: this.id(), kind: 'repair', state: 'applied', diagnosticIds: [id], executionRef: edit.ref, verification: 'not-run' }
        state.actions.push(receipt)
        receipts.push(receipt)
        changed = true
      }
      this.refreshRepairVerification(state)
      if (changed) this.event(state, 'repair-updated')
      return receipts
    })
  }
  private authorizePublication(state: RunState, grantId: string, ids: string[]): void {
    if (state.run.progress.status === 'cancelled') return fail('run-not-active')
    this.grant(state, grantId, 'publication', ids)
    if (state.actionPhase) {
      if (state.actionPhase.kind !== 'publication') return fail('action-phase-only')
      if (state.actionPhase.grantId !== grantId) return fail('action-grant-mismatch')
    }
  }
  async beginPublication(runId: string, request: PublicationRequest): Promise<{ operation: PublicationOperation; shouldSend: boolean }> {
    const input = clone(request)
    const contentDigest = await digest(text(input.normalizedContent).trim().replace(/\r\n/g, '\n'))
    const reservation = this.publicationTail.catch(() => undefined).then(async () => {
      return this.mutate(runId, state => {
      if (!state.structured) return fail('report-required')
      this.diagnosticIds(state, input.diagnosticIds)
      this.authorizePublication(state, input.grantId, input.diagnosticIds)
      const scope = state.run.scope
      if (scope.kind !== 'change-request' || !scope.request || !scope.repository.platform) return fail('publication-target-required')
      if (input.remoteHead !== scope.request.headRevision || input.remoteHead !== scope.revision.head) return fail('stale-publication-head')
      enumeration(input.kind, ['inline', 'note', 'summary', 'discussion'])
      text(input.normalizedContent)
      if (input.kind === 'inline' || input.kind === 'discussion') {
        if (input.diagnosticIds.length !== 1) return fail('inline-diagnostic-required')
        const anchor = state.diagnostics.find(item => item.id === input.diagnosticIds[0])!.anchor
        if (!anchor.span || anchor.side === 'working-copy') return fail('inline-anchor-required')
      }
      const target = [scope.repository.platform, scope.repository.projectKey, scope.request.number, input.remoteHead]
      const rootKeys = input.diagnosticIds.map(id => {
        const diagnostic = state.diagnostics.find(item => item.id === id)!
        const candidate = state.candidates.find(item => item.diagnosticId === id)!
        return canonical([...target, candidate.mechanism, diagnostic.anchor.span ?? null])
      })
      const key = canonical([...target, input.kind, contentDigest,
        input.kind === 'inline' || input.kind === 'discussion' ? rootKeys : [state.run.reportRevision, [...input.diagnosticIds].sort(), state.coverage]])
      const allOperations = state.publications
      const existing = allOperations.find(item => item.key === key)
      if (existing) return { operation: existing, shouldSend: false }
      const duplicate = allOperations.find(item => item.state !== 'failed' && rootKeys.length > 0 && rootKeys.length === item.rootKeys.length && rootKeys.every(key => item.rootKeys.includes(key)))
      if (duplicate) return { operation: duplicate, shouldSend: false }
      const receipt: ReportActionReceipt = { id: this.id(), diagnosticIds: input.diagnosticIds, kind: 'publication', state: 'running' }
      const operation: PublicationOperation = { id: this.id(), key, rootKeys, receiptId: receipt.id, state: 'pending' }
      state.actions.push(receipt)
      state.publications.push(operation)
      this.event(state, 'publication-updated')
      return { operation, shouldSend: true }
      })
    })
    this.publicationTail = reservation
    return reservation
  }
  async settlePublication(runId: string, operationId: string, result: { state: 'succeeded' | 'failed' | 'uncertain'; externalRef?: string; reason?: string }): Promise<void> {
    const input = clone(result)
    enumeration(input.state, ['succeeded', 'failed', 'uncertain'])
    return this.mutate(runId, state => {
      const operation = state.publications.find(item => item.id === operationId)
      if (!operation) return fail('unknown-publication')
      if (operation.state === 'succeeded') {
        if (input.state === 'succeeded' && operation.externalRef === input.externalRef) return
        return fail('publication-already-succeeded')
      }
      if (input.state === 'succeeded') text(input.externalRef)
      operation.state = input.state
      operation.externalRef = input.externalRef
      const receipt = state.actions.find(item => item.id === operation.receiptId)!
      if (receipt.kind !== 'publication') return fail('invalid-publication-receipt')
      receipt.state = input.state
      receipt.externalRef = input.externalRef
      receipt.reason = input.reason
      this.event(state, 'publication-updated')
    })
  }
  // Security: absenceConfirmed is a host adapter query result, never model input.
  async retryPublication(runId: string, operationId: string, grantId: string, remoteHead: string, absenceConfirmed: boolean): Promise<PublicationOperation> {
    return this.mutate(runId, state => {
      const operation = state.publications.find(item => item.id === operationId)
      if (!operation) return fail('unknown-publication')
      const receipt = state.actions.find(item => item.id === operation.receiptId)!
      this.authorizePublication(state, grantId, receipt.diagnosticIds)
      if (remoteHead !== state.run.scope.revision.head || remoteHead !== state.run.scope.request?.headRevision) return fail('stale-publication-head')
      if (!['failed', 'uncertain'].includes(operation.state) || !absenceConfirmed) return fail('publication-retry-not-safe')
      operation.state = 'pending'
      operation.externalRef = undefined
      receipt.state = 'running'
      receipt.externalRef = undefined
      this.event(state, 'publication-updated')
      return operation
    })
  }
  async getPublications(runId: string): Promise<ReadonlyArray<PublicationOperation>> {
    return this.serial(runId, async () => immutable(clone((await this.load(runId)).publications)))
  }
}
