// Plan usage limits: `PlanUsageSnapshot` is the provider-neutral shape the composer
// renders (quota windows, money amounts). Reading a provider's document is its own
// `usage.ts`; no source or nothing parsed is `undefined`.

/** The quota windows the UI knows how to label (one catalog string each). */
export type PlanUsageWindowKind = 'five_hour' | 'daily' | 'weekly' | 'monthly'

/**
 * Where one window's figures sit (dot paths). The used share is the first that
 * resolves: `usedPercent`, `used` / `limit`, (`limit` − `remaining`) / `limit`.
 * `resetsAt` may be an ISO-8601 string, epoch seconds or epoch ms.
 */
export type NexusPlanUsageWindowMapping = {
  kind: PlanUsageWindowKind
  usedPercent?: string
  used?: string
  limit?: string
  remaining?: string
  resetsAt?: string
}

export type PlanUsageMapping = {
  /** GET path, relative to the provider's base URL, returning JSON. */
  path: string
  /** Dot path of the plan's display name (`Max (5x)`), when the vendor reports one. */
  planName?: string
  windows: NexusPlanUsageWindowMapping[]
}

export type PlanUsageWindow = {
  kind: PlanUsageWindowKind
  /**
   * What the window counts when it is not the plan's own quota — labelled
   * apart so two `daily` windows never read the same. Absent = the plan quota.
   */
  subject?: 'free_requests'
  /** 0–100, clamped. */
  usedPercent: number
  /** Epoch ms of the next reset, when known. */
  resetsAt?: number
}

/** Money figures the UI labels (one catalog string each). */
export type PlanUsageAmountKind =
  /** Prepaid credit left on the account. */
  | 'balance'
  /** What is left of a spending cap (OpenRouter's per-key `limit`). */
  | 'limit_remaining'
  /** Spent over `period`. */
  | 'spent'
  /**
   * What can be spent right now — a provider's summary of its money figures
   * for the hover surfaces (`ProviderModelDisplay.usageSummary`), e.g. the
   * least of OpenRouter's balance and key limit. Never in a full snapshot.
   */
  | 'available'

export type PlanUsageAmount = {
  kind: PlanUsageAmountKind
  amount: number
  /** ISO 4217; the gateways bill in US dollars. */
  currency: 'USD'
  /** For `spent`: the span it covers. */
  period?: 'day' | 'week' | 'month' | 'total'
}

export type PlanUsageSnapshot = {
  planName?: string
  windows: PlanUsageWindow[]
  /** Money figures, shown after the windows. Absent = none. */
  amounts?: PlanUsageAmount[]
  /**
   * Why the account balance is missing, for a provider whose balance needs a
   * credential of its own (`ProviderDefinition.balance`): `needs_key` — none
   * is stored; `unavailable` — the read failed (a wrong or revoked key). The
   * UI says so instead of leaving a key's spending cap as the only money
   * figure, which reads like a balance. Absent = no balance to explain.
   */
  balanceNote?: PlanUsageBalanceNote
}

export type PlanUsageBalanceNote = 'needs_key' | 'unavailable'

/** A quota window that is used up: requests it meters fail until it resets. */
export function isWindowExhausted(w: PlanUsageWindow): boolean {
  return w.usedPercent >= 100
}

/** A money figure that bounds spending and is known to be at or below zero.
 *  Spend figures never exhaust anything; an unknown balance is not zero. */
export function isAmountExhausted(a: PlanUsageAmount): boolean {
  return (a.kind === 'balance' || a.kind === 'limit_remaining' || a.kind === 'available') && a.amount <= 0
}

/** Any limit in the snapshot is used up — the next request it meters fails. */
export function isUsageExhausted(usage: PlanUsageSnapshot): boolean {
  return usage.windows.some(isWindowExhausted) || (usage.amounts ?? []).some(isAmountExhausted)
}

function readPath(doc: unknown, path: string | undefined): unknown {
  if (!path) return undefined
  let cur: unknown = doc
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function readNumber(doc: unknown, path: string | undefined): number | undefined {
  const v = readPath(doc, path)
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

// Epoch seconds and epoch ms are told apart by magnitude: 1e11 s is the year
// 5138, 1e11 ms is 1973 — no real reset time falls on the wrong side.
function readTimestamp(doc: unknown, path: string | undefined): number | undefined {
  const v = readPath(doc, path)
  if (typeof v === 'string') {
    const asNum = Number(v)
    if (v.trim() !== '' && Number.isFinite(asNum)) return toEpochMs(asNum)
    const parsed = Date.parse(v)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return typeof v === 'number' && Number.isFinite(v) ? toEpochMs(v) : undefined
}

function toEpochMs(n: number): number {
  return n < 1e11 ? n * 1000 : n
}

function resolveUsedPercent(
  doc: unknown,
  m: NexusPlanUsageWindowMapping,
): number | undefined {
  const direct = readNumber(doc, m.usedPercent)
  if (direct !== undefined) return direct
  const limit = readNumber(doc, m.limit)
  if (limit === undefined || limit <= 0) return undefined
  const used = readNumber(doc, m.used)
  if (used !== undefined) return (used / limit) * 100
  const remaining = readNumber(doc, m.remaining)
  if (remaining !== undefined) return ((limit - remaining) / limit) * 100
  return undefined
}

/**
 * Normalize a usage document through a `PlanUsageMapping`.
 * Windows whose figures don't resolve are dropped; no window → `undefined`.
 */
export function parsePlanUsage(
  config: PlanUsageMapping,
  doc: unknown,
): PlanUsageSnapshot | undefined {
  const windows: PlanUsageWindow[] = []
  for (const m of config.windows) {
    const pct = resolveUsedPercent(doc, m)
    if (pct === undefined) continue
    const resetsAt = readTimestamp(doc, m.resetsAt)
    windows.push({
      kind: m.kind,
      usedPercent: Math.min(100, Math.max(0, pct)),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    })
  }
  if (windows.length === 0) return undefined
  const name = readPath(doc, config.planName)
  return {
    ...(typeof name === 'string' && name.trim() ? { planName: name.trim() } : {}),
    windows,
  }
}

/**
 * How a reset time is worded: under a day away → relative (`in 2 hr 56 min`);
 * further → weekday + clock (`Tue 7:00 AM`). Returned as data so the view
 * picks the catalog string and the locale formats the clock.
 */
export type PlanUsageResetLabel =
  | { kind: 'relative'; hours: number; minutes: number }
  | { kind: 'absolute'; at: number }

export function describePlanUsageReset(
  resetsAt: number,
  now: number,
): PlanUsageResetLabel {
  const ms = Math.max(0, resetsAt - now)
  // Decide on the rounded figure, not raw ms: 23h59m30s rounds up to 24 h,
  // which must read as the weekday form, never "24 hr 0 min".
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin >= 24 * 60) return { kind: 'absolute', at: resetsAt }
  return { kind: 'relative', hours: Math.floor(totalMin / 60), minutes: totalMin % 60 }
}
