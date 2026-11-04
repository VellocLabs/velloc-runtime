import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type FC, type ReactNode } from 'react'
import { useAssistantState } from '@assistant-ui/react'
import { CheckIcon, ChevronDownIcon, CopyIcon, EllipsisIcon, Loader2Icon, SearchCheckIcon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { useT } from '@/browser/webview/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { writeClipboard } from '@/utils/clipboard'
import { useRightPanelContent } from './right-panel-content-context'
import { useBackgroundTasksContext } from './background-tasks-context'
import { isReviewFileLocation, reviewTopic, type ReviewAction, type ReviewReportView, type ReviewSessionSnapshot } from '@/codeReview/review-protocol'
import type { Diagnostic, OutputMode, ReviewRun, ReviewTaskView } from '@/codeReview/contracts'
import { reviewMessage, reviewDetailMessage, reviewAngleMessage, reviewValueMessage, reviewTaskRoleMessage, reviewTaskStatusMessage, reviewEndMessage } from '@/codeReview/messages'

type Translate = ReturnType<typeof useT>
/** A task's angles, else its label. */
const taskDetail = (t: Translate, task: ReviewTaskView) => task.angles?.length ? task.angles.map(angle => reviewAngleMessage(t, angle)).join(', ') : task.label

/** The run's model tasks: role, label, status, last action, end reason and a jump to the drawer transcript. */
export const ReviewTaskTree: FC<{ tasks: ReviewTaskView[]; open?: boolean }> = ({ tasks, open = true }) => {
  const t = useT()
  const { openTasksDrawer } = useBackgroundTasksContext()
  if (!tasks.length) return null
  return <details open={open} data-testid="review-tasks" className="text-xs">
    <summary className="cursor-pointer text-muted-foreground">{t('reviewCard.tasks')} · {open || tasks.some(task => task.status === 'running') ? tasks.length : <>
      {t('reviewCard.tasksCompleted', { count: tasks.filter(task => task.status === 'finished').length })}
      {tasks.some(task => task.status !== 'finished') && <> · {t('reviewCard.tasksNotCompleted', { count: tasks.filter(task => task.status !== 'finished').length })}</>}
    </>}</summary>
    <ul className="mt-1.5 space-y-1">{tasks.map(task => {
      const end = task.end ? reviewEndMessage(t, task.end) : undefined
      const detail = taskDetail(t, task)
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
/** A target label that names only revisions, which the range line already shows. */
const REVISION_ONLY_LABEL = /^\s*[0-9a-f]{7,}\s*(?:(?:\.\.\.?|→|->)\s*[0-9a-f]{7,}\s*)?$/i
/** The catalog value naming the card's state: a running review names its stage. */
export function reviewStatusValue(status: ReviewRun['progress']['status'], stage: Stage): string {
  return status === 'active' ? stage : status
}

/** The repository's name: its remote name, else the change request's project, else the reviewed directory's name. */
export function reviewRepositoryName(scope: ReviewRun['scope']): string {
  if (scope.repository.name) return scope.repository.name
  const key = scope.repository.platform ? scope.repository.projectKey : scope.workspaceKey
  return key.split(/[\\/]/).filter(Boolean).at(-1) ?? key
}

/** The repository and the revision pair shown short; hover or focus shows the pair in full, and the button copies it in full. */
const ReviewRange: FC<{ repository: string; base: string; head: string; target?: string }> = ({ repository, base, head, target }) => {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const full = `${base} → ${head}`
  const extra = target && !REVISION_ONLY_LABEL.test(target) ? target : undefined
  return <div data-testid="review-range" className="relative z-10 flex min-w-0 max-w-full items-center gap-1 self-start text-xs text-muted-foreground">
    <span data-testid="review-repository" className="min-w-0 max-w-[40%] shrink truncate font-medium text-foreground/80" title={repository}>{repository}</span>
    <span aria-hidden>·</span>
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-testid="review-range-short" className="shrink-0 rounded-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring">{shortRevision(base)} → {shortRevision(head)}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-none font-mono">{full}</TooltipContent>
    </Tooltip>
    <button type="button" data-testid="review-range-copy" aria-label={t(copied ? 'messageMenu.copied' : 'reviewCard.copyRange')} title={t(copied ? 'messageMenu.copied' : 'reviewCard.copyRange')}
      className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={event => {
        event.stopPropagation()
        void writeClipboard(full).then(ok => {
          if (!ok) return
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1500)
        })
      }}>{copied ? <CheckIcon aria-hidden className="size-3.5 text-success" /> : <CopyIcon aria-hidden className="size-3.5" />}</button>
    {extra && <span className="min-w-0 truncate" title={extra}>· {extra}</span>}
  </div>
}

/**
 * The header both card states share: title and level on one line, the range under them, one status badge. With
 * `onToggle`, the whole row is one toggle button; the range's own controls sit above it.
 */
const ReviewCardHeader: FC<{
  level?: string
  range?: { repository: string; base: string; head: string; target?: string }
  status: string
  variant: (typeof STATUS_VARIANT)[keyof typeof STATUS_VARIANT]
  running: boolean
  collapsed?: boolean
  bodyId?: string
  onToggle?: () => void
}> = ({ level, range, status, variant, running, collapsed = false, bodyId, onToggle }) => {
  const t = useT()
  return <header className="relative flex items-start gap-3 px-4 py-3">
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><SearchCheckIcon className="size-4" /></span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div data-testid="review-heading" className="flex min-h-8 min-w-0 items-center gap-2">
        <h3 className="truncate font-medium">{t('reviewCard.title')}</h3>
        {level && <span data-testid="review-level" className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{level}</span>}
      </div>
      {range && <ReviewRange {...range} />}
    </div>
    <div className="flex h-8 shrink-0 items-center gap-1">
      <Badge variant={variant} size="sm" aria-live="polite" data-testid="review-status">
        {running && <Loader2Icon aria-hidden className="animate-spin" />}{status}
      </Badge>
      {onToggle && <button type="button" data-testid="review-toggle" aria-expanded={!collapsed} aria-controls={bodyId} aria-label={t(collapsed ? 'reviewCard.expand' : 'reviewCard.collapse')} title={t(collapsed ? 'reviewCard.expand' : 'reviewCard.collapse')} onClick={onToggle}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none after:absolute after:inset-0 after:content-[''] hover:text-foreground focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring">
        <ChevronDownIcon aria-hidden className={cn('size-4 transition-transform', collapsed && '-rotate-90')} />
      </button>}
    </div>
  </header>
}

/** What the review is doing now: the most recently active running task and how many tasks have ended; the full tree folds away. */
const ReviewActivity: FC<{ tasks: ReviewTaskView[] }> = ({ tasks }) => {
  const t = useT()
  const running = tasks.filter(task => task.status === 'running')
  const current = running.reduce<ReviewTaskView | undefined>((latest, task) => !latest || task.lastActivityAt >= latest.lastActivityAt ? task : latest, undefined)
  const detail = current && taskDetail(t, current)
  return <div data-testid="review-activity" className="space-y-1.5 text-xs">
    {current && <div data-testid="review-current-task" className="min-w-0">
      <p><span className="sr-only">{t('reviewCard.currentTask')} </span><span className="font-medium">{reviewTaskRoleMessage(t, current.role)}</span>{detail && <> · {detail}</>}</p>
      {current.lastAction && <p className="truncate text-muted-foreground" title={current.lastAction}>{t('reviewCard.task.lastAction', { action: current.lastAction })}</p>}
    </div>}
    <p data-testid="review-task-counts" className="text-muted-foreground">{t('reviewCard.tasksDone', { finished: tasks.length - running.length, running: running.length })}</p>
    <ReviewTaskTree tasks={tasks} open={false} />
  </div>
}

/** A ghost cancel at the bottom of a running card's body. */
const ReviewCancel: FC<{ disabled: boolean; onClick: () => void }> = ({ disabled, onClick }) => {
  const t = useT()
  return <div className="flex justify-end">
    <Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" disabled={disabled} data-testid="review-cancel" onClick={onClick}>{t('reviewCard.cancel')}</Button>
  </div>
}

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
    <ReviewCardHeader status={reviewValueMessage(t, 'scope')} variant="muted" running />
    <div className="flex flex-col gap-3 border-t px-4 py-3">
      <ReviewStages stage="scope" queued={false} />
      <p className="text-xs text-muted-foreground" data-testid="review-preparing">{t('reviewCard.preparing')}</p>
      <ReviewCancel disabled={busy || !canCancel} onClick={() => {
        setBusy(true)
        setError(false)
        void onCancel().catch(() => { setError(true); setBusy(false) })
      }} />
    </div>
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
  const bodyId = useId()
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
  const method = <>{enumText(run.policy.recipe)} · {t(run.scope.revision.workingCopyDigest ? 'reviewCard.workingCopy' : 'reviewCard.revisionOnly')}</>
  const openPublish = () => report.permissions?.publishConfirmation ? setConfirming(true) : act('publish', { preview: false, confirmed: false, ...publicationOptions })
  const menuItem = (label: 'preview' | 'publish' | 'verify', action: ReviewAction, handler: () => void, disabled = false): ReactNode => (
    <DropdownMenuPrimitive.Item data-testid={`review-${label}`} className={MENU_ITEM_CLASS} disabled={busy || !can(action) || disabled} onSelect={handler}>{t(`reviewCard.${label}`)}</DropdownMenuPrimitive.Item>
  )
  const progress = reviewProgressCounts(report)
  const notices = report.notices && report.notices.length > 0 ? <ul data-testid="review-notices" className="space-y-1">{report.notices.map((notice, index) => <li key={index}>{reviewMessage(t, notice)}</li>)}</ul> : null
  const target = report.targetLabel !== undefined && report.targetLabel !== run.scope.repository.projectKey && report.targetLabel !== run.scope.workspaceKey ? report.targetLabel : undefined
  return <TooltipProvider><Card className="my-2 gap-0 overflow-hidden py-0 text-sm" data-testid="code-review-card" data-status={status}>
    <ReviewCardHeader level={enumText(run.policy.level)} range={{ repository: reviewRepositoryName(run.scope), base: run.scope.revision.base, head: run.scope.revision.head, target }}
      status={enumText(reviewStatusValue(status, stage))} variant={STATUS_VARIANT[status]} running={running} collapsed={collapsed} bodyId={bodyId} onToggle={() => setCollapsed(value => !value)} />
    {!collapsed && <div id={bodyId}>
      <div className="flex flex-col gap-3 border-t px-4 py-3">
        {reviewing ? <>
          <ReviewStages stage={stage} queued={status === 'queued'} />
          {report.tasks && report.tasks.length > 0 && <ReviewActivity tasks={report.tasks} />}
          {status === 'active' && <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="review-progress">{progress.found === 0 ? t('reviewCard.progressNone') : t('reviewCard.progressFound', progress)}</p>}
        </> : <>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-semibold leading-tight" data-testid="review-count">{report.diagnostics.length === 1 ? t('reviewCard.findingsOne') : t('reviewCard.findingsMany', { count: report.diagnostics.length })}</p>
              {impactCounts.map(([impact, count]) => <Badge key={impact} variant={IMPACT_VARIANT[impact]} size="sm">{enumText(impact)} · {count}</Badge>)}
              {run.progress.omittedByLimit > 0 && <span className="text-xs text-muted-foreground">{t('reviewCard.omitted', { omitted: run.progress.omittedByLimit })}</span>}
            </div>
            {report.diagnostics.length === 0 && <p data-testid="review-empty" className={cn('text-xs', report.emptyScope || (report.coverage.complete && status === 'finished') ? 'text-muted-foreground' : 'text-warning-emphasis')}>{t(report.emptyScope ? 'reviewCard.emptyScope' : report.coverage.complete && status === 'finished' ? 'reviewCard.emptyComplete' : 'reviewCard.emptyPartial')}</p>}
          </div>
          <div data-testid="review-scope" className="space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <p data-testid="review-method">{method}</p>
            {notices}
          </div>
        </>}
        {endMessage && <p role="status" data-testid="review-end" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-emphasis">{endMessage}</p>}
        {reviewing && notices && <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{notices}</div>}
        {finished && !report.coverage.complete && !report.emptyScope && report.diagnostics.length > 0 && <p data-testid="review-incomplete" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-emphasis">{t('reviewCard.notice.incomplete')}</p>}
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
        {!reviewing && (report.unverified?.length ?? 0) > 0 && <details data-testid="review-unverified" className="rounded-lg border border-dashed px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t('reviewCard.unverified')} · {report.unverified!.length}</summary>
          <p className="mt-1 text-muted-foreground">{t('reviewCard.unverifiedNote')}</p>
          <ul className="mt-2 space-y-2">{report.unverified!.map(item => <li key={item.id} data-testid="review-unverified-item" className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2">
              {item.impact && <Badge variant={IMPACT_VARIANT[item.impact]} size="sm">{enumText(item.impact)}</Badge>}
              <p className="font-medium leading-snug">{item.headline}</p>
              {item.path && <span className="ml-auto max-w-full truncate font-mono text-muted-foreground">{item.path}{item.line ? `:${item.line}` : ''}</span>}
            </div>
            {item.details && <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{item.details}</p>}
          </li>)}</ul>
        </details>}
        {(report.verifications ?? []).map(check => <details key={check.ref} data-testid="review-verification" className="text-xs"><summary className="cursor-pointer">{t('reviewCard.verify')} · {enumText(check.afterLatestEdit ? check.succeeded ? 'passed' : 'failed' : 'not-run')}</summary>{check.command && <pre className="whitespace-pre-wrap">{check.command}</pre>}{check.codeRevision && <p className="break-all">{check.codeRevision}</p>}{check.evidence.map((evidence, index) => <pre key={index} className="overflow-auto whitespace-pre-wrap">{evidence.quote}</pre>)}{check.missingCases.map((item, index) => <p key={index}>{reviewDetailMessage(t, item)}</p>)}</details>)}
        {report.publicationPreview !== undefined && <details open className="text-xs"><summary className="cursor-pointer">{t('reviewCard.preview')}</summary><pre className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 p-2">{report.publicationPreview}</pre></details>}
        {!reviewing && report.tasks && <ReviewTaskTree tasks={report.tasks} open={false} />}
        <details data-testid="review-details" className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t('reviewCard.details')}</summary>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            {reviewing && <><dt>{t('reviewCard.method')}</dt><dd data-testid="review-method">{method}</dd></>}
            <dt>{t('reviewCard.policyLabel')}</dt><dd>{t('reviewCard.policy', { level: enumText(run.policy.level), recipe: enumText(run.policy.recipe), mode: enumText(run.policy.execution), cap: run.policy.reportLimit === 'unlimited' ? enumText('unlimited') : run.policy.reportLimit })}</dd>
            <dt>{t('reviewCard.coverage')}</dt><dd>
              {report.coverage.limitations.length === 0 && run.progress.unavailableAngles.length === 0 ? <span>{t(report.coverage.complete ? 'reviewCard.coverageComplete' : 'reviewCard.notice.incomplete')}</span> : <ul className="list-disc pl-4">{report.coverage.limitations.map((text, index) => <li key={index}>{reviewDetailMessage(t, text)}</li>)}{run.progress.unavailableAngles.length > 0 && <li>{t('reviewCard.uncovered', { angles: run.progress.unavailableAngles.map(angle => reviewAngleMessage(t, angle)).join(', ') })}</li>}</ul>}
            </dd>
          </dl>
          <p className="mt-1.5 text-muted-foreground">{t('reviewCard.workers', { started: run.progress.spawnedTasks, finished: report.finishedTasks ?? 0 })}</p>
          {report.exportJson !== undefined && <details className="mt-2"><summary className="cursor-pointer">{t('reviewCard.exportJson')}</summary><pre data-testid="review-export-json" className="mt-1 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2">{report.exportJson}</pre></details>}
        </details>
        {running && <ReviewCancel disabled={busy || !can('cancel')} onClick={() => act('cancel')} />}
      </div>
      {!running && <footer className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5">
        <span className="mr-auto text-xs text-muted-foreground">{selectedIds.length > 0 && t('reviewCard.selected', { count: selectedIds.length })}</span>
          <Button type="button" variant="outline" size="sm" disabled={busy || !can('rerun')} onClick={() => act('rerun', { presentation })} data-testid="review-rerun">{t('reviewCard.rerun')}</Button>
          {report.diagnostics.length > 0 && <Button type="button" size="sm" disabled={busy || !can('repair') || selectedIds.length === 0} onClick={() => act('repair', { diagnosticIds: selectedIds })} data-testid="review-repair">{selectedIds.length > 0 ? t('reviewCard.repairCount', { count: selectedIds.length }) : t('reviewCard.repair')}</Button>}
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
      </footer>}
      {confirming && <div role="group" aria-label={t('reviewCard.confirm')} className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5 text-xs"><p className="mr-auto">{t('reviewCard.confirm')}</p><Button type="button" size="sm" disabled={busy || !can('publish')} onClick={() => { setConfirming(false); act('publish', { preview: false, confirmed: true, ...publicationOptions }) }}>{t('reviewCard.publish')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t('reviewCard.dismiss')}</Button></div>}
      {error && <p role="alert" className="border-t px-4 py-2 text-xs text-destructive">{t('reviewCard.actionFailed')}</p>}
    </div>}
  </Card></TooltipProvider>
}
