/**
 * Lite (title) pass for a Codex rollout. Reuses the rollout parser on the
 * head slice — it tolerates a truncated final line — to pull the session id,
 * project dir, created-at and first prompt without reading the whole file.
 *
 * (The AI-generated thread title lives in `state_5.sqlite`, not the rollout
 * head; v1 titles by the first user prompt. Using the DB title is a possible future refinement.)
 */

import type { ImportLiteItem, ImportSessionLiteRow } from '../../protocol'
import { pickSessionTitle } from '../../core/sessionTitle'
import { firstUserPrompt, parseRollout } from './parseRollout'

// The rollout filename (`rollout-<ts>-<uuid>.jsonl`), OR a bare `<uuid>.jsonl`.
// The bare form is what the bridge write-path validates a converted result's id
// against (`sessionIdFor(`${sessionId}.jsonl`)`); the `rollout-` prefix is
// therefore optional. Anchored so a `<uuid>` in the MIDDLE of some other name
// does not match.
const ROLLOUT_FILE_RE =
  /^(?:rollout-.*-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** The Codex thread id a `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` path
 *  (or a bare `<uuid>.jsonl`) names, or null for any other file. */
export function sessionIdFromPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? ''
  const match = ROLLOUT_FILE_RE.exec(name)
  return match ? match[1]!.toLowerCase() : null
}

export function parseLiteItem(item: ImportLiteItem): ImportSessionLiteRow {
  const { items, meta } = parseRollout(item.head)
  const projectPath = meta.cwd
  return {
    source: 'codex',
    path: item.path,
    sessionId: sessionIdFromPath(item.path) ?? meta.id ?? item.path,
    title: pickSessionTitle({ firstPrompt: firstUserPrompt(items) }),
    projectPath,
    createdAt: meta.timestamp,
    mtimeMs: item.mtimeMs,
    size: item.size,
    // Codex has no sidechain files; a rollout with no cwd cannot bind a project.
    importable: projectPath !== null,
  }
}

export function parseLite(
  items: readonly ImportLiteItem[],
): ImportSessionLiteRow[] {
  return items.map(parseLiteItem)
}
