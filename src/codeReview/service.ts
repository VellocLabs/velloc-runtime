import { parseReviewArguments } from './arguments'
import { isTestOrFixturePath, resolveReviewPolicy, resolveReviewPreferences, reviewTimeBudgetMs, shouldRunAutomaticVerification } from './recipes'
import { composeReviewPrompt, composeFinderPrompt, composeVerifierPrompt, composeSweeperPrompt, type ReviewPromptBlock } from './composer'
import type { ReviewArguments, ReviewCapabilities, ReviewPlan, ReviewPreferences, OutputMode, ReviewRunEnd, ReviewTaskView } from './contracts'
import type { ScopeManifest } from './scope'
import { ReviewReportStore, type ReportSnapshot, type ReportStorageAdapter, type ReportGrant } from './report-store'
import { createReviewTools, REVIEW_RESULT_SCHEMA, REVIEW_ASSESSMENT_SCHEMA, REVIEW_SUPPORT_SCHEMA } from './tools'
import { ReviewWorkerPool, endOf, type ReviewModelRunner, type ReviewTaskObserver } from './runner'
import { lookupForkTaskId } from '../backgroundTasks/sideTaskSink'
import type { ToolContract } from '../toolkit/toolContract'

export interface ReviewPreferencesStorage { load(): Promise<ReviewPreferences>; save(value: ReviewPreferences): Promise<void> }
export interface ReviewScopeAccess {
  manifest: ScopeManifest
  read(input: Record<string, unknown>, plan: ReviewPlan, signal: AbortSignal): Promise<unknown>
  trustedGuidance: string
  authorizedGuidance?: ReviewServiceOptions['guidance']
  evidenceSources?: Array<{ path: string; revision: string; excerpt?: string }>
}
export interface ReviewServiceOptions {
  ownerSignal?: AbortSignal
  conversationKey: string
  modelId: string
  sessionLevel?: import('./contracts').ReviewLevel
  guidance?: { level: import('./contracts').ReviewLevel; trusted: boolean; appliesToProject: boolean }
  capabilities: ReviewCapabilities
  preferences: ReviewPreferencesStorage
  storage: ReportStorageAdapter
  sanitizeExcerpt(text: string): string
  /** Contract: with `approved`, reuse that guidance decision instead of asking for review-effort approval again. */
  resolveScope(args: ReviewArguments, plan: ReviewPlan, signal: AbortSignal, approved?: { guidance: ReviewServiceOptions['guidance'] }): Promise<ReviewScopeAccess>
  runModel: ReviewModelRunner
  repairTools?(snapshot: ReportSnapshot, grant: ReportGrant, signal: AbortSignal, store: ReviewReportStore, actionEpoch?: string): Promise<ToolContract[]>
  publish?(snapshot: ReportSnapshot, grantId: string, signal: AbortSignal, store: ReviewReportStore, discussions?: boolean): Promise<void>
  verify?(snapshot: ReportSnapshot, signal: AbortSignal, store: ReviewReportStore, actionEpoch?: string, verificationGrantId?: string): Promise<void>
  alreadyVerified?(snapshot: ReportSnapshot): Promise<boolean>
  automaticVerificationPermitted?: boolean
  output?: OutputMode
  maxDurationMs?: number
  savePresentation?(runId: string, value: { notices: ReviewPlan['notices']; emptyScope: boolean; target?: string }): Promise<void>
  saveTarget?(runId: string, target: string | undefined, targetLiteral?: true, directory?: string): Promise<void>
  loadDirectory?(runId: string): Promise<string | undefined>
  loadTargetLiteral?(runId: string): Promise<true | undefined>
  loadTarget?(runId: string): Promise<string | undefined>
}
interface LiveRun { access: ReviewScopeAccess; plan: ReviewPlan; args: ReviewArguments; controller: AbortController; done: Promise<void>; source: 'user' | 'model'; completedAngles: Set<string>; finderTasks: Map<string, string>; verified: Set<string>; sweepIds: Set<string>; swept: boolean; tasks: Map<string, ReviewTaskView>; agentIds: Map<string, string>; end?: ReviewRunEnd; budgetExpired?: boolean }
export class ReviewGatewayError extends Error { constructor(readonly code: string) { super(code) } }
const onlyTestsSkipped = (manifest: ScopeManifest): boolean => !manifest.files.some(file => file.status === 'included') && manifest.files.some(file => file.status === 'skipped' && isTestOrFixturePath(file.path))
const patchBytes = (manifest: ScopeManifest): number => manifest.files.reduce((total, file) => total + new TextEncoder().encode(file.patch).length, 0)
const block = (text: string, source: string): ReviewPromptBlock => ({ type: 'text', text, source, provenance: 'trusted-task' })
const newLive = (base: Omit<LiveRun, 'completedAngles' | 'finderTasks' | 'verified' | 'sweepIds' | 'swept' | 'tasks' | 'agentIds'>): LiveRun =>
  ({ ...base, completedAngles: new Set(), finderTasks: new Map(), verified: new Set(), sweepIds: new Set(), swept: false, tasks: new Map(), agentIds: new Map() })
const endCode = (end: ReviewRunEnd): string => `review-${end.kind}`
/** A task the run's time budget aborted ended on the time limit, not on a cancellation. */
const timed = (live: LiveRun, end: ReviewRunEnd): ReviewRunEnd => live.budgetExpired && end.kind === 'cancelled' ? { kind: 'time-limit' } : end
const countLines = (patch: string, sign: '+' | '-'): number => patch.split('\n').filter(line => line.startsWith(sign) && !line.startsWith(sign.repeat(3))).length

/** Contract: the manifest without patch text; patches are read per file through ReviewRead. */
export function scopeIndex(manifest: ScopeManifest): Record<string, unknown> {
  return { ...manifest, files: manifest.files.map(({ patch, ...file }) => ({ ...file,
    hunks: (patch.match(/^@@ /gm) ?? []).length, added: countLines(patch, '+'), removed: countLines(patch, '-') })) }
}
/** The patches a worker needs: every included file, or only the named ones (by current or pre-rename path). */
export function reviewMaterial(manifest: ScopeManifest, paths?: readonly string[]): string {
  return JSON.stringify(manifest.files.filter(file => file.status === 'included' && (!paths || paths.includes(file.path) || (!!file.beforePath && paths.includes(file.beforePath)))).map(file => ({ path: file.path, beforePath: file.beforePath, patch: file.patch })))
}

/** Invocation provenance is selected by separate host entry points, never by model JSON. */
export class LocalReviewService {
  readonly store: ReviewReportStore
  private readonly live = new Map<string, LiveRun>()
  private readonly pending = new Map<string, { toolCallId: string; controller: AbortController }>()
  private readonly listeners = new Set<() => void>()
  private readonly known = new Set<string>()
  private sequence = 0
  private readonly actionsInFlight = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private disposed = false
  dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.options.ownerSignal?.removeEventListener('abort', this.dispose)
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.listeners.clear()
  }
  private admit(signal?: AbortSignal): void {
    if (this.disposed || this.options.ownerSignal?.aborted || signal?.aborted) throw new ReviewGatewayError('review-cancelled')
  }
  private operation(signal?: AbortSignal): { controller: AbortController; release(): void } {
    this.admit(signal)
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    this.controllers.add(controller)
    return { controller, release: () => { this.controllers.delete(controller); signal?.removeEventListener('abort', abort) } }
  }
  private runModel: ReviewModelRunner = request => {
    this.admit(request.signal)
    return this.options.runModel({ ...request, tools: request.tools.map(tool => ({ ...tool, call: (...args) => {
      this.admit(request.signal)
      return tool.call(...args)
    } })) })
  }
  constructor(private readonly options: ReviewServiceOptions) {
    this.store = new ReviewReportStore(options.storage, { sanitizeExcerpt: options.sanitizeExcerpt, onChange: () => this.changed() })
    options.ownerSignal?.addEventListener('abort', this.dispose, { once: true })
    if (options.ownerSignal?.aborted) this.dispose()
  }
  subscribe = (listener: () => void): (() => void) => { this.admit(); this.listeners.add(listener); return () => this.listeners.delete(listener) }
  changed = (): void => { this.sequence++; for (const listener of this.listeners) listener() }
  presentation(runId: string): { notices: ReviewPlan['notices']; emptyScope: boolean; target?: string } | undefined {
    const live = this.live.get(runId)
    return live ? { notices: live.plan.notices, emptyScope: live.access.manifest.status === 'empty', target: live.args.target } : undefined
  }
  /** The run's model tasks with their drawer handles, and the coordinator's end when it did not complete. */
  tasks(runId: string): { tasks: ReviewTaskView[]; end?: ReviewRunEnd } | undefined {
    const live = this.live.get(runId)
    if (!live) return undefined
    const tasks = [...live.tasks.values()].map(task => {
      const agentId = live.agentIds.get(task.key)
      const taskId = agentId ? lookupForkTaskId(agentId) : undefined
      return taskId ? { ...task, taskId } : { ...task }
    })
    return { tasks, end: live.end }
  }
  private observer(live: LiveRun): ReviewTaskObserver {
    return {
      started: info => {
        live.agentIds.set(info.key, info.agentId)
        live.tasks.set(info.key, { key: info.key, role: info.role, ...(info.label ? { label: info.label } : {}), ...(info.angles?.length ? { angles: [...info.angles] } : {}),
          status: 'running', startedAt: Date.now(), lastActivityAt: Date.now() })
        this.changed()
      },
      activity: info => {
        const task = live.tasks.get(info.key)
        if (task) { task.lastAction = info.action; task.lastActivityAt = Date.now(); this.changed() }
      },
      ended: info => {
        const task = live.tasks.get(info.key)
        if (!task) return
        task.end = timed(live, info.end)
        task.finishedAt = Date.now()
        task.status = task.end.kind === 'completed' ? 'finished' : task.end.kind === 'cancelled' ? 'stopped' : 'failed'
        this.changed()
      },
      timeLimited: () => !!live.budgetExpired,
    }
  }
  preload(): { command: string; aliases: string[]; levels: string[] } {
    return { command: 'code-review', aliases: ['review'], levels: ['low', 'medium', 'high', 'xhigh', 'max'] }
  }
  startUser(raw: string, signal?: AbortSignal, presentation?: OutputMode): Promise<{ runId: string }> { return this.start(raw, 'user', signal, presentation) }
  /** `toolCallId` names the Skill call that asked for the review; until the run exists it is listed by `preparing()`. */
  startModel(raw: string, signal?: AbortSignal, toolCallId?: string): Promise<{ runId: string }> { return this.start(raw, 'model', signal, undefined, toolCallId) }
  /** Model-requested reviews whose run does not exist yet; `cancel` accepts their ids. */
  preparing(): Array<{ id: string; toolCallId: string }> { return [...this.pending].map(([id, entry]) => ({ id, toolCallId: entry.toolCallId })) }
  private async start(raw: string, source: 'user' | 'model', signal?: AbortSignal, presentation?: OutputMode, toolCallId?: string): Promise<{ runId: string }> {
    const operation = this.operation(signal)
    const pendingId = toolCallId ? `preparing-${crypto.randomUUID()}` : undefined
    if (pendingId) { this.pending.set(pendingId, { toolCallId: toolCallId!, controller: operation.controller }); this.changed() }
    try {
      const result = await this.prepare(raw, source, operation.controller, presentation, toolCallId)
      void this.live.get(result.runId)!.done.then(operation.release, operation.release)
      return result
    } catch (error) { operation.release(); throw error }
    finally { if (pendingId && this.pending.delete(pendingId)) this.changed() }
  }
  private async prepare(raw: string, source: 'user' | 'model', controller: AbortController, presentation?: OutputMode, toolCallId?: string): Promise<{ runId: string }> {
    const parsed = parseReviewArguments(raw)
    if (!parsed.ok) throw new ReviewGatewayError(parsed.error.code)
    if (source === 'model' && (parsed.arguments.fix || parsed.arguments.comment)) throw new ReviewGatewayError('action-not-authorized')
    const preferences = await this.options.preferences.load()
    this.admit(controller.signal)
    let plan = resolveReviewPolicy({ arguments: parsed.arguments, source, preferences,
      sessionLevel: this.options.sessionLevel, guidance: this.options.guidance, canonicalModelId: this.options.modelId, capabilities: this.options.capabilities, output: presentation ?? this.options.output ?? 'terminal' })
    if (plan.blocked) throw new ReviewGatewayError('review-plan-blocked')
    let access = await this.options.resolveScope(parsed.arguments, plan, controller.signal)
    this.admit(controller.signal)
    const approved = { guidance: access.authorizedGuidance }
    const guidance = access.authorizedGuidance ?? this.options.guidance
    const authorizedPlan = resolveReviewPolicy({ arguments: parsed.arguments, source, preferences, sessionLevel: this.options.sessionLevel, guidance,
      canonicalModelId: this.options.modelId, capabilities: this.options.capabilities, output: presentation ?? this.options.output ?? 'terminal' })
    if (authorizedPlan.blocked) throw new ReviewGatewayError('review-plan-blocked')
    if (authorizedPlan.skipTestsAndFixtures !== plan.skipTestsAndFixtures) {
      access = await this.options.resolveScope(parsed.arguments, authorizedPlan, controller.signal, approved)
      this.admit(controller.signal)
      if (JSON.stringify(access.authorizedGuidance ?? this.options.guidance) !== JSON.stringify(guidance)) throw new ReviewGatewayError('review-guidance-changed')
    }
    const testsOnly = authorizedPlan.skipTestsAndFixtures && onlyTestsSkipped(access.manifest)
    if (testsOnly) {
      access = await this.options.resolveScope(parsed.arguments, resolveReviewPolicy({ arguments: parsed.arguments, source, preferences, sessionLevel: this.options.sessionLevel, guidance,
        canonicalModelId: this.options.modelId, capabilities: this.options.capabilities, output: presentation ?? this.options.output ?? 'terminal', testsOnly }), controller.signal, approved)
      this.admit(controller.signal)
      if (JSON.stringify(access.authorizedGuidance ?? this.options.guidance) !== JSON.stringify(guidance)) throw new ReviewGatewayError('review-guidance-changed')
    }
    const changedLines = access.manifest.files.reduce((total, file) => total + file.patch.split('\n').filter(line => /^[+-]/.test(line) && !/^(?:---|\+\+\+)/.test(line)).length, 0)
    plan = resolveReviewPolicy({ arguments: parsed.arguments, source, preferences, sessionLevel: this.options.sessionLevel, guidance,
      canonicalModelId: this.options.modelId, capabilities: this.options.capabilities, output: presentation ?? this.options.output ?? 'terminal', changedLines, testsOnly })
    const next = resolveReviewPreferences({ current: preferences, arguments: parsed.arguments, source, targetAuthorized: true })
    if (source === 'user' && JSON.stringify(preferences) !== JSON.stringify(next)) await this.options.preferences.save(next)
    this.admit(controller.signal)
    const runId = await this.store.createRun({ conversationKey: this.options.conversationKey, scope: access.manifest.scope,
      policy: plan, expectedAngles: access.manifest.status === 'empty' ? [] : [...plan.angles], ...(toolCallId ? { toolCallId } : {}) })
    await this.options.saveTarget?.(runId, parsed.arguments.target, parsed.arguments.targetLiteral, parsed.arguments.directory)
    await this.options.savePresentation?.(runId, { notices: plan.notices, emptyScope: access.manifest.status === 'empty', target: [parsed.arguments.directory, parsed.arguments.target].filter(Boolean).join(' ') || undefined })
    for (const anchor of access.manifest.anchors) {
      const revision = anchor.side === 'working-copy' ? access.manifest.scope.revision.workingCopyDigest! : anchor.revision
      anchor.anchorKey = await this.store.registerAnchor(runId, { ...anchor, revision })
      anchor.revision = revision
    }
    const live = newLive({ access, plan, args: parsed.arguments, controller, done: Promise.resolve(), source })
    this.live.set(runId, live); this.known.add(runId)
    live.done = this.execute(runId, live)
    return { runId }
  }
  async wait(runId: string): Promise<ReportSnapshot> { await this.live.get(runId)?.done; return this.store.getSnapshot(runId) }
  async restore(runIds: string[]): Promise<void> { for (const id of runIds) { await this.store.getSnapshot(id); this.known.add(id) }; this.changed() }
  async snapshots(): Promise<{ sequence: number; reports: ReportSnapshot[] }> {
    return { sequence: this.sequence, reports: await Promise.all([...this.known].map(id => this.store.getSnapshot(id))) }
  }
  async cancel(runId: string): Promise<{ accepted: boolean }> {
    const pending = this.pending.get(runId)
    if (pending) { pending.controller.abort(); return { accepted: true } }
    const live = this.live.get(runId)
    if (!live || !['queued', 'active'].includes((await this.store.getSnapshot(runId)).run.progress.status)) return { accepted: false }
    live.controller.abort(); this.changed(); return { accepted: true }
  }
  private async execute(runId: string, live: LiveRun): Promise<void> {
    const { plan, access, controller } = live
    const budgetMs = this.options.maxDurationMs ?? reviewTimeBudgetMs(plan, patchBytes(access.manifest))
    const timer = setTimeout(() => { live.budgetExpired = true; controller.abort() }, budgetMs)
    try {
      await this.store.start(runId); this.changed()
      this.admit(controller.signal)
      for (const source of access.evidenceSources ?? []) await this.store.registerEvidenceSource(runId, source)
      if (access.manifest.status === 'empty') {
        await this.store.submitLedger(runId, crypto.randomUUID(), { operation: 'coverage', coverage: { angles: [], limitations: access.manifest.notices, complete: true } })
        await this.store.submitRecord(runId, crypto.randomUUID(), await this.store.expectedRecord(runId))
      } else {
        const tools = this.tools(runId, live, true)
        const blocks = composeReviewPrompt(plan, {
          run_summary: JSON.stringify({ runId, plan }), scope_manifest: JSON.stringify(scopeIndex(access.manifest)),
          trusted_guidance: access.trustedGuidance, capability_text: tools.map(t => t.name).join(', '),
          budget_text: JSON.stringify({ concurrency: plan.workerConcurrency, maxTurns: 32, maxDurationMs: budgetMs }),
          verification_contract: 'Runtime verification is a separate permission boundary; do not run tests during static review.',
        }, { repair: false, publication: false })
        if (plan.coordinatorWorkerRequired) await this.store.noteWorker(runId, 'started')
        let result: Awaited<ReturnType<ReviewModelRunner>>
        try {
          result = await this.runModel({ blocks, tools, signal: controller.signal, taskId: plan.coordinatorWorkerRequired ? `${runId}-worker` : runId,
            execution: plan.coordinatorWorkerRequired ? 'isolated' : plan.execution, reasoningLevel: plan.reasoningLevel,
            role: 'coordinator', observer: this.observer(live), onStop: () => controller.abort() })
        } finally { if (plan.coordinatorWorkerRequired) await this.store.noteWorker(runId, 'finished') }
        const end = timed(live, endOf(result))
        if (end.kind !== 'completed') { live.end = end; throw new ReviewGatewayError(endCode(end)) }
        if (plan.presentation !== 'panel') {
          try { await this.store.submitFinalJson(runId, crypto.randomUUID(), result.text) }
          catch {
            const { operation: _, ...expected } = await this.store.expectedRecord(runId)
            const corrected = await this.runModel({ blocks: [block('Correct only the JSON format/selection. Return candidates and coverage exactly from the provided retained ledger; do not rerun the review.', 'format-correction'), block(JSON.stringify(expected), 'retained-ledger')], tools: [], signal: controller.signal, taskId: `${runId}-format`, maxTurns: 1, role: 'format', observer: this.observer(live) })
            try { await this.store.submitFinalJson(runId, crypto.randomUUID(), corrected.text, 'exact') }
            catch {
              await this.store.submitLedger(runId, crypto.randomUUID(), { operation: 'coverage', coverage: { angles: [], limitations: ['invalid-response'], complete: false } })
              await this.store.submitRecord(runId, crypto.randomUUID(), await this.store.expectedRecord(runId))
            }
          }
        }
        if (plan.agentMode === 'parallel') {
          const snapshot = await this.store.getSnapshot(runId)
          const missing = plan.angles.filter(angle => !live.completedAngles.has(angle))
          const unverified = snapshot.diagnostics.map(diagnostic => diagnostic.id).filter(id => !live.verified.has(id) && !live.sweepIds.has(id))
          if (missing.length || plan.independentVerification && unverified.length || plan.sweep === 'independent' && !live.swept) {
            await this.store.submitLedger(runId, crypto.randomUUID(), { operation: 'coverage', coverage: { angles: [], limitations: ['independent-worker-coverage-incomplete'], complete: false } })
          }
        }
        if (!access.manifest.complete) await this.store.submitLedger(runId, crypto.randomUUID(), { operation: 'coverage', coverage: { angles: [], limitations: access.manifest.notices.concat('scope-incomplete'), complete: false } })
      }
      await this.store.setStage(runId, 'report'); this.changed()
      if (plan.notices.length || access.manifest.notices.length) await this.store.submitLedger(runId, crypto.randomUUID(), { operation: 'coverage',
        coverage: { angles: [], limitations: [...plan.notices.map(notice => notice.code), ...access.manifest.notices], complete: (await this.store.getSnapshot(runId)).coverage.complete } })
      if (live.args.fix && (await this.store.getSnapshot(runId)).retainedIds.length) {
        try { await this.repairActive(runId, live) }
        catch (error) { if (controller.signal.aborted) throw error }
      }
      if (controller.signal.aborted) throw new ReviewGatewayError('review-cancelled')
      if (live.args.comment && access.manifest.scope.kind === 'change-request') {
        try { await this.publishActive(runId, live) }
        catch (error) { if (controller.signal.aborted) throw error }
      }
      else if (live.args.comment) await this.store.submitLedger(runId, crypto.randomUUID(), { operation: 'coverage', coverage: { angles: [], limitations: ['publication-target-required'], complete: (await this.store.getSnapshot(runId)).coverage.complete } })
      if (shouldRunAutomaticVerification(plan, { permitted: this.options.automaticVerificationPermitted === true,
        adapterAvailable: !!this.options.verify, runtimeBehaviorChanged: access.manifest.files.some(f => !isTestOrFixturePath(f.path) && !/(?:^|\/)docs?\/|\.(?:md|txt)$/i.test(f.path)), alreadyVerified: await this.options.alreadyVerified?.(await this.store.getSnapshot(runId)) ?? false })) {
        await this.store.setStage(runId, 'verify')
        const snapshot = await this.store.getSnapshot(runId)
        this.admit(controller.signal)
        await this.options.verify!(snapshot, controller.signal, this.store)
      }
      this.admit(controller.signal)
      await this.store.finish(runId, 'finished')
    } catch (error) {
      const snapshot = await this.store.getSnapshot(runId)
      if (snapshot.run.progress.status === 'active') {
        const reason = live.budgetExpired ? 'review-budget-exhausted' : controller.signal.aborted ? 'review-cancelled' : error instanceof Error ? error.message : 'review-failed'
        await this.store.submitLedger(runId, crypto.randomUUID(), { operation: 'coverage', coverage: { angles: [], limitations: [reason], complete: false } })
        if (!snapshot.structured) await this.store.submitRecord(runId, crypto.randomUUID(), await this.store.expectedRecord(runId))
        await this.store.finish(runId, controller.signal.aborted && !live.budgetExpired ? 'cancelled' : 'partial')
      }
    } finally { clearTimeout(timer); this.changed() }
  }
  private async read(runId: string, live: LiveRun, input: Record<string, unknown>): Promise<unknown> {
    this.admit(live.controller.signal)
    const result = await live.access.read(input, live.plan, live.controller.signal)
    const revision = live.access.manifest.scope.revision.workingCopyDigest ?? live.access.manifest.scope.revision.head
    if (input.operation === 'context' && typeof input.path === 'string' && typeof result === 'string' && result.trim()) {
      await this.store.registerEvidenceSource(runId, { path: input.path, revision, excerpt: result })
    } else if (input.operation === 'search' && result && typeof result === 'object' && 'matches' in result && Array.isArray(result.matches)) {
      for (const match of result.matches) if (match && typeof match.path === 'string' && typeof match.text === 'string' && match.text.trim()) {
        await this.store.registerEvidenceSource(runId, { path: match.path, revision, excerpt: match.text })
      }
    }
    return result
  }
  private tools(runId: string, live: LiveRun, delegate: boolean): ToolContract[] {
    const pool = new ReviewWorkerPool(Math.min(4, live.plan.workerConcurrency))
    let launched = 0
    const launch = async (input: Record<string, unknown>) => {
      const capabilities = this.options.capabilities
      if (!capabilities.agentAvailable || !capabilities.agentPermitted || capabilities.remainingDepth <= 0) throw new ReviewGatewayError('agent-unavailable')
      const role = input.role
      if (!['finder', 'verifier', 'sweeper'].includes(String(role))) throw new ReviewGatewayError('invalid-worker-role')
      if (role === 'verifier' && !live.plan.independentVerification || role === 'sweeper' && live.plan.sweep !== 'independent') throw new ReviewGatewayError('worker-role-not-authorized')
      const angles = Array.isArray(input.angles) ? input.angles : []
      if (role === 'finder' && (!angles.length || angles.some(a => !live.plan.angles.includes(a as never)))) throw new ReviewGatewayError('invalid-worker-angles')
      if (++launched > 128) throw new ReviewGatewayError('review-task-budget')
      return pool.run(live.controller.signal, async () => {
        const taskId = crypto.randomUUID()
        const snapshot = await this.store.getSnapshot(runId)
        const candidate = snapshot.diagnostics.find(d => d.id === input.candidateId)
        if (role === 'verifier' && !candidate) throw new ReviewGatewayError('unknown-candidate')
        const index = JSON.stringify(scopeIndex(live.access.manifest))
        const promptBlocks = role === 'finder' ? composeFinderPrompt({ scope_manifest: index, review_material: reviewMaterial(live.access.manifest), trusted_guidance: live.access.trustedGuidance, assigned_angles: JSON.stringify(angles), candidatesPerAngle: live.plan.candidatesPerAngle })
          : role === 'verifier' ? composeVerifierPrompt({ scope_manifest: index, review_material: reviewMaterial(live.access.manifest, [candidate!.anchor.path]), candidate: JSON.stringify(candidate) })
          : composeSweeperPrompt({ scope_manifest: index, review_material: reviewMaterial(live.access.manifest), existing_findings: JSON.stringify(snapshot.diagnostics) })
        const blocks = [...promptBlocks, block(JSON.stringify(role === 'verifier' ? { type: 'object', properties: { ...REVIEW_ASSESSMENT_SCHEMA.properties, support: REVIEW_SUPPORT_SCHEMA, missingEvidence: { type: 'array', items: { type: 'string' } } }, required: ['disposition', 'reason', 'support'] } : REVIEW_RESULT_SCHEMA), 'required-json-schema')]
        await this.store.noteWorker(runId, 'started'); this.changed()
        try {
          const result = await this.runModel({ blocks, tools: this.tools(runId, live, false).filter(t => t.name === 'ReviewRead'), signal: live.controller.signal, taskId, maxTurns: 16,
            role: role as 'finder' | 'verifier' | 'sweeper', ...(role === 'verifier' ? { label: candidate!.claim.title } : role === 'finder' ? { angles: angles as string[] } : {}), observer: this.observer(live) })
          const end = timed(live, endOf(result))
          if (end.kind !== 'completed') throw new ReviewGatewayError(endCode(end))
          const value = JSON.parse(result.text)
          if (role === 'verifier') {
            const candidateId = String(input.candidateId)
            const finderTaskKey = live.finderTasks.get(candidateId)
            if (!finderTaskKey || live.verified.has(candidateId)) throw new ReviewGatewayError('verifier-assignment-not-authorized')
            await this.store.submitLedger(runId, taskId, { operation: 'assess', assessments: [{ candidateId, disposition: value.disposition, reason: value.reason, support: value.support }] })
            if (value.disposition !== 'unchecked') {
              const assessment = (await this.store.getSnapshot(runId)).assessments.filter(a => a.diagnosticId === candidateId).at(-1)!
              await this.store.noteIndependentVerification(runId, { ref: taskId, diagnosticId: candidateId, assessmentId: assessment.id, finderTaskKey, verifierTaskKey: taskId })
              live.verified.add(candidateId)
            }
          } else {
            if (!Array.isArray(value.candidates) || value.candidates.length > (role === 'sweeper' ? 8 : live.plan.candidatesPerAngle * angles.length)) throw new ReviewGatewayError('worker-candidate-limit')
            const assigned = role === 'sweeper' ? [...live.plan.angles] : angles as string[]
            const counts = new Map<string, number>()
            for (const candidate of value.candidates) {
              if (!assigned.includes(candidate.angle)) throw new ReviewGatewayError('worker-angle-not-assigned')
              const count = (counts.get(candidate.angle) ?? 0) + 1
              counts.set(candidate.angle, count)
              if (count > live.plan.candidatesPerAngle) throw new ReviewGatewayError('worker-angle-candidate-limit')
              if (candidate.assessment?.disposition === 'proven') candidate.assessment = { disposition: 'plausible', reason: candidate.assessment.reason }
            }
            const covered: string[] = value.coverage?.angles ?? []
            if (covered.some(angle => !assigned.includes(angle))) throw new ReviewGatewayError('worker-angle-not-assigned')
            for (let i = 0; i < value.candidates.length; i += 32) {
              const accepted = await this.store.submitLedger(runId, `${taskId}-${i}`, { operation: 'append-candidates', candidates: value.candidates.slice(i, i + 32) })
              for (const entry of accepted.accepted) {
                if (!live.finderTasks.has(entry.diagnosticId)) {
                  live.finderTasks.set(entry.diagnosticId, taskId)
                  if (role === 'sweeper') live.sweepIds.add(entry.diagnosticId)
                }
              }
            }
            await this.store.submitLedger(runId, `${taskId}-coverage`, { operation: 'coverage', coverage: { angles: covered, limitations: value.coverage?.limitations ?? [], complete: false } })
            if (role === 'finder') for (const angle of covered) live.completedAngles.add(angle)
            else live.swept = true
          }
          await this.store.noteWorker(runId, 'finished'); this.changed()
          return { taskId, result: value, ledger: await this.store.expectedRecord(runId) }
        } catch (error) { await this.store.noteWorker(runId, 'finished', angles as string[]); this.changed(); throw error }
      })
    }
    return createReviewTools({ runId, store: this.store, signal: live.controller.signal,
      read: input => this.read(runId, live, input), changed: this.changed,
      independentAssessments: live.plan.independentVerification,
      allowOutput: live.plan.presentation === 'panel', launch: delegate && live.plan.agentMode === 'parallel' ? launch : undefined })
  }
  private async actionGrant(runId: string, kind: 'repair' | 'publication', ids?: string[]): Promise<ReportGrant> {
    const snapshot = await this.store.getSnapshot(runId)
    const diagnosticIds = ids ?? snapshot.retainedIds
    const grant = { kind, workspaceKey: snapshot.run.scope.workspaceKey, headRevision: snapshot.run.scope.revision.head,
      diagnosticIds, paths: [...new Set(snapshot.diagnostics.filter(d => diagnosticIds.includes(d.id)).map(d => d.anchor.path))], expiresAt: Date.now() + 600_000 }
    return { ...grant, id: await this.store.grantAction(runId, grant) }
  }
  private async repairActive(runId: string, live: LiveRun, ids?: string[], followup = false): Promise<void> {
    const grant = await this.actionGrant(runId, 'repair', ids)
    const epoch = followup ? await this.store.beginActionPhase(runId, grant.id) : undefined
    try {
      if (!this.options.repairTools) throw new ReviewGatewayError('repair-unavailable')
      if (live.controller.signal.aborted) throw new ReviewGatewayError('review-cancelled')
      await this.store.setStage(runId, 'repair')
      const snapshot = await this.store.getSnapshot(runId)
      this.admit(live.controller.signal)
      const editTools = await this.options.repairTools(snapshot, grant, live.controller.signal, this.store, epoch)
      const tools = createReviewTools({ runId, store: this.store, signal: live.controller.signal, read: async input => {
        const material = await this.read(runId, live, input)
        if (input.operation !== 'context' || typeof input.path !== 'string' || typeof material !== 'string' || !material.trim()) return material
        const ref = crypto.randomUUID()
        await this.store.recordExecution(runId, { ref, kind: 'evidence', diagnosticIds: grant.diagnosticIds, paths: [input.path], succeeded: true,
          actionEpoch: epoch, evidence: [{ path: input.path, quote: material.slice(0, 4000), relevance: 'Fresh authorized context read during repair reassessment.' }] })
        return { content: material, executionRef: ref }
      }, changed: this.changed, allowOutput: live.plan.presentation === 'panel', actions: true, actionEpoch: epoch }).filter(t => t.name !== 'ReviewLedger')
      const result = await this.runModel({ blocks: [block('Repair only the selected saved diagnostics. Preserve concurrent user changes. Use actual execution references returned by edits in ReviewActionLog; do not claim tests, commits or remote updates.', 'authorized-repair'), block(JSON.stringify({ report: snapshot, diagnosticIds: grant.diagnosticIds }), 'saved-report')], tools: [...tools, ...editTools], signal: live.controller.signal, taskId: `${runId}-repair`,
        role: 'repair', observer: this.observer(live) })
      if (result.interrupted) throw new ReviewGatewayError('repair-interrupted')
      await this.store.reconcileObservedEdits(runId, grant.id, grant.diagnosticIds, epoch)
      const after = await this.store.getSnapshot(runId)
      for (const id of grant.diagnosticIds) if (!after.actions.some(a => a.kind === 'repair' && a.diagnosticIds.includes(id))) {
        await this.store.reconcile(runId, crypto.randomUUID(), { operation: 'reconcile', updates: [{ diagnosticId: id, observation: 'left-open', explanation: 'No completed repair was observed.', executionRefs: [] }] }, epoch)
      }
    } catch (error) {
      await this.store.reconcileObservedEdits(runId, grant.id, grant.diagnosticIds, epoch)
      const snapshot = await this.store.getSnapshot(runId)
      const unresolved = grant.diagnosticIds.filter(id => !snapshot.actions.some(action => action.kind === 'repair' && action.state === 'applied' && action.diagnosticIds.includes(id)))
      if (unresolved.length) await this.store.recordActionReceipt(runId, { kind: 'repair', state: 'blocked', diagnosticIds: unresolved,
        reason: error instanceof Error ? error.message : 'repair-unavailable', actionEpoch: epoch })
      throw error
    } finally { if (epoch) await this.store.endActionPhase(runId, epoch); this.changed() }
  }
  private async publishActive(runId: string, live: LiveRun): Promise<void> {
    await this.store.setStage(runId, 'publish')
    const grant = await this.actionGrant(runId, 'publication')
    try {
      if (!this.options.publish) throw new ReviewGatewayError('publication-unavailable')
      if (live.controller.signal.aborted) throw new ReviewGatewayError('review-cancelled')
      const snapshot = await this.store.getSnapshot(runId)
      this.admit(live.controller.signal)
      await this.options.publish(snapshot, grant.id, live.controller.signal, this.store)
    } catch (error) {
      await this.store.recordActionReceipt(runId, { kind: 'publication', state: 'blocked', diagnosticIds: grant.diagnosticIds, reason: error instanceof Error ? error.message : 'publication-failed' })
      throw error
    }
  }
  private async actionContext(runId: string, controller: AbortController): Promise<LiveRun> {
    this.admit(controller.signal)
    const existing = this.live.get(runId)
    if (existing) { await existing.done.catch(() => {}); this.admit(controller.signal); return existing }
    const snapshot = await this.store.getSnapshot(runId)
    const target = await this.options.loadTarget?.(runId)
    if (!target && snapshot.run.scope.kind !== 'workspace') throw new ReviewGatewayError('review-target-needs-selection')
    const args: ReviewArguments = { target, targetLiteral: await this.options.loadTargetLiteral?.(runId), directory: await this.options.loadDirectory?.(runId), level: snapshot.run.policy.level, fix: false, comment: false }
    const preferences = await this.options.preferences.load()
    let plan = resolveReviewPolicy({ arguments: args, source: 'model', preferences,
      canonicalModelId: this.options.modelId, capabilities: this.options.capabilities, output: snapshot.run.policy.presentation })
    this.admit(controller.signal)
    let access = await this.options.resolveScope(args, plan, controller.signal)
    this.admit(controller.signal)
    if (plan.skipTestsAndFixtures && onlyTestsSkipped(access.manifest)) {
      plan = resolveReviewPolicy({ arguments: args, source: 'model', preferences, canonicalModelId: this.options.modelId, capabilities: this.options.capabilities, output: snapshot.run.policy.presentation, testsOnly: true })
      access = await this.options.resolveScope(args, plan, controller.signal, { guidance: access.authorizedGuidance })
      this.admit(controller.signal)
    }
    if (access.manifest.scope.repository.projectKey !== snapshot.run.scope.repository.projectKey || access.manifest.scope.revision.head !== snapshot.run.scope.revision.head) throw new ReviewGatewayError('snapshot-changed')
    const live = newLive({ access, plan, args, controller, done: Promise.resolve(), source: 'model' })
    this.live.set(runId, live)
    return live
  }
  private async followup(runId: string, task: (live: LiveRun) => Promise<void>): Promise<void> {
    this.admit()
    if (this.actionsInFlight.has(runId)) throw new ReviewGatewayError('review-action-in-progress')
    this.actionsInFlight.add(runId)
    const operation = this.operation()
    try {
      const live = await this.actionContext(runId, operation.controller)
      this.admit(operation.controller.signal)
      live.controller = operation.controller
      live.budgetExpired = false
      live.done = task(live)
      await live.done
      this.admit()
    } finally { operation.release(); this.actionsInFlight.delete(runId); this.changed() }
  }
  async requestRepair(runId: string, ids: string[]): Promise<void> {
    await this.followup(runId, live => this.repairActive(runId, live, ids, true))
  }
  async requestVerification(runId: string): Promise<void> {
    this.admit()
    if (!this.options.verify) throw new ReviewGatewayError('verification-unavailable')
    await this.followup(runId, async live => {
      const snapshot = await this.store.getSnapshot(runId)
      const grantId = await this.store.grantAction(runId, { kind: 'verification', workspaceKey: snapshot.run.scope.workspaceKey,
        headRevision: snapshot.run.scope.revision.head, diagnosticIds: snapshot.retainedIds, expiresAt: Date.now() + 600_000 })
      const epoch = await this.store.beginActionPhase(runId, grantId)
      try {
        await this.store.setStage(runId, 'verify')
        this.admit(live.controller.signal)
        await this.options.verify!(snapshot, live.controller.signal, this.store, epoch, grantId)
      } finally { await this.store.endActionPhase(runId, epoch) }
    })
  }
  async requestPublication(runId: string, discussions = false): Promise<void> {
    await this.followup(runId, async live => {
      const grant = await this.actionGrant(runId, 'publication')
      const epoch = await this.store.beginActionPhase(runId, grant.id)
      try {
        await this.store.setStage(runId, 'publish')
        if (!this.options.publish) throw new ReviewGatewayError('publication-unavailable')
        const snapshot = await this.store.getSnapshot(runId)
        this.admit(live.controller.signal)
        await this.options.publish(snapshot, grant.id, live.controller.signal, this.store, discussions)
      } finally { await this.store.endActionPhase(runId, epoch) }
    })
  }
  async rerun(runId: string, presentation?: OutputMode): Promise<{ runId: string }> {
    this.admit()
    const snapshot = await this.store.getSnapshot(runId)
    const live = this.live.get(runId)
    const target = live?.args.target ?? await this.options.loadTarget?.(runId)
    if (!live && !target && snapshot.run.scope.kind !== 'workspace') throw new ReviewGatewayError('review-target-needs-selection')
    const directory = live?.args.directory ?? await this.options.loadDirectory?.(runId)
    if ([target, directory].some(value => value?.includes('"') && value.includes("'"))) throw new ReviewGatewayError('review-target-needs-selection')
    const quote = (value: string) => value.includes('"') ? `'${value}'` : `"${value}"`
    const literal = live?.args.targetLiteral ?? await this.options.loadTargetLiteral?.(runId)
    return this.start(`${snapshot.run.policy.level}${directory ? ` -C ${quote(directory)}` : ''}${target ? ` ${literal ? '-- ' : ''}${quote(target)}` : ''}`, 'user', undefined, presentation)
  }
}
