import { createHash } from 'node:crypto'

/**
 * Trace normalization, the only differences a replay tolerates: ids map to ordinal `<id:n>` placeholders in
 * first-seen order (also inside longer strings); ISO instants and timestamp-named numeric fields are zeroed.
 * Error messages, execution order and persisted content are not normalized.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** Ids minted by the replay runtime config (`id-<n>`), by the fallback
 *  generator (`uuid-<hex>-<hex>`) and the transport's stream ids. */
const MINTED_RE = /\b(?:id-\d+|uuid-[0-9a-f]+-[0-9a-f]+|stream-\d+)\b/g
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g
const ZERO_ISO = '1970-01-01T00:00:00.000Z'
const TIMESTAMP_KEYS = new Set([
  'timestamp',
  'deadlineMs',
  'startedAt',
  'createdAt',
  'updatedAt',
  'askedAtMs',
])

export function normalizeTrace<T>(trace: T): T {
  const ids = new Map<string, string>()
  const placeholder = (id: string) => {
    let p = ids.get(id)
    if (!p) {
      p = `<id:${ids.size + 1}>`
      ids.set(id, p)
    }
    return p
  }
  const normalizeString = (s: string): string =>
    s.replace(UUID_RE, m => placeholder(m.toLowerCase())).replace(MINTED_RE, m => placeholder(m)).replace(ISO_RE, ZERO_ISO)
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') return normalizeString(value)
    if (typeof value === 'number') return key !== undefined && TIMESTAMP_KEYS.has(key) ? 0 : value
    if (Array.isArray(value)) return value.map(v => walk(v))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[normalizeString(k)] = walk(v, k)
      return out
    }
    return value
  }
  return walk(trace) as T
}

/** Strings longer than this are stored by digest. */
export const LONG_TEXT_CHARS = 120

/**
 * A fixture never holds long text verbatim (prompts, context blocks, tool
 * descriptions, message content, summaries): every string longer than
 * LONG_TEXT_CHARS becomes `{ digest: <sha256 hex>, chars: <length> }`.
 * Equality is still exact; short strings stay readable. Runs after
 * normalizeTrace, so the digest is taken over the normalized text.
 */
export function digestLongTexts<T>(trace: T): T {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.length > LONG_TEXT_CHARS ? { digest: createHash('sha256').update(value, 'utf8').digest('hex'), chars: value.length } : value
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = walk(v)
      return out
    }
    return value
  }
  return walk(trace) as T
}
