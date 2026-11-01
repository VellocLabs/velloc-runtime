/**
 * What a model asks for when it starts a child session, checked before anything
 * is created, and the texts the start produces: the child's first message and
 * the parent's acknowledgement. Pure. The checks fail closed: a request that
 * is not well-formed in every field is refused with the field named. (F-36)
 */

import { coerceSessionMode, type SessionMode } from '../permissions/sessionModes'
import { sessionLinkMarkdown } from './sessionLink'

export const SPAWN_SESSION_TOOL_NAME = 'SpawnSession'

/** Session types whose model may start a child session. */
export const CHILD_SESSION_TEMPLATE_TYPES: readonly string[] = ['code', 'agent']

/** Shortest briefing a fresh child may be started with, in characters. */
export const CHILD_BRIEFING_MIN_CHARS = 80

export type ChildSessionSource = 'fresh' | 'fork'
export type ChildSessionIsolation = 'shared' | 'worktree'
/** How the start was decided. Only a start the person asked for exists yet. */
export type ChildSessionInitiation = 'asked'

/** The raw tool arguments: every field a string, `""` for "none". */
export type SpawnSessionInput = {
  initiation: string
  title: string
  task: string
  briefing: string
  from: string
  name: string
  isolation: string
  model: string
  effort: string
  permissionMode: string
  cwd: string
  baseBranch: string
  branchName: string
  /** A proposal to start as proposed; `""` for a direct start. */
  proposalId: string
}

/** A request the checks accepted. Absent fields were `""`. */
export type ChildSessionRequest = {
  initiation: ChildSessionInitiation
  title: string
  task: string
  briefing?: string
  from: ChildSessionSource
  name?: string
  /** The isolation the child starts with; defaulted from the parent's own
   *  checkout when the request named none. */
  isolation: ChildSessionIsolation
  /** Whether `isolation` came from the request or the default. */
  isolationRequested: boolean
  model?: string
  effort?: string
  /** The child's mode: the request's, else the parent's. */
  permissionMode: SessionMode
  cwd?: string
  baseBranch?: string
  branchName?: string
}

/** What the checks need to know about the calling session. */
export type ChildSessionCallerContext = {
  /** The release channel the runtime serves; children exist on `beta` only. */
  channel: string
  templateType: string | undefined
  /** Whether the call comes from a loop under the session (a sub-agent or a
   *  teammate), which may not start sessions. */
  nested: boolean
  parentPermissionMode: string
  /** Whether the parent itself works in a git worktree of its project. */
  parentInWorktree: boolean
}

export type ChildSessionCheck =
  | { ok: true; request: ChildSessionRequest }
  | { ok: false; reason: string }

/** How permissive each mode is; a child may be at most as permissive as its
 *  parent. `plan` and `default` ask for everything, so they rank equal. */
const PERMISSION_RANK: Readonly<Record<SessionMode, number>> = {
  plan: 0,
  default: 0,
  acceptEdits: 1,
  auto: 2,
  bubble: 2,
  dontAsk: 3,
  bypassPermissions: 4,
}

/** Whether a child in `child` mode is no more permissive than a parent in `parent` mode. */
export function permissionNotRaised(child: SessionMode, parent: SessionMode): boolean {
  return PERMISSION_RANK[child] <= PERMISSION_RANK[parent]
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export function hasControlCharacters(text: string): boolean {
  return CONTROL_CHARS.test(text)
}

/** Security: the only characters a branch or base name may hold. An
 *  allow-list, not git's deny-list: the value reaches a shell command, so
 *  anything a shell could read (`;`, `&`, `|`, `$`, backticks, quotes,
 *  redirects, parentheses, whitespace) is refused outright. */
const GIT_REF_ALLOWED = /^[A-Za-z0-9._/-]+$/

/** Whether `name` can be a git branch name: letters, digits, `.`, `_`,
 *  `-` and `/` only, no `..`, no `//`, no leading `-` or `/`, no trailing
 *  `/`, `.` or `.lock`, no empty segment, no segment starting with `.`. */
export function isGitBranchNameSafe(name: string): boolean {
  if (!name || name.length > 200) return false
  if (!GIT_REF_ALLOWED.test(name)) return false
  if (name.includes('..') || name.includes('//')) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false
  if (name.endsWith('.') || name.endsWith('.lock')) return false
  return name.split('/').every(segment => segment.length > 0 && !segment.startsWith('.'))
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The isolation a child defaults to: its parent's own arrangement. */
export function defaultChildIsolation(parentInWorktree: boolean): ChildSessionIsolation {
  return parentInWorktree ? 'worktree' : 'shared'
}

/**
 * Check a request against the caller and normalize it. Every refusal names
 * what was wrong; nothing is inferred from a malformed field.
 */
export function checkChildSessionRequest(
  input: Partial<SpawnSessionInput> | undefined,
  caller: ChildSessionCallerContext,
  options: { briefLater?: boolean } = {},
): ChildSessionCheck {
  if (caller.channel !== 'beta') {
    return { ok: false, reason: 'child sessions are not available on this release channel.' }
  }
  if (caller.nested) {
    return { ok: false, reason: 'a sub-agent or teammate cannot start a session. Finish the task with your own tools.' }
  }
  if (!caller.templateType || !CHILD_SESSION_TEMPLATE_TYPES.includes(caller.templateType)) {
    return {
      ok: false,
      reason: `child sessions can be started from a ${CHILD_SESSION_TEMPLATE_TYPES.join(' or ')} session only.`,
    }
  }
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'the arguments are missing.' }
  }

  const initiation = trimmed(input.initiation)
  if (initiation !== 'asked') {
    return { ok: false, reason: `initiation must be "asked" (got ${JSON.stringify(initiation)}); other initiations are not available yet.` }
  }

  const from = trimmed(input.from)
  if (from !== 'fresh' && from !== 'fork') {
    return { ok: false, reason: `from must be "fresh" or "fork" (got ${JSON.stringify(from)}).` }
  }

  const title = trimmed(input.title)
  if (!title) return { ok: false, reason: 'title is required.' }
  if (title.length > 120) return { ok: false, reason: 'title must be at most 120 characters.' }
  if (hasControlCharacters(title)) return { ok: false, reason: 'title must not contain control characters.' }

  // An offer is checked before its brief exists: the task and briefing come
  // once the person accepts it, and are checked then.
  const task = trimmed(input.task)
  if (!task && !options.briefLater) return { ok: false, reason: 'task is required: what the child session is to do.' }

  const briefing = trimmed(input.briefing)
  if (from === 'fresh' && !options.briefLater && briefing.length < CHILD_BRIEFING_MIN_CHARS) {
    return {
      ok: false,
      reason: `briefing must be at least ${CHILD_BRIEFING_MIN_CHARS} characters for a fresh session: it is all the child knows (got ${briefing.length}).`,
    }
  }

  const name = trimmed(input.name)
  if (name && (hasControlCharacters(name) || name.length > 64)) {
    return { ok: false, reason: 'name must be at most 64 characters without control characters.' }
  }

  const isolation = trimmed(input.isolation)
  if (isolation && isolation !== 'shared' && isolation !== 'worktree') {
    return { ok: false, reason: `isolation must be "shared", "worktree" or "" (got ${JSON.stringify(isolation)}).` }
  }
  if (from === 'fork' && isolation) {
    return { ok: false, reason: 'a fork takes no isolation: it follows the parent\'s checkout. Leave isolation empty.' }
  }

  const model = trimmed(input.model)
  const effort = trimmed(input.effort)
  if (effort && !model) {
    return { ok: false, reason: 'effort needs a model to apply to; pass model alongside it or leave effort empty.' }
  }
  if ((model && hasControlCharacters(model)) || (effort && hasControlCharacters(effort))) {
    return { ok: false, reason: 'model and effort must not contain control characters.' }
  }

  const parentMode = coerceSessionMode(caller.parentPermissionMode)
  const requestedMode = trimmed(input.permissionMode)
  let permissionMode: SessionMode = parentMode
  if (requestedMode) {
    if (coerceSessionMode(requestedMode) !== requestedMode) {
      return { ok: false, reason: `permissionMode ${JSON.stringify(requestedMode)} is not a permission mode.` }
    }
    permissionMode = requestedMode as SessionMode
    if (!permissionNotRaised(permissionMode, parentMode)) {
      return {
        ok: false,
        reason: `permissionMode "${permissionMode}" is more permissive than this session's "${parentMode}"; a child may inherit or lower the mode, never raise it.`,
      }
    }
  }

  const cwd = trimmed(input.cwd)
  if (cwd && hasControlCharacters(cwd)) {
    return { ok: false, reason: 'cwd must not contain control characters.' }
  }

  const baseBranch = trimmed(input.baseBranch)
  const branchName = trimmed(input.branchName)
  for (const [field, value] of [['baseBranch', baseBranch], ['branchName', branchName]] as const) {
    if (value && !isGitBranchNameSafe(value)) {
      return { ok: false, reason: `${field} ${JSON.stringify(value)} is not a valid git branch name.` }
    }
  }
  const effectiveIsolation = isolation
    ? (isolation as ChildSessionIsolation)
    : defaultChildIsolation(caller.parentInWorktree)
  if ((baseBranch || branchName) && effectiveIsolation !== 'worktree') {
    return { ok: false, reason: 'baseBranch and branchName apply to a worktree child only; set isolation to "worktree" or leave them empty.' }
  }

  return {
    ok: true,
    request: {
      initiation: 'asked',
      title,
      task,
      ...(briefing ? { briefing } : {}),
      from,
      ...(name ? { name } : {}),
      isolation: effectiveIsolation,
      isolationRequested: isolation.length > 0,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      permissionMode,
      ...(cwd ? { cwd } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(branchName ? { branchName } : {}),
    },
  }
}

export const CHILD_BRIEFING_HEADING = '## Background'
export const CHILD_TASK_HEADING = '## Task'

/**
 * The child's first message: the briefing the parent wrote, then the task.
 * Nothing of the parent's conversation is in it; a fork carries its copy of
 * the transcript instead and may omit the briefing.
 */
export function buildChildFirstMessage(args: { briefing?: string; task: string }): string {
  const parts: string[] = []
  const briefing = args.briefing?.trim()
  if (briefing) {
    parts.push(`${CHILD_BRIEFING_HEADING}\n\n${briefing}`)
  }
  parts.push(`${CHILD_TASK_HEADING}\n\n${args.task.trim()}`)
  return parts.join('\n\n')
}

const CHILD_ACK_FORK_ORIGIN =
  'It starts from a copy of this conversation up to the last answered message; your uncommitted file changes are not copied.'
const CHILD_ACK_SHARED = 'It works in the SHARED directory'

/**
 * The parent's acknowledgement. It says the session is registered and
 * starting, never that the task reached a model; the shared directory is
 * named when the child edits the parent's checkout.
 */
export function childSessionRegisteredText(args: {
  sessionId: string
  name: string
  title: string
  from: ChildSessionSource
  sharedCheckout: boolean
  cwd?: string
}): string {
  const where = args.sharedCheckout
    ? `${CHILD_ACK_SHARED} ${args.cwd ?? 'of this session'}: the same files you edit, so touch only this step's files there, or stop if its work could overlap yours.`
    : args.cwd
      ? `It works in its own worktree at ${args.cwd}.`
      : 'It works in its own worktree.'
  const origin = args.from === 'fork'
    ? CHILD_ACK_FORK_ORIGIN
    : 'It starts from your briefing only; it has not seen this conversation.'
  return (
    `Registered child session "${args.name}" (session ${args.sessionId}). ` +
    `Registered means the session exists and is starting; it does not mean the task has been delivered to or read by its model. ` +
    `${origin} ${where} ` +
    `To point the user at it, write the link ${sessionLinkMarkdown(args.title, args.sessionId)}; it shows the session's live state. ` +
    `Do not wait or poll for it: end your turn, and its report arrives as a later turn in this session.`
  )
}

/** The parent's acknowledgement for a session that is registered but did not start. */
export function childSessionNotStartedAckText(args: { sessionId: string; name: string; reason: string }): string {
  return (
    `Child session "${args.name}" (session ${args.sessionId}) is registered but did not start: ${args.reason} ` +
    'It stays listed as not started with that reason; nothing was shared or run. Fix the cause and start it again, or do the work here.'
  )
}

/** What the page reads back from a `SpawnSession` result: the session it registered and where it works. */
export type ChildSessionAck = {
  sessionId: string
  name: string
  from: ChildSessionSource
  sharedCheckout: boolean
  startFailed: boolean
}

const REGISTERED_ACK = /^Registered child session "(.+?)" \(session ([^)\s]+)\)\./
const PROPOSAL_START_LEAD = /^Started proposal task_[a-z0-9]{8}\. /
const NOT_STARTED_ACK = /^Child session "(.+?)" \(session ([^)\s]+)\) is registered but did not start: /

/** Reads one of the two acknowledgements above; null for a refusal or any other text. */
export function parseChildSessionAck(text: string): ChildSessionAck | null {
  // A start from a proposal leads with the proposal it started.
  const trimmed = text.trim().replace(PROPOSAL_START_LEAD, '')
  const registered = REGISTERED_ACK.exec(trimmed)
  if (registered) {
    return {
      name: registered[1]!,
      sessionId: registered[2]!,
      from: trimmed.includes(CHILD_ACK_FORK_ORIGIN) ? 'fork' : 'fresh',
      sharedCheckout: trimmed.includes(CHILD_ACK_SHARED),
      startFailed: false,
    }
  }
  const failed = NOT_STARTED_ACK.exec(trimmed)
  if (failed) {
    return { name: failed[1]!, sessionId: failed[2]!, from: 'fresh', sharedCheckout: false, startFailed: true }
  }
  return null
}

/** The one reminder a parent gets when a child it started never started. */
export function childNotStartedText(args: { name: string; sessionId: string; reason: string }): string {
  return `Child session "${args.name}" (${args.sessionId}) did not start: ${args.reason}`
}
