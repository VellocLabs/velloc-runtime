/**
 * Recovered session-title rows after a restart: one finished row per `ai-title` entry written before
 * this worker lifetime.
 */

import { AI_TITLE_TYPE } from '../../runtime/VercelModelConstants'

export type RecoveredTitleRow = {
  /** Drawer row id — unique across sessions, stable across rebuilds of the
   *  same transcript (owner session + the entry's position among titles). */
  taskId: string
  /** The title the call produced — the detail view's output. */
  title: string
  /** When the title was stored — just after the call finished. The call's
   *  start and duration are not persisted. */
  storedAt: number
}

/** The `querySource` the session-title namer's fast call carries
 *  (`sessions/sessionTitles.ts`); a recovered row carries it too, so the
 *  drawer files and labels it like the live one. */
export const SESSION_TITLE_QUERY_SOURCE = 'rename_generate_name'

/** Mirrors the live finished-fast-call tail the drawer can show. */
export const MAX_RECOVERED_TITLE_ROWS = 20

/** The prefix of a recovered title row's id. */
const RECOVERED_TITLE_ID_PREFIX = 'recovered-title:'

/**
 * Scan a raw session transcript for `ai-title` entries written before
 * `lifetimeStartedAt` and project them to drawer rows, newest last. Capped to
 * the most recent MAX_RECOVERED_TITLE_ROWS.
 */
export function extractRecoveredTitleRows(
  ownerSessionId: string,
  entries: readonly unknown[],
  lifetimeStartedAt: number,
): RecoveredTitleRow[] {
  const rows: RecoveredTitleRow[] = []
  let ordinal = 0
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (record.type !== AI_TITLE_TYPE) continue
    const title = typeof record.aiTitle === 'string' ? record.aiTitle.trim() : ''
    if (!title) continue
    const storedAt = record.updatedAt
    if (typeof storedAt !== 'number' || !Number.isFinite(storedAt)) continue
    const index = ordinal++
    if (storedAt >= lifetimeStartedAt) continue
    rows.push({
      taskId: `${RECOVERED_TITLE_ID_PREFIX}${ownerSessionId}:${index}`,
      title,
      storedAt,
    })
  }
  return rows.slice(-MAX_RECOVERED_TITLE_ROWS)
}
