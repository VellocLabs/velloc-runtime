/**
 * A sub-agent or fork run's tool calls and token usage (F-2).
 *
 * `strip`: one quiet line of icon + figure pairs, for a list row or a
 * conversation card. `badges`: labelled chips for the detail header, the tool
 * count set apart from the token figures.
 */
import type { ComponentType, ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon, DatabaseIcon, PencilLineIcon, WrenchIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NexusTaskRunStats } from '../bridge/protocol/ui'
import { compactTokenCount, hasRunStats } from '../../utils/taskRunStats'
import { useT } from './i18n'

type IconType = ComponentType<{ className?: string; 'data-testid'?: string }>

const TOOL_TINT = 'text-foreground/60'
const INPUT_TINT = 'text-info'
const OUTPUT_TINT = 'text-success'
const CACHE_TINT = 'text-warning'

function exact(n: number): string {
  return n.toLocaleString()
}

export type TaskRunStatsProps = {
  stats: NexusTaskRunStats | undefined
  variant: 'strip' | 'badges'
  /** Marks the tool figure as live while the run is still working. */
  running?: boolean
  className?: string
}

export function TaskRunStats({ stats, variant, running = false, className }: TaskRunStatsProps): ReactNode {
  const t = useT()
  if (!hasRunStats(stats)) return null
  const hasTokens = stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens > 0
  const hasCache = stats.cacheReadTokens + stats.cacheWriteTokens > 0
  const toolsTitle = t('taskStats.toolsTitle', { n: exact(stats.toolUses) })
  const inputTitle = t('taskStats.inputTitle', { n: exact(stats.inputTokens) })
  const outputTitle = t('taskStats.outputTitle', { n: exact(stats.outputTokens) })
  const cacheTitle = t('taskStats.cacheTitle', {
    read: exact(stats.cacheReadTokens),
    write: exact(stats.cacheWriteTokens),
  })

  if (variant === 'strip') {
    return (
      <div
        role="group"
        aria-label={t('taskStats.groupLabel')}
        data-testid="task-run-stats"
        data-variant="strip"
        className={cn(
          'flex min-w-0 items-center gap-2 text-[11px] leading-none tabular-nums text-muted-foreground',
          className,
        )}
      >
        <StripItem icon={WrenchIcon} tint={TOOL_TINT} title={toolsTitle} testId="task-run-stats-tools" live={running}>
          {stats.toolUses}
        </StripItem>
        {hasTokens ? (
          <>
            <span aria-hidden className="h-2.5 w-px shrink-0 bg-border" />
            <StripItem icon={ArrowUpIcon} tint={INPUT_TINT} title={inputTitle} testId="task-run-stats-input">
              {compactTokenCount(stats.inputTokens)}
            </StripItem>
            <StripItem icon={ArrowDownIcon} tint={OUTPUT_TINT} title={outputTitle} testId="task-run-stats-output">
              {compactTokenCount(stats.outputTokens)}
            </StripItem>
            {hasCache ? (
              <StripItem icon={DatabaseIcon} tint={CACHE_TINT} title={cacheTitle} testId="task-run-stats-cache">
                {compactTokenCount(stats.cacheReadTokens)}
              </StripItem>
            ) : null}
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div
      role="group"
      aria-label={t('taskStats.groupLabel')}
      data-testid="task-run-stats"
      data-variant="badges"
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      <Badge icon={WrenchIcon} tint={TOOL_TINT} title={toolsTitle} testId="task-run-stats-tools" live={running}
        value={String(stats.toolUses)}
        label={t(stats.toolUses === 1 ? 'taskStats.toolsLabelOne' : 'taskStats.toolsLabel')} />
      {hasTokens ? (
        <>
          <span aria-hidden className="mx-0.5 h-3 w-px bg-border" />
          <Badge icon={ArrowUpIcon} tint={INPUT_TINT} title={inputTitle} testId="task-run-stats-input"
            value={compactTokenCount(stats.inputTokens)} label={t('taskStats.inputLabel')} />
          <Badge icon={ArrowDownIcon} tint={OUTPUT_TINT} title={outputTitle} testId="task-run-stats-output"
            value={compactTokenCount(stats.outputTokens)} label={t('taskStats.outputLabel')} />
          {hasCache ? (
            <Badge icon={DatabaseIcon} tint={CACHE_TINT} title={cacheTitle} testId="task-run-stats-cache"
              value={compactTokenCount(stats.cacheReadTokens)} label={t('taskStats.cacheReadLabel')} />
          ) : null}
          {stats.cacheWriteTokens > 0 ? (
            <Badge icon={PencilLineIcon} tint={CACHE_TINT} title={cacheTitle} testId="task-run-stats-cache-write"
              value={compactTokenCount(stats.cacheWriteTokens)} label={t('taskStats.cacheWriteLabel')} />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function LiveIcon({ icon: Icon, tint, live }: { icon: IconType; tint: string; live?: boolean }) {
  return (
    <Icon
      data-testid={live ? 'task-run-stats-live' : undefined}
      className={cn('size-3 shrink-0', tint, live && 'animate-pulse')}
    />
  )
}

function StripItem(props: {
  icon: IconType
  tint: string
  title: string
  testId: string
  live?: boolean
  children: ReactNode
}) {
  return (
    <span title={props.title} aria-label={props.title} data-testid={props.testId} className="inline-flex shrink-0 items-center gap-0.5">
      <LiveIcon icon={props.icon} tint={props.tint} live={props.live} />
      <span aria-hidden>{props.children}</span>
    </span>
  )
}

function Badge(props: {
  icon: IconType
  tint: string
  title: string
  testId: string
  value: string
  label: string
  live?: boolean
}) {
  return (
    <span
      title={props.title}
      data-testid={props.testId}
      className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md bg-muted/60 px-1.5 text-[11px] leading-none"
    >
      <LiveIcon icon={props.icon} tint={props.tint} live={props.live} />
      <span className="font-medium tabular-nums text-foreground/90">{props.value}</span>
      <span className="text-muted-foreground">{props.label}</span>
    </span>
  )
}
