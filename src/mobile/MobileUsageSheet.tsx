/**
 * The phone shell's usage sheet (F-24), opened by the top bar's `i`. Two sections, each drawn only
 * when it has figures: the open session's context window (percentage, bar, used / total tokens),
 * and the current provider's plan windows (percentage, bar, next reset; a used-up window in the
 * warning colour). Refresh asks the runtime to re-read the plan figures; a refused or failed
 * refresh leaves the figures shown as they were.
 */
import { RefreshCwIcon } from 'lucide-react'

import type { ContextUsageFigures } from '../browser/webview/contextUsage'
import { useT } from '../browser/webview/i18n'
import { usePlanResetText, windowLabelKey } from '../browser/webview/planUsageLabels'
import { isWindowExhausted, type PlanUsageSnapshot } from '../models/usage/planUsage'
import { compactTokenCount } from '../utils/taskRunStats'
import { MobileSheet } from './MobileSheet'
import { useTickingNow } from './useTickingNow'

export type MobileUsageSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Absent: the session has no model yet, so there is nothing to measure. */
  context?: ContextUsageFigures
  /** The plan figures that meter the session's model; absent or windowless draws no plan section. */
  planUsage?: PlanUsageSnapshot
  /** Absent: no provider to ask, so no refresh button. */
  onRefresh?: () => void
  /** Epoch ms the reset countdowns count from; a test passes its own. */
  now?: number
}

type BarTone = 'primary' | 'warning' | 'destructive'

const BAR_FILL: Record<BarTone, string> = {
  primary: 'bg-primary',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
}

function UsageBar({ percent, tone, label, testId }: { percent: number; tone: BarTone; label: string; testId: string }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      data-testid={testId}
      data-tone={tone}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={`h-full rounded-full ${BAR_FILL[tone]}`} style={{ width: `${clamped}%` }} />
    </div>
  )
}

export function MobileUsageSheet({ open, onOpenChange, context, planUsage, onRefresh, now }: MobileUsageSheetProps) {
  const t = useT()
  const resetText = usePlanResetText()
  const windows = planUsage?.windows ?? []
  // Reset labels are minute-grained; tick them while the sheet stays open.
  const ticking = useTickingNow(open && windows.length > 0 && now === undefined, 30_000)
  const clock = now ?? ticking
  const contextTone: BarTone =
    context?.warning === 'danger' ? 'destructive' : context?.warning === 'warning' ? 'warning' : 'primary'
  const refresh = onRefresh ? (
    <button
      type="button"
      data-testid="mobile-usage-refresh"
      aria-label={t('mobile.usage.refresh')}
      onClick={onRefresh}
      className="flex size-11 shrink-0 items-center justify-center rounded-lg active:bg-accent"
    >
      <RefreshCwIcon aria-hidden className="size-5" />
    </button>
  ) : undefined

  return (
    <MobileSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('mobile.usage.title')}
      action={refresh}
      testId="mobile-usage-sheet"
    >
      <div className="flex flex-col gap-5 px-3 pt-1">
        {context ? (
          <section data-testid="mobile-usage-context" className="flex flex-col gap-2">
            <h2 className="text-muted-foreground text-sm">{t('tokenUsage.contextWindow')}</h2>
            <div className="flex items-baseline justify-between gap-3">
              <span data-testid="mobile-usage-context-percent" className="font-semibold text-2xl tabular-nums">
                {t('tokenUsage.percent', { pct: context.percent.toFixed(0) })}
              </span>
              <span data-testid="mobile-usage-context-tokens" className="text-muted-foreground text-sm tabular-nums">
                {t('mobile.usage.contextTokens', {
                  used: compactTokenCount(context.usedTokens),
                  window: compactTokenCount(context.windowTokens),
                })}
              </span>
            </div>
            <UsageBar
              percent={context.percent}
              tone={contextTone}
              label={t('tokenUsage.contextWindow')}
              testId="mobile-usage-context-bar"
            />
          </section>
        ) : null}
        {windows.length > 0 ? (
          <section data-testid="mobile-usage-plan" className="flex flex-col gap-3">
            <h2 className="text-muted-foreground text-sm">
              {planUsage?.planName
                ? t('tokenUsage.planUsageLimitsNamed', { plan: planUsage.planName })
                : t('tokenUsage.planUsageLimits')}
            </h2>
            {windows.map(w => {
              const name = t(windowLabelKey(w, false))
              const reset = resetText(w.resetsAt, clock)
              const exhausted = isWindowExhausted(w)
              const id = `${w.kind}${w.subject ? `-${w.subject}` : ''}`
              return (
                <div
                  key={id}
                  data-testid={`mobile-usage-window-${id}`}
                  data-exhausted={exhausted || undefined}
                  className={`flex flex-col gap-1 ${exhausted ? 'text-warning' : ''}`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body">{name}</span>
                    <span className={`shrink-0 tabular-nums ${exhausted ? 'font-medium' : 'text-muted-foreground'}`}>
                      {t('tokenUsage.percent', { pct: w.usedPercent.toFixed(0) })}
                    </span>
                  </div>
                  <UsageBar
                    percent={w.usedPercent}
                    tone={exhausted ? 'warning' : 'primary'}
                    label={name}
                    testId={`mobile-usage-window-${id}-bar`}
                  />
                  {reset ? (
                    <span className={`text-sm ${exhausted ? '' : 'text-muted-foreground'}`}>{reset}</span>
                  ) : null}
                </div>
              )
            })}
          </section>
        ) : null}
        {!context && windows.length === 0 ? (
          <p data-testid="mobile-usage-empty" className="px-1 py-2 text-muted-foreground text-sm">
            {t('mobile.usage.empty')}
          </p>
        ) : null}
      </div>
    </MobileSheet>
  )
}
