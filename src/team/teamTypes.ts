/**
 * Types for the team + shared-task store:
 *   - Team = TaskList, 1:1.
 *   - A teammate is a Nexus SharedWorker session (its `sessionId` is
 *     filled in once spawned; absent for a bare team record).
 *   - Tasks are owner-assignable with blocks/blockedBy dependency edges.
 */

import { sanitizeTeamId } from './TeamRegistry'

/** Lifecycle of a teammate member. */
export type TeamMemberStatus = 'active' | 'idle' | 'stopped'

/** One member of a team (the lead, or a spawned teammate). */
export type TeamMember = {
  /** Display name, unique within the team — a person name (e.g. "Ada"). */
  name: string
  /** SharedWorker session id once spawned; absent until then. */
  sessionId?: string
  /** Subagent type / role (e.g. "Explore"); absent for a plain fork. */
  agentType?: string
  /** Per-member model override; absent → inherit the lead's. */
  model?: string
  status: TeamMemberStatus
  /** True for the team lead (the session that created the team). */
  isLead?: boolean
  joinedAt: number
}

/** A team: a named group sharing one task list. */
export type Team = {
  /** Sanitized identifier; also the task-list key. Stable for the team's life. */
  id: string
  /** Original (unsanitized) name as the user/model typed it. */
  name: string
  description?: string
  createdAt: number
  /** Session id of the lead (the creator). */
  headSessionId?: string
  members: TeamMember[]
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** A unit of work on a team's shared task list. */
export type Task = {
  /** Numeric string id, sequential within the team ("1", "2", …). */
  id: string
  subject: string
  description: string
  /** Present-continuous form for a spinner (e.g. "Running tests"). */
  activeForm?: string
  /** Member name (or session id) this task is assigned to; absent = unclaimed. */
  owner?: string
  status: TaskStatus
  /** Task ids this task blocks (they can't start until this completes). */
  blocks: string[]
  /** Task ids that must complete before this one can start. */
  blockedBy: string[]
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Append-only JSONL log entries (replayed on load). Tombstones drop earlier
// entries with the same id; updates merge on top of the latest record.
// Mirrors `RoutineLogEntry` in `routineTypes.ts`.
// ---------------------------------------------------------------------------

export type TeamLogEntry =
  | { type: 'team'; team: Team }
  | { type: 'team_update'; id: string; patch: Partial<Team> }
  | { type: 'team_tombstone'; id: string; deletedAt: number }

export type TaskLogEntry =
  | { type: 'task'; task: Task }
  | { type: 'task_update'; id: string; patch: Partial<Task> }
  | { type: 'task_tombstone'; id: string; deletedAt: number }

export type TaskListFilter = {
  status?: TaskStatus
  owner?: string
}

/**
 * Params for spawning a teammate session. Lives
 * here (a leaf types module) rather than on the session manager so the
 * `teammateSpawner` leaf + tools can reference it without importing the
 * heavy manager (which would form a tools → manager → tools cycle).
 */
export type SpawnTeammateParams = {
  /** Team id this teammate joins. */
  teamName: string
  /** This teammate's member name within the team. */
  teammateName: string
  /** First user message driving the teammate's (one-shot) turn. */
  prompt: string
  /** Lead session that spawned it (for later cascade-delete / routing). */
  spawnerSessionId?: string
  /** Optional model override; absent → inherit the lead's. */
  model?: string
  /**
   * Session template the child runs under. DERIVED by the lead's side from
   * the target provider's trust setting — never supplied by the model. An
   * untrusted provider forces `safe_code`, whose tool set closes execution,
   * egress and spawning STRUCTURALLY (they are absent, not gated).
   */
  templateType?: string
  /** Provider the child runs on; absent → inherit the lead's. */
  providerId?: string
  /** Thinking tier pinned for `model`, when one was resolved. */
  thinkingTier?: string
  /** Memory / skills / storage anchor — the real repo root when the child is
   *  worktree-isolated (matching `SubAgentSpawnParams.projectRoot`). */
  projectRoot?: string
  /** The child's working directory: its own worktree when isolated. */
  cwd?: string
  /** Release the child's worktree once it is torn down. */
  onCleanup?: () => void | Promise<void>
  /**
   * Read boundary for an untrusted child: every path it reads must resolve
   * inside this root. Present ⇒ the boundary is ON. Stamped here, from
   * settings — a model cannot ask for it and cannot ask to be without it.
   */
  untrustedReadRoot?: string
  /** Routine this spawn's work originates from (see the same field on
   *  `SubAgentSpawnParams`). Stamped onto the teammate's init payload so the
   *  recursion guard still fires inside a teammate spawned by routine-driven
   *  work. Undefined for ordinary user-driven work. */
  routineOriginId?: string
}

// ---------------------------------------------------------------------------
// Mailbox frames (team feature). One JSON object per line in a member's
// `inbox.jsonl`; see `teamPaths.ts` for the layout and `TeamMailboxStore`
// for the reader/writer.
// ---------------------------------------------------------------------------

export type TeamMessageKind = 'message' | 'turn_end' | 'shutdown' | 'system'

/** Trust class of the SENDING session's provider. */
export type TeamMessageTrust = 'trusted' | 'untrusted'

export type TeamMessageFrame = {
  /** Frame schema version; a reader skips a line it does not understand. */
  v: 1
  id: string
  /** Per-inbox, monotonic from 1. Assigned by the writer; the cursor is a
   *  position in this sequence. */
  seq: number
  ts: number
  /**
   * `name` is the sender's member key; `display` its human name (absent for the
   * lead or old frames). `sessionId` is the sender's session, resolved at write
   * time; trust derives from it. Absent: the reader treats it as untrusted.
   */
  from: {
    name: string
    role: 'lead' | 'member'
    display?: string
    sessionId?: string
  }
  to: { name: string; display?: string }
  kind: TeamMessageKind
  /**
   * Stamped by the SENDER's coordinator from that session's provider trust,
   * and RE-DERIVED by the reader from its own view — stricter wins. Never
   * taken from the model, and never parsed out of `body`: a frame that
   * claims to be trusted is still rendered untrusted if the reader knows
   * the sender is not.
   */
  trust: TeamMessageTrust
  body: string
  meta?: Record<string, unknown>
}

/** `{memberKey}/cursor.json` — how far the poller has delivered. */
export type MailboxCursor = { v: 1; deliveredSeq: number }

/**
 * The one team a lead owns: its session id IS the team, so `team_name` is
 * optional everywhere.
 */
export function implicitTeamIdFor(headSessionId: string): string {
  return sanitizeTeamId(headSessionId)
}
