/**
 * Security: shapes a provider's status view from what its module left in
 * `$.store` (F-27). The stored value is untrusted input. Only the declared
 * keys are read, each through its declared format; a value of another type is
 * dropped. Text is cut to a fixed length, a list to its limit, and an entry to
 * a total text budget. Nothing read here is ever markup: the page draws it as
 * text. Pure.
 */
import type {
  ProviderStatusColumn,
  ProviderStatusValueFormat,
  ProviderStatusView,
} from './providerStatusManifest'
import {
  PROVIDER_STATUS_ENTRY_TEXT_BUDGET,
  PROVIDER_STATUS_TEXT_MAX,
  PROVIDER_STATUS_TONES,
  type ProviderStatusCell,
  type ProviderStatusEntry,
  type ProviderStatusRow,
  type ProviderStatusTone,
} from './providerStatusState'

/** The latest instant a `time` value may name (the year 9999). */
const TIME_MAX_MS = 253_402_300_799_999
const DURATION_MAX_MS = 366 * 24 * 60 * 60 * 1000 * 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A stored value read as its own property only (never the prototype's). */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

// Control characters and line separators would let a stored value reshape a
// line of the card.
function isControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

function withoutControls(text: string): string {
  let out = ''
  let from = 0
  for (let i = 0; i < text.length; i++) {
    if (!isControl(text.charCodeAt(i))) continue
    out += `${text.slice(from, i)} `
    from = i + 1
  }
  return from === 0 ? text : out + text.slice(from)
}

function clipText(value: unknown, budget: { left: number }): string | undefined {
  let text: string
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value)
  else if (typeof value === 'boolean') text = String(value)
  else return undefined
  text = withoutControls(text)
  if (text.length > PROVIDER_STATUS_TEXT_MAX) text = `${text.slice(0, PROVIDER_STATUS_TEXT_MAX - 1)}…`
  if (text.trim() === '') return undefined
  budget.left -= text.length
  return text
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readTime(value: unknown): number | undefined {
  let at: number | undefined
  if (typeof value === 'number') at = finite(value)
  else if (typeof value === 'string' && value.length <= 64) {
    const parsed = Date.parse(value)
    at = Number.isFinite(parsed) ? parsed : undefined
  }
  if (at === undefined || at <= 0 || at > TIME_MAX_MS) return undefined
  return Math.trunc(at)
}

function readTone(value: unknown): ProviderStatusTone {
  return (PROVIDER_STATUS_TONES as readonly unknown[]).includes(value) ? (value as ProviderStatusTone) : 'neutral'
}

/** One stored value through its declared format, or `undefined`. */
export function shapeStatusValue(
  format: ProviderStatusValueFormat,
  value: unknown,
  budget: { left: number } = { left: Number.POSITIVE_INFINITY },
): ProviderStatusCell | undefined {
  switch (format) {
    case 'text': {
      const text = clipText(value, budget)
      return text === undefined ? undefined : { format, text }
    }
    case 'count': {
      const n = finite(value)
      return n === undefined ? undefined : { format, value: Math.trunc(n) }
    }
    case 'time': {
      const at = readTime(value)
      return at === undefined ? undefined : { format, at }
    }
    case 'duration': {
      const ms = finite(value)
      return ms === undefined || ms < 0 ? undefined : { format, ms: Math.min(Math.trunc(ms), DURATION_MAX_MS) }
    }
    case 'percent': {
      const n = finite(value)
      return n === undefined ? undefined : { format, value: Math.min(100, Math.max(0, n)) }
    }
    case 'badge': {
      // Text alone, or `{ text, tone }`.
      const text = clipText(isRecord(value) ? own(value, 'text') : value, budget)
      if (text === undefined) return undefined
      return { format, text, tone: isRecord(value) ? readTone(own(value, 'tone')) : 'neutral' }
    }
  }
}

function shapeList(
  columns: readonly ProviderStatusColumn[],
  limit: number,
  value: unknown,
  budget: { left: number },
): { items: Array<Array<ProviderStatusCell | null>>; total: number } {
  if (!Array.isArray(value)) return { items: [], total: 0 }
  const items: Array<Array<ProviderStatusCell | null>> = []
  for (const raw of value) {
    if (items.length >= limit || budget.left <= 0) break
    if (!isRecord(raw)) continue
    const cells = columns.map(column => shapeStatusValue(column.format, own(raw, column.key), budget) ?? null)
    if (cells.some(cell => cell !== null)) items.push(cells)
  }
  return { items, total: value.length }
}

/**
 * The entry the page draws for `view`, from `stored` (the value under the
 * view's store key). Every declared field gets a row, in the declared order,
 * with or without a value.
 */
export function shapeProviderStatus(view: ProviderStatusView, stored: unknown, readAt: number): ProviderStatusEntry {
  const source = isRecord(stored) ? stored : undefined
  const budget = { left: PROVIDER_STATUS_ENTRY_TEXT_BUDGET }
  const rows: ProviderStatusRow[] = view.fields.map(field => {
    const value = source ? own(source, field.key) : undefined
    if (field.format === 'list') {
      const { items, total } = shapeList(field.columns, field.limit, value, budget)
      return { key: field.key, label: field.label, kind: 'list', columns: field.columns.map(c => ({ ...c })), items, total }
    }
    const cell = shapeStatusValue(field.format, value, budget)
    return { key: field.key, label: field.label, kind: 'value', ...(cell ? { cell } : {}) }
  })
  return {
    rows,
    actions: (view.actions ?? []).map(action => ({ job: action.job, label: action.label })),
    readAt,
    ...(source ? {} : { empty: true }),
  }
}
