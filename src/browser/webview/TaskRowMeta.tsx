/**
 * A background task's meta line and agent-type pill (F-2), shared by the Tasks
 * pane list row and its detail header so both read the same way: icon + value
 * items at one spacing — time first, then origin, then usage.
 */
import type { ReactNode } from 'react'
import { ClockIcon, CornerDownRightIcon, HistoryIcon, TimerIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NexusTaskSummaryRow } from '../bridge/protocol/ui'
import { durationLabel } from '../../utils/humanize/durationLabel'
import { hasRunStats } from '../../utils/taskRunStats'
import { taskRowOriginName } from './backgroundSubAgents'
import { useLocale, useT } from './i18n'
import { MetaItem, TaskRunStats } from './TaskRunStats'

/** Start stamp on a 24-hour clock: "14:32" today, "Jun 30 14:32" otherwise. */
export function formatStartStamp(ms: number, locale: string, now = Date.now()): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`
}

/** The run's agent type as a fixed-width pill; placed before the title so a
 *  long title truncates without pushing it out. */
export function AgentTypePill({ type, className }: { type: string; className?: string }): ReactNode {
  const t = useT()
  return (
    <span
      title={t('backgroundTasks.meta.agentTypeTitle', { type })}
      data-testid="task-agent-type"
      className={cn(
        'inline-flex h-4 max-w-[9rem] shrink-0 items-center truncate rounded bg-muted px-1.5 text-[10px] font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      {type}
    </span>
  )
}

export type TaskMetaLineProps = {
  row: NexusTaskSummaryRow
  now: number
  /** Shown first, before the time items (the detail header's status). */
  leading?: ReactNode
  /** Status words for assistive tech when no visible status precedes the line. */
  srStatus?: string
  /** False leaves the usage figures out (a view that shows them elsewhere). */
  usage?: boolean
  className?: string
}

export function TaskMetaLine({ row, now, leading, srStatus, usage = true, className }: TaskMetaLineProps): ReactNode {
  const t = useT()
  const locale = useLocale()
  const running = row.status === 'running'
  const timeItems: ReactNode[] = []
  if (running) {
    if (row.startedAt) {
      const span = durationLabel(Math.max(0, now - row.startedAt), 'largest')
      timeItems.push(
        <MetaItem key="elapsed" icon={TimerIcon} testId="task-meta-elapsed"
          title={t('backgroundTasks.meta.elapsedTitle', { span })}>{span}</MetaItem>,
      )
    }
    if (row.lastActivityAt) {
      const age = durationLabel(Math.max(0, now - row.lastActivityAt), 'largest')
      timeItems.push(
        <MetaItem key="updated" icon={HistoryIcon} testId="task-meta-updated"
          title={t('backgroundTasks.meta.updatedTitle', { age })}>
          {t('backgroundTasks.meta.ago', { age })}
        </MetaItem>,
      )
    }
  } else {
    if (row.startedAt) {
      const when = formatStartStamp(row.startedAt, locale, now)
      timeItems.push(
        <MetaItem key="started" icon={ClockIcon} testId="task-meta-started"
          title={t('backgroundTasks.meta.startedTitle', { when })}>{when}</MetaItem>,
      )
    }
    if (row.startedAt && row.finishedAt) {
      const span = durationLabel(Math.max(0, row.finishedAt - row.startedAt))
      timeItems.push(
        <MetaItem key="took" icon={TimerIcon} testId="task-meta-took"
          title={t('backgroundTasks.meta.tookTitle', { span })}>{span}</MetaItem>,
      )
    }
  }
  const origin = taskRowOriginName(row)
  const showUsage = usage && hasRunStats(row.stats)
  return (
    <div
      data-testid="task-meta-line"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] leading-4 tabular-nums text-muted-foreground',
        className,
      )}
    >
      {srStatus ? <span className="sr-only">{srStatus}</span> : null}
      {leading}
      {timeItems}
      {origin ? (
        <MetaItem icon={CornerDownRightIcon} testId="task-meta-origin" className="min-w-0 max-w-full shrink"
          title={t('backgroundTasks.viaAgent', { name: origin })}>{origin}</MetaItem>
      ) : null}
      {showUsage && (timeItems.length > 0 || origin || leading) ? (
        <span aria-hidden className="h-3 w-px shrink-0 bg-foreground/15" />
      ) : null}
      {showUsage ? <TaskRunStats stats={row.stats} variant="strip" running={running} /> : null}
    </div>
  )
}
