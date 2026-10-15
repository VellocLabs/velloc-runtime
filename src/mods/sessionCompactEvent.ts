/**
 * `session.compact` (F-25): transcript rows as entries carrying the engine's
 * `handle`, and back: an entry with its handle is the engine's row, whole; one
 * without is built. Pure.
 */

import type { StoredRow } from './sessionAppendEvent'

export type SessionCompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute'

export type ToolUseSummary = {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  result?: unknown
  text?: string
  isError?: boolean
}

export type ToolResultSummary = {
  tool_use_id: string
  text: string
  isError: boolean
  result?: unknown
}

/** One message of the transcript as `$.session.messages()` returns it, with
 *  the engine's `handle` when it is the engine's own. */
export type ModTranscriptEntry = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUseSummary[]
  toolResults?: ToolResultSummary[]
  handle?: string
}

export type SessionCompactInput = {
  trigger: SessionCompactTrigger
  agentId?: string
  instructions?: string
  messages: readonly ModTranscriptEntry[]
}

export type SessionCompacted = {
  messages: readonly ModTranscriptEntry[]
  tokensBefore?: number
  tokensAfter?: number
}

export type SessionCompactResult = SessionCompacted | { skip: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return textOf(result)
  return result === undefined || result === null ? '' : JSON.stringify(result)
}

/** The transcript's conversational rows (user and assistant) as the
 *  declaration's messages, each with a handle naming the row. Rows no
 *  request carries (a notice, an attachment, a frame) are left out. */
export function sessionMessagesOf(rows: readonly StoredRow[]): { messages: ModTranscriptEntry[]; byHandle: Map<string, StoredRow> } {
  const byHandle = new Map<string, StoredRow>()
  const messages: ModTranscriptEntry[] = []
  rows.forEach((row, index) => {
    if (row.type !== 'user' && row.type !== 'assistant') return
    const message = isRecord(row.message) ? row.message : {}
    const handle = `h${index}:${typeof row.uuid === 'string' ? row.uuid : ''}`
    byHandle.set(handle, row)
    const content = message.content
    const parts = Array.isArray(content) ? content : []
    if (row.type === 'assistant') {
      const toolUses: ToolUseSummary[] = parts
        .filter(part => isRecord(part) && (part.type === 'tool-call' || part.type === 'tool_use'))
        .map(part => {
          const p = part as Record<string, unknown>
          return {
            tool_use_id: String(p.toolCallId ?? p.id ?? ''),
            tool: String(p.toolName ?? p.name ?? ''),
            input: isRecord(p.args) ? p.args : isRecord(p.input) ? p.input : {},
          }
        })
      messages.push({ role: 'assistant', text: textOf(content), toolUses, handle })
      return
    }
    const toolResults: ToolResultSummary[] = parts
      .filter(part => isRecord(part) && (part.type === 'tool-result' || part.type === 'tool_result'))
      .map(part => {
        const p = part as Record<string, unknown>
        const result = p.result ?? p.output ?? p.content
        return {
          tool_use_id: String(p.toolCallId ?? p.tool_use_id ?? ''),
          text: resultText(result),
          isError: p.isError === true || p.is_error === true,
          result,
        }
      })
    messages.push({
      role: 'user',
      text: textOf(content),
      toolUses: [],
      ...(toolResults.length > 0 ? { toolResults } : {}),
      handle,
    })
  })
  return { messages, byHandle }
}

/** Whether a value is one `ModTranscriptEntry` as a hook may build it. */
function isSessionMessage(value: unknown): value is ModTranscriptEntry {
  if (!isRecord(value)) return false
  if (value.role !== 'user' && value.role !== 'assistant') return false
  if (typeof value.text !== 'string') return false
  if (value.toolUses !== undefined && !Array.isArray(value.toolUses)) return false
  if (value.toolResults !== undefined && !Array.isArray(value.toolResults)) return false
  if (value.handle !== undefined && typeof value.handle !== 'string') return false
  return true
}

/** The event's result shape: `{ messages }` or `{ skip }`. */
export function isSessionCompactResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.skip === 'string') return value.skip !== ''
  return Array.isArray(value.messages) && value.messages.every(isSessionMessage)
}

/** Whether a rewritten `e` is one the chain's core can run over. */
export function compactInputProblem(original: SessionCompactInput, e: unknown): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  if (e.trigger !== undefined && e.trigger !== original.trigger) return 'trigger is pinned'
  if (e.agentId !== undefined && e.agentId !== original.agentId) return 'agentId is pinned'
  if (e.instructions !== undefined && typeof e.instructions !== 'string') return 'instructions is not a string'
  if (!Array.isArray(e.messages) || !e.messages.every(isSessionMessage)) return 'messages is not a list of messages'
  return null
}

/**
 * The stored rows for a list a hook handed down or up: a message with the
 * engine's handle is the engine's own row, whole; one without is built from
 * its role, text and tool blocks. A handle the engine never gave is refused.
 */
export function rowsOf(
  messages: readonly ModTranscriptEntry[],
  byHandle: ReadonlyMap<string, StoredRow>,
  uuid: () => string,
): { rows: StoredRow[] } | { refused: string } {
  const rows: StoredRow[] = []
  for (const message of messages) {
    if (message.handle !== undefined) {
      const own = byHandle.get(message.handle)
      if (!own) return { refused: `handle ${message.handle} is not one the engine gave` }
      rows.push(own)
      continue
    }
    rows.push(buildRow(message, uuid()))
  }
  return { rows }
}

/** A row the engine stores for a message a hook built. */
export function buildRow(message: ModTranscriptEntry, uuid: string): StoredRow {
  const timestamp = new Date().toISOString()
  if (message.role === 'assistant') {
    const content: unknown[] = []
    if (message.text !== '') content.push({ type: 'text', text: message.text })
    for (const use of message.toolUses ?? []) {
      content.push({ type: 'tool-call', toolCallId: use.tool_use_id, toolName: use.tool, args: use.input ?? {} })
    }
    return { type: 'assistant', uuid, timestamp, message: { role: 'assistant', content } }
  }
  const results = message.toolResults ?? []
  if (results.length === 0) {
    return { type: 'user', uuid, timestamp, message: { role: 'user', content: message.text } }
  }
  const content: unknown[] = results.map(result => ({
    type: 'tool-result',
    toolCallId: result.tool_use_id,
    result: result.text,
    ...(result.isError ? { isError: true } : {}),
  }))
  if (message.text !== '') content.push({ type: 'text', text: message.text })
  return { type: 'user', uuid, timestamp, message: { role: 'user', content } }
}

/** What the chain's core runs: the engine's own compaction over the rows
 *  it is handed, with the instructions it is handed. */
export type SessionCompactCoreInput = { instructions?: string; messages: StoredRow[] }

/** The engine's compaction, as `performCompaction` answers it. */
export type SessionCompactOutcome =
  | { boundaryMarker: StoredRow; summaryMessages: StoredRow[] }
  | { error: string }

/** A call site's half of `session.compact`. */
export type SessionCompactCore = {
  run(e: SessionCompactCoreInput): Promise<SessionCompactOutcome>
  /** The boundary row for a compaction a hook answered in core's place. */
  boundary(messages: readonly StoredRow[]): StoredRow
}

export type SessionCompactSettlement = SessionCompactOutcome | { skip: string }

/** The tokens the boundary row records, when it does. */
export function tokensBeforeOf(boundary: StoredRow): number | undefined {
  const metadata = isRecord(boundary.compactMetadata) ? boundary.compactMetadata : undefined
  return metadata && typeof metadata.preTokens === 'number' ? metadata.preTokens : undefined
}
