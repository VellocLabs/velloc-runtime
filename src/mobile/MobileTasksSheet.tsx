/**
 * The phone shell's background tasks sheet (F-24), opened from the session menu. It lists the open
 * session's background tasks — title, state and elapsed time — and offers Stop on the running ones.
 * It shows no task's transcript.
 */
import { useEffect, useState } from 'react'

import {
  SUB_AGENT_STATUS_LABEL_KEY,
  shellTaskTitle,
  taskRowLabelKey,
} from '../browser/webview/backgroundSubAgents'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import { useT } from '../browser/webview/i18n'
import { durationLabel } from '../utils/humanize/durationLabel'
import { MobileSheet } from './MobileSheet'

export type MobileTasksSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: readonly NexusTaskSummaryRow[]
  onStop: (taskId: string) => void
  /** The clock elapsed times count to; a test passes its own. Absent: the wall clock, ticking. */
  now?: number
}

/** Running: since it started; settled: how long it took; unknown start: none. */
function elapsedMs(row: NexusTaskSummaryRow, now: number): number | undefined {
  if (row.startedAt === undefined) return undefined
  const end = row.status === 'running' ? now : row.finishedAt
  return end === undefined ? undefined : Math.max(0, end - row.startedAt)
}

/** Ticks once a second while `live`, so a running row's elapsed time moves. */
function useTickingNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [live])
  return now
}

export function MobileTasksSheet({ open, onOpenChange, rows, onStop, now }: MobileTasksSheetProps) {
  const t = useT()
  const anyRunning = rows.some(row => row.status === 'running')
  const ticking = useTickingNow(open && anyRunning && now === undefined)
  const clock = now ?? ticking

  const titleOf = (row: NexusTaskSummaryRow): { text: string; isCommand: boolean } => {
    if (row.type === 'local_bash') return shellTaskTitle(row)
    const key = taskRowLabelKey(row)
    return { text: key ? t(key) : row.description, isCommand: false }
  }

  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} title={t('mobile.tasks.title')} testId="mobile-tasks-sheet">
      {rows.length === 0 ? (
        <p data-testid="mobile-tasks-empty" className="px-3 py-2 text-muted-foreground text-sm">
          {t('mobile.tasks.empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map(row => {
            const title = titleOf(row)
            const elapsed = elapsedMs(row, clock)
            const running = row.status === 'running'
            return (
              <li
                key={row.sessionId}
                data-testid="mobile-task-row"
                data-task-id={row.sessionId}
                data-status={row.status}
                className="flex min-h-12 items-center gap-3 rounded-lg px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span
                    data-testid="mobile-task-title"
                    className={`block truncate text-body ${title.isCommand ? 'font-mono text-sm' : ''}`}
                  >
                    {title.text}
                  </span>
                  <span className="block truncate text-muted-foreground text-sm">
                    <span data-testid="mobile-task-status">{t(SUB_AGENT_STATUS_LABEL_KEY[row.status])}</span>
                    {elapsed !== undefined ? (
                      <span data-testid="mobile-task-elapsed" className="tabular-nums">
                        {' · '}
                        {durationLabel(elapsed)}
                      </span>
                    ) : null}
                  </span>
                </span>
                {running ? (
                  <button
                    type="button"
                    data-testid="mobile-task-stop"
                    onClick={() => onStop(row.sessionId)}
                    className="h-11 shrink-0 rounded-lg border border-border px-4 text-body active:bg-accent"
                  >
                    {t('mobile.tasks.stop')}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </MobileSheet>
  )
}
