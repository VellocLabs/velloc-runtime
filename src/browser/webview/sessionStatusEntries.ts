/**
 * How the shell turns its session list and the sessions summary into the
 * status index the transcript reads (F-36). Pure.
 */
import type { NexusSessionActivity, NexusTurnEnding } from '../bridge/protocol/ui'
import type { SessionListItem } from './SessionRows'
import type { SessionStatusEntry } from './sessionStatusStore'

export type SessionActivityFacts = { activity?: NexusSessionActivity; ending?: NexusTurnEnding }
export type SessionActivityById = ReadonlyMap<string, SessionActivityFacts>

function activityKey(facts: SessionActivityFacts | undefined): string {
  if (!facts) return ''
  const a = facts.activity
  const activity = !a ? '' : a.kind === 'tool' ? `tool:${a.tool}` : a.kind
  return `${activity}|${facts.ending ?? ''}`
}

/** The summary's per-session facts; `prev` itself when nothing changed. */
export function sessionActivityFromSummary(
  prev: SessionActivityById,
  rows: ReadonlyArray<{ sessionId: string } & SessionActivityFacts>,
): SessionActivityById {
  const next = new Map<string, SessionActivityFacts>()
  for (const row of rows) {
    if (!row.activity && !row.ending) continue
    next.set(row.sessionId, {
      ...(row.activity ? { activity: row.activity } : {}),
      ...(row.ending ? { ending: row.ending } : {}),
    })
  }
  if (next.size !== prev.size) return next
  for (const [id, facts] of next) {
    if (activityKey(facts) !== activityKey(prev.get(id))) return next
  }
  return prev
}

/** One status entry per listed session. */
export function sessionStatusEntries(
  items: readonly SessionListItem[],
  activity: SessionActivityById,
): SessionStatusEntry[] {
  return items.map(item => {
    const facts = activity.get(item.sessionId)
    return {
      sessionId: item.sessionId,
      title: item.title,
      ...(item.templateType ? { templateType: item.templateType } : {}),
      ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
      ...(item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
      ...(item.lineageKind ? { lineageKind: item.lineageKind } : {}),
      ...(item.familyName ? { familyName: item.familyName } : {}),
      ...(item.starting ? { starting: true } : {}),
      ...(item.startFailed ? { startFailed: item.startFailed } : {}),
      ...(item.running ? { running: true } : {}),
      ...(item.needsAnswer ? { needsAnswer: true } : {}),
      ...(item.previewText ? { previewText: item.previewText } : {}),
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      ...(facts?.activity ? { activity: facts.activity } : {}),
      ...(facts?.ending ? { ending: facts.ending } : {}),
    }
  })
}
