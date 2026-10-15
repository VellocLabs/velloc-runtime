import type { ProviderDocumentSource } from '../../providerDefinition'
import type {
  PlanUsageSnapshot,
  PlanUsageWindow,
  PlanUsageWindowKind,
} from '../../../../models/usage/planUsage'
import { finiteNumber, isRecord } from '../shared/listing'

/**
 * Kimi Code's `GET /usages`, in three shapes, any subset present: the `usages` map
 * (read first; the only one carrying the monthly pool), `limits` windows, and the
 * weekly `usage` total. Counts are decimal strings; resets ISO strings.
 */

const UNIT_MINUTES: Record<string, number> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 24 * 60,
}

/** A window's length in minutes → the kind the page names. */
function kindOfMinutes(minutes: number): PlanUsageWindowKind | undefined {
  if (minutes === 5 * 60) return 'five_hour'
  if (minutes === 24 * 60) return 'daily'
  if (minutes === 7 * 24 * 60) return 'weekly'
  if (minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60) return 'monthly'
  return undefined
}

/** A `usages` pool name → its kind: `limit_5h`, `limit_7d`, `limit_month_*`. */
function kindOfPool(name: string): PlanUsageWindowKind | undefined {
  if (/^limit_month/.test(name)) return 'monthly'
  const m = /^limit_(\d+)([hd])$/.exec(name)
  if (!m) return undefined
  return kindOfMinutes(Number(m[1]) * (m[2] === 'h' ? 60 : 24 * 60))
}

/** ISO with up to nanoseconds (`…13.716839300Z`) or epoch s / ms. */
function resetOf(row: Record<string, unknown>): number | undefined {
  for (const key of ['reset_time', 'resetTime', 'reset_at', 'resetAt']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) {
      const at = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))
      if (Number.isFinite(at)) return at
    }
    const n = finiteNumber(value)
    if (n !== undefined) return n < 1e11 ? n * 1000 : n
  }
  return undefined
}

/** A count row's share used, 0–100: `used`, else `limit - remaining`. */
function countPercent(row: Record<string, unknown>): number | undefined {
  const limit = finiteNumber(row.limit)
  if (limit === undefined || limit <= 0) return undefined
  const used = finiteNumber(row.used)
  if (used !== undefined) return (used / limit) * 100
  const remaining = finiteNumber(row.remaining)
  return remaining !== undefined ? ((limit - remaining) / limit) * 100 : undefined
}

function window(kind: PlanUsageWindowKind, pct: number, resetsAt: number | undefined): PlanUsageWindow {
  return {
    kind,
    usedPercent: Math.min(100, Math.max(0, pct)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

export function parseKimiUsage(document: unknown): PlanUsageSnapshot | undefined {
  if (!isRecord(document)) return undefined
  const byKind = new Map<PlanUsageWindowKind, PlanUsageWindow>()
  const add = (w: PlanUsageWindow | undefined) => {
    if (w && !byKind.has(w.kind)) byKind.set(w.kind, w)
  }

  // 1. The pools. Two monthly pools (`limit_month_total`, `limit_month_code`)
  //    are one period: the total is the one that runs out first.
  const pools = isRecord(document.usages) ? document.usages : {}
  const poolNames = Object.keys(pools).sort((a, b) =>
    a === 'limit_month_total' ? -1 : b === 'limit_month_total' ? 1 : a.localeCompare(b),
  )
  for (const name of poolNames) {
    const pool = pools[name]
    const kind = kindOfPool(name)
    const ratio = isRecord(pool) ? finiteNumber(pool.used_ratio) : undefined
    if (!kind || ratio === undefined || !isRecord(pool)) continue
    add(window(kind, ratio * 100, resetOf(pool)))
  }

  // 2. The count windows, by their stated length.
  for (const item of Array.isArray(document.limits) ? document.limits : []) {
    if (!isRecord(item)) continue
    const detail = isRecord(item.detail) ? item.detail : item
    const span = isRecord(item.window) ? item.window : item
    const duration = finiteNumber(span.duration)
    const unit = typeof span.timeUnit === 'string' ? UNIT_MINUTES[span.timeUnit] : undefined
    const kind = duration !== undefined && unit !== undefined ? kindOfMinutes(duration * unit) : undefined
    const pct = countPercent(detail)
    if (kind && pct !== undefined) add(window(kind, pct, resetOf(detail)))
  }

  // 3. The summary: the weekly total.
  if (isRecord(document.usage)) {
    const pct = countPercent(document.usage)
    if (pct !== undefined) add(window('weekly', pct, resetOf(document.usage)))
  }

  if (byKind.size === 0) return undefined
  const order: PlanUsageWindowKind[] = ['five_hour', 'daily', 'weekly', 'monthly']
  return { windows: order.flatMap(kind => (byKind.has(kind) ? [byKind.get(kind)!] : [])) }
}

export const kimiUsage: ProviderDocumentSource<PlanUsageSnapshot | undefined> = {
  path: '/usages',
  parse: document => parseKimiUsage(document),
}
