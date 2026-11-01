/**
 * The page's read-only index of what the runtime publishes about each
 * session (the session list and the sessions summary), for surfaces deep in a
 * transcript — the start card and the session link chip (F-36). The shell
 * publishes into it from the one `sessions` subscription it already holds;
 * readers subscribe per session and never call the runtime.
 */
import { useSyncExternalStore } from 'react'
import type { NexusSessionActivity, NexusTurnEnding } from '../bridge/protocol/ui'
import type { SessionLineageKind } from '../../sessions/sessionLineage'

export type SessionStatusEntry = {
  sessionId: string
  title: string
  templateType?: string
  projectRoot?: string
  parentSessionId?: string
  lineageKind?: SessionLineageKind
  familyName?: string
  starting?: boolean
  startFailed?: string
  archived?: boolean
  running?: boolean
  needsAnswer?: boolean
  previewText?: string
  updatedAt?: number
  activity?: NexusSessionActivity
  ending?: NexusTurnEnding
}

type Listener = () => void

const FIELDS: readonly (keyof SessionStatusEntry)[] = [
  'title', 'templateType', 'projectRoot', 'parentSessionId', 'lineageKind',
  'familyName', 'starting', 'startFailed', 'archived', 'running',
  'needsAnswer', 'previewText', 'updatedAt', 'ending',
]

function entriesEqual(a: SessionStatusEntry, b: SessionStatusEntry): boolean {
  for (const field of FIELDS) if (a[field] !== b[field]) return false
  const x = a.activity
  const y = b.activity
  if (x === y) return true
  if (!x || !y || x.kind !== y.kind) return false
  return x.kind !== 'tool' || x.tool === (y as { tool: string }).tool
}

let entries = new Map<string, SessionStatusEntry>()
const listeners = new Set<Listener>()

/**
 * Replace the index with `next`. An entry equal to the one held keeps its
 * identity, so a reader of an unchanged session does not re-render; listeners
 * hear nothing when nothing changed.
 */
export function publishSessionStatuses(next: readonly SessionStatusEntry[]): void {
  const fresh = new Map<string, SessionStatusEntry>()
  let changed = next.length !== entries.size
  for (const entry of next) {
    const held = entries.get(entry.sessionId)
    if (held && entriesEqual(held, entry)) {
      fresh.set(entry.sessionId, held)
    } else {
      fresh.set(entry.sessionId, entry)
      changed = true
    }
  }
  if (!changed) return
  entries = fresh
  for (const listener of listeners) listener()
}

export function sessionStatusOf(sessionId: string): SessionStatusEntry | undefined {
  return entries.get(sessionId)
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The published entry for one session; undefined while the runtime has not listed it. */
export function useSessionStatus(sessionId: string | null | undefined): SessionStatusEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? entries.get(sessionId) : undefined),
    () => (sessionId ? entries.get(sessionId) : undefined),
  )
}

/** Test seam: empties the index and drops every reader. */
export function resetSessionStatusesForTests(): void {
  entries = new Map()
  listeners.clear()
}
