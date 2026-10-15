/**
 * A teammate's DISPLAY name is free text shown to the user; its MEMBER KEY is
 * the ASCII slug for its session id, mailbox directory and frame addresses.
 * Derived deterministically from the display name, made unique among the
 * lead's running teammates; not persisted.
 */
import { sanitizeTeamId } from './TeamRegistry'

/** Cap on a display name, in code points. */
export const MAX_MEMBER_DISPLAY_NAME_CHARS = 64

/** Keys with a fixed meaning in the frame grammar and member resolution. */
export const RESERVED_MEMBER_KEYS: ReadonlySet<string> = new Set([
  'team-lead',
  'lead',
])

/** Key grammar: what `deriveMemberKeyBase` produces and the frame parser
 *  accepts. `sanitizeTeamId` already yields exactly this alphabet. */
export const MEMBER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Control characters and the characters the rendered frame header uses as
 * structure: `[ ]` delimit it, `( )` set the key off from the display name,
 * `< > "` would matter inside the untrusted XML-ish envelope, and a
 * backslash is dropped so nothing can be read as an escape.
 */
// eslint-disable-next-line no-control-regex
const DISPLAY_NAME_STRIP = /[\u0000-\u001f\u007f[\]()<>"\\]/g

/**
 * The display name as it will be shown and addressed: trimmed, inner
 * whitespace collapsed, structural characters removed, capped. Null when
 * nothing displayable is left (empty, whitespace, only punctuation).
 */
export function normalizeMemberDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(DISPLAY_NAME_STRIP, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  // Slice by code point, not UTF-16 unit, so a cap never splits a surrogate
  // pair (an emoji or a rare CJK character) into two broken halves.
  return Array.from(cleaned).slice(0, MAX_MEMBER_DISPLAY_NAME_CHARS).join('')
}

/** FNV-1a (32-bit) over code points, as 8 lowercase hex digits. Stable across
 *  runs and platforms; no dependency. */
export function stableHash8(text: string): string {
  let hash = 0x811c9dc5
  for (const ch of text) {
    hash ^= ch.codePointAt(0) ?? 0
    // 32-bit FNV prime multiply, kept in uint32 via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The deterministic key for a display name: an ASCII slug, `m-<hash>` when there
 * is nothing to slug, suffixed when it collides with a reserved key (a teammate
 * can never be addressed as the lead).
 */
export function deriveMemberKeyBase(displayName: string): string {
  const slug = sanitizeTeamId(displayName).slice(0, 40).replace(/-+$/g, '')
  if (!slug) return `m-${stableHash8(displayName)}`
  if (RESERVED_MEMBER_KEYS.has(slug)) return `${slug}-${stableHash8(displayName)}`
  return slug
}

/**
 * A key for `displayName` that is not in `taken`. The base first; then the
 * base with the name's hash (two different display names slugging to the
 * same base — `Bob` and `bob` — separate here); then a counter, so the
 * function always terminates with something unique.
 */
export function allocateMemberKey(
  displayName: string,
  taken: ReadonlySet<string>,
): string {
  const base = deriveMemberKeyBase(displayName)
  if (!taken.has(base)) return base
  const hashed = `${base}-${stableHash8(displayName)}`
  if (!taken.has(hashed)) return hashed
  for (let n = 2; ; n += 1) {
    const candidate = `${hashed}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
