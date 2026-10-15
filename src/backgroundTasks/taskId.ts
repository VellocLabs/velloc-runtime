/**
 * Kind-prefixed background-task ids: a 1-char prefix encodes the kind. The
 * `taskId` is the public, model-facing handle and registry key, distinct from
 * the task's internal native id. Random part from the platform CSPRNG, else
 * `Math.random`.
 */

import type { NexusTaskKind } from '../browser/bridge/protocol/ui'

/** One-char id prefix per kind (extensible — future kinds add an entry). */
const KIND_LETTER: Record<NexusTaskKind, string> = {
  local_agent: 'a',
  local_bash: 'b',
  local_fork: 'f',
  local_fast: 'c',
  local_routine: 'r',
  // run_js worker runs (`JsWorker`). The public id is the tool call id (so the
  // conversation card can jump to the drawer without correlating a minted id),
  // so `mintTaskHandle('local_js')` is never actually called for this kind —
  // the entry exists only to keep this Record exhaustive over NexusTaskKind.
  local_js: 'j',
  // SuperShell invocations — minted, since the model reads them with TaskOutput.
  // Not `s`: native sub-agent ids start `subagent-`, and `taskKindFromId` is
  // prefix-only.
  local_supershell: 'h',
}

// Case-insensitive-safe alphabet (digits + lowercase).
const ID_DIGITS_BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const TASK_ID_RANDOM_LEN = 8

/**
 * Regex character class matching every known task-id PREFIX (e.g. `[ab]`), built
 * from `KIND_LETTER` so adding a task kind extends it automatically. Callers
 * that scan text for a public task id must derive their pattern from this instead
 * of hardcoding the prefixes (which silently stops matching a new kind).
 */
export const TASK_ID_PREFIX_CLASS = `[${Object.values(KIND_LETTER).join('')}]`

/**
 * Unanchored regex SOURCE matching a full public task id: a known kind prefix +
 * `TASK_ID_RANDOM_LEN` base36 chars (e.g. `a3x9f2k1`, `b7g0abcd`). Wrap in a
 * `RegExp` with whatever surrounding context/anchors the call site needs.
 */
export const TASK_ID_PATTERN = `${TASK_ID_PREFIX_CLASS}[0-9a-z]{${TASK_ID_RANDOM_LEN}}`

/** The id prefix for a kind; `x` for an unknown kind (defensive). */
export function kindLetterOf(kind: NexusTaskKind): string {
  return KIND_LETTER[kind] ?? 'x'
}

/** Fill `out` with random bytes via the platform CSPRNG, else `Math.random`. */
function fillRandomBytes(out: Uint8Array): void {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(out)
    return
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.floor(Math.random() * 256)
  }
}

/** A fresh task id: kind prefix + 8 base36 chars (e.g. `a3x9f2k1`, `b7g0...`). */
export function mintTaskHandle(kind: NexusTaskKind): string {
  const bytes = new Uint8Array(TASK_ID_RANDOM_LEN)
  fillRandomBytes(bytes)
  let id = kindLetterOf(kind)
  for (let i = 0; i < TASK_ID_RANDOM_LEN; i++) {
    id += ID_DIGITS_BASE36[bytes[i]! % ID_DIGITS_BASE36.length]
  }
  return id
}

/** Recover the kind from a task id's prefix; null if it matches no known kind. */
export function taskKindFromId(id: string): NexusTaskKind | null {
  const prefix = id.charAt(0)
  for (const kind of Object.keys(KIND_LETTER) as NexusTaskKind[]) {
    if (KIND_LETTER[kind] === prefix) return kind
  }
  return null
}
