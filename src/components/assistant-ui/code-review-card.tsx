import { createContext, useContext, useEffect, useState, type FC, type ReactNode } from 'react'
import { useAssistantState } from '@assistant-ui/react'
import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { useT } from '@/browser/webview/i18n'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useRightPanelContent } from './right-panel-content-context'
import { useBackgroundTasksContext } from './background-tasks-context'
import { isReviewFileLocation, reviewTopic, type ReviewAction, type ReviewReportView, type ReviewSessionSnapshot } from '@/codeReview/review-protocol'
import type { Diagnostic, OutputMode, ReviewTaskView } from '@/codeReview/contracts'
import { reviewMessage, reviewDetailMessage, reviewAngleMessage, reviewValueMessage, reviewTaskRoleMessage, reviewTaskStatusMessage, reviewEndMessage } from '@/codeReview/messages'

/** The run's model tasks: role, label, status, last action, end reason and a jump to the drawer transcript. */
export const ReviewTaskTree: FC<{ tasks: ReviewTaskView[] }> = ({ tasks }) => {
  const t = useT()
  const { openTasksDrawer } = useBackgroundTasksContext()
  if (!tasks.length) return null
  return <details open data-testid="review-tasks"><summary className="cursor-pointer">{t('reviewCard.tasks')} · {tasks.length}</summary>
    <ul className="mt-1 space-y-1">{tasks.map(task => {
      const end = task.end ? reviewEndMessage(t, task.end) : undefined
      const detail = task.angles?.length ? task.angles.map(angle => reviewAngleMessage(t, angle)).join(', ') : task.label
      return <li key={task.key} data-testid="review-task" data-role={task.role} data-status={task.status} className={task.role === 'coordinator' ? 'text-xs' : 'ml-4 text-xs'}>
        <span className="font-medium">{reviewTaskRoleMessage(t, task.role)}</span>{detail && <> · {detail}</>} · <span aria-live="polite">{reviewTaskStatusMessage(t, task.status)}</span>
        {task.taskId && openTasksDrawer && <button type="button" className="ml-2 underline" data-testid="review-task-transcript" onClick={() => openTasksDrawer(task.taskId)}>{t('reviewCard.task.openTranscript')}</button>}
        {task.lastAction && <p className="truncate text-muted-foreground">{t('reviewCard.task.lastAction', { action: task.lastAction })}</p>}
        {end && <p className="text-muted-foreground">{end}</p>}
      </li>
    })}</ul>
  </details>
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

export const CodeReviewMessage: FC = () => {
  const runId = useAssistantState(state => state.message.metadata.custom?.reviewRunId)
  return typeof runId === 'string' ? <CodeReviewCard runId={runId} /> : null
}

export const CodeReviewCard: FC<{ runId: string }> = ({ runId }) => {
  const t = useT()
  const { connection, sessionId, readOnly } = useContext(ReviewConnectionContext)
  const [snapshot, setSnapshot] = useState<ReviewSessionSnapshot | null>(null)
  const [selectedRunId, setSelectedRunId] = useState(runId)
  const [conn, setConn] = useState<RuntimeConnection | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    setSnapshot(null)
    setConn(null)
    setUnavailable(!connection || !sessionId)
    if (!connection || !sessionId) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    connection().then(client => {
      if (disposed) return
      setConn(client)
      unsubscribe = client.subscribe<ReviewSessionSnapshot>(reviewTopic(sessionId), event => {
        const next = event.payload
        if (next.sessionId !== sessionId || !Array.isArray(next.reports)) return
        setSnapshot(previous => previous && previous.sequence > next.sequence ? previous : next)
      })
    }).catch(() => { if (!disposed) setUnavailable(true) })
    return () => { disposed = true; unsubscribe?.() }
  }, [connection, sessionId])
  const report = snapshot?.reports.find(item => item.run.id === selectedRunId)
  if (!report) return <Card className="my-2 p-4 text-sm" data-testid="code-review-card">{t(unavailable || snapshot ? 'reviewCard.unavailable' : 'reviewCard.loading')}</Card>
  const can = (action: ReviewAction) => !readOnly && !!report.permissions?.[action] && !!conn?.can('review', action)
  return <ReviewReportCard key={selectedRunId} report={report} can={can} onAction={async (action, extra = {}) => {
    if (!conn || !can(action)) throw new Error('Review action unavailable')
    const result = await conn.request<unknown>(`review.${action}`, { sessionId, runId: selectedRunId, ...extra })
    if (action === 'rerun' && result && typeof result === 'object' && 'runId' in result && typeof result.runId === 'string') setSelectedRunId(result.runId)
    return result
  }} />
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
  const active = run.progress.status === 'queued' || run.progress.status === 'active'
  const shown = report.diagnostics.slice(0, 32).filter(diagnostic =>
    (severity === 'all' || diagnostic.classification.impact === severity) &&
    (kind === 'all' || (kind === 'correctness' ? ['correctness', 'security'].includes(diagnostic.classification.kind) : !['correctness', 'security'].includes(diagnostic.classification.kind))) &&
    (state === 'all' || reviewFindingState(report, diagnostic.id) === state))
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
  const filter = (name: 'severity' | 'kind' | 'state', value: string, values: string[], change: (value: string) => void) => (
    <label className="flex items-center gap-1 text-xs">{t(`reviewCard.${name}`)}<select aria-label={t(`reviewCard.${name}`)} className="rounded border bg-background p-1" value={value} onChange={event => change(event.target.value)}>{values.map(item => <option key={item} value={item}>{enumText(item)}</option>)}</select></label>
  )
  const button = (label: 'cancel' | 'repair' | 'preview' | 'publish' | 'rerun' | 'verify', action: ReviewAction, handler: () => void, disabled = false): ReactNode => <Button type="button" variant="outline" size="sm" disabled={busy || !can(action) || disabled} onClick={handler} data-testid={`review-${label}`}>{t(`reviewCard.${label}`)}</Button>
  return <Card className="my-2 gap-3 p-4 text-sm" data-testid="code-review-card" data-status={run.progress.status}>
    <header className="flex items-start justify-between gap-2"><div><h3 className="font-medium">{t('reviewCard.title')}</h3><p>{report.targetLabel ?? run.scope.repository.projectKey}</p><p className="break-all text-xs text-muted-foreground">{run.scope.revision.base} → {run.scope.revision.head}</p></div><Button type="button" variant="ghost" size="sm" onClick={() => setCollapsed(value => !value)}>{t(collapsed ? 'reviewCard.expand' : 'reviewCard.collapse')}</Button></header>
    <p aria-live="polite">{enumText(run.progress.status)} · {enumText(run.progress.stage)}</p>
    {!collapsed && <>
      <p className="text-xs text-muted-foreground">{t('reviewCard.policy', { level: enumText(run.policy.level), recipe: enumText(run.policy.recipe), mode: enumText(run.policy.execution), cap: run.policy.reportLimit === 'unlimited' ? enumText('unlimited') : run.policy.reportLimit })}</p>
      <p className="text-xs">{t(run.scope.revision.workingCopyDigest ? 'reviewCard.workingCopy' : 'reviewCard.revisionOnly')}</p>
      <p className="text-xs">{t('reviewCard.workers', { started: run.progress.spawnedTasks, finished: report.finishedTasks ?? 0 })}</p>
      {report.tasks && <ReviewTaskTree tasks={report.tasks} />}
      {report.end && reviewEndMessage(t, report.end) && <p role="status" data-testid="review-end" className="text-xs">{reviewEndMessage(t, report.end)}</p>}
      <p>{t('reviewCard.count', { count: report.diagnostics.length, omitted: run.progress.omittedByLimit })}</p>
      {report.notices && <ul data-testid="review-notices">{report.notices.map((notice, index) => <li key={index}>{reviewMessage(t, notice)}</li>)}</ul>}
      <details><summary className="cursor-pointer">{t('reviewCard.coverage')}</summary><ul>{report.coverage.limitations.map((text, index) => <li key={index}>{reviewDetailMessage(t, text)}</li>)}</ul>{run.progress.unavailableAngles.length > 0 && <p>{t('reviewCard.uncovered', { angles: run.progress.unavailableAngles.map(angle => reviewAngleMessage(t, angle)).join(', ') })}</p>}</details>
      {report.diagnostics.length === 0 && <p data-testid="review-empty">{t(report.emptyScope ? 'reviewCard.emptyScope' : report.coverage.complete && run.progress.status === 'finished' ? 'reviewCard.emptyComplete' : 'reviewCard.emptyPartial')}</p>}
      <div className="flex flex-wrap gap-2">{filter('severity', severity, ['all', 'critical', 'major', 'minor'], setSeverity)}{filter('kind', kind, ['all', 'correctness', 'cleanup'], setKind)}{filter('state', state, ['all', 'open', 'applied', 'verified', 'skipped'], setState)}</div>
      <ul className="space-y-3">{shown.map(diagnostic => {
        const assessment = report.assessments.filter(item => item.diagnosticId === diagnostic.id).at(-1)
        const receipts = report.actions.filter(item => item.diagnosticIds.includes(diagnostic.id))
        const workingCopy = diagnostic.anchor.side === 'working-copy'
        const canLocate = workingCopy && !!report.permissions?.locate && can('locate') && !!openFile
        return <li key={diagnostic.id} data-testid="review-finding" className="rounded border p-3">
          <label className="flex items-start gap-2"><input type="checkbox" checked={selected.includes(diagnostic.id)} disabled={busy || !can('repair')} onChange={event => setSelected(ids => event.target.checked ? [...ids, diagnostic.id] : ids.filter(id => id !== diagnostic.id))} aria-label={t('reviewCard.select', { title: diagnostic.claim.title })} /><span>{enumText(diagnostic.classification.impact)} · {enumText(diagnostic.classification.kind)} · {diagnostic.claim.title}</span></label>
          <button type="button" className="my-1 text-xs underline disabled:no-underline" disabled={busy || !canLocate} onClick={() => locate(diagnostic)}>{diagnostic.anchor.path}{diagnostic.anchor.span ? `:${diagnostic.anchor.span.start}` : ''}</button>
          {!workingCopy && <p className="text-xs text-muted-foreground">{t('reviewCard.historical', { revision: diagnostic.anchor.revision })}</p>}
          <p className="text-xs">{enumText(assessment?.disposition ?? 'unchecked')} · {enumText(reviewFindingState(report, diagnostic.id))}</p>
          <details><summary className="cursor-pointer">{t('reviewCard.evidence')}</summary><p className="whitespace-pre-wrap">{diagnostic.claim.explanation}</p><p className="whitespace-pre-wrap">{diagnostic.claim.trigger}</p>{assessment && <p>{assessment.rationale}</p>}{report.evidence.filter(item => item.diagnosticId === diagnostic.id && item.runId === run.id).map(item => <blockquote key={item.id} className="my-2 border-l-2 pl-3"><pre className="overflow-auto whitespace-pre-wrap text-xs">{item.excerpt}</pre><p>{item.reason}</p></blockquote>)}</details>
          {receipts.map(receipt => <p className="mt-1 text-xs" key={receipt.id}>{enumText(receipt.kind)} · {enumText(receipt.state)}{receipt.verification && <> · {enumText(receipt.verification)}</>}{receipt.reason && <> · {reviewDetailMessage(t, receipt.reason)}</>}</p>)}
        </li>
      })}</ul>
      {(report.verifications ?? []).map(check => <details key={check.ref} data-testid="review-verification"><summary>{t('reviewCard.verify')} · {enumText(check.afterLatestEdit ? check.succeeded ? 'passed' : 'failed' : 'not-run')}</summary>{check.command && <pre className="whitespace-pre-wrap text-xs">{check.command}</pre>}{check.codeRevision && <p className="break-all text-xs">{check.codeRevision}</p>}{check.evidence.map((evidence, index) => <pre key={index} className="overflow-auto whitespace-pre-wrap text-xs">{evidence.quote}</pre>)}{check.missingCases.map((item, index) => <p key={index}>{reviewDetailMessage(t, item)}</p>)}</details>)}
      {run.scope.repository.platform === 'gitlab' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={discussions} disabled={busy || confirming || !can('publish')} onChange={event => setDiscussions(event.target.checked)} />{t('reviewCard.discussions')}</label>}
      {report.publicationPreview !== undefined && <details open><summary>{t('reviewCard.preview')}</summary><pre className="whitespace-pre-wrap text-xs">{report.publicationPreview}</pre></details>}
      {report.exportJson !== undefined && <details><summary>{t('reviewCard.exportJson')}</summary><pre data-testid="review-export-json" className="overflow-auto whitespace-pre-wrap text-xs">{report.exportJson}</pre></details>}
      <label className="flex items-center gap-2 text-xs">{t('reviewCard.outputMode')}<select aria-label={t('reviewCard.outputMode')} value={presentation} disabled={busy || active || !can('rerun')} onChange={event => { const value = event.target.value; if (value === 'terminal' || value === 'json' || value === 'panel') setPresentation(value) }} className="rounded border bg-background p-1">{(['terminal', 'json', 'panel'] as const).map(mode => <option key={mode} value={mode}>{t(`reviewCard.output.${mode}`)}</option>)}</select></label>
      <div className="flex flex-wrap gap-2">
        {button('cancel', 'cancel', () => act('cancel'), !active)}
        {button('repair', 'repair', () => act('repair', { diagnosticIds: selected.filter(id => report.diagnostics.some(item => item.id === id)) }), selected.length === 0)}
        {button('preview', 'publish', () => act('publish', { preview: true, confirmed: false, ...publicationOptions }))}
        {button('publish', 'publish', () => report.permissions?.publishConfirmation ? setConfirming(true) : act('publish', { preview: false, confirmed: false, ...publicationOptions }))}
        {button('rerun', 'rerun', () => act('rerun', { presentation }), active)}
        {button('verify', 'verify', () => act('verify'), active || !report.permissions?.verify)}
      </div>
      {confirming && <div role="group" aria-label={t('reviewCard.confirm')}><p>{t('reviewCard.confirm')}</p><Button type="button" disabled={busy || !can('publish')} onClick={() => { setConfirming(false); act('publish', { preview: false, confirmed: true, ...publicationOptions }) }}>{t('reviewCard.publish')}</Button><Button type="button" variant="ghost" onClick={() => setConfirming(false)}>{t('reviewCard.dismiss')}</Button></div>}
      {error && <p role="alert">{t('reviewCard.actionFailed')}</p>}
    </>}
  </Card>
}
