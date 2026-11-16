/**
 * How a `PlanUsageSnapshot`'s figures are named and formatted — shared by the
 * composer's context popover (TokenUsageIndicator), the phone shell's usage
 * sheet and the provider settings page, so a figure reads the same in each.
 */
import {
  describePlanUsageReset,
  type PlanUsageAmount,
  type PlanUsageBalanceNote,
  type PlanUsageWindow,
} from '../../models/usage/planUsage'
import { useLocale, useT } from './i18n'
import type { MessageKey } from './i18n/messages/en'

/** A window's name: its kind, unless it counts something other than the
 *  plan quota (OpenRouter's free-model requests). */
export function windowLabelKey(w: PlanUsageWindow, short: boolean): MessageKey {
  if (w.subject === 'free_requests') {
    return short ? 'tokenUsage.windowShort.freeRequests' : 'tokenUsage.window.freeRequests'
  }
  return `tokenUsage.${short ? 'windowShort' : 'window'}.${w.kind}` as MessageKey
}

/** A quota window's name in the compact form (`5h`, `Month`, `Free req.`):
 *  the quick picker's footer, where each figure is `label value`. */
export function compactWindowLabelKey(w: PlanUsageWindow): MessageKey {
  if (w.subject === 'free_requests') return 'modelPicker.quota.freeRequests'
  return `modelPicker.quota.${w.kind}` as MessageKey
}

/** A money figure's name in the compact form (`Balance`, `Left`, `Today`). */
export function compactAmountLabelKey(a: PlanUsageAmount): MessageKey {
  if (a.kind === 'spent') return `modelPicker.quota.spent_${a.period ?? 'total'}` as MessageKey
  return `modelPicker.quota.${a.kind}` as MessageKey
}

/** A money figure's name: its kind, and for spend the span it covers. */
export function amountLabelKey(a: PlanUsageAmount): MessageKey {
  if (a.kind === 'spent') return `tokenUsage.amount.spent_${a.period ?? 'total'}` as MessageKey
  return `tokenUsage.amount.${a.kind}` as MessageKey
}

/** Why the account balance is missing (`PlanUsageSnapshot.balanceNote`) —
 *  shown where the balance would be, so a key's cap is never the only money
 *  figure on screen. */
export function balanceNoteKey(note: PlanUsageBalanceNote): MessageKey {
  return `tokenUsage.balanceNote.${note}` as MessageKey
}

/** Locale currency formatting (`$95.50`, `95,50 $US`). */
export function useFormatAmount(): (a: PlanUsageAmount) => string {
  const locale = useLocale()
  return a => {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: a.currency,
        maximumFractionDigits: 2,
      }).format(a.amount)
    } catch {
      return `${a.amount.toFixed(2)} ${a.currency}`
    }
  }
}

/** Catalog wording for a window's next reset (see describePlanUsageReset). */
export function usePlanResetText(): (
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
