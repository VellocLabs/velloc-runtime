/**
 * `prompt.mention` (F-25): one file a submitted prompt names after an `@`,
 * raised before it is read for the model. Pure shapes and checks; the chain
 * runs in the extension runtime, the read in the prompt's attachment step.
 */

/** How a mentioned file was attached. */
export type PromptMentionAttached = 'file' | 'already_read_file' | 'pdf_reference'

export type PromptMentionInput = {
  /** What followed the `@`, as typed (fragment included). Pinned. */
  mention: string
  /** The absolute path read. A rewrite reads another file. */
  path: string
  /** First line read, from 1; absent for a whole file. */
  offset?: number
  /** Lines read; absent for a whole file. */
  limit?: number
  /** The loop whose prompt carries the mention; absent on main. Pinned. */
  agentId?: string
}

/** What the read hands the chain: how the file was attached (null: nothing
 *  was), or a refusal when a deny rule covers a rewritten path. */
export type PromptMentionRead = { type: PromptMentionAttached | null } | { deny: string }

/** The read a mention site hands the runtime; called at most once. */
export type PromptMentionCore = (e: { path: string; offset?: number; limit?: number }) => Promise<PromptMentionRead>

/** What the chain settles to: the attachment kind plus model-only context,
 *  or a refusal (nothing of the file is attached). */
export type PromptMentionSettlement =
  | { type: PromptMentionAttached | null; context: string[] }
  | { deny: string }

const ATTACHED: ReadonlySet<unknown> = new Set(['file', 'already_read_file', 'pdf_reference'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLineCount(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1)
}

/** A hook's answer: `{ deny: reason }`, or `{ type, context? }` with each
 *  context entry a non-empty string. */
export function isPromptMentionResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.deny !== undefined) return typeof value.deny === 'string' && value.deny !== ''
  if (value.type !== null && !ATTACHED.has(value.type)) return false
  if (value.context === undefined) return true
  return Array.isArray(value.context) && value.context.every(c => typeof c === 'string' && c !== '')
}

/** An answer over what its `next` resolved to keeps every context entry that
 *  resolution carried. Returns the reason it is refused, or null. */
export function droppedContextProblem(answer: unknown, beneath: unknown): string | null {
  if (!isRecord(answer) || !isRecord(beneath) || typeof answer.deny === 'string') return null
  const below = Array.isArray(beneath.context) ? beneath.context : []
  if (below.length === 0) return null
  const kept = Array.isArray(answer.context) ? answer.context : []
  return below.every(entry => kept.includes(entry)) ? null : 'an answer drops context its next gave'
}

/** A rewritten event: `path` a non-empty string, `offset`/`limit` whole
 *  numbers from 1, `mention` and `agentId` pinned. Returns the reason it is
 *  refused, or null. */
export function mentionInputProblem(original: PromptMentionInput, e: unknown): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  if (typeof e.path !== 'string' || e.path.trim() === '') return 'path is not a non-empty string'
  if (!isLineCount(e.offset)) return 'offset is not a whole number from 1'
  if (!isLineCount(e.limit)) return 'limit is not a whole number from 1'
  if (e.mention !== undefined && e.mention !== original.mention) return 'mention is pinned'
  if (e.agentId !== undefined && e.agentId !== original.agentId) return 'agentId is pinned'
  return null
}

/** The read a rewritten event asks for. */
export function mentionReadOf(e: PromptMentionInput): { path: string; offset?: number; limit?: number } {
  return {
    path: e.path,
    ...(e.offset !== undefined ? { offset: e.offset } : {}),
    ...(e.limit !== undefined ? { limit: e.limit } : {}),
  }
}

/** The settlement of an accepted answer. */
export function settlementOf(result: unknown): PromptMentionSettlement {
  const r = result as { deny?: string; type?: PromptMentionAttached | null; context?: string[] }
  if (typeof r.deny === 'string') return { deny: r.deny }
  return { type: r.type ?? null, context: [...(r.context ?? [])] }
}
