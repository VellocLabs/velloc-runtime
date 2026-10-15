import type { ProviderDocumentSource } from '../../providerDefinition'
import type {
  PlanUsageAmount,
  PlanUsageSnapshot,
  PlanUsageWindow,
  PlanUsageWindowKind,
} from '../../../../models/usage/planUsage'
import { finiteNumber, isRecord } from '../shared/listing'

/**
 * `GET /key`: the key's own figures (spending cap and its reset, daily / weekly /
 * monthly spend, the free-model request allowance), in US dollars. Not the account
 * balance (`openrouterBalance`). A capped key with a reset is a quota window.
 */
const RESET_KINDS: Record<string, PlanUsageWindowKind> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
}

/** The next UTC day / Monday / first-of-month boundary after `now`. */
export function nextUtcBoundary(kind: PlanUsageWindowKind, now: number): number | undefined {
  const d = new Date(now)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  if (kind === 'daily') return Date.UTC(y, m, day + 1)
  if (kind === 'weekly') {
    // getUTCDay: 0 = Sunday … 6 = Saturday; the week starts on Monday.
    const daysToMonday = ((8 - d.getUTCDay()) % 7) || 7
    return Date.UTC(y, m, day + daysToMonday)
  }
  if (kind === 'monthly') return Date.UTC(y, m + 1, 1)
  return undefined
}

/** The host secret holding the optional OpenRouter management key. */
export const OPENROUTER_MANAGEMENT_KEY_SECRET = 'management_key'

/**
 * `GET /credits`: the ACCOUNT's balance, readable only with the optional management
 * key. A key's `limit_remaining` is a spending cap, not money. The balance can be
 * negative, so it is not clamped.
 */
export const openrouterBalance: ProviderDocumentSource<PlanUsageAmount[]> = {
  path: '/credits',
  headers: { authorization: `Bearer {{secret:${OPENROUTER_MANAGEMENT_KEY_SECRET}}}` },
  parse(document) {
    const data = isRecord(document) && isRecord(document.data) ? document.data : undefined
    if (!data) throw new Error('the credits document has no data object')
    const total = finiteNumber(data.total_credits)
    const used = finiteNumber(data.total_usage)
    if (total === undefined || used === undefined) {
      throw new Error('the credits document has no total_credits / total_usage')
    }
    return [{ kind: 'balance', amount: total - used, currency: 'USD' }]
  },
}

export const openrouterUsage: ProviderDocumentSource<PlanUsageSnapshot | undefined> = {
  path: '/key',
  parse(document, now) {
    const data = isRecord(document) && isRecord(document.data) ? document.data : undefined
    if (!data) throw new Error('the key document has no data object')
    const windows: PlanUsageWindow[] = []
    const amounts: PlanUsageAmount[] = []

    const limit = finiteNumber(data.limit)
    const remaining = finiteNumber(data.limit_remaining)
    const resetKind = typeof data.limit_reset === 'string' ? RESET_KINDS[data.limit_reset] : undefined
    if (limit !== undefined && limit > 0 && remaining !== undefined) {
      if (resetKind) {
        const resetsAt = nextUtcBoundary(resetKind, now)
        windows.push({
          kind: resetKind,
          usedPercent: Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100)),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        })
      }
      amounts.push({ kind: 'limit_remaining', amount: Math.max(0, remaining), currency: 'USD' })
    }

    const free = isRecord(data.free_model_daily_requests) ? data.free_model_daily_requests : undefined
    const freeLimit = finiteNumber(free?.limit)
    const freeUsed = finiteNumber(free?.used)
    if (data.is_free_tier === true && freeLimit !== undefined && freeLimit > 0 && freeUsed !== undefined) {
      windows.push({
        kind: 'daily',
        subject: 'free_requests',
        usedPercent: Math.min(100, Math.max(0, (freeUsed / freeLimit) * 100)),
        resetsAt: nextUtcBoundary('daily', now)!,
      })
    }

    const spentToday = finiteNumber(data.usage_daily)
    if (spentToday !== undefined) amounts.push({ kind: 'spent', amount: spentToday, currency: 'USD', period: 'day' })
    const spentMonth = finiteNumber(data.usage_monthly)
    if (spentMonth !== undefined) amounts.push({ kind: 'spent', amount: spentMonth, currency: 'USD', period: 'month' })

    if (windows.length === 0 && amounts.length === 0) return undefined
    return { windows, ...(amounts.length > 0 ? { amounts } : {}) }
  },
}
