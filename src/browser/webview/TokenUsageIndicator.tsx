import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { Message, StreamRecord } from '../../runtime/RuntimeTypes'
import type { BrowserLlmCatalog } from '../bridge/browserBridgeProtocol'
import {
  estimateTranscriptTokens,
  tokensFromUsage,
  tokenWarningLevel,
} from '../../engine/tokenCounts'
import {
  contextUsageShares,
  contextWindowOf,
} from '../../engine/contextWindow'
import { isAssistantMessage } from '../../runtime/VercelModelConstants'
import { getCacheRatio } from '../../utils/cacheUsage'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { HelpCircleIcon, ZapIcon } from 'lucide-react'
import { useLocale, useT } from './i18n'
import {
  thresholdForChoice,
  windowSliderScale,
  type WindowChoice,
} from '../../context/compaction/windowSlider'
import type { AutoCompactView } from '../worker/workerProtocol'
import { AutoCompactHandle } from './AutoCompactHandle'
import { usageForModel, usageSummary } from '../../config/nexusModelConfig/modelDisplay'
import {
  isAmountExhausted,
  isUsageExhausted,
  isWindowExhausted,
} from '../../models/usage/planUsage'
import {
  describePlanUsageReset,
  type PlanUsageSnapshot,
} from '../../models/usage/planUsage'
import { amountLabelKey, balanceNoteKey, useFormatAmount, windowLabelKey } from './planUsageLabels'

function compactTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function getLatestTranscriptUsage(
  messages: Message[],
): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (isAssistantMessage(msg)) {
      const usage = asRecord((msg.message as { usage?: unknown } | undefined)?.usage)
      if (usage) return usage
    }
  }
  return undefined
}

function getLiveUsage(
  liveEvents: StreamRecord[],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined
  for (const event of liveEvents) {
    const record = asRecord(event)
    if (!record) continue
    const inner =
      record.type === 'stream_event'
        ? asRecord(record.event)
        : record
    if (!inner) continue
    const type = inner.type
    if (type === 'message_start') {
      const msg = asRecord(inner.message)
      const usage = asRecord(msg?.usage)
      if (usage) merged = { ...(merged ?? {}), ...usage }
    } else if (type === 'message_delta') {
      const usage = asRecord(inner.usage)
      if (usage) merged = { ...(merged ?? {}), ...usage }
    }
  }
  return merged
}

function numOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export type TokenUsageContextValue = {
  messages: Message[]
  liveEvents: StreamRecord[]
  modelId: string | undefined
  providerId?: string | undefined
  /**
   * The configured catalog the window's figures were mirrored from. Read
   * only as a change signal — see TokenUsageIndicator's `catalog`.
   */
  catalog?: BrowserLlmCatalog | null
  isStreaming: boolean
  /**
   * The current provider's plan quota windows (5-hour, weekly, …). Absent —
   * the provider reports none, or nothing has fetched them — hides every
   * plan-usage line in the context ring's tooltip and popover.
   */
  planUsage?: PlanUsageSnapshot
  /** The active model is a free one — picks the part of `planUsage` that
   *  meters it (`usageForModel`) for the limit-reached warning. */
  modelFree?: boolean
  /** The popover opened: the figures are worth re-reading (the runtime
   *  throttles). */
  onPlanUsageOpen?: () => void
  /** The user's auto-compact switch and window for this model (worker
   *  snapshot). Absent = on, at the model's own window. */
  autoCompact?: AutoCompactView
  /** Save (tokens) or clear (`'auto'`) the active model's window — the
   *  popover's drag handle. Absent = no handle (read-only thread). */
  onSetAutoCompactWindow?: (value: WindowChoice) => void
}

const TokenUsageContext = createContext<TokenUsageContextValue | null>(null)

export function TokenUsageProvider({
  value,
  children,
}: {
  value: TokenUsageContextValue
  children: React.ReactNode
}) {
  return (
    <TokenUsageContext.Provider value={value}>
      {children}
    </TokenUsageContext.Provider>
  )
}

/**
 * Live output-token count for the in-flight turn, read off the same
 * `TokenUsageContext` the composer indicator uses. Returns 0 when there is no
 * provider (tests) or no live usage yet. Used by the conversation
 * running-indicator's status text ("… · 1.8k tokens").
 */
export function useLiveTurnOutputTokens(): number {
  const ctx = useContext(TokenUsageContext)
  // getLiveUsage is an O(liveEvents) scan; memoize on the context identity so a
  // re-render that isn't driven by new events (e.g. the indicator's 1s verb
  // tick) doesn't rescan. Mirrors TokenUsageIndicator's own useMemo.
  const live = useMemo(
    () => (ctx ? getLiveUsage(ctx.liveEvents) : undefined),
    [ctx],
  )
  return numOrZero(live?.output_tokens)
}

export function ComposerTokenUsage({
  className,
  canCompact,
  onCompact,
  isForeground,
}: {
  className?: string
  /** The session is stopped, so the popover's Compact session may run. */
  canCompact?: boolean
  onCompact?: () => void
  /** False while the thread is hidden — see TokenUsageIndicator. */
  isForeground?: boolean
}) {
  const ctx = useContext(TokenUsageContext)
  if (!ctx) return null
  return (
    <TokenUsageIndicator
      messages={ctx.messages}
      liveEvents={ctx.liveEvents}
      modelId={ctx.modelId}
      providerId={ctx.providerId}
      catalog={ctx.catalog}
      isStreaming={ctx.isStreaming}
      planUsage={ctx.planUsage}
      modelFree={ctx.modelFree}
      onPlanUsageOpen={ctx.onPlanUsageOpen}
      autoCompact={ctx.autoCompact}
      onSetAutoCompactWindow={ctx.onSetAutoCompactWindow}
      canCompact={canCompact}
      onCompact={onCompact}
      className={className}
      isForeground={isForeground}
    />
  )
}

/**
 * The latest turn's cache ratio as a whole percent: the live turn while it
 * streams, else the newest assistant usage in the transcript. This — not the
 * session total — is what the composer shows next to the context ring.
 */
function getLastTurnCachePct(
  messages: Message[],
  liveEvents: StreamRecord[],
  isStreaming: boolean,
): number {
  const live = isStreaming ? getLiveUsage(liveEvents) : undefined
  const usage = live ?? getLatestTranscriptUsage(messages)
  return Math.round(getCacheRatio(usage) * 100)
}

function ProgressBar({
  pct,
  tone = 'primary',
  label,
}: {
  pct: number
  tone?: 'primary' | 'warning' | 'destructive'
  label: string
}) {
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300',
          tone === 'destructive'
            ? 'bg-destructive'
            : tone === 'warning'
              ? 'bg-warning'
              : 'bg-primary',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

/** Catalog wording for a window's next reset (see describePlanUsageReset). */
function usePlanResetText(): (
  resetsAt: number | undefined,
  now: number,
) => string | undefined {
  const t = useT()
  const locale = useLocale()
  return (resetsAt, now) => {
    if (resetsAt === undefined) return undefined
    const label = describePlanUsageReset(resetsAt, now)
    if (label.kind === 'absolute') {
      const at = new Date(label.at).toLocaleString(locale, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
      return t('tokenUsage.resetsAt', { time: at })
    }
    const duration =
      label.hours > 0
        ? t('tokenUsage.durationHrMin', {
            hours: String(label.hours),
            minutes: String(label.minutes),
          })
        : t('tokenUsage.durationMin', { minutes: String(label.minutes) })
    return t('tokenUsage.resetsIn', { duration })
  }
}

/**
 * Composer context ring with the last turn's cache ratio (hidden at 0%). Hover: a summary;
 * click: a popover with the context bar, the distance to auto-compact, Compact session
 * (only while stopped) and every plan-usage window (none without `planUsage`).
 */
export function TokenUsageIndicator({
  messages,
  liveEvents,
  modelId,
  providerId,
  isStreaming,
  planUsage,
  modelFree,
  onPlanUsageOpen,
  autoCompact,
  onSetAutoCompactWindow,
  canCompact = false,
  onCompact,
  className,
  isForeground = true,
}: {
  messages: Message[]
  liveEvents: StreamRecord[]
  modelId: string | undefined
  providerId?: string | undefined
  /**
   * The configured catalog: a render trigger, not an input (`NEXUS_MODEL_CONFIG` is mutated
   * in place when a later catalog arrives), so a new one re-reads the context window.
   */
  catalog?: BrowserLlmCatalog | null
  isStreaming: boolean
  /** The provider's plan quota windows and money figures; absent → no
   *  plan-usage UI at all. */
  planUsage?: PlanUsageSnapshot
  /** The active model is free (see TokenUsageContextValue.modelFree). */
  modelFree?: boolean
  onPlanUsageOpen?: () => void
  /** See TokenUsageContextValue.autoCompact. */
  autoCompact?: AutoCompactView
  onSetAutoCompactWindow?: (value: WindowChoice) => void
  /** The session is stopped, so a manual compact may start now. */
  canCompact?: boolean
  onCompact?: () => void
  className?: string
  /** False while this thread is mounted but hidden (another session is in
   *  front). The popover and tooltip are portaled to <body>, so left open
   *  they would stay on screen with a `display:none` anchor — measured as a
   *  zero rect, which pins them to the window's top-left corner. */
  isForeground?: boolean
}) {
  const t = useT()
  const resetText = usePlanResetText()
  const formatAmount = useFormatAmount()
  const [open, setOpenState] = useState(false)
  const setOpen = (next: boolean) => {
    if (next && !open) onPlanUsageOpen?.()
    setOpenState(next)
  }
  const [tooltipOpen, setTooltipOpen] = useState(false)
  // Hidden thread: close both (see `isForeground`), so switching back does
  // not resurrect them either.
  useEffect(() => {
    if (isForeground) return
    setOpenState(false)
    setTooltipOpen(false)
  }, [isForeground])
  // Read every render, not memoized: the figures table is mutated in place
  // when a catalog is configured (see `catalog`), and each lookup is O(1).
  const window = contextWindowOf(modelId, providerId)
  // The trigger's threshold at the user's window (settings / `/autocompact`)
  // when one is set. The test-only `autoCompactTokenThreshold` override lives
  // in worker settings the composer does not see.
  const savedChoice: WindowChoice = autoCompact?.windowTokens ?? 'auto'
  // The handle's drag preview, then the value just saved until the snapshot
  // carries it (or the save fails) — so the handle does not jump back.
  const [previewChoice, setPreviewChoice] = useState<WindowChoice | null>(null)
  const [pendingChoice, setPendingChoice] = useState<WindowChoice | null>(null)
  const saveError = autoCompact?.saveError
  useEffect(() => {
    if (pendingChoice === null) return
    if (pendingChoice === savedChoice) {
      setPendingChoice(null)
      return
    }
    // A save the snapshot never reflects (failed, or another file decides)
    // stops holding the handle after a moment.
    const timer = setTimeout(() => setPendingChoice(null), 3_000)
    return () => clearTimeout(timer)
  }, [pendingChoice, savedChoice, saveError])
  const shownChoice = previewChoice ?? pendingChoice ?? savedChoice
  const autoCompactThreshold = thresholdForChoice(shownChoice, modelId, providerId)
  const autoCompactOn = autoCompact?.enabled !== false
  const handleScale = windowSliderScale(modelId, providerId)
  // The handle shows only where a save can take effect, or — read-only — to
  // place a window another settings file decides.
  const showHandle =
    !!onSetAutoCompactWindow
    && !!autoCompact?.canSave
    && autoCompactOn
    && handleScale.usable
  const handleLocked = !!autoCompact?.lockedBy
  // The O(messages) walk, keyed on what it reads alone. A catalog arriving is
  // no reason to re-run it — worker snapshots are structured-cloned, so the
  // catalog is a new object on every state push, changed or not.
  const used = useMemo(() => {
    const liveUsage = getLiveUsage(liveEvents)
    if (liveUsage && typeof liveUsage.input_tokens === 'number') {
      // Full context size; same input + cache + output sum the compact
      // boundary uses. Relies on the bridge's exclusive-input convention
      // (cache fields are additive, never a subset of input_tokens).
      return tokensFromUsage(liveUsage)
    }
    return estimateTranscriptTokens(messages)
  }, [messages, liveEvents])
  // The ring, its tooltip and the popover's headline measure usage against
  // the user's auto-compact window — the point it compacts at (the model's
  // window while auto or off): 200k used reads 20% on a 1M model, 40% at a
  // 500k window. It follows the handle while dragging.
  const effectiveWindow = autoCompactOn && shownChoice !== 'auto'
    ? autoCompactThreshold
    : window
  const { pct, barPct, warning, untilAutoCompact } = useMemo(() => {
    const { usedPercentage } = contextUsageShares(used, effectiveWindow)
    return {
      pct: usedPercentage,
      // With the handle, the bar spans the model's whole window so every
      // window can be picked on it; the fill reaching the handle compacts.
      barPct: showHandle
        ? contextUsageShares(used, window).usedPercentage
        : usedPercentage,
      warning: tokenWarningLevel(used, {
        modelOptions: { contextWindowSize: effectiveWindow },
      }),
      untilAutoCompact: Math.max(0, autoCompactThreshold - used),
    }
  }, [used, window, effectiveWindow, showHandle, autoCompactThreshold])

  const cachePct = useMemo(
    () => getLastTurnCachePct(messages, liveEvents, isStreaming),
    [messages, liveEvents, isStreaming],
  )
  const showCache = cachePct > 0

  const strokeColor =
    warning === 'danger'
      ? 'stroke-destructive'
      : warning === 'warning'
        ? 'stroke-warning'
        : 'stroke-primary'
  const barTone =
    warning === 'danger'
      ? 'destructive'
      : warning === 'warning'
        ? 'warning'
        : 'primary'

  // Only the part of the usage that meters THIS model, on every surface —
  // the trigger, its tooltip and the popover. OpenRouter's free-request
  // allowance meters free models alone: shown beside a paid model it reads
  // as if the paid model were free (and a free model shows that allowance
  // only). A provider without the rule passes through whole.
  const modelUsage = planUsage
    ? usageForModel(providerId, planUsage, { free: modelFree })
    : undefined
  const windows = modelUsage?.windows ?? []
  const amounts = modelUsage?.amounts ?? []
  const balanceNote = modelUsage?.balanceNote
  // Reset countdowns are minute-grained; a render-time clock is fresh enough
  // (the surface re-renders on open and on every transcript/live update).
  const now = Date.now()

  const size = 18
  const stroke = 2.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - Math.min(1, pct / 100))

  const fraction = {
    used: compactTokenCount(used),
    window: compactTokenCount(effectiveWindow),
    pct: pct.toFixed(0),
  }
  // The hover summary is at most three short lines; the popover (a click
  // away) carries every window and figure with its bar.
  //   1. the quota that matters most — the most-used window, the soonest
  //      reset breaking a tie — with when it resets;
  //   2. context · last-turn cache;
  //   3. the money figures as the provider summarises them (OpenRouter:
  //      balance and key limit as one Available), then spend. Why a balance
  //      is missing stays in the popover's (?).
  const headlineWindow = [...windows].sort(
    (a, b) =>
      b.usedPercent - a.usedPercent ||
      (a.resetsAt ?? Number.POSITIVE_INFINITY) -
        (b.resetsAt ?? Number.POSITIVE_INFINITY),
  )[0]
  const quotaLine = headlineWindow
    ? [
        t('tokenUsage.windowHeadline', {
          pct: headlineWindow.usedPercent.toFixed(0),
          window: t(windowLabelKey(headlineWindow, true)),
        }),
        resetText(headlineWindow.resetsAt, now),
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined
  // The tooltip shows the provider's one-line summary of the money figures
  // (OpenRouter: balance and key limit as one Available); the popover below
  // keeps every figure.
  const summaryAmounts = modelUsage
    ? usageSummary(providerId, modelUsage).amounts ?? []
    : []
  const moneyLine = summaryAmounts
    .map((a) =>
      t('tokenUsage.amountSummary', {
        label: t(amountLabelKey(a)),
        amount: formatAmount(a),
      }),
    )
    .join(' · ')
  // A limit that meters THIS model is used up — a quota window at 100%
  // (5-hour, daily, weekly, monthly) or a money figure known to be at or
  // below zero (OpenRouter: the balance or the key limit). The next request
  // will fail, so the trigger says so before it is opened. Unknown is not
  // zero, and a quota that meters other models (OpenRouter's free-request
  // allowance, for a paid model) does not count. Read from the model's whole
  // usage, not the summary: a summary may leave a figure out (OpenRouter
  // drops a lone key limit), and a used-up limit still fails the request.
  const limitReached = modelUsage ? isUsageExhausted(modelUsage) : false
  const triggerLabel = showCache
    ? t('tokenUsage.contextUsedCached', {
        pct: fraction.pct,
        cachePct: String(cachePct),
      })
    : t('tokenUsage.contextUsed', { pct: fraction.pct })

  return (
    <Popover open={open && isForeground} onOpenChange={setOpen}>
      <Tooltip open={tooltipOpen && isForeground} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'group flex h-8 items-center justify-center gap-1.5 rounded-full cursor-pointer select-none transition-colors',
                limitReached
                  ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                  : 'hover:bg-accent hover:text-accent-foreground',
                showCache ? 'pl-2.5 pr-[7px]' : 'w-8',
                isStreaming && 'animate-pulse',
                className,
              )}
              aria-label={
                limitReached
                  ? t('tokenUsage.withLimitReached', { label: triggerLabel })
                  : triggerLabel
              }
              data-limit-reached={limitReached || undefined}
              data-testid="composer-context-usage"
            >
              {showCache && (
                <span
                  className={cn(
                    'flex items-center gap-1 text-xs font-medium tabular-nums',
                    limitReached
                      ? 'text-destructive'
                      : 'text-muted-foreground group-hover:text-accent-foreground',
                  )}
                  aria-hidden="true"
                  data-testid="composer-cache-ratio"
                >
                  <ZapIcon className="size-3 shrink-0 opacity-70" />
                  {t('tokenUsage.percent', { pct: String(cachePct) })}
                </span>
              )}
              <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                className="-rotate-90"
                aria-hidden="true"
              >
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  strokeWidth={stroke}
                  className="stroke-muted"
                />
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className={cn(
                    'transition-[stroke-dashoffset] duration-300',
                    strokeColor,
                  )}
                />
              </svg>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {/* The hover summary yields to the open popover, which says more. */}
        {!open && (
          <TooltipContent
            side="bottom"
            align="end"
            className="text-xs"
            data-testid="composer-context-tooltip"
          >
            {quotaLine && (
              <div
                className="font-medium tabular-nums"
                data-testid="composer-plan-tooltip-line"
              >
                {quotaLine}
              </div>
            )}
            <div
              className={cn('tabular-nums', quotaLine ? 'opacity-70' : 'font-medium')}
              data-testid="composer-context-tooltip-line"
            >
              {t('tokenUsage.contextSummary', fraction)}
              {showCache && (
                <span data-testid="composer-cache-summary">
                  {' · '}
                  {t('tokenUsage.cacheHeadline', { pct: String(cachePct) })}
                </span>
              )}
            </div>
            {moneyLine && (
              <div
                className="opacity-70 tabular-nums"
                data-testid="composer-money-tooltip-line"
              >
                {moneyLine}
              </div>
            )}
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        // Every row is one label and one figure: let the card grow to fit
        // (w-80 floor) instead of wrapping "886k until auto-compact" or
        // "Weekly · all models" in two. The Radix popper wrapper is
        // `min-width: max-content`, so w-auto already lays each row out on
        // one line; only at the viewport cap (a narrow window, the remote
        // client, a long translation) do rows wrap — a forced nowrap there
        // pushed the figures out of the card.
        className="w-auto min-w-80 max-w-[calc(100vw-2rem)] p-0 text-sm"
        data-testid="composer-context-popover"
        // Escape mid-drag (or over unsaved keys) cancels the handle's preview,
        // not the popover. The layer hears Escape first (document, capture).
        onEscapeKeyDown={e => {
          if (previewChoice !== null) e.preventDefault()
        }}
      >
        <div className="space-y-2 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">
              {t('tokenUsage.contextWindow')}
            </span>
            <span
              className="tabular-nums text-muted-foreground"
              data-testid="composer-context-fraction"
            >
              {t('tokenUsage.contextFraction', fraction)}
            </span>
          </div>
          <div className="relative">
            <ProgressBar
              pct={barPct}
              tone={barTone}
              label={t('tokenUsage.contextWindow')}
            />
            {showHandle && (
              <AutoCompactHandle
                scale={handleScale}
                modelId={modelId}
                providerId={providerId}
                usedTokens={used}
                value={pendingChoice ?? savedChoice}
                disabled={handleLocked}
                format={compactTokenCount}
                onPreview={setPreviewChoice}
                onCommit={choice => {
                  setPendingChoice(choice)
                  onSetAutoCompactWindow?.(choice)
                }}
              />
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span
              className={cn(
                'tabular-nums',
                autoCompactOn && untilAutoCompact === 0 && 'text-warning',
              )}
              data-testid="composer-until-auto-compact"
            >
              {!autoCompactOn
                ? t('tokenUsage.autoCompactOff')
                : untilAutoCompact === 0
                  ? t('tokenUsage.autoCompactNextMessage')
                  : t('tokenUsage.untilAutoCompact', {
                      amount: compactTokenCount(untilAutoCompact),
                    })}
            </span>
            {onCompact && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canCompact}
                data-testid="composer-compact-session"
                onClick={() => {
                  setOpen(false)
                  onCompact()
                }}
              >
                {t('tokenUsage.compactSession')}
              </Button>
            )}
          </div>
          {showHandle && handleLocked && (
            <div
              className="text-xs text-muted-foreground"
              data-testid="composer-auto-compact-locked"
            >
              {t(
                autoCompact?.lockedBy === 'policySettings'
                  ? 'tokenUsage.autoCompactLockedManaged'
                  : autoCompact?.lockedBy === 'flagSettings'
                    ? 'tokenUsage.autoCompactLockedFlag'
                    : 'tokenUsage.autoCompactLockedProject',
              )}
            </div>
          )}
          {showHandle && saveError && (
            <div
              className="text-xs text-destructive"
              data-testid="composer-auto-compact-error"
            >
              {t('tokenUsage.autoCompactSaveFailed', { error: saveError })}
            </div>
          )}
        </div>
        {(windows.length > 0 || amounts.length > 0 || balanceNote) && (
          <div
            className="space-y-2 border-t p-3"
            data-testid="composer-plan-usage"
          >
            <div className="text-muted-foreground">
              {planUsage?.planName
                ? t('tokenUsage.planUsageLimitsNamed', {
                    plan: planUsage.planName,
                  })
                : windows.length > 0
                  ? t('tokenUsage.planUsageLimits')
                  : t('tokenUsage.credits')}
            </div>
            {windows.map((w) => {
              const name = t(windowLabelKey(w, false))
              const reset = resetText(w.resetsAt, now)
              const percent = t('tokenUsage.percent', {
                pct: w.usedPercent.toFixed(0),
              })
              // Used up: the row goes red — name, reset, figure and bar.
              const exhausted = isWindowExhausted(w)
              const rowKey = `${w.kind}-${w.subject ?? 'plan'}`
              const testId = `composer-plan-window-${w.kind}${w.subject ? `-${w.subject}` : ''}`
              const figureClass = cn(
                'tabular-nums',
                exhausted ? 'font-medium' : 'text-muted-foreground',
              )
              return (
                <div
                  key={rowKey}
                  className={cn('space-y-1', exhausted && 'text-destructive')}
                  data-exhausted={exhausted || undefined}
                  data-testid={testId}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span>{name}</span>
                    <span className={figureClass}>
                      {reset ? `${reset}  ${percent}` : percent}
                    </span>
                  </div>
                  <ProgressBar
                    pct={w.usedPercent}
                    tone={exhausted ? 'destructive' : 'primary'}
                    label={name}
                  />
                </div>
              )
            })}
            {balanceNote ? (
              <div className="space-y-0.5" data-testid="composer-plan-balance-note">
                <div className="flex items-baseline justify-between gap-3">
                  <span>{t('tokenUsage.amount.balance')}</span>
                  <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
                    {t('tokenUsage.notAvailable')}
                    {/* Why the balance is missing sits one click away, not
                        inline — it is long and rarely needed twice. */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="cursor-pointer rounded-full hover:text-foreground"
                          aria-label={t('tokenUsage.balanceNote.help')}
                          data-testid="composer-plan-balance-help"
                        >
                          <HelpCircleIcon className="size-3.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="top"
                        align="end"
                        className="w-64 p-2 text-xs text-muted-foreground"
                        data-testid="composer-plan-balance-help-content"
                      >
                        {t(balanceNoteKey(balanceNote))}
                      </PopoverContent>
                    </Popover>
                  </span>
                </div>
              </div>
            ) : null}
            {amounts.map((a) => {
              // A balance or limit at or below zero: the row goes red.
              const exhausted = isAmountExhausted(a)
              return (
                <div
                  key={`${a.kind}-${a.period ?? ''}`}
                  className={cn(
                    'flex items-baseline justify-between gap-3',
                    exhausted && 'text-destructive',
                  )}
                  data-exhausted={exhausted || undefined}
                  data-testid={`composer-plan-amount-${a.kind}${a.period ? `-${a.period}` : ''}`}
                >
                  <span>{t(amountLabelKey(a))}</span>
                  <span className={cn('tabular-nums', exhausted && 'font-medium')}>
                    {formatAmount(a)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
