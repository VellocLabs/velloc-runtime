/**
 * Background Tasks drawer: a LIST of background sub-agents grouped by launching session,
 * and a read-only DETAIL transcript. Controls post `task.stop` / `task.resume`; rows change
 * only on the next broadcast, never optimistically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import {
  ArrowLeftIcon,
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  GitForkIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { InkRipple } from '@/components/assistant-ui/ink-ripple'
import { Button } from '@/components/ui/button'
import { durationLabel } from '../../utils/humanize/durationLabel'
import type {
  NexusRunJsInvokeParams,
  NexusShellInvokeParams,
  NexusTaskDetail,
  NexusTaskInfo,
  NexusTaskSummaryRow,
  NexusTaskTranscriptEntry,
} from '../bridge/protocol/ui'
import {
  SUB_AGENT_CATEGORY_DEFAULT_EXPANDED,
  SUB_AGENT_CATEGORY_ICON,
  SUB_AGENT_CATEGORY_LABEL_KEY,
  SUB_AGENT_STATUS_LABEL_KEY,
  groupSubAgentsByCategory,
  taskRowLabelKey,
  type SubAgentCategory,
} from './backgroundSubAgents'
import { useT } from "./i18n";
import { useSessionAreaVisible } from './sessionAreaVisibility'

/** Static icon + tint for each TERMINAL status. A `running` task instead shows
 *  the ink-drop ripple busy indicator (see `StatusIcon`). */
const TERMINAL_STATUS_META: Record<
  Exclude<NexusTaskSummaryRow['status'], 'running'>,
  { Icon: LucideIcon; cls: string }
> = {
  success: { Icon: CheckIcon, cls: 'text-success' },
  error: { Icon: XIcon, cls: 'text-destructive' },
  stopped: { Icon: SquareIcon, cls: 'text-muted-foreground' },
}

/** Row status glyph: a RUNNING task shows the ink-drop ripple — the same
 *  busy indicator as the session list's running rows + the composer-footer
 *  control, so every "still working" cue across the app is one animation. It
 *  keeps animating regardless of the OS reduce-motion preference (the ripple's
 *  reduced-motion exemption in globals.css, a functional indicator). A terminal
 *  task shows a static icon. The ripple is 14px (`size-3.5`), sharing the
 *  terminal icons' footprint so rows stay aligned. */
function StatusIcon({
  status,
}: {
  status: NexusTaskSummaryRow['status']
}): ReactElement {
  if (status === 'running') {
    return (
      <InkRipple
        title="running"
        data-testid="subagent-status-running"
        className="shrink-0 text-primary"
      />
    )
  }
  const { Icon, cls } = TERMINAL_STATUS_META[status]
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', cls)} />
}

/** Read-only invoke parameters for a background shell (`local_bash`). A backgrounded
 *  command runs unbounded; only a leading `sleep` on the forced path keeps its timeout.
 *  Renders nothing when no parameter is known. */
function ShellParamsBlock({
  params,
}: {
  params: NexusShellInvokeParams
}): ReactElement | null {
  const t = useT()
  const rows: Array<{ label: string; value: string; mono?: boolean }> = []
  if (params.unbounded) {
    rows.push({
      label: t('backgroundTasks.timeoutLabel'),
      value: t('backgroundTasks.timeoutUnbounded'),
    })
  } else if (typeof params.timeoutMs === 'number') {
    rows.push({
      label: t('backgroundTasks.timeoutLabel'),
      value: t('backgroundTasks.timeoutHostKill', {
        duration: durationLabel(params.timeoutMs, 'largest'),
      }),
    })
  }
  if (params.backgroundMode) {
    rows.push({
      label: t('backgroundTasks.backgroundLabel'),
      value:
        params.backgroundMode === 'auto'
          ? t('backgroundTasks.backgroundAuto')
          // A literal flag name the user passes to the tool — protocol.
          : 'run_in_background',
    })
  }
  if (params.cwd) {
    rows.push({
      label: t('backgroundTasks.workingDir'),
      value: params.cwd,
      mono: true,
    })
  }
  if (params.description) {
    rows.push({
      label: t('backgroundTasks.descriptionLabel'),
      value: params.description,
    })
  }
  if (rows.length === 0) return null
  return (
    <div data-testid="background-tasks-detail-params">
      <p className="mb-0.5 font-semibold">
        {t('backgroundTasks.paramsHeader')}
      </p>
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <div key={r.label}>
            <span className="font-medium text-muted-foreground">
              {r.label}:{' '}
            </span>
            <span
              className={cn(
                'break-words text-foreground/90',
                r.mono && 'font-mono text-[11px]',
              )}
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The `run_js` invoke parameters, shown read-only as the FIRST of the three
 *  detail parts (input parameters). The JS SOURCE is deliberately elided here as
 *  "…" — it gets its own formatted block below (`RunJsSourceBlock`) so the
 *  parameters stay a compact overview. Renders nothing when nothing is known. */
function RunJsParamsBlock({
  params,
}: {
  params: NexusRunJsInvokeParams
}): ReactElement | null {
  const t = useT()
  const rows: Array<{ label: string; value: string; mono?: boolean }> = []
  if (params.path) {
    rows.push({
      label: t('backgroundTasks.sourceLabel'),
      value: params.path,
      mono: true,
    })
  } else if (params.inlineCode) {
    // The inline script itself is elided as "…" — the formatted source block
    // below carries it in full.
    rows.push({ label: t('backgroundTasks.sourceLabel'), value: '…' })
  }
  if (typeof params.timeoutSec === 'number') {
    rows.push({
      label: t('backgroundTasks.timeoutLabel'),
      value: `${params.timeoutSec}s`,
    })
  }
  if (params.description) {
    rows.push({
      label: t('backgroundTasks.descriptionLabel'),
      value: params.description,
    })
  }
  // The run's `inputs` data values — the content a generic script writes.
  // Rendered as a formatted block of its own (values are often multiline file
  // content), so the code/data split never makes a mutation unreviewable.
  const hasInputs = params.inputs && Object.keys(params.inputs).length > 0
  let inputsJson = ''
  if (hasInputs) {
    try {
      inputsJson = JSON.stringify(params.inputs, null, 2)
    } catch {
      inputsJson = String(params.inputs)
    }
  }
  if (rows.length === 0 && !hasInputs) return null
  return (
    <div data-testid="background-tasks-detail-runjs-params">
      <p className="mb-0.5 font-semibold">
        {t('backgroundTasks.paramsHeader')}
      </p>
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <div key={r.label}>
            <span className="font-medium text-muted-foreground">
              {r.label}:{' '}
            </span>
            <span
              className={cn(
                'break-words text-foreground/90',
                r.mono && 'font-mono text-[11px]',
              )}
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>
      {hasInputs ? (
        <div
          data-testid="background-tasks-detail-runjs-inputs"
          className="mt-1 flex flex-col"
        >
          <p className="mb-0.5 font-semibold">
            {t('backgroundTasks.jsInputsHeader')}
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background/60 p-1.5 font-mono text-[11px] leading-4 text-foreground/90">
            {inputsJson}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

/** Compact single-unit elapsed string, e.g. "5s" / "2m" / "1h" — the shared
 *  `durationLabel` (clamped so clock skew can't show a negative age). */
function formatAge(ms: number): string {
  return durationLabel(Math.max(0, ms), 'largest')
}

/** Compact absolute start stamp: time-of-day for today ("14:32"), short date +
 *  time otherwise ("Jun 30 14:32"). */
function formatStartedDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** Dropdown menu item styling (mirrors the sidebar row-actions menu). */
const MENU_ITEM_CLASS =
  'flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 ' +
  'text-start text-sm outline-none hover:bg-muted focus:bg-muted ' +
  'data-[highlighted]:bg-muted'

export type BackgroundTasksDrawerProps = {
  rows: readonly NexusTaskSummaryRow[]
  onClose: () => void
  onStop: (subAgentSessionId: string) => void
  onResume: (subAgentSessionId: string, prompt: string) => void
  /** Optional task id to open directly in detail view. Consumed ONCE — after
   *  the detail opens, `onFocusConsumed` asks the owner to clear it so a later
   *  summary broadcast can't re-hijack the user's back-navigation. */
  focusSessionId?: string | null
  /** Called right after `focusSessionId` has been consumed (detail opened).
   *  The owner should clear its focus state in response. */
  onFocusConsumed?: () => void
  /** A count the owner bumps to show the list: each new value leaves any
   *  task detail the drawer shows. */
  listRequest?: number
  /** Load a sub-agent's read-only transcript + header info for the detail view. */
  loadTranscript: (
    subAgentSessionId: string,
  ) => Promise<NexusTaskDetail | null>
}

/** A pending in-flight control action, cleared once the feed reflects it. */
type PendingAction = 'stop' | 'resume'
type ViewState = { kind: 'list' } | { kind: 'detail'; sessionId: string }

export function BackgroundTasksDrawer({
  rows,
  onClose,
  onStop,
  onResume,
  loadTranscript,
  focusSessionId,
  onFocusConsumed,
  listRequest,
}: BackgroundTasksDrawerProps): ReactElement {
  const t = useT()
  // The drawer is already scoped to one session, so it groups active work into
  // one always-open Running section and terminal work by KIND (Sub-agents /
  // Shell / Super Shell / Super Edit) — never by launching session.
  const groups = useMemo(() => groupSubAgentsByCategory(rows), [rows])
  // Per-category collapse. Default (SUB_AGENT_CATEGORY_DEFAULT_EXPANDED): only
  // Running starts open; the terminal kind sections (Sub-agents / Shell / Super
  // Shell / Super Edit) start collapsed. A user toggle wins for the session,
  // except Running, which the render pins open (`pinnedOpen`).
  const [expanded, setExpanded] = useState<
    Record<SubAgentCategory, boolean>
  >(() => ({ ...SUB_AGENT_CATEGORY_DEFAULT_EXPANDED }))
  const toggleCategory = useCallback(
    (status: SubAgentCategory) =>
      setExpanded((prev) => ({ ...prev, [status]: !prev[status] })),
    [],
  )

  const [view, setView] = useState<ViewState>({ kind: 'list' })
  const [pending, setPending] = useState<ReadonlyMap<string, PendingAction>>(
    () => new Map(),
  )
  const [resumeTarget, setResumeTarget] =
    useState<NexusTaskSummaryRow | null>(null)
  const [resumeText, setResumeText] = useState(() =>
    t('backgroundTasks.resumeDefaultText'),
  )

  // Detail-view state (transcript + header info). `detailReqRef` guards against
  // a stale response landing after the user navigated to a different task.
  const [transcript, setTranscript] = useState<
    readonly NexusTaskTranscriptEntry[] | null
  >(null)
  const [info, setInfo] = useState<NexusTaskInfo | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const detailReqRef = useRef<string | null>(null)

  // 5s ticker so the running rows' "started Xm ago / updated Ys ago" stay fresh
  // between broadcasts. Gated: it only matters in the LIST view AND only while a
  // row is actually running (ages render only for running rows), so the detail
  // view and an all-finished list don't re-render the drawer every 5s for nothing.
  const hasRunningRows = rows.some((r) => r.status === 'running')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (view.kind !== 'list' || !hasRunningRows) return
    setNow(Date.now()) // refresh immediately so a re-armed ticker isn't stale
    const id = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [view.kind, hasRunningRows])

  const loadDetail = useCallback(
    (sessionId: string, opts?: { silent?: boolean }) => {
      // `silent` is for the running-row auto-refresh: keep the current
      // transcript on screen (no spinner, no clear-to-empty) and just swap in
      // the newer one when it lands, so live tool-call turns stream in without
      // a flicker. The explicit open / refresh-button path stays non-silent.
      const silent = opts?.silent ?? false
      detailReqRef.current = sessionId
      if (!silent) {
        setTranscript(null)
        setTranscriptLoading(true)
      }
      // Returns the loaded detail (or null) so a focus open can decide whether
      // the target resolved to anything before switching to the detail view.
      return loadTranscript(sessionId)
        .then((detail) => {
          if (detailReqRef.current !== sessionId) return null // superseded
          setTranscript(detail?.entries ?? null)
          setInfo(detail?.info ?? null)
          setTranscriptLoading(false)
          return detail ?? null
        })
        .catch(() => {
          // A rejected load must still clear the spinner — otherwise the detail
          // view spins forever and the refresh button stays disabled. Fall back
          // to the empty state (loadTranscript's null contract already maps a
          // failed read to "no messages") — but a SILENT auto-refresh must not
          // wipe a good transcript/info on a transient read error.
          if (detailReqRef.current !== sessionId) return null
          if (!silent) {
            setTranscript(null)
            setInfo(null)
          }
          setTranscriptLoading(false)
          return null
        })
    },
    [loadTranscript],
  )

  const openDetail = useCallback(
    (sessionId: string) => {
      setView({ kind: 'detail', sessionId })
      loadDetail(sessionId)
    },
    [loadDetail],
  )

  // Consume a focus request ONCE (`consumedFocusRef`), so summary broadcasts never reopen
  // the detail. A rowless focus is probed first and opens the detail only if it loads info
  // or a transcript.
  const consumedFocusRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusSessionId) {
      consumedFocusRef.current = null
      return
    }
    if (consumedFocusRef.current === focusSessionId) return
    consumedFocusRef.current = focusSessionId
    onFocusConsumed?.()
    if (rows.some((r) => r.sessionId === focusSessionId)) {
      openDetail(focusSessionId)
      return
    }
    const id = focusSessionId
    void loadDetail(id).then((detail) => {
      if (detailReqRef.current !== id) return // superseded / navigated away
      if (detail?.info || detail?.entries?.length) {
        setView({ kind: 'detail', sessionId: id })
      }
    })
  }, [focusSessionId, rows, openDetail, loadDetail, onFocusConsumed])

  const backToList = useCallback(() => {
    detailReqRef.current = null
    setView({ kind: 'list' })
    setTranscript(null)
    setInfo(null)
    setTranscriptLoading(false)
  }, [])

  const seenListRequestRef = useRef(listRequest)
  useEffect(() => {
    if (listRequest === seenListRequestRef.current) return
    seenListRequestRef.current = listRequest
    backToList()
  }, [listRequest, backToList])

  // Clear a pending action once the authoritative feed reflects it (stop → no
  // longer running; resume → running again) or the row vanished.
  useEffect(() => {
    setPending((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Map(prev)
      for (const [id, action] of prev) {
        const row = rows.find((r) => r.sessionId === id)
        const settled =
          !row ||
          (action === 'stop' && row.status !== 'running') ||
          (action === 'resume' && row.status === 'running')
        if (settled) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [rows])

  // Esc: close the resume dialog → leave the detail view → close the drawer.
  // Only while the drawer is on screen: the shell keeps the session area
  // mounted under Settings, and an Escape meant for Settings must not act on
  // a drawer the user cannot see.
  const sessionAreaVisible = useSessionAreaVisible()
  useEffect(() => {
    if (!sessionAreaVisible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (resumeTarget) setResumeTarget(null)
      else if (view.kind === 'detail') backToList()
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, resumeTarget, view.kind, backToList, sessionAreaVisible])

  const detailRow =
    view.kind === 'detail'
      ? rows.find((r) => r.sessionId === view.sessionId)
      : undefined
  const detailRowLabelKey = detailRow ? taskRowLabelKey(detailRow) : null
  const detailRowLabel = detailRowLabelKey
    ? t(detailRowLabelKey)
    : detailRow?.description

  // While a RUNNING task's detail is open, reload its transcript silently on each
  // `lastActivityAt` advance, and once more when it settles (the result is readable only
  // after the finish is recorded). Keyed by session id.
  const detailSessionId = view.kind === 'detail' ? view.sessionId : null
  const detailStatus = detailRow?.status
  const detailActivityAt = detailRow?.lastActivityAt
  const prevDetailStatusRef = useRef<{
    id: string | null
    status?: NexusTaskSummaryRow['status']
  }>({ id: null })
  useEffect(() => {
    const prev = prevDetailStatusRef.current
    prevDetailStatusRef.current = { id: detailSessionId, status: detailStatus }
    if (detailSessionId === null) return
    if (detailStatus === 'running') {
      loadDetail(detailSessionId, { silent: true })
      return
    }
    if (
      prev.id === detailSessionId &&
      prev.status === 'running' &&
      detailStatus !== undefined
    ) {
      loadDetail(detailSessionId, { silent: true })
    }
  }, [detailSessionId, detailStatus, detailActivityAt, loadDetail])

  const markPending = (id: string, action: PendingAction) => {
    setPending((prev) => new Map(prev).set(id, action))
    // Safety net: never leave a row spinning if the feed never reflects the
    // action (e.g. a no-op resume that returns 'unavailable').
    window.setTimeout(() => {
      setPending((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }, 5000)
  }

  const handleStop = (id: string) => {
    markPending(id, 'stop')
    onStop(id)
  }

  const handleResumeConfirm = () => {
    const target = resumeTarget
    if (!target) return
    markPending(target.sessionId, 'resume')
    onResume(
      target.sessionId,
      resumeText.trim() || t('backgroundTasks.resumeDefaultText'),
    )
    setResumeTarget(null)
  }

  // Always renders chrome-free: the only mount is inside RightPanel, which owns
  // the outer width/border + the tab strip (with its own close). The detail-view
  // back header below stays — it is navigation, not panel chrome.
  return (
    <div
      data-testid="background-tasks-drawer"
      aria-label={t('topbar.backgroundTasks')}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {view.kind === 'detail' ? (
        <>
          <div className="flex items-center gap-1.5 border-b px-2 py-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={backToList}
              aria-label={t('backgroundTasks.back')}
              data-testid="background-tasks-detail-back"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-sm font-medium"
                title={view.sessionId}
              >
                {detailRowLabel ??
                  // A row-less detail (reloaded session — recovered from the
                  // tool-detail sidecar) must not fall back to the SUB-AGENT
                  // title for a run_js / SuperShell run: name it what it is,
                  // preferring the model's own description off the loaded info.
                  (info?.type === 'local_js'
                    ? info.jsParams?.description?.trim() ||
                      t('backgroundTasks.runJsFallbackTitle', {
                        id: view.sessionId.slice(-6),
                      })
                    : info?.type === 'local_supershell'
                      ? info.jsParams?.description?.trim() ||
                        t('backgroundTasks.superShellFallbackTitle', {
                          id: view.sessionId.slice(-6),
                        })
                      : t('backgroundTasks.subAgentFallbackTitle', {
                          id: view.sessionId.slice(-6),
                        }))}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {detailRow
                  ? t(SUB_AGENT_STATUS_LABEL_KEY[detailRow.status])
                  : t('backgroundTasks.status.unknown')}
                {detailRow?.agentType ? ` · ${detailRow.agentType}` : ''}
              </div>
            </div>
            {/* Reload only makes sense for a RUNNING task (streaming transcript
                / live shell output). A terminal task — including a shell/run_js
                recovered from a transcript after an app restart, whose process
                is long dead and whose detailRow is often absent — has nothing
                new to load, so the manual refresh is hidden. */}
            {detailStatus === 'running' ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={() => loadDetail(view.sessionId)}
                disabled={transcriptLoading}
                aria-label={t('backgroundTasks.reloadTranscript')}
                data-testid="background-tasks-detail-refresh"
              >
                <RotateCcwIcon
                  className={cn('size-3.5', transcriptLoading && 'animate-spin')}
                />
              </Button>
            ) : null}
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2"
            data-testid="background-tasks-detail"
          >
            {info &&
            (info.model ||
              info.effort ||
              info.task ||
              info.systemPrompt ||
              info.summary ||
              info.outputText ||
              info.shellParams ||
              info.jsSource ||
              info.jsParams ||
              info.type === 'local_js') ? (
              <div
                data-testid="background-tasks-detail-info"
                // A flat list of header+content blocks that all flow at their
                // natural height. The single scroll container is the outer
                // detail column (`background-tasks-detail`, overflow-y-auto) —
                // no block here caps its own height or nests a second vertical
                // scrollbar, so one scrollbar moves the whole detail. Shell and
                // Super Edit share this exact view: whichever blocks are present
                // render in reading order (params → result → source/output).
                className="mb-2 flex flex-col gap-2 rounded-md border bg-muted/30 px-2 py-2 text-xs"
              >
                {info.model ? (
                  <div>
                    <span className="font-medium text-muted-foreground">
                      Model:{' '}
                    </span>
                    <span className="break-words text-foreground/90">
                      {info.model}
                    </span>
                  </div>
                ) : null}
                {info.effort ? (
                  <div data-testid="background-tasks-detail-effort">
                    <span className="font-medium text-muted-foreground">
                      Effort:{' '}
                    </span>
                    <span className="break-words text-foreground/90">
                      {info.effort}
                    </span>
                  </div>
                ) : null}
                {info.systemPrompt ? (
                  // The fixed system prompt sent with the model call (e.g. the
                  // session-title namer directive, or a fork's custom/inherited
                  // agent prompt). May be long — it flows at natural height so
                  // the OUTER detail column owns the only scrollbar (no nested
                  // scrollbox).
                  <div data-testid="background-tasks-detail-system-prompt">
                    <p className="mb-0.5 font-semibold">
                      {t('backgroundTasks.systemPrompt')}
                    </p>
                    <pre className="whitespace-pre-wrap break-words rounded bg-background/60 p-1.5 font-mono text-[11px] leading-4 text-foreground/90">
                      {info.systemPrompt}
                    </pre>
                  </div>
                ) : null}
                {info.task ? (
                  <div>
                    <p className="mb-0.5 font-semibold">
                      {info.type === 'local_bash'
                        ? t('backgroundTasks.commandLabel')
                        : info.type === 'local_fast'
                          ? t('backgroundTasks.promptLabel')
                          : t('backgroundTasks.taskLabel')}
                    </p>
                    <p
                      className={cn(
                        'whitespace-pre-wrap break-words text-muted-foreground',
                        info.type === 'local_bash' && 'font-mono',
                      )}
                    >
                      {info.task}
                    </p>
                  </div>
                ) : null}
                {info.shellParams ? (
                  <ShellParamsBlock params={info.shellParams} />
                ) : null}
                {info.jsParams ? (
                  // Part 1 — the input parameters (with the JS code elided).
                  <RunJsParamsBlock params={info.jsParams} />
                ) : null}
                {info.type === 'local_js' &&
                !info.outputText &&
                detailRow?.status === 'running' ? (
                  // Part 2 (running) — no result yet. A finished run renders its
                  // result via the Result block below; the Source block trails.
                  <div
                    data-testid="background-tasks-detail-runjs-running"
                    className="flex items-center gap-2 text-muted-foreground"
                  >
                    <Loader2Icon className="size-3.5 animate-spin" />
                    {t('backgroundTasks.status.running')}
                  </div>
                ) : null}
                {info.outputText ? (
                  // Part 2 — the result. For a `local_js` (Super Edit) run this
                  // is the script's return/console output, headed "Result"; for a
                  // `local_bash` task it is the output-file contents, headed
                  // "Output". Shown INSTEAD of the summary — for a shell the
                  // summary is the same output, just a possibly-staler capped
                  // view. Flows at natural height (wraps, no inner scrollbox) so
                  // the outer detail column owns the only scrollbar.
                  <div data-testid="background-tasks-detail-output" className="flex flex-col">
                    <p className="mb-0.5 font-semibold">
                      {info.type === 'local_js' || info.type === 'local_supershell'
                        ? t('backgroundTasks.resultHeader')
                        : 'Output'}
                    </p>
                    {info.outputFilePath ? (
                      <p
                        className="mb-1 truncate text-[10px] text-muted-foreground"
                        title={info.outputFilePath}
                      >
                        {info.outputFilePath}
                      </p>
                    ) : null}
                    <pre className="whitespace-pre-wrap break-words rounded bg-background/60 p-1.5 font-mono text-[11px] leading-4 text-foreground/90">
                      {info.outputText}
                    </pre>
                  </div>
                ) : info.summary ? (
                  <div>
                    <p className="mb-0.5 font-semibold">Summary</p>
                    <p className="whitespace-pre-wrap break-words text-foreground/90">
                      {info.summary}
                    </p>
                  </div>
                ) : null}
                {info.jsSource ? (
                  // Part 3 — the JS source, LAST (after params + result). Flows
                  // at natural height into the outer detail column's single
                  // scrollbar; only long CODE LINES scroll, horizontally, inside
                  // the pre (`overflow-x-auto`, and `whitespace-pre` so code
                  // isn't reflowed). No vertical inner scrollbox and no height
                  // cap — the whole detail moves as one.
                  <div
                    data-testid="background-tasks-detail-runjs-source"
                    className="flex flex-col"
                  >
                    <p className="mb-0.5 font-semibold">
                      {t('backgroundTasks.jsSourceHeader')}
                    </p>
                    <pre className="overflow-x-auto whitespace-pre rounded bg-background/60 p-1.5 font-mono text-[11px] leading-4 text-foreground/90">
                      {info.jsSource}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
            {transcriptLoading && !transcript ? (
              <div className="flex items-center gap-2 px-2 py-6 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                {t("backgroundTasks.loadingTranscript")}
              </div>
            ) : !transcript || transcript.length === 0 ? (
              // A shell task / fast call / run_js has no transcript by design —
              // the Output block above (or the run_js source/result blocks)
              // carries the content, so an empty-state would just read as an
              // error.
              info?.type === 'local_bash' ||
              info?.type === 'local_fast' ||
              info?.type === 'local_js' ||
              info?.type === 'local_supershell' ? null : (
                <div className="px-2 py-10 text-center text-xs text-muted-foreground">
                  {t("backgroundTasks.noMessages")}
                </div>
              )
            ) : (
              <ol className="flex flex-col gap-2">
                {transcript.map((entry, i) => (
                  <li
                    key={i}
                    className={cn(
                      'rounded-md border px-2 py-1.5 text-xs',
                      entry.role === 'user' ? 'bg-muted/40' : 'bg-card',
                    )}
                  >
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {entry.role}
                    </div>
                    {entry.text ? (
                      <div className="whitespace-pre-wrap break-words text-foreground/90">
                        {entry.text}
                      </div>
                    ) : null}
                    {entry.tools.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {entry.tools.map((t, j) => (
                          <span
                            key={j}
                            className="rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {groups.length === 0 ? (
            <div className="px-2 py-10 text-center text-xs text-muted-foreground">
              {t("backgroundTasks.emptyState")}
            </div>
          ) : (
            groups.map((group) => {
              // The Running section is pinned open — active work of any kind
              // must never be hidden behind a collapsed header — so it can't be
              // toggled; every other (terminal) section is collapsible.
              const pinnedOpen = group.category === 'running'
              const isOpen = pinnedOpen || expanded[group.category]
              // Header tallies outcomes with the SAME glyphs the rows use: a
              // green check + the success count, a red ✗ + the failed count —
              // no words, each shown only when non-zero. A terminal section
              // mixes statuses, so "✓ 3  ✗ 1" surfaces a failure without a
              // Failed bucket; the always-open Running section (no settled rows)
              // shows just its label.
              const successCount = group.items.filter(
                (i) => i.status === 'success',
              ).length
              const failedCount = group.items.filter(
                (i) => i.status === 'error',
              ).length
              const CategoryIcon = SUB_AGENT_CATEGORY_ICON[group.category]
              const headerInner = (
                <>
                  <CategoryIcon
                    aria-hidden
                    data-testid="subagent-category-icon"
                    className="size-3.5 shrink-0"
                  />
                  <span>{t(SUB_AGENT_CATEGORY_LABEL_KEY[group.category])}</span>
                  {successCount > 0 ? (
                    <span
                      className="flex items-center gap-0.5 tabular-nums text-success"
                      data-testid="subagent-category-success-count"
                    >
                      <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                      {successCount}
                    </span>
                  ) : null}
                  {failedCount > 0 ? (
                    <span
                      className="flex items-center gap-0.5 tabular-nums text-destructive"
                      data-testid="subagent-category-failed-count"
                    >
                      <XIcon aria-hidden className="size-3.5 shrink-0" />
                      {failedCount}
                    </span>
                  ) : null}
                  {pinnedOpen ? null : (
                    <ChevronDownIcon
                      className={cn(
                        'ml-auto size-3.5 shrink-0 transition-transform',
                        !isOpen && '-rotate-90',
                      )}
                    />
                  )}
                </>
              )
              return (
                <div key={group.category} className="mb-2">
                  {pinnedOpen ? (
                    <div
                      data-testid={`subagent-category-${group.category}`}
                      className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {headerInner}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleCategory(group.category)}
                      data-testid={`subagent-category-${group.category}`}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {headerInner}
                    </button>
                  )}
                  {isOpen ? (
                  <ul className="mt-1 flex flex-col gap-1">
                    {group.items.map((item) => {
                      const isRunning = item.status === 'running'
                      const isPending = pending.has(item.sessionId)
                      const meta: string[] = [
                        t(SUB_AGENT_STATUS_LABEL_KEY[item.status]),
                      ]
                      // Every row shows WHEN it started; a running row adds the
                      // live age + last-activity hint, a finished row adds the
                      // total span it took.
                      if (item.startedAt) {
                        meta.push(
                          t('backgroundTasks.startedAt', {
                            when: formatStartedDate(item.startedAt),
                          }),
                        )
                      }
                      if (isRunning) {
                        if (item.startedAt) meta.push(formatAge(now - item.startedAt))
                        if (item.lastActivityAt) {
                          meta.push(`updated ${formatAge(now - item.lastActivityAt)} ago`)
                        }
                      } else if (item.startedAt && item.finishedAt) {
                        meta.push(
                          `took ${durationLabel(
                            Math.max(0, item.finishedAt - item.startedAt),
                          )}`,
                        )
                      }
                      if (item.agentType) meta.push(item.agentType)
                      // A background shell (local_bash) shows its COMMAND (mono,
                      // terminal glyph) in place of the agent description; agent
                      // rows are unchanged. Absent type ⇒ local_agent. Forks /
                      // fast calls / routines get their own kind glyph.
                      const kind = item.type ?? 'local_agent'
                      const isBash = kind === 'local_bash'
                      const KindGlyph =
                        kind === 'local_bash' || kind === 'local_supershell'
                          ? TerminalIcon
                          : kind === 'local_fork'
                            ? GitForkIcon
                            : kind === 'local_fast'
                              ? ZapIcon
                              : kind === 'local_routine'
                                ? ClockIcon
                                : kind === 'local_js'
                                  ? BracesIcon
                                  : null
                      const labelKey = taskRowLabelKey(item)
                      const primaryLabel = isBash
                        ? item.command ?? item.description
                        : labelKey
                          ? t(labelKey)
                          : item.description
                      return (
                        <li
                          key={item.sessionId}
                          // Lets tests (and future styling) target rows of one
                          // task kind — e.g. count running SUB-AGENTS without
                          // tripping over a transient fast-call/fork row.
                          data-task-kind={kind}
                          className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 text-xs"
                        >
                          <StatusIcon status={item.status} />
                          <button
                            type="button"
                            onClick={() => openDetail(item.sessionId)}
                            title={`${primaryLabel} · ${item.sessionId}`}
                            data-testid="subagent-row-open"
                            className="min-w-0 flex-1 text-start outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <div
                              className={cn(
                                // min-w-0 keeps this flex level shrinkable so the
                                // truncating span inside actually ellipsizes: a flex
                                // item's automatic minimum size would otherwise pin
                                // the row to the label's content width and let a long
                                // description overflow the <li> (hard-clipped by the
                                // parent scroll container) instead of truncating.
                                'flex min-w-0 items-center gap-1 truncate font-medium text-foreground/90',
                                isBash && 'font-mono',
                              )}
                            >
                              {KindGlyph ? (
                                <KindGlyph className="size-3 shrink-0 text-muted-foreground" />
                              ) : null}
                              <span className="truncate">{primaryLabel}</span>
                            </div>
                            <div className="truncate text-[11px] tabular-nums text-muted-foreground">
                              {meta.join(' · ')}
                            </div>
                          </button>
                          <DropdownMenuPrimitive.Root>
                            <DropdownMenuPrimitive.Trigger asChild>
                              <button
                                type="button"
                                data-testid="subagent-row-menu"
                                aria-label={t('backgroundTasks.taskActions')}
                                disabled={isPending}
                                className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                              >
                                {isPending ? (
                                  <Loader2Icon className="size-3.5 animate-spin" />
                                ) : (
                                  <MoreHorizontalIcon className="size-3.5" />
                                )}
                              </button>
                            </DropdownMenuPrimitive.Trigger>
                            <DropdownMenuPrimitive.Portal>
                              <DropdownMenuPrimitive.Content
                                align="end"
                                sideOffset={4}
                                onCloseAutoFocus={(e) => e.preventDefault()}
                                className="z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                              >
                                {isRunning ? (
                                  // A fast call is a single in-flight request —
                                  // nothing to stop; it settles in moments.
                                  kind === 'local_fast' ? null : (
                                    <DropdownMenuPrimitive.Item
                                      asChild
                                      onSelect={() => handleStop(item.sessionId)}
                                    >
                                      <button
                                        type="button"
                                        data-testid="subagent-stop"
                                        className={MENU_ITEM_CLASS}
                                      >
                                        <SquareIcon className="size-4" />
                                        Stop
                                      </button>
                                    </DropdownMenuPrimitive.Item>
                                  )
                                ) : kind !== 'local_agent' ? (
                                  // Only a sub-agent can be Resumed (it re-prompts
                                  // the persisted worker session). Shells, forks,
                                  // fast calls, and routine runs show only "Open".
                                  null
                                ) : (
                                  <DropdownMenuPrimitive.Item
                                    asChild
                                    onSelect={() => {
                                      setResumeText(
                                        t('backgroundTasks.resumeDefaultText'),
                                      )
                                      setResumeTarget(item)
                                    }}
                                  >
                                    <button
                                      type="button"
                                      data-testid="subagent-resume"
                                      className={MENU_ITEM_CLASS}
                                    >
                                      <RotateCcwIcon className="size-4" />
                                      Resume
                                    </button>
                                  </DropdownMenuPrimitive.Item>
                                )}
                                <DropdownMenuPrimitive.Item
                                  asChild
                                  onSelect={() => openDetail(item.sessionId)}
                                >
                                  <button
                                    type="button"
                                    data-testid="subagent-open"
                                    className={MENU_ITEM_CLASS}
                                  >
                                    <ScrollTextIcon className="size-4" />
                                    Open
                                  </button>
                                </DropdownMenuPrimitive.Item>
                              </DropdownMenuPrimitive.Content>
                            </DropdownMenuPrimitive.Portal>
                          </DropdownMenuPrimitive.Root>
                        </li>
                      )
                    })}
                  </ul>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      )}

      {resumeTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="subagent-resume-dialog"
        >
          <div className="w-full max-w-md rounded-lg border bg-background p-4 shadow-lg">
            <div className="mb-1 text-sm font-medium">
              {t("backgroundTasks.resumeTitle", {
                description: resumeTarget.description,
              })}
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              {t("backgroundTasks.resumeHint")}
            </p>
            <textarea
              autoFocus
              rows={3}
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              className="w-full resize-none rounded-md border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setResumeTarget(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!resumeText.trim()}
                onClick={handleResumeConfirm}
                data-testid="subagent-resume-confirm"
              >
                Resume
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
