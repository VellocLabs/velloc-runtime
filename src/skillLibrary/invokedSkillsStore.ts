/**
 * Tracks every skill invoked in a session, scoped by `sessionId` then
 * `agentId`, so its body is re-injected as an `invoked_skills` attachment after
 * autocompaction. Tokens are estimated as `text.length / 4`. Only the main
 * session produces entries.
 */

import type { InvokedSkillsAttachment, Message } from '../runtime/RuntimeTypes'
import { MSG_TYPE_ATTACHMENT } from '../runtime/VercelModelConstants'

// --- constants -----------------------------------------------------------

/** Per-skill cap so one huge SKILL.md can't squeeze others out. */
export const REFOLD_SKILL_TOKEN_CAP = 5_000
/** Hard cap across all surviving skills in the attachment. */
export const REFOLD_SKILLS_TOKEN_POOL = 25_000
/** Chars-per-token heuristic — same constant the listing budget uses. */
const APPROX_CHARS_IN_TOKEN = 4

// --- store ----------------------------------------------------------------

export type UsedSkillRecord = {
  skillName: string
  skillPath: string
  /**
   * The skill body as it was injected into the conversation — *after*
   * arg/dir/session substitution and after `!`cmd`` shell expansion. We
   * store the expanded form so the post-compact restoration carries the
   * same live context the original invocation did.
   */
  content: string
  invokedAt: number
  agentId: string | null
}

// Outer key = sessionId; inner key = `${agentId??''}:${skillName}` so a
// re-invocation of the same skill overwrites the prior entry.
const STORE = new Map<string, Map<string, UsedSkillRecord>>()

function bucketFor(sessionId: string): Map<string, UsedSkillRecord> {
  let bucket = STORE.get(sessionId)
  if (!bucket) {
    bucket = new Map()
    STORE.set(sessionId, bucket)
  }
  return bucket
}

function compositeKey(agentId: string | null, skillName: string): string {
  return `${agentId ?? ''}:${skillName}`
}

// --- public API -----------------------------------------------------------

/**
 * Record an invocation. Idempotent on `(sessionId, agentId, skillName)`:
 * a later call with the same key replaces the prior entry (most-recent body
 * wins).
 */
export function noteSkillUse(
  sessionId: string,
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  if (!sessionId || !skillName) return
  bucketFor(sessionId).set(compositeKey(agentId, skillName), {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

/**
 * All invocations for a given (sessionId, agentId). Pass `undefined` /
 * `null` to fetch the main-session bucket (skills invoked outside any
 * subagent fork).
 */
export function skillsUsedBy(
  sessionId: string,
  agentId?: string | null,
): Map<string, UsedSkillRecord> {
  const bucket = STORE.get(sessionId)
  if (!bucket) return new Map()
  const normalizedAgent = agentId ?? null
  const filtered = new Map<string, UsedSkillRecord>()
  for (const [key, skill] of bucket) {
    if (skill.agentId === normalizedAgent) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

/** Drop the main loop's invocations (`agentId` null) — `/clear`. A
 *  sub-agent's stay: one still running may compact. */
export function clearMainInvokedSkills(sessionId: string): void {
  const bucket = STORE.get(sessionId)
  if (!bucket) return
  for (const [key, skill] of bucket) {
    if (skill.agentId === null) bucket.delete(key)
  }
}

/** Drop the session's entire bucket (e.g. on session close). */
export function clearInvokedSkillsForSession(sessionId: string): void {
  STORE.delete(sessionId)
}

/** Test-only: wipe the whole store. */
export function __resetInvokedSkillsStoreForTests(): void {
  STORE.clear()
}

// --- compact-time attachment builder --------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_IN_TOKEN)
}

function clipToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * APPROX_CHARS_IN_TOKEN
  if (text.length <= maxChars) return text
  // Keep the head (typically setup/usage instructions) and mark truncation.
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Build the `invoked_skills` attachment payload for a session. Sort
 * recent-first so budget pressure drops the *least* relevant skills first;
 * per-skill content is capped at `REFOLD_SKILL_TOKEN_CAP`; the
 * combined total is capped at `REFOLD_SKILLS_TOKEN_POOL`. Returns
 * `null` when nothing has been invoked (so the caller can skip the
 * attachment entirely instead of emitting an empty one).
 */
export function createInvokedSkillsAttachmentPayload(
  sessionId: string,
  agentId?: string | null,
): InvokedSkillsAttachment | null {
  const invoked = skillsUsedBy(sessionId, agentId)
  if (invoked.size === 0) {
    return null
  }

  let usedTokens = 0
  const skills: InvokedSkillsAttachment['skills'] = []
  const sorted = Array.from(invoked.values()).sort(
    (a, b) => b.invokedAt - a.invokedAt,
  )

  for (const skill of sorted) {
    const trimmedContent = clipToTokenBudget(
      skill.content,
      REFOLD_SKILL_TOKEN_CAP,
    )
    const tokens = estimateTokens(trimmedContent)
    if (usedTokens + tokens > REFOLD_SKILLS_TOKEN_POOL) {
      // Stop the first time the running total exceeds the budget (smaller
      // subsequent skills are not tried).
      break
    }
    usedTokens += tokens
    skills.push({
      name: skill.skillName,
      path: skill.skillPath,
      content: trimmedContent,
    })
  }

  if (skills.length === 0) {
    return null
  }
  return { type: 'invoked_skills', skills }
}

// --- restoration on resume ------------------------------------------------

/**
 * Re-populate the store for `sessionId` from `invoked_skills` attachments
 * already in the conversation (main session, `agentId = null`), so compaction
 * after a resume keeps the skills. Idempotent.
 */
export function restoreInvokedSkillsFromMessages(
  sessionId: string,
  messages: readonly Message[],
): void {
  if (!sessionId) return
  for (const message of messages) {
    if (message.type !== MSG_TYPE_ATTACHMENT) continue
    const attachment = (message as { attachment?: { type?: string } })
      .attachment
    if (!attachment || attachment.type !== 'invoked_skills') continue
    const skills = (attachment as InvokedSkillsAttachment).skills
    for (const skill of skills) {
      if (skill.name && skill.path && typeof skill.content === 'string') {
        noteSkillUse(sessionId, skill.name, skill.path, skill.content, null)
      }
    }
  }
}
