/**
 * `$.session.messages` (newest 4096 entries; another agent's only when readable,
 * else `{ deny }`) and `$.session.usage` (missing figures left out, never zeroed)
 * (F-25). Op events, so a guard above may scrub what another plugin reads. Pure.
 */

import { blocksOf, type ApiContentBlock, type SessionAppendMessage, type StoredRow } from './sessionAppendEvent'
import { sessionMessagesOf, type ModTranscriptEntry } from './sessionCompactEvent'
import type { SessionSendResult } from './sessionMessageEvents'
import type { DispatchContext } from './modTypes'
import type { WindowBreakdown } from './windowBreakdown'

/** "The newest 4096 entries" — both forms. */
export const SESSION_MESSAGES_CAP = 4096

/** What `$.session.messages(args)` takes, checked: `SessionMessagesArgs`. */
export type SessionMessagesArgs = { agentId?: string; as?: 'api' }

/** One message in Messages API form — `ApiMessage` in the declaration. */
export type ApiMessage = { role: 'user' | 'assistant'; content: ApiContentBlock[] }

/** "Why no conversation was read, naming the id." */
export type SessionMessagesDeny = { deny: string }

/** What `$.session` needs of the engine for these two nouns; bound late. */
export type ModTranscriptHost = {
  /** The main conversation's rows, oldest first. */
  rows(): readonly StoredRow[]
  /** One of this session's agents' rows, or why they cannot be read. */
  agentRows(agentId: string): Promise<readonly StoredRow[] | SessionMessagesDeny>
  /** `$.session.usage()` without a breakdown. */
  usage(): SessionUsage
  /** The live window by category; absent on a host that cannot render the prompt. */
  breakdown?(args: { columns?: number }): Promise<WindowBreakdown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The event's `e` from `$.session.messages(args?)`: `{}` for the main
 *  conversation's rows. A wrong field is a TypeError naming it. */
export function sessionMessagesArgsOf(value: unknown): SessionMessagesArgs {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError('$.session.messages(args): args must be { agentId?, as? }')
  const { agentId, as } = value
  if (agentId !== undefined && (typeof agentId !== 'string' || agentId === '')) {
    throw new TypeError('$.session.messages: agentId must be a non-empty string')
  }
  if (as !== undefined && as !== 'api') throw new TypeError('$.session.messages: as must be "api" or absent')
  return { ...(agentId !== undefined ? { agentId } : {}), ...(as !== undefined ? { as } : {}) }
}

/**
 * An Edit or Write call's `result` as a plugin sees it — the shape it reads
 * a turn's edits off (`{ filePath, structuredPatch }`,
 * Write's `type` and `content` beside them) — from the diff Velloc keeps on
 * the row's tool detail (`toolCallDetail.editDiff`) rather than in the
 * model-facing result. Keyed by the call's id; a row whose detail was
 * stripped (a reloaded session's) has none.
 */
function editResultsOf(rows: readonly StoredRow[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const detail = (row as { toolCallDetail?: unknown }).toolCallDetail
    if (!isRecord(detail) || typeof detail.toolCallId !== 'string' || !isRecord(detail.editDiff)) continue
    // The stored diff names its fields `patchHunks` / `fileWasCreated`; the
    // plugin-facing result keeps the `structuredPatch` key plugins read.
    const { filePath, patchHunks, fileWasCreated } = detail.editDiff
    if (typeof filePath !== 'string' || !Array.isArray(patchHunks)) continue
    const args = isRecord(detail.args) ? detail.args : {}
    out.set(detail.toolCallId, {
      filePath,
      structuredPatch: patchHunks,
      ...(detail.toolName === 'Write'
        ? {
            type: fileWasCreated === true ? 'create' : 'update',
            ...(typeof args.content === 'string' ? { content: args.content } : {}),
          }
        : {}),
    })
  }
  return out
}

/**
 * The rows as `ModTranscriptEntry`s: the conversation's user and assistant rows,
 * no handles ("Absent on `$.session.messages()`"), each tool use carrying
 * its outcome — "`result`, `text`, `isError` once the transcript holds it",
 * paired by `tool_use_id` with the tool_result of a later user row. The
 * newest 4096.
 */
export function sessionMessageRows(rows: readonly StoredRow[]): ModTranscriptEntry[] {
  const { messages } = sessionMessagesOf(rows)
  const edits = editResultsOf(rows)
  const outcomes = new Map<string, { text: string; isError: boolean; result?: unknown }>()
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const edit = result.isError ? undefined : edits.get(result.tool_use_id)
      outcomes.set(result.tool_use_id, edit ? { ...result, result: edit } : result)
    }
  }
  const out = messages.map(({ handle: _handle, ...message }): ModTranscriptEntry => {
    const toolResults = message.toolResults?.map(each => {
      const result = outcomes.get(each.tool_use_id)?.result ?? each.result
      return {
        tool_use_id: each.tool_use_id,
        text: each.text,
        isError: each.isError,
        ...(result !== undefined ? { result } : {}),
      }
    })
    return {
      ...message,
      toolUses: message.toolUses.map(use => {
        const outcome = outcomes.get(use.tool_use_id)
        if (!outcome) return use
        return {
          ...use,
          ...(outcome.result !== undefined ? { result: outcome.result } : {}),
          text: outcome.text,
          // "Present only when the tool reported an error."
          ...(outcome.isError ? { isError: true } : {}),
        }
      }),
      ...(toolResults ? { toolResults } : {}),
    }
  })
  return out.length > SESSION_MESSAGES_CAP ? out.slice(out.length - SESSION_MESSAGES_CAP) : out
}

/**
 * The rows in Messages API form: "the ones the next request is built from,
 * after the engine's normalization (the last compaction's summary in place
 * of what it replaced …); at most 4096, opening on a user one". So: the rows
 * from the last compaction boundary on, user and assistant alone, adjacent
 * rows of one role joined into one message (as a request carries them), the
 * newest 4096, and any assistant message before the first user one dropped.
 */
export function apiMessageRows(rows: readonly StoredRow[]): ApiMessage[] {
  let start = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      start = i + 1
      break
    }
  }
  const out: ApiMessage[] = []
  for (const row of rows.slice(start)) {
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const message = isRecord(row.message) ? row.message : {}
    const content = blocksOf(message.content)
    if (content.length === 0) continue
    const last = out[out.length - 1]
    if (last && last.role === row.type) last.content.push(...content)
    else out.push({ role: row.type, content })
  }
  let first = out.length > SESSION_MESSAGES_CAP ? out.length - SESSION_MESSAGES_CAP : 0
  while (first < out.length && out[first]!.role !== 'user') first += 1
  return out.slice(first)
}

/** `{ deny }` for an id this session cannot read: "naming the id". */
export function agentDeny(agentId: string, why: string): SessionMessagesDeny {
  return { deny: `agent ${agentId}: ${why}` }
}

/** A `session.messages` answer as the declaration takes it: the rows, the
 *  API messages, or `{ deny }`. */
export function isSessionMessagesValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isRecord)
  return isRecord(value) && typeof value.deny === 'string' && value.deny !== ''
}

// ---------------------------------------------------------------------------
// usage

/** What `$.session.usage(args)` takes, checked: `SessionUsageArgs`. */
export type SessionUsageArgs = { breakdown?: 'summary' | 'full'; columns?: number }

export type SessionContextUsage = { tokens?: number; window: number; percent?: number; breakdown?: WindowBreakdown }

/** `SessionUsage` in the declaration; `context.breakdown` only when asked. */
export type SessionUsage = {
  startedAt: number
  context: SessionContextUsage
  rateLimits: { kind: string; percentUsed: number; resetsAt?: number }[]
  cost?: { usd: number }
}

/** The event's `e` from `$.session.usage(args?)`. A wrong field is a TypeError naming it. */
export function sessionUsageArgsOf(value: unknown): SessionUsageArgs {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError('$.session.usage(args): args must be { breakdown?, columns? }')
  const { breakdown, columns } = value
  if (breakdown !== undefined && breakdown !== 'summary' && breakdown !== 'full') {
    throw new TypeError('$.session.usage: breakdown must be "summary", "full" or absent')
  }
  if (columns !== undefined && (typeof columns !== 'number' || !Number.isInteger(columns) || columns < 1)) {
    throw new TypeError('$.session.usage: columns must be a whole number of at least 1')
  }
  return { ...(breakdown !== undefined ? { breakdown } : {}), ...(columns !== undefined ? { columns } : {}) }
}

/** Why `{ breakdown }` is refused on a host that cannot render the prompt. */
export const USAGE_BREAKDOWN_REFUSAL =
  '$.session.usage({ breakdown }) is not available: this session cannot render its prompt to measure it'

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** A row's time in ms, or undefined. */
function timeOf(row: StoredRow): number | undefined {
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
  return Number.isFinite(at) ? at : undefined
}

/**
 * The status line's figures off the rows: `startedAt`, `context.tokens` / `percent`
 * from the last usage after the last compaction, `rateLimits` always `[]`, `cost`
 * when every response was priced.
 */
export function sessionUsageOf(input: {
  rows: readonly StoredRow[]
  window: number
  fallbackStartedAt: number
  costUsd?: number
}): SessionUsage {
  const { rows, window } = input
  let startedAt: number | undefined
  for (const row of rows) {
    const at = timeOf(row)
    if (at !== undefined && (startedAt === undefined || at < startedAt)) startedAt = at
  }
  let tokens: number | undefined
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.type === 'system' && row.subtype === 'compact_boundary') break
    if (row.type !== 'assistant') continue
    const message = isRecord(row.message) ? row.message : {}
    const usage = isRecord(message.usage) ? message.usage : undefined
    if (!usage || typeof usage.input_tokens !== 'number') continue
    tokens = count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens)
    break
  }
  return {
    startedAt: startedAt ?? input.fallbackStartedAt,
    context: {
      ...(tokens !== undefined ? { tokens } : {}),
      window,
      ...(tokens !== undefined && window > 0 ? { percent: Math.min(100, Math.max(0, Math.round((tokens / window) * 100))) } : {}),
    },
    rateLimits: [],
    ...(input.costUsd !== undefined ? { cost: { usd: input.costUsd } } : {}),
  }
}

// ---------------------------------------------------------------------------
// session.measure — the same figures, pushed after each main-thread turn

/** `UsageUnit` in the declaration. */
export type UsageUnit = 'context' | 'rateLimits' | 'cost'

/** The figures the last raised `session.measure` carried. */
export type MeasuredFigures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

/**
 * "Which units differ from the last measurement raised … never empty; the
 * first measurement names every unit it has a figure for." `context`: the
 * fill (`tokens`) moved; `rateLimits`: a window moved a whole point, appeared
 * or left; `cost`: the total grew. `[]` means nothing to raise.
 */
export function measureChangedUnits(previous: MeasuredFigures | undefined, now: MeasuredFigures): UsageUnit[] {
  const changed: UsageUnit[] = []
  if (previous === undefined) {
    if (now.context.tokens !== undefined) changed.push('context')
    if (now.rateLimits.length > 0) changed.push('rateLimits')
    if (now.cost !== undefined) changed.push('cost')
    return changed
  }
  if (now.context.tokens !== previous.context.tokens) changed.push('context')
  const points = (limits: MeasuredFigures['rateLimits']) =>
    limits.map(limit => `${limit.kind}:${Math.floor(limit.percentUsed)}`).sort().join(',')
  if (points(now.rateLimits) !== points(previous.rateLimits)) changed.push('rateLimits')
  if (now.cost !== undefined && now.cost.usd > (previous.cost?.usd ?? -1)) changed.push('cost')
  return changed
}

/** A `session.usage` answer as the declaration takes it. */
export function isSessionUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.startedAt === 'number' &&
    isRecord(value.context) &&
    typeof value.context.window === 'number' &&
    Array.isArray(value.rateLimits)
  )
}

// ---------------------------------------------------------------------------
// compact / send / append — the plugin's own calls of three engine events
//
// Unlike `messages` and `usage` these are not op events: each is "the event
// `session.<x>`" itself (`EventCalls['session']`), raised by the engine with
// the caller's context — every hook but the calling one, then core. The
// nouns are `raisesItself` (`modNouns.ts`); the engine's half is
// `QueryEngine.modConversation`.

/** Who raised the call, and the hook to skip; the call's signal. */
export type ModConversationRaise = { context: DispatchContext; signal?: AbortSignal }

/** `$.session.compact(args?)`: "What the summary should keep or stress". */
export type SessionCompactArgs = { instructions?: string }

/** `$.session.compact`'s answer: the conversation as it reads afterwards (no
 *  handles: they are the event's, not the call's), or the veto. */
export type SessionCompactCallResult =
  | { messages: ModTranscriptEntry[]; tokensBefore?: number; tokensAfter?: number }
  | { skip: string }

/** "a recipient as the SendMessage tool names one (a string), or a session or
 *  an agent of this session by id" — `SessionSendAddress`. */
export type SessionSendAddress = string | { sessionId: string } | { agentId: string }

export type SessionSendArgs = { to: SessionSendAddress; text: string }

/** `$.session.append(args)` — `SessionAppendArgs`. */
export type SessionAppendArgs = {
  message: { type: 'user' | 'system'; content: ApiContentBlock[] }
  agentId?: string
}

/** What the three calls need of the engine; bound late, like `transcript`. */
export type ModConversationHost = {
  compact(args: SessionCompactArgs, raise: ModConversationRaise): Promise<SessionCompactCallResult>
  send(args: SessionSendArgs, raise: ModConversationRaise): Promise<SessionSendResult>
  append(
    args: SessionAppendArgs,
    raise: ModConversationRaise,
  ): Promise<{ message: SessionAppendMessage; uuid: string } | { deny: string }>
}

export function sessionCompactArgsOf(value: unknown): SessionCompactArgs {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError('$.session.compact(args): args must be { instructions? }')
  const { instructions } = value
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new TypeError('$.session.compact: instructions must be a string')
  }
  return instructions !== undefined && instructions.trim() !== '' ? { instructions } : {}
}

export function sessionSendArgsOf(value: unknown): SessionSendArgs {
  if (!isRecord(value)) throw new TypeError('$.session.send(args): args must be { to, text }')
  const { to, text } = value
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('$.session.send: text must be a non-empty string')
  }
  if (typeof to === 'string') {
    if (to.trim() === '') throw new TypeError('$.session.send: to must be a non-empty name')
    return { to, text }
  }
  if (isRecord(to)) {
    const keys = Object.keys(to)
    if (keys.length === 1 && typeof to.sessionId === 'string' && to.sessionId !== '') {
      return { to: { sessionId: to.sessionId }, text }
    }
    if (keys.length === 1 && typeof to.agentId === 'string' && to.agentId !== '') {
      return { to: { agentId: to.agentId }, text }
    }
  }
  throw new TypeError('$.session.send: to must be a name, { sessionId } or { agentId }')
}

/** The call's shape. What the content may hold is "the bottom's" to refuse
 *  (`appendRefusal`): a hook above may rewrite it first. */
export function sessionAppendArgsOf(value: unknown): SessionAppendArgs {
  if (!isRecord(value) || !isRecord(value.message)) {
    throw new TypeError('$.session.append(args): args must be { message: { type, content }, agentId? }')
  }
  const { type, content } = value.message
  if (type !== 'user' && type !== 'system') {
    throw new TypeError('$.session.append: message.type must be "user" or "system"')
  }
  if (!Array.isArray(content) || !content.every(isRecord)) {
    throw new TypeError('$.session.append: message.content must be a list of blocks')
  }
  const { agentId } = value
  if (agentId !== undefined && (typeof agentId !== 'string' || agentId === '')) {
    throw new TypeError('$.session.append: agentId must be a non-empty string')
  }
  return {
    message: { type, content: content as ApiContentBlock[] },
    ...(agentId !== undefined ? { agentId } : {}),
  }
}

/**
 * "Its `content` is text blocks alone (one, for a notice): the bottom refuses
 * any other block, and any other row type, with the reason." Null when the
 * row may be kept.
 */
export function appendRefusal(message: SessionAppendArgs['message']): string | null {
  if (message.content.length === 0) return 'message.content holds no block'
  const other = message.content.find(block => block.type !== 'text' || typeof block.text !== 'string')
  if (other) return `message.content holds a ${String(other.type)} block: text blocks alone`
  if (message.type === 'system' && message.content.length !== 1) return 'a notice is one text block'
  return null
}

/** `$.session.compact`'s answer from the settled compaction: the rows the
 *  boundary is followed by, as `ModTranscriptEntry`s. */
export function compactCallResultOf(
  rows: readonly StoredRow[],
  tokensBefore: number | undefined,
): SessionCompactCallResult {
  return {
    messages: sessionMessagesOf(rows).messages.map(({ handle: _handle, ...message }) => message),
    ...(tokensBefore !== undefined ? { tokensBefore } : {}),
  }
}
