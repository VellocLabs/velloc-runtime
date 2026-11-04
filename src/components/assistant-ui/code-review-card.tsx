import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type FC, type ReactNode } from 'react'
import { useAssistantState } from '@assistant-ui/react'
import { CheckIcon, ChevronDownIcon, EllipsisIcon, Loader2Icon, SearchCheckIcon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { useT } from '@/browser/webview/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useRightPanelContent } from './right-panel-content-context'
import { useBackgroundTasksContext } from './background-tasks-context'
import { isReviewFileLocation, reviewTopic, type ReviewAction, type ReviewReportView, type ReviewSessionSnapshot } from '@/codeReview/review-protocol'
import type { Diagnostic, OutputMode, ReviewRun, ReviewTaskView } from '@/codeReview/contracts'
import { reviewMessage, reviewDetailMessage, reviewAngleMessage, reviewValueMessage, reviewTaskRoleMessage, reviewTaskStatusMessage, reviewEndMessage } from '@/codeReview/messages'

/** The run's model tasks: role, label, status, last action, end reason and a jump to the drawer transcript. */
export const ReviewTaskTree: FC<{ tasks: ReviewTaskView[] }> = ({ tasks }) => {
  const t = useT()
  const { openTasksDrawer } = useBackgroundTasksContext()
  if (!tasks.length) return null
  return <details open data-testid="review-tasks" className="text-xs">
    <summary className="cursor-pointer text-muted-foreground">{t('reviewCard.tasks')} · {tasks.length}</summary>
    <ul className="mt-1.5 space-y-1">{tasks.map(task => {
      const end = task.end ? reviewEndMessage(t, task.end) : undefined
      const detail = task.angles?.length ? task.angles.map(angle => reviewAngleMessage(t, angle)).join(', ') : task.label
      return <li key={task.key} data-testid="review-task" data-role={task.role} data-status={task.status} className={task.role === 'coordinator' ? '' : 'ml-4'}>
        <span className="font-medium">{reviewTaskRoleMessage(t, task.role)}</span>{detail && <> · {detail}</>} · <span aria-live="polite">{reviewTaskStatusMessage(t, task.status)}</span>
        {task.taskId && openTasksDrawer && <button type="button" className="ml-2 underline" data-testid="review-task-transcript" onClick={() => openTasksDrawer(task.taskId)}>{t('reviewCard.task.openTranscript')}</button>}
        {task.lastAction && <p className="truncate text-muted-foreground">{t('reviewCard.task.lastAction', { action: task.lastAction })}</p>}
        {end && <p className="text-muted-foreground">{end}</p>}
      </li>
    })}</ul>
  </details>
}

type SnapshotStore = { get(): ReviewSessionSnapshot | null; subscribe(listener: () => void): () => void }
const snapshotStores = new WeakMap<RuntimeConnection, Map<string, SnapshotStore>>()
const noSnapshotStore: SnapshotStore = { get: () => null, subscribe: () => () => {} }

/** One topic subscription per connection and session, shared by every card: the runtime sends a snapshot to the first subscriber only. */
function snapshotStoreFor(conn: RuntimeConnection, sessionId: string): SnapshotStore {
  let bySession = snapshotStores.get(conn)
  if (!bySession) snapshotStores.set(conn, bySession = new Map())
  const existing = bySession.get(sessionId)
  if (existing) return existing
  const sessions = bySession
  let snapshot: ReviewSessionSnapshot | null = null
  let unsubscribeTopic: (() => void) | undefined
  const listeners = new Set<() => void>()
  const store: SnapshotStore = {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribeTopic = conn.subscribe<ReviewSessionSnapshot>(reviewTopic(sessionId), event => {
          const next = event.payload
          if (next.sessionId !== sessionId || !Array.isArray(next.reports)) return
          if (snapshot && snapshot.sequence > next.sequence) return
          snapshot = next
          for (const notify of Array.from(listeners)) notify()
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        unsubscribeTopic?.()
        unsubscribeTopic = undefined
        sessions.delete(sessionId)
      }
    },
  }
  bySession.set(sessionId, store)
  return store
}

const ReviewConnectionContext = createContext<{ connection?: () => Promise<RuntimeConnection>; sessionId?: string; readOnly?: boolean }>({})
export const CodeReviewProvider = ReviewConnectionContext.Provider

type FindingState = 'open' | 'applied' | 'verified' | 'skipped'
export function reviewFindingState(report: ReviewReportView, id: string): FindingState {
  const receipt = report.actions.filter(action => action.kind === 'repair' && action.diagnosticIds.includes(id)).at(-1)
  if (receipt?.state === 'applied') return receipt.verification === 'passed' ? 'verified' : 'applied'
  return receipt?.state === 'skipped' || receipt?.state === 'unnecessary' ? 'skipped' : 'open'
}
export function currentReviewLocation(report: ReviewReportView, diagnostic: Diagnostic): boolean {
  return report.currentAnchors?.includes(diagnostic.id) === true && diagnostic.anchor.side === 'working-copy' && !/(^|[\\/])\.\.([\\/]|$)|[\x00-\x1f]/.test(diagnostic.anchor.path)
}

type Stage = ReviewRun['progress']['stage']
type Step = 'prepare' | 'inspect' | 'summarize'
const STEPS: Step[] = ['prepare', 'inspect', 'summarize']
const REVIEW_STAGES: Stage[] = ['scope', 'inspect', 'assess', 'sweep', 'report']
/** Which of the three visible steps a run stage belongs to; follow-up stages come after all of them. */
function stepOfStage(stage: Stage): number {
  return stage === 'scope' ? 0 : stage === 'report' ? 2 : REVIEW_STAGES.includes(stage) ? 1 : 3
}
/** A revision shown short; the full identity stays in the title. */
const shortRevision = (revision: string) => /^[0-9a-f]{12,}$/i.test(revision) ? revision.slice(0, 7) : revision

const IMPACT_VARIANT = { critical: 'destructive', major: 'warning', minor: 'muted' } as const
const STATUS_VARIANT = { queued: 'muted', active: 'info', finished: 'success', partial: 'warning', cancelled: 'muted', failed: 'destructive' } as const
const MENU_CONTENT_CLASS = 'z-50 min-w-[14rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md'
const MENU_ITEM_CLASS = 'flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start text-xs outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

export const CodeReviewMessage: FC = () => {
  const runId = useAssistantState(state => state.message.metadata.custom?.reviewRunId)
  return typeof runId === 'string' ? <CodeReviewRow runId={runId} /> : null
}

/** A review card as its own transcript row: held to the thread's text column like every other row. */
export const CodeReviewRow: FC<{ runId: string }> = ({ runId }) => (
  <div data-testid="code-review-row" className="mx-auto w-full max-w-(--thread-max-width) px-2">
    <CodeReviewCard runId={runId} />
  </div>
)

/**
 * Contract: shows the run named by `runId`, else the run a model's Skill call `toolCallId` started. While that call is
 * `starting` and its run is not listed yet, a preparing card stands in; a settled call with no run renders `fallback`.
 */
export const CodeReviewCard: FC<{ runId?: string; toolCallId?: string; starting?: boolean; fallback?: ReactNode }> = ({ runId, toolCallId, starting = false, fallback }) => {
  const t = useT()
  const { connection, sessionId, readOnly } = useContext(ReviewConnectionContext)
  const [rerunRunId, setRerunRunId] = useState<string | undefined>()
  const [conn, setConn] = useState<RuntimeConnection | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    setConn(null)
    setUnavailable(!connection || !sessionId)
    if (!connection || !sessionId) return
    let disposed = false
    connection().then(client => { if (!disposed) setConn(client) }).catch(() => { if (!disposed) setUnavailable(true) })
    return () => { disposed = true }
  }, [connection, sessionId])
  const store = conn && sessionId ? snapshotStoreFor(conn, sessionId) : noSnapshotStore
  const snapshot = useSyncExternalStore(store.subscribe, store.get, () => null)
  // The first sequence this card saw: a later one that still lists neither run nor preparing entry means no review is tracked for the call.
  const firstSequence = useRef<number | undefined>(undefined)
  if (snapshot && firstSequence.current === undefined) firstSequence.current = snapshot.sequence
  const selectedRunId = rerunRunId ?? runId ?? (toolCallId ? snapshot?.reports.filter(item => item.run.toolCallId === toolCallId).at(-1)?.run.id : undefined)
  const report = selectedRunId ? snapshot?.reports.find(item => item.run.id === selectedRunId) : undefined
  if (!report) {
    const preparing = toolCallId ? snapshot?.preparing?.find(entry => entry.toolCallId === toolCallId) : undefined
    const untracked = !!snapshot && firstSequence.current !== undefined && snapshot.sequence > firstSequence.current
    if (preparing || (starting && !runId && !(untracked && fallback !== undefined))) {
      const canCancel = !readOnly && !!preparing && !!conn?.can('review', 'cancel')
      return <ReviewPreparingCard canCancel={canCancel} onCancel={async () => {
        if (!conn || !preparing || !canCancel) throw new Error('Review action unavailable')
        await conn.request<unknown>('review.cancel', { sessionId, runId: preparing.id })
      }} />
    }
    if (fallback !== undefined && !runId && (unavailable || snapshot)) return <>{fallback}</>
    return <Card className="my-2 gap-0 p-4 text-sm text-muted-foreground" data-testid="code-review-card">{t(unavailable || snapshot ? 'reviewCard.unavailable' : 'reviewCard.loading')}</Card>
  }
  const can = (action: ReviewAction) => !readOnly && !!report.permissions?.[action] && !!conn?.can('review', action)
  return <ReviewReportCard key={selectedRunId} report={report} can={can} onAction={async (action, extra = {}) => {
    if (!conn || !can(action)) throw new Error('Review action unavailable')
    const result = await conn.request<unknown>(`review.${action}`, { sessionId, runId: selectedRunId, ...extra })
    if (action === 'rerun' && result && typeof result === 'object' && 'runId' in result && typeof result.runId === 'string') setRerunRunId(result.runId)
    return result
  }} />
}

/** Candidates found so far, counting those over the report limit and those dismissed, beside how many were verified. */
export function reviewProgressCounts(report: ReviewReportView): { found: number; verified: number } {
  const latest = new Map<string, string>()
  for (const assessment of report.assessments) latest.set(assessment.diagnosticId, assessment.disposition)
  const dismissed = [...latest.values()].filter(disposition => disposition === 'dismissed').length
  const found = report.diagnostics.length + report.run.progress.omittedByLimit + dismissed
  return { found, verified: Math.min(report.run.progress.verifiedCandidates, found) }
}

/** A model-requested review before its run exists: the scope is still being read; only cancel is offered. */
const ReviewPreparingCard: FC<{ canCancel: boolean; onCancel: () => Promise<void> }> = ({ canCancel, onCancel }) => {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  return <Card className="my-2 gap-0 overflow-hidden py-0 text-sm" data-testid="code-review-card" data-status="preparing">
    <header className="flex items-center gap-3 px-4 py-3">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><SearchCheckIcon className="size-4" /></span>
      <h3 className="min-w-0 flex-1 font-medium">{t('reviewCard.title')}</h3>
      <Badge variant="muted" size="sm" aria-live="polite" data-testid="review-status"><Loader2Icon aria-hidden className="animate-spin" />{reviewValueMessage(t, 'queued')}</Badge>
    </header>
    <div className="flex flex-col gap-3 border-t px-4 py-3">
      <div className="flex items-start gap-3">
        <Loader2Icon aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
        <div className="min-w-0">
          <p className="font-medium">{reviewValueMessage(t, 'scope')}</p>
          <p className="text-xs text-muted-foreground" data-testid="review-preparing">{t('reviewCard.preparing')}</p>
        </div>
      </div>
      <ReviewStages stage="scope" queued={false} />
    </div>
    <footer className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5">
      <span className="mr-auto text-xs text-muted-foreground">{reviewValueMessage(t, 'scope')}</span>
      <Button type="button" variant="outline" size="sm" disabled={busy || !canCancel} data-testid="review-cancel" onClick={() => {
        setBusy(true)
        setError(false)
        void onCancel().catch(() => { setError(true); setBusy(false) })
      }}>{t('reviewCard.cancel')}</Button>
    </footer>
    {error && <p role="alert" className="border-t px-4 py-2 text-xs text-destructive">{t('reviewCard.actionFailed')}</p>}
  </Card>
}

/** Three steps of a running review; a follow-up stage shows all three done. */
const ReviewStages: FC<{ stage: Stage; queued: boolean }> = ({ stage, queued }) => {
  const t = useT()
  const current = queued ? -1 : stepOfStage(stage)
  return <ol data-testid="review-stages" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs">
    {STEPS.map((step, index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'pending'
      return <li key={step} data-state={state} className="flex items-center gap-1.5">
        {index > 0 && <span aria-hidden className="mr-0.5 h-px w-6 bg-border" />}
        <span aria-hidden className={cn('flex size-4 items-center justify-center rounded-full border', state === 'done' && 'border-success/40 bg-success/15 text-success', state === 'current' && 'border-primary bg-primary text-primary-foreground', state === 'pending' && 'border-border text-transparent')}>
          {state === 'done' ? <CheckIcon className="size-2.5" /> : <span className="size-1.5 rounded-full bg-current" />}
        </span>
        <span className={cn(state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{t(`reviewCard.stage.${step}`)}</span>
      </li>
    })}
  </ol>
}

export const ReviewReportCard: FC<{
  report: ReviewReportView
  can: (action: ReviewAction) => boolean
  onAction: (action: ReviewAction, extra?: Record<string, unknown>) => Promise<unknown>
}> = ({ report, can, onAction }) => {
  const t = useT()
  const { openFile } = useRightPanelContent()
  const [severity, setSeverity] = useState('all')
  const [kind, setKind] = useState('all')
  const [state, setState] = useState('all')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [discussions, setDiscussions] = useState(false)
  const { run } = report
  const publicationOptions = run.scope.repository.platform === 'gitlab' ? { discussions } : {}
  const [presentation, setPresentation] = useState<OutputMode>(run.policy.presentation)
  const { status, stage } = run.progress
  const running = status === 'queued' || status === 'active'
  // The review itself is in flight: findings are not a result yet. A follow-up stage keeps them on screen.
  const reviewing = running && (status === 'queued' || REVIEW_STAGES.includes(stage))
  const finished = !running
  const shown = report.diagnostics.slice(0, 32).filter(diagnostic =>
    (severity === 'all' || diagnostic.classification.impact === severity) &&
    (kind === 'all' || (kind === 'correctness' ? ['correctness', 'security'].includes(diagnostic.classification.kind) : !['correctness', 'security'].includes(diagnostic.classification.kind))) &&
    (state === 'all' || reviewFindingState(report, diagnostic.id) === state))
  const selectedIds = selected.filter(id => report.diagnostics.some(item => item.id === id))
  const impactCounts = (['critical', 'major', 'minor'] as const).map(impact => [impact, report.diagnostics.filter(item => item.classification.impact === impact).length] as const).filter(([, count]) => count > 0)
  const act = (action: ReviewAction, extra?: Record<string, unknown>) => {
    if (busy || !can(action)) return
    setBusy(true)
    setError(false)
    void onAction(action, extra).catch(() => setError(true)).finally(() => setBusy(false))
  }
  const locate = (diagnostic: Diagnostic) => {
    if (busy || !openFile || !report.permissions?.locate || !can('locate') || diagnostic.anchor.side !== 'working-copy') return
    setBusy(true)
    setError(false)
    void onAction('locate', { diagnosticId: diagnostic.id }).then(location => {
      if (!isReviewFileLocation(location)) throw new Error('Invalid review location')
      openFile(location)
    }).catch(() => setError(true)).finally(() => setBusy(false))
  }
  const enumText = (value: string) => reviewValueMessage(t, value)
  const endMessage = report.end && reviewEndMessage(t, report.end)
  const filter = (name: 'severity' | 'kind' | 'state', value: string, values: string[], change: (value: string) => void) => (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">{t(`reviewCard.${name}`)}<select aria-label={t(`reviewCard.${name}`)} className="rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground" value={value} onChange={event => change(event.target.value)}>{values.map(item => <option key={item} value={item}>{enumText(item)}</option>)}</select></label>
  )
  const revision = `${run.scope.revision.base} → ${run.scope.revision.head}`
  const method = <>{enumText(run.policy.recipe)} · {t(run.scope.revision.workingCopyDigest ? 'reviewCard.workingCopy' : 'reviewCard.revisionOnly')}</>
  const openPublish = () => report.permissions?.publishConfirmation ? setConfirming(true) : act('publish', { preview: false, confirmed: false, ...publicationOptions })
  const menuItem = (label: 'preview' | 'publish' | 'verify', action: ReviewAction, handler: () => void, disabled = false): ReactNode => (
    <DropdownMenuPrimitive.Item data-testid={`review-${label}`} className={MENU_ITEM_CLASS} disabled={busy || !can(action) || disabled} onSelect={handler}>{t(`reviewCard.${label}`)}</DropdownMenuPrimitive.Item>
  )
  return <Card className="my-2 gap-0 overflow-hidden py-0 text-sm" data-testid="code-review-card" data-status={status}>
    <header className="flex items-center gap-3 px-4 py-3">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><SearchCheckIcon className="size-4" /></span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <h3 className="font-medium">{t('reviewCard.title')}</h3>
        <span className="truncate text-xs text-muted-foreground">{report.targetLabel ?? run.scope.repository.projectKey}</span>
        <Badge variant="muted" size="sm">{enumText(run.policy.level)}</Badge>
      </div>
      <Badge variant={STATUS_VARIANT[status]} size="sm" aria-live="polite" data-testid="review-status">
        {running && <Loader2Icon aria-hidden className="animate-spin" />}{enumText(status)}
      </Badge>
      <Button type="button" variant="ghost" size="icon-xs" aria-expanded={!collapsed} aria-label={t(collapsed ? 'reviewCard.expand' : 'reviewCard.collapse')} title={t(collapsed ? 'reviewCard.expand' : 'reviewCard.collapse')} onClick={() => setCollapsed(value => !value)}>
        <ChevronDownIcon aria-hidden className={cn('transition-transform', collapsed && '-rotate-90')} />
      </Button>
    </header>
    {!collapsed && <>
      <div className="flex flex-col gap-3 border-t px-4 py-3">
        {reviewing ? <>
          <div className="flex items-start gap-3">
            <Loader2Icon aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
            <div className="min-w-0">
              <p className="font-medium">{enumText(stage)}</p>
              <p className="text-xs text-muted-foreground">{t('reviewCard.inProgress')}</p>
            </div>
          </div>
          <ReviewStages stage={stage} queued={status === 'queued'} />
          {status === 'active' && <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="review-progress">{t('reviewCard.progressCounts', reviewProgressCounts(report))}</p>}
          <p className="text-xs text-muted-foreground">{method}</p>
        </> : <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-lg font-semibold leading-tight" data-testid="review-count">{report.diagnostics.length === 1 ? t('reviewCard.findingsOne') : t('reviewCard.findingsMany', { count: report.diagnostics.length })}</p>
            {impactCounts.map(([impact, count]) => <Badge key={impact} variant={IMPACT_VARIANT[impact]} size="sm">{enumText(impact)} · {count}</Badge>)}
            {run.progress.omittedByLimit > 0 && <span className="text-xs text-muted-foreground">{t('reviewCard.omitted', { omitted: run.progress.omittedByLimit })}</span>}
          </div>
          <p className="text-xs text-muted-foreground">{method}</p>
          {running && <p role="status" className="flex items-center gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-info"><Loader2Icon aria-hidden className="size-3.5 animate-spin" />{enumText(stage)}</p>}
        </>}
        {endMessage && <p role="status" data-testid="review-end" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-emphasis">{endMessage}</p>}
        {report.notices && report.notices.length > 0 && <ul data-testid="review-notices" className="space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{report.notices.map((notice, index) => <li key={index}>{reviewMessage(t, notice)}</li>)}</ul>}
        {finished && !report.coverage.complete && !report.emptyScope && report.diagnostics.length > 0 && <p data-testid="review-incomplete" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-emphasis">{t('reviewCard.notice.incomplete')}</p>}
        {!reviewing && report.diagnostics.length === 0 && <p data-testid="review-empty" className={cn('rounded-lg px-3 py-2 text-xs', report.emptyScope ? 'bg-muted/50 text-muted-foreground' : report.coverage.complete && status === 'finished' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning-emphasis')}>{t(report.emptyScope ? 'reviewCard.emptyScope' : report.coverage.complete && status === 'finished' ? 'reviewCard.emptyComplete' : 'reviewCard.emptyPartial')}</p>}
        {!reviewing && report.diagnostics.length > 0 && <>
          <div className="flex flex-wrap gap-3">{filter('severity', severity, ['all', 'critical', 'major', 'minor'], setSeverity)}{filter('kind', kind, ['all', 'correctness', 'cleanup'], setKind)}{filter('state', state, ['all', 'open', 'applied', 'verified', 'skipped'], setState)}</div>
          <ul className="space-y-2">{shown.map(diagnostic => {
            const assessment = report.assessments.filter(item => item.diagnosticId === diagnostic.id).at(-1)
            const receipts = report.actions.filter(item => item.diagnosticIds.includes(diagnostic.id))
            const workingCopy = diagnostic.anchor.side === 'working-copy'
            const canLocate = workingCopy && !!report.permissions?.locate && can('locate') && !!openFile
            const checked = selectedIds.includes(diagnostic.id)
            const findingState = reviewFindingState(report, diagnostic.id)
            return <li key={diagnostic.id} data-testid="review-finding" data-impact={diagnostic.classification.impact} className={cn('rounded-lg border p-3', checked ? 'border-primary/50 bg-primary/5' : 'bg-card')}>
              <div className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={checked} disabled={busy || !can('repair')} onChange={event => setSelected(ids => event.target.checked ? [...ids, diagnostic.id] : ids.filter(id => id !== diagnostic.id))} aria-label={t('reviewCard.select', { title: diagnostic.claim.title })} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant={IMPACT_VARIANT[diagnostic.classification.impact]} size="sm">{enumText(diagnostic.classification.impact)}</Badge>
                    <span className="text-xs text-muted-foreground">{enumText(diagnostic.classification.kind)}</span>
                    <button type="button" className="ml-auto max-w-full truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline disabled:no-underline disabled:opacity-60" disabled={busy || !canLocate} onClick={() => locate(diagnostic)}>{diagnostic.anchor.path}{diagnostic.anchor.span ? `:${diagnostic.anchor.span.start}` : ''}</button>
                  </div>
                  <p className="font-medium leading-snug">{diagnostic.claim.title}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{diagnostic.claim.explanation}</p>
                  {!workingCopy && <p className="text-xs text-muted-foreground">{t('reviewCard.historical', { revision: diagnostic.anchor.revision })}</p>}
                  <p className="text-xs text-muted-foreground">{enumText(assessment?.disposition ?? 'unchecked')} · <span className={cn(findingState !== 'open' && 'text-success')}>{enumText(findingState)}</span></p>
                  <details className="text-xs"><summary className="cursor-pointer text-primary">{t('reviewCard.evidence')}</summary>
                    <div className="mt-1 space-y-2">
                      <p className="whitespace-pre-wrap">{diagnostic.claim.explanation}</p>
                      <p className="whitespace-pre-wrap">{diagnostic.claim.trigger}</p>
                      {assessment && <p className="text-muted-foreground">{assessment.rationale}</p>}
                      {report.evidence.filter(item => item.diagnosticId === diagnostic.id && item.runId === run.id).map(item => <blockquote key={item.id} className="border-l-2 pl-3"><pre className="overflow-auto whitespace-pre-wrap">{item.excerpt}</pre><p className="text-muted-foreground">{item.reason}</p></blockquote>)}
                    </div>
                  </details>
                  {receipts.map(receipt => <p className="text-xs text-muted-foreground" key={receipt.id}>{enumText(receipt.kind)} · {enumText(receipt.state)}{receipt.verification && <> · {enumText(receipt.verification)}</>}{receipt.reason && <> · {reviewDetailMessage(t, receipt.reason)}</>}</p>)}
                </div>
              </div>
            </li>
          })}</ul>
        </>}
        {(report.verifications ?? []).map(check => <details key={check.ref} data-testid="review-verification" className="text-xs"><summary className="cursor-pointer">{t('reviewCard.verify')} · {enumText(check.afterLatestEdit ? check.succeeded ? 'passed' : 'failed' : 'not-run')}</summary>{check.command && <pre className="whitespace-pre-wrap">{check.command}</pre>}{check.codeRevision && <p className="break-all">{check.codeRevision}</p>}{check.evidence.map((evidence, index) => <pre key={index} className="overflow-auto whitespace-pre-wrap">{evidence.quote}</pre>)}{check.missingCases.map((item, index) => <p key={index}>{reviewDetailMessage(t, item)}</p>)}</details>)}
        {report.publicationPreview !== undefined && <details open className="text-xs"><summary className="cursor-pointer">{t('reviewCard.preview')}</summary><pre className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 p-2">{report.publicationPreview}</pre></details>}
        {report.tasks && <ReviewTaskTree tasks={report.tasks} />}
        <details data-testid="review-details" className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t('reviewCard.details')}</summary>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>{t('reviewCard.revision')}</dt><dd className="font-mono" title={revision}>{shortRevision(run.scope.revision.base)} → {shortRevision(run.scope.revision.head)}</dd>
            <dt>{t('reviewCard.policyLabel')}</dt><dd>{t('reviewCard.policy', { level: enumText(run.policy.level), recipe: enumText(run.policy.recipe), mode: enumText(run.policy.execution), cap: run.policy.reportLimit === 'unlimited' ? enumText('unlimited') : run.policy.reportLimit })}</dd>
            <dt>{t('reviewCard.coverage')}</dt><dd>
              {report.coverage.limitations.length === 0 && run.progress.unavailableAngles.length === 0 ? <span>{t(report.coverage.complete ? 'reviewCard.coverageComplete' : 'reviewCard.notice.incomplete')}</span> : <ul className="list-disc pl-4">{report.coverage.limitations.map((text, index) => <li key={index}>{reviewDetailMessage(t, text)}</li>)}{run.progress.unavailableAngles.length > 0 && <li>{t('reviewCard.uncovered', { angles: run.progress.unavailableAngles.map(angle => reviewAngleMessage(t, angle)).join(', ') })}</li>}</ul>}
            </dd>
          </dl>
          <p className="mt-1.5 text-muted-foreground">{t('reviewCard.workers', { started: run.progress.spawnedTasks, finished: report.finishedTasks ?? 0 })}</p>
          {report.exportJson !== undefined && <details className="mt-2"><summary className="cursor-pointer">{t('reviewCard.exportJson')}</summary><pre data-testid="review-export-json" className="mt-1 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2">{report.exportJson}</pre></details>}
        </details>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5">
        <span className="mr-auto text-xs text-muted-foreground">{running ? enumText(stage) : selectedIds.length > 0 ? t('reviewCard.selected', { count: selectedIds.length }) : enumText(status)}</span>
        {running ? <Button type="button" variant="outline" size="sm" disabled={busy || !can('cancel')} onClick={() => act('cancel')} data-testid="review-cancel">{t('reviewCard.cancel')}</Button> : <>
          <Button type="button" variant="outline" size="sm" disabled={busy || !can('rerun')} onClick={() => act('rerun', { presentation })} data-testid="review-rerun">{t('reviewCard.rerun')}</Button>
          <Button type="button" size="sm" disabled={busy || !can('repair') || selectedIds.length === 0} onClick={() => act('repair', { diagnosticIds: selectedIds })} data-testid="review-repair">{selectedIds.length > 0 ? t('reviewCard.repairCount', { count: selectedIds.length }) : t('reviewCard.repair')}</Button>
          <DropdownMenuPrimitive.Root>
            <DropdownMenuPrimitive.Trigger asChild>
              <Button type="button" variant="outline" size="icon-sm" aria-label={t('reviewCard.more')} title={t('reviewCard.more')} data-testid="review-more"><EllipsisIcon aria-hidden /></Button>
            </DropdownMenuPrimitive.Trigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS} data-testid="review-more-menu">
                {menuItem('preview', 'publish', () => act('publish', { preview: true, confirmed: false, ...publicationOptions }))}
                {menuItem('publish', 'publish', openPublish)}
                {run.scope.repository.platform === 'gitlab' && <DropdownMenuPrimitive.CheckboxItem className={MENU_ITEM_CLASS} checked={discussions} disabled={busy || confirming || !can('publish')} onCheckedChange={value => setDiscussions(value === true)} onSelect={event => event.preventDefault()} data-testid="review-discussions">
                  <span className="flex size-3.5 items-center justify-center"><DropdownMenuPrimitive.ItemIndicator><CheckIcon className="size-3.5" /></DropdownMenuPrimitive.ItemIndicator></span>{t('reviewCard.discussions')}
                </DropdownMenuPrimitive.CheckboxItem>}
                {menuItem('verify', 'verify', () => act('verify'), !report.permissions?.verify)}
                <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
                <DropdownMenuPrimitive.Label className="px-2 py-1 text-xs text-muted-foreground">{t('reviewCard.outputMode')}</DropdownMenuPrimitive.Label>
                <DropdownMenuPrimitive.RadioGroup value={presentation} onValueChange={value => { if (value === 'terminal' || value === 'json' || value === 'panel') setPresentation(value) }}>
                  {(['terminal', 'json', 'panel'] as const).map(mode => <DropdownMenuPrimitive.RadioItem key={mode} value={mode} className={MENU_ITEM_CLASS} disabled={busy || !can('rerun')} data-testid={`review-output-${mode}`}>
                    <span className="flex size-3.5 items-center justify-center"><DropdownMenuPrimitive.ItemIndicator><CheckIcon className="size-3.5" /></DropdownMenuPrimitive.ItemIndicator></span>{t(`reviewCard.output.${mode}`)}
                  </DropdownMenuPrimitive.RadioItem>)}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        </>}
      </footer>
      {confirming && <div role="group" aria-label={t('reviewCard.confirm')} className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5 text-xs"><p className="mr-auto">{t('reviewCard.confirm')}</p><Button type="button" size="sm" disabled={busy || !can('publish')} onClick={() => { setConfirming(false); act('publish', { preview: false, confirmed: true, ...publicationOptions }) }}>{t('reviewCard.publish')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t('reviewCard.dismiss')}</Button></div>}
      {error && <p role="alert" className="border-t px-4 py-2 text-xs text-destructive">{t('reviewCard.actionFailed')}</p>}
    </>}
  </Card>
}
