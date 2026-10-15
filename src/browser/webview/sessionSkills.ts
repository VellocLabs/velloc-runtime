/**
 * Pure helpers for the Skill panel's session list: scope the `session.summary` skills to the active
 * thread and dedupe state churn.
 */

import type {
  NexusSessionSkillRow,
  NexusSessionSkillStatus,
} from '../bridge/protocol/ui'
import type { LoadedSkillSummary } from '../worker/workerProtocol'
import type { Message, UserRow } from '../../runtime/RuntimeTypes'
import { MSG_TYPE_USER } from '../../runtime/VercelModelConstants'
// Import-light on purpose (see that module's header) — safe for the webview
// bundle.
import {
  getSkillBodyDetailId,
  parseSkillInvocationTags,
} from '../../skillLibrary/skillInvocationTags'

/** Shallow per-field equality so the shell skips re-renders when an unrelated
 *  summary flush carries an unchanged skill set. Order is authoritative (the
 *  worker emits newest-invocation first). */
export function sessionSkillsEqual(
  a: readonly NexusSessionSkillRow[],
  b: readonly NexusSessionSkillRow[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.spawnerSessionId !== y.spawnerSessionId ||
      x.name !== y.name ||
      x.path !== y.path ||
      x.invokedAt !== y.invokedAt ||
      x.size !== y.size ||
      x.id !== y.id ||
      x.status !== y.status
    ) {
      return false
    }
  }
  return true
}

/**
 * Skill invocations by a specific session, for the per-session Skills-tab event
 * list. Returns a new array (empty when no session / no rows); preserves
 * incoming order (the worker emits newest-invocation first). The feed is an
 * append-only event log, so a re-invoked skill appears once PER invocation.
 */
export function filterSessionSkillsByParent(
  rows: readonly NexusSessionSkillRow[] | undefined,
  sessionId: string | null | undefined,
): NexusSessionSkillRow[] {
  if (!rows || !sessionId) return []
  return rows.filter((r) => r.spawnerSessionId === sessionId)
}

/** One row of the Skills tab's event list — one skill invocation.
 *  `LoadedSkillSummary` (registry enrichment: description / source / size)
 *  plus this invocation's outcome (`status`), time (`invokedAt`), stable key
 *  (`id`), any `error`, and the `skill:<uuid>` sidecar id that resolves the
 *  body on click — the body source for rows with no readable `SKILL.md` on disk
 *  (transcript-restored rows with an unknown path, and bundled skills whose
 *  `path` is the synthetic `bundled:<name>`). */
export type SkillPanelListRow = LoadedSkillSummary & {
  detailId?: string | null
  /** Stable per-invocation id — the row key. Absent for transcript-restored
   *  rows recovered after a restart. */
  id?: string
  /** Unix ms of this invocation — the row's time. Absent for restored rows. */
  invokedAt?: number
  /** This invocation's outcome. Defaulted to `'loaded'` by the builder. */
  status?: NexusSessionSkillStatus
  /** Failure message — set only for a `'failed'` row. */
  error?: string
}

/**
 * One skill invocation recovered from the persisted transcript: a view-only restore for the Skill panel
 * after a restart. Never written back into the invoked-skills store.
 */
export type RestoredSessionSkill = {
  name: string
  /** `skill:<uuid>` sidecar id of the invocation message — loads the invoked
   *  body on demand. Null for messages from before the sidecar change. */
  detailId: string | null
}

/** The text content of a (possibly block-structured) user message. */
function userMessageText(message: Message): string | undefined {
  const content = (message as UserRow).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string') return b.text
  }
  return undefined
}

/**
 * Scan a transcript for skill invocations: `isMeta` user messages starting with the `<command-message>`
 * tags. Name-deduped keeping the latest, newest first. A full walk; gate it on the panel being open.
 */
export function restoreSessionSkillsFromTranscript(
  messages: readonly Message[] | undefined,
): RestoredSessionSkill[] {
  if (!messages || messages.length === 0) return []
  const byName = new Map<string, RestoredSessionSkill>()
  for (const message of messages) {
    if (message.type !== MSG_TYPE_USER) continue
    if (!(message as UserRow).isMeta) continue
    const tags = parseSkillInvocationTags(userMessageText(message))
    if (!tags) continue
    // Delete-then-set so a re-invocation moves the row to the newest
    // position (a plain `set` would keep the FIRST occurrence's position).
    byName.delete(tags.name)
    byName.set(tags.name, {
      name: tags.name,
      detailId: getSkillBodyDetailId(message),
    })
  }
  return [...byName.values()].reverse()
}

/**
 * Whether a transcript proves it loaded any skill (decides if the Skills tab is shown). Same
 * discriminator as `restoreSessionSkillsFromTranscript`, exiting on the first hit.
 */
export function sessionHasInvokedSkills(
  messages: readonly Message[] | undefined,
): boolean {
  if (!messages || messages.length === 0) return false
  for (const message of messages) {
    if (message.type !== MSG_TYPE_USER) continue
    if (!(message as UserRow).isMeta) continue
    if (parseSkillInvocationTags(userMessageText(message))) return true
  }
  return false
}

/**
 * The Skill panel's list for the active session. The invoked-skills feed decides membership, order and
 * `size`; `loadedSkills` adds `description`/`source` and backfills `size`. Restored transcript skills not in
 * the feed are appended; a live row also in the transcript borrows its restored `detailId`.
 */
export function buildSessionSkillPanelList(
  rows: readonly NexusSessionSkillRow[] | undefined,
  sessionId: string | null | undefined,
  registry: readonly LoadedSkillSummary[] | undefined,
  restored: readonly RestoredSessionSkill[] = [],
): SkillPanelListRow[] {
  if (!sessionId) return []
  const byName = new Map<string, LoadedSkillSummary>()
  for (const skill of registry ?? []) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  const restoredByName = new Map<string, RestoredSessionSkill>()
  for (const skill of restored) {
    if (!restoredByName.has(skill.name)) restoredByName.set(skill.name, skill)
  }
  const list: SkillPanelListRow[] = filterSessionSkillsByParent(
    rows,
    sessionId,
  ).map((row) => {
    const known = byName.get(row.name)
    return {
      name: row.name,
      path: row.path,
      description: known?.description,
      source: known?.source,
      size: row.size ?? known?.size,
      // The event row carries its own sidecar id; fall back to a transcript
      // match, then null.
      detailId: row.detailId ?? restoredByName.get(row.name)?.detailId ?? null,
      id: row.id,
      invokedAt: row.invokedAt,
      // An older worker bundle omits `status` — treat those rows as loaded.
      status: row.status ?? 'loaded',
      error: row.error,
    }
  })
  const liveNames = new Set(list.map((row) => row.name))
  for (const skill of restored) {
    if (liveNames.has(skill.name)) continue
    const known = byName.get(skill.name)
    list.push({
      name: skill.name,
      // Registry path when the skill is still known; '' otherwise — the
      // shell's select handler falls back to `detailId` for pathless rows.
      path: known?.path ?? '',
      description: known?.description,
      source: known?.source,
      // Registry backfill only — the invoked body is not loaded here, so a
      // dynamic-content bundled skill's restored row shows no size badge.
      size: known?.size,
      detailId: skill.detailId,
      // A transcript-scan row can only prove `loaded`. Fallback for a session with no `skill-events.json`
      // sidecar.
      status: 'loaded',
    })
  }
  return list
}
