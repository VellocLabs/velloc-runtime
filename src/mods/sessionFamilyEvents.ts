/**
 * The child-session events (F-36, proposed in mods ABI 0.3): `session.spawn`,
 * `session.propose`, `session.report`, `session.wake`, `lineage.detach`, and the
 * nouns `$.session.family` and `$.session.spawn`. Pure shapes, the pins and the
 * answer checks; who started a session, for whom, under which permissions and
 * under which parent is pinned, and only text and narrower settings are rewritten.
 */

import type { ChildReport, ChildReportEnding } from '../sessions/sessionLineage'
import type { DispatchContext } from './modTypes'

/** The events a hook may name that are raised but not yet frozen. */
export const PROPOSED_SESSION_FAMILY_EVENTS: readonly string[] = Object.freeze([
  'session.spawn',
  'session.propose',
  'session.report',
  'session.wake',
  'lineage.detach',
  'session.family',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether `e` changes only `rewritable` fields of `original`: a field left
 * out is kept, an unknown one or a changed pin is refused. Returns the reason,
 * or null.
 */
function pinProblem(
  event: string,
  original: Record<string, unknown>,
  e: unknown,
  rewritable: ReadonlySet<string>,
): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  for (const key of Object.keys(e)) {
    if (rewritable.has(key)) continue
    if (!(key in original)) return `${key} is not a field of ${event}`
    if (e[key] !== undefined && !sameJson(e[key], original[key])) return `${key} is pinned`
  }
  return null
}

// ── session.spawn ─────────────────────────────────────────────────────────

/** Who asked for the session: the model's `SpawnSession` call, or a plugin's
 *  own (`$.session.spawn`, raised through `tool.call`). */
export type SessionSpawnOrigin = { kind: 'model' } | { kind: 'plugin'; name: string }

/** `e` of `session.spawn`, raised once the runtime's checks passed and before
 *  a session id exists. `""` means none, as in the tool. */
export type SessionSpawnInput = {
  from: 'fresh' | 'fork'
  kind: 'side_session' | 'hand_off'
  initiation: string
  title: string
  task: string
  briefing: string
  name: string
  isolation: 'shared' | 'worktree'
  model: string
  effort: string
  permissionMode: string
  cwd: string
  parentSessionId: string
  origin: SessionSpawnOrigin
}

export type SessionSpawnRewrite = Pick<SessionSpawnInput, 'title' | 'task' | 'briefing' | 'name' | 'model' | 'effort'>

/** What core answers: the registered session, or the runtime's refusal of
 *  the request as handed down. */
export type SessionSpawnLaunched = { sessionId: string; name: string } | { refused: string }

export type SessionSpawnSettlement = SessionSpawnLaunched | { deny: string }

/** Core of `session.spawn`: start the session from the request with the
 *  chain's rewrite applied. Throws, starting nothing, when the rewrite fails
 *  the request's own checks. */
export type SessionSpawnCore = (rewrite: SessionSpawnRewrite) => Promise<SessionSpawnLaunched>

const SPAWN_REWRITABLE: ReadonlySet<string> = new Set(['title', 'task', 'briefing', 'name', 'model', 'effort'])

export function isSessionSpawnResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.deny === 'string') return value.deny !== ''
  if (typeof value.refused === 'string') return true
  return typeof value.sessionId === 'string' && typeof value.name === 'string'
}

/** A rewritten `session.spawn` event: the rewritable fields strings, the rest
 *  pinned. Returns the reason it is refused, or null. */
export function sessionSpawnInputProblem(original: SessionSpawnInput, e: unknown): string | null {
  const pinned = pinProblem('session.spawn', original, e, SPAWN_REWRITABLE)
  if (pinned) return pinned
  const rewrite = e as Record<string, unknown>
  for (const key of SPAWN_REWRITABLE) {
    if (rewrite[key] !== undefined && typeof rewrite[key] !== 'string') return `${key} is not a string`
  }
  if (rewrite.task !== undefined && (rewrite.task as string).trim() === '') return 'task is empty'
  if (rewrite.title !== undefined && (rewrite.title as string).trim() === '') return 'title is empty'
  return null
}

/** The rewrite read back from the `e` core was handed. */
export function sessionSpawnRewriteOf(original: SessionSpawnInput, e: unknown): SessionSpawnRewrite {
  const given = isRecord(e) ? e : {}
  const pick = (key: keyof SessionSpawnRewrite): string =>
    typeof given[key] === 'string' ? (given[key] as string) : original[key]
  return {
    title: pick('title'),
    task: pick('task'),
    briefing: pick('briefing'),
    name: pick('name'),
    model: pick('model'),
    effort: pick('effort'),
  }
}

/**
 * Whether `effort` is no higher than `requested` in the model's published
 * tiers (lowest first). Nothing requested: any published tier, as the model
 * could have asked for. A requested tier never clears to the default.
 */
export function effortNotRaised(requested: string, effort: string, tiers: readonly string[]): boolean {
  if (effort === requested) return true
  if (effort === '') return false
  const to = tiers.indexOf(effort)
  if (to < 0) return false
  if (requested === '') return true
  const from = tiers.indexOf(requested)
  return from >= 0 && to <= from
}

// ── session.propose ───────────────────────────────────────────────────────

/** `e` of `session.propose`: a proposal card about to be recorded. */
export type SessionProposeInput = {
  initiation: 'suggest' | 'offer'
  title: string
  task: string
  briefing: string
  parentSessionId: string
}

export type SessionProposeRewrite = Pick<SessionProposeInput, 'title' | 'task' | 'briefing'>

export type SessionProposeSettlement = { taskId: string } | { deny: string }

/** Core: record the proposal with the rewrite applied; throws, recording
 *  nothing, when the rewrite fails the request's checks. */
export type SessionProposeCore = (rewrite: SessionProposeRewrite) => Promise<{ taskId: string }>

const PROPOSE_REWRITABLE: ReadonlySet<string> = new Set(['title', 'task', 'briefing'])

export function isSessionProposeResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.deny === 'string') return value.deny !== ''
  return typeof value.taskId === 'string'
}

export function sessionProposeInputProblem(original: SessionProposeInput, e: unknown): string | null {
  const pinned = pinProblem('session.propose', original, e, PROPOSE_REWRITABLE)
  if (pinned) return pinned
  const rewrite = e as Record<string, unknown>
  for (const key of PROPOSE_REWRITABLE) {
    if (rewrite[key] !== undefined && typeof rewrite[key] !== 'string') return `${key} is not a string`
  }
  if (rewrite.title !== undefined && (rewrite.title as string).trim() === '') return 'title is empty'
  return null
}

export function sessionProposeRewriteOf(original: SessionProposeInput, e: unknown): SessionProposeRewrite {
  const given = isRecord(e) ? e : {}
  const pick = (key: keyof SessionProposeRewrite): string =>
    typeof given[key] === 'string' ? (given[key] as string) : original[key]
  return { title: pick('title'), task: pick('task'), briefing: pick('briefing') }
}

// ── session.report ────────────────────────────────────────────────────────

/** `e` of `session.report`: a child's turn report about to be queued on its
 *  parent. `text` is already sanitized. */
export type SessionReportInput = {
  childSessionId: string
  parentSessionId: string
  ending: ChildReportEnding
  text: string
  lineageKind: string
}

export type SessionReportSettlement = { text: string } | { consumed: string }

const REPORT_REWRITABLE: ReadonlySet<string> = new Set(['text'])

export function isSessionReportResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.consumed === 'string') return value.consumed !== ''
  return typeof value.text === 'string'
}

export function sessionReportInputProblem(original: SessionReportInput, e: unknown): string | null {
  const pinned = pinProblem('session.report', original, e, REPORT_REWRITABLE)
  if (pinned) return pinned
  const text = (e as Record<string, unknown>).text
  if (text !== undefined && typeof text !== 'string') return 'text is not a string'
  return null
}

// ── session.wake ──────────────────────────────────────────────────────────

/** `e` of `session.wake`: every condition of the wake held; the continuation
 *  is about to be queued. */
export type SessionWakeInput = {
  parentSessionId: string
  reports: ChildReport[]
  count: number
}

export type SessionWakeSettlement = { wake: true } | { defer: string }

export function isSessionWakeResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.defer === 'string') return value.defer !== ''
  return value.wake === true
}

export function sessionWakeInputProblem(original: SessionWakeInput, e: unknown): string | null {
  return pinProblem('session.wake', original, e, new Set())
}

// ── lineage.detach ────────────────────────────────────────────────────────

/** `e` of `lineage.detach`: a detach about to take effect. */
export type LineageDetachInput = {
  sessionId: string
  parentSessionId: string
  initiator: 'model' | 'user'
}

export type LineageDetachSettlement = { detached: true } | { deny: string }

export function isLineageDetachResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.deny === 'string') return value.deny !== ''
  return value.detached === true
}

export function lineageDetachInputProblem(original: LineageDetachInput, e: unknown): string | null {
  return pinProblem('lineage.detach', original, e, new Set())
}

// ── the nouns ─────────────────────────────────────────────────────────────

/** `$.session.family(options?)`: `e` is `{ includeArchived? }`. */
export type SessionFamilyArgs = { includeArchived?: boolean }

export function sessionFamilyArgsOf(value: unknown): SessionFamilyArgs {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError('$.session.family(options): options must be an object')
  if (value.includeArchived === undefined) return {}
  if (typeof value.includeArchived !== 'boolean') {
    throw new TypeError('$.session.family: options.includeArchived must be a boolean')
  }
  return { includeArchived: value.includeArchived }
}

/** `$.session.spawn(params)`: `SpawnSession`'s fields, `title` and `task`
 *  required, the rest optional strings; `from` defaults to `fresh`. */
export type SessionSpawnArgs = {
  title: string
  task: string
  briefing?: string
  from?: 'fresh' | 'fork'
  name?: string
  isolation?: 'shared' | 'worktree'
  model?: string
  effort?: string
  permissionMode?: string
  cwd?: string
  baseBranch?: string
  branchName?: string
}

const SPAWN_ARG_FIELDS = [
  'briefing',
  'name',
  'model',
  'effort',
  'permissionMode',
  'cwd',
  'baseBranch',
  'branchName',
] as const

export function sessionSpawnArgsOf(value: unknown): SessionSpawnArgs {
  if (!isRecord(value)) throw new TypeError('$.session.spawn(params): params must be an object')
  for (const field of ['title', 'task'] as const) {
    if (typeof value[field] !== 'string' || (value[field] as string).trim() === '') {
      throw new TypeError(`$.session.spawn: params.${field} must be a non-empty string`)
    }
  }
  const out: SessionSpawnArgs = { title: value.title as string, task: value.task as string }
  for (const field of SPAWN_ARG_FIELDS) {
    const given = value[field]
    if (given === undefined) continue
    if (typeof given !== 'string') throw new TypeError(`$.session.spawn: params.${field} must be a string`)
    out[field] = given
  }
  if (value.from !== undefined) {
    if (value.from !== 'fresh' && value.from !== 'fork') throw new TypeError("$.session.spawn: params.from must be 'fresh' or 'fork'")
    out.from = value.from
  }
  if (value.isolation !== undefined) {
    if (value.isolation !== 'shared' && value.isolation !== 'worktree') {
      throw new TypeError("$.session.spawn: params.isolation must be 'shared' or 'worktree'")
    }
    out.isolation = value.isolation
  }
  return out
}

/** The `SpawnSession` tool input for a plugin's spawn: every field present,
 *  `""` for none, a direct start the plugin asked for. */
export function spawnSessionToolInputOf(args: SessionSpawnArgs): Record<string, unknown> {
  return {
    tool: 'SpawnSession',
    initiation: 'asked',
    title: args.title,
    task: args.task,
    briefing: args.briefing ?? '',
    from: args.from ?? 'fresh',
    name: args.name ?? '',
    isolation: args.isolation ?? '',
    model: args.model ?? '',
    effort: args.effort ?? '',
    permissionMode: args.permissionMode ?? '',
    cwd: args.cwd ?? '',
    baseBranch: args.baseBranch ?? '',
    branchName: args.branchName ?? '',
    proposalId: '',
  }
}

/** A registered child, as the tool tells a plugin's call about it. */
export type ChildSessionRegistered = { sessionId: string; name: string; started: boolean }

/** What a plugin's spawn resolves to. */
export type SessionSpawnOutcome = ChildSessionRegistered | { deny: string }

/** What `$.session.spawn` needs of the session's tools. */
export type SessionSpawnToolCaller = {
  call(
    input: Record<string, unknown>,
    raise: { context: DispatchContext; signal?: AbortSignal },
    options?: { onChildSessionRegistered?: (registered: ChildSessionRegistered) => void },
  ): Promise<unknown>
}

/** The tool's refusal text as a reason: "Refused: <reason>". */
function refusalOf(text: unknown): string {
  if (typeof text !== 'string' || text.trim() === '') return 'SpawnSession did not register a session'
  const first = text.trim()
  return first.startsWith('Refused: ') ? first.slice('Refused: '.length) : first
}

/**
 * A plugin's spawn: its own `SpawnSession` call through `tool.call`, so every
 * other plugin's guard on that tool applies, then `session.spawn` inside it.
 * Resolves to the registered session, or `{ deny }` with the reason.
 */
export async function spawnSessionThroughTool(
  tools: SessionSpawnToolCaller,
  args: SessionSpawnArgs,
  raise: { context: DispatchContext; signal?: AbortSignal },
): Promise<SessionSpawnOutcome> {
  let registered: ChildSessionRegistered | undefined
  const answer = (await tools.call(spawnSessionToolInputOf(args), raise, {
    onChildSessionRegistered: outcome => {
      registered = outcome
    },
  })) as { result?: unknown; text?: unknown } | undefined
  if (registered) return registered
  return { deny: refusalOf(typeof answer?.text === 'string' ? answer.text : answer?.result) }
}
