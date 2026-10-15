/**
 * `session.append` (F-25): conversion between stored rows and the event's messages,
 * and a hook's rewrite applied under the pins: the pinned fields fail the hook if
 * changed; text and tool_result content are rewritable; media may be dropped or
 * moved only; thinking, tool_use and `tool_use_id` are put back. Pure.
 */

export type SessionAppendDoor =
  | 'prompt'
  | 'command'
  | 'response'
  | 'tool-result'
  | 'tool-message'
  | 'delivery'
  | 'attachment'
  | 'hook-context'
  | 'note'
  | 'compaction'
  | 'notice'

export type SessionAppendOrigin =
  | { kind: 'composer' }
  | { kind: 'sdk' }
  | { kind: 'peer' }
  | { kind: 'engine' }
  | { kind: 'hook'; event: string }
  | { kind: 'plugin'; event: string }
  /** A plugin's own `$.session.append` (door `note`) — `PromptOrigin`'s. */
  | { kind: 'plugin'; name: string }
  | { kind: 'model'; model: string }
  | { kind: 'tool'; tool: string }

/** One block of a row as the declaration hands it: Messages API shaped. */
export type ApiContentBlock = { type: string; [field: string]: unknown }

export type SessionAppendMessage = {
  type: 'user' | 'assistant' | 'attachment' | 'system'
  name?: string
  role?: 'user' | 'assistant'
  isMeta?: true
  content: ApiContentBlock[]
}

export type SessionAppendInput = {
  message: SessionAppendMessage
  door: SessionAppendDoor
  origin: SessionAppendOrigin
  uuid: string
  agentId?: string
}

export type SessionAppendResult = { message: SessionAppendMessage; uuid: string }

/** A stored row as the engine keeps it — `Message` of `runtime/RuntimeTypes`
 *  (kept structural here so this module imports nothing of the engine's). */
export type StoredRow = { type: string; uuid?: string; [key: string]: unknown }

const PART_TEXT = 'text'
const PART_TOOL_CALL = 'tool-call'
const PART_TOOL_RESULT = 'tool-result'
const LEGACY_TOOL_USE = 'tool_use'
const LEGACY_TOOL_RESULT = 'tool_result'
const MEDIA_BLOCKS = new Set(['image', 'document', 'file'])
const COMPACT_BOUNDARY = 'compact_boundary'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return value === undefined || value === null ? '' : JSON.stringify(value)
}

/** The Messages API block for one of Velloc's content parts. */
function blockOf(part: unknown): ApiContentBlock {
  if (typeof part === 'string') return { type: PART_TEXT, text: part }
  if (!isRecord(part)) return { type: 'unknown', value: part }
  const type = typeof part.type === 'string' ? part.type : 'unknown'
  if (type === PART_TEXT) return { type: PART_TEXT, text: typeof part.text === 'string' ? part.text : '' }
  if (type === PART_TOOL_CALL || type === LEGACY_TOOL_USE) {
    return {
      type: LEGACY_TOOL_USE,
      id: String(part.toolCallId ?? part.id ?? ''),
      name: String(part.toolName ?? part.name ?? ''),
      input: part.args ?? part.input ?? {},
    }
  }
  if (type === PART_TOOL_RESULT || type === LEGACY_TOOL_RESULT) {
    const result = part.result ?? part.output ?? part.content
    return {
      type: LEGACY_TOOL_RESULT,
      tool_use_id: String(part.toolCallId ?? part.tool_use_id ?? ''),
      content: typeof result === 'string' ? result : textOf(result),
      ...(part.isError === true || part.is_error === true ? { is_error: true } : {}),
    }
  }
  // Media and the rest cross as they are, under their own type.
  return { ...part, type }
}

/** A row's content as Messages API blocks — also `$.session.messages({ as:
 *  "api" })`'s (`sessionNouns.ts`). */
export function blocksOf(content: unknown): ApiContentBlock[] {
  if (typeof content === 'string') return [{ type: PART_TEXT, text: content }]
  if (Array.isArray(content)) return content.map(blockOf)
  return []
}

export type DescribedRow = {
  input: SessionAppendInput
}

/**
 * The event's `e` for a stored row, or null for a row the engine does not
 * raise: one without a uuid (a synthetic row the loop made for itself), a
 * stream or progress frame, a tombstone — nothing a conversation keeps as a
 * row of its own.
 */
export function describeAppendRow(row: StoredRow, agentId?: string): SessionAppendInput | null {
  if (typeof row.uuid !== 'string' || row.uuid === '') return null
  const ride = agentId !== undefined ? { agentId } : {}
  switch (row.type) {
    case 'user': {
      const message = isRecord(row.message) ? row.message : {}
      const content = message.content
      const blocks = blocksOf(content)
      const isMeta = row.isMeta === true
      const toolResult = blocks.find(block => block.type === LEGACY_TOOL_RESULT)
      if (toolResult) {
        const ref = isRecord(row.toolCallDetailRef) ? row.toolCallDetailRef : undefined
        const tool = ref && typeof ref.toolName === 'string' ? ref.toolName : 'unknown'
        return {
          message: { type: 'user', role: 'user', ...(isMeta ? { isMeta: true } : {}), content: blocks },
          door: 'tool-result',
          origin: { kind: 'tool', tool },
          uuid: row.uuid,
          ...ride,
        }
      }
      if (row.origin === 'mailbox') {
        return {
          message: { type: 'user', role: 'user', ...(isMeta ? { isMeta: true } : {}), content: blocks },
          door: 'delivery',
          origin: { kind: 'peer' },
          uuid: row.uuid,
          ...ride,
        }
      }
      if (isMeta) {
        return {
          message: { type: 'user', role: 'user', isMeta: true, content: blocks },
          door: 'attachment',
          origin: { kind: 'engine' },
          uuid: row.uuid,
          ...ride,
        }
      }
      const text = textOf(content)
      return {
        message: { type: 'user', role: 'user', content: blocks },
        door: text.startsWith('/') ? 'command' : 'prompt',
        origin: { kind: 'composer' },
        uuid: row.uuid,
        ...ride,
      }
    }
    case 'assistant': {
      const message = isRecord(row.message) ? row.message : {}
      return {
        message: { type: 'assistant', role: 'assistant', content: blocksOf(message.content) },
        door: 'response',
        origin: { kind: 'model', model: typeof message.model === 'string' ? message.model : '' },
        uuid: row.uuid,
        ...ride,
      }
    }
    case 'system': {
      const subtype = typeof row.subtype === 'string' ? row.subtype : 'informational'
      return {
        message: {
          type: 'system',
          name: subtype,
          content: [{ type: PART_TEXT, text: typeof row.message === 'string' ? row.message : textOf(row.message) }],
        },
        door: subtype === COMPACT_BOUNDARY ? 'compaction' : 'notice',
        origin: { kind: 'engine' },
        uuid: row.uuid,
        ...ride,
      }
    }
    case 'attachment': {
      const attachment = isRecord(row.attachment) ? row.attachment : {}
      const name = typeof attachment.type === 'string' ? attachment.type : 'attachment'
      const rendered =
        typeof attachment.content === 'string'
          ? attachment.content
          : typeof attachment.prompt === 'string'
            ? attachment.prompt
            : JSON.stringify(attachment)
      return {
        message: { type: 'attachment', name, content: [{ type: PART_TEXT, text: rendered }] },
        door: 'attachment',
        origin: { kind: 'engine' },
        uuid: row.uuid,
        ...ride,
      }
    }
    default:
      return null
  }
}

/** Whether a value is the event's result shape: `{ message, uuid }`. */
export function isSessionAppendResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.deny === 'string') return true
  return isRecord(value.message) && Array.isArray(value.message.content) && typeof value.uuid === 'string'
}

/**
 * The pins, checked on the row a hook handed down: `type`, `name`, `role`,
 * `isMeta` left out are kept, changed fail the hook. Returns the reason, or
 * null when the row passes.
 */
export function pinnedDifference(original: SessionAppendInput, returned: unknown): string | null {
  if (!isRecord(returned)) return 'the event argument is not an object'
  for (const key of ['door', 'uuid', 'agentId'] as const) {
    if (returned[key] !== undefined && returned[key] !== original[key]) return `${key} is pinned`
  }
  if (returned.origin !== undefined && JSON.stringify(returned.origin) !== JSON.stringify(original.origin)) {
    return 'origin is pinned'
  }
  const message = returned.message
  if (!isRecord(message)) return 'message is not an object'
  for (const key of ['type', 'name', 'role', 'isMeta'] as const) {
    if (message[key] !== undefined && message[key] !== original.message[key]) return `message.${key} is pinned`
  }
  if (!Array.isArray(message.content)) return 'message.content is not an array'
  return null
}

/**
 * Apply a hook's rewrite to the stored row: the row the chain's core was
 * handed, against the row as described. Returns the row to store, or the
 * reason the rewrite is refused (the row is then stored as made).
 */
export function applyAppendRewrite(
  row: StoredRow,
  original: SessionAppendInput,
  returned: unknown,
): { row: StoredRow } | { refused: string } {
  const pinned = pinnedDifference(original, returned)
  if (pinned !== null) return { refused: pinned }
  const message = (returned as { message: { content: unknown[] } }).message
  const blocks = message.content
  const before = original.message.content
  // What is put back is the original block the returned one stands for: a
  // tool_use by id, any other block by equal content, else the first of its
  // kind not yet put back. `sources[k]` is its index in `before`.
  const used = new Set<number>()
  const ownFor = (block: Record<string, unknown>, exact: boolean): number => {
    const open = before.flatMap((own, index) => (own.type === block.type && !used.has(index) ? [index] : []))
    const same =
      block.type === LEGACY_TOOL_USE
        ? open.find(index => before[index]!.id === block.id)
        : open.find(index => JSON.stringify(before[index]) === JSON.stringify(block))
    const index = same ?? (exact ? undefined : open[0])
    if (index === undefined) return -1
    used.add(index)
    return index
  }
  const toolUseIds = new Set(
    before.filter(block => block.type === LEGACY_TOOL_RESULT).map(block => String(block.tool_use_id)),
  )
  const next: ApiContentBlock[] = []
  const sources: Array<number | undefined> = []
  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== 'string') return { refused: 'a block has no type' }
    if (block.type === PART_TEXT) {
      if (typeof block.text !== 'string') return { refused: 'a text block has no text' }
      next.push({ type: PART_TEXT, text: block.text })
      continue
    }
    if (block.type === LEGACY_TOOL_RESULT) {
      const id = String(block.tool_use_id ?? '')
      if (!toolUseIds.has(id)) return { refused: `tool_result ${id || '(none)'} is not one of the row's` }
      const content = block.content
      next.push({
        type: LEGACY_TOOL_RESULT,
        tool_use_id: id,
        content: typeof content === 'string' ? content : textOf(content),
        ...(block.is_error === true ? { is_error: true } : {}),
      })
      continue
    }
    if (MEDIA_BLOCKS.has(block.type)) {
      // Dropped or moved, never changed or added: it must be one of the
      // row's own, whole.
      const index = ownFor(block, true)
      if (index < 0) return { refused: `a ${block.type} block was added or changed` }
      sources[next.length] = index
      next.push(before[index]!)
      continue
    }
    // Thinking, tool_use and unknown kinds: the row's own, never changed.
    const index = ownFor(block, false)
    if (index < 0) return { refused: `a ${block.type} block was added` }
    sources[next.length] = index
    next.push(before[index]!)
  }
  // Relayed unchanged: the row as made, the same object.
  if (JSON.stringify(next) === JSON.stringify(before)) return { row }
  return { row: writeBlocks(row, before, next, sources) }
}

/** The stored row with its content replaced by `blocks` — in Velloc's part
 *  format, keeping each original part's other fields where the block is the
 *  row's own (a tool_result's record, a tool_use's args). */
function writeBlocks(
  row: StoredRow,
  before: ApiContentBlock[],
  blocks: ApiContentBlock[],
  sources: ReadonlyArray<number | undefined>,
): StoredRow {
  if (row.type === 'system') {
    const text = blocks.map(block => (block.type === PART_TEXT ? String(block.text) : '')).join('')
    // A rewritten notice loses its translation: the model and the screen read
    // the text the hook wrote.
    const { i18nContent: _dropped, ...rest } = row
    return { ...rest, message: text }
  }
  if (row.type === 'attachment') {
    // An attachment's rendering is the engine's at request time: the
    // text a hook wrote is kept beside it for what reads `content`, and the
    // payload stands.
    return row
  }
  const message = isRecord(row.message) ? row.message : {}
  const original = Array.isArray(message.content) ? (message.content as unknown[]) : undefined
  const originalParts = original ? [...original] : undefined
  const partsByType = new Map<string, unknown[]>()
  if (originalParts) {
    for (const part of originalParts) {
      const type = isRecord(part) && typeof part.type === 'string' ? blockOf(part).type : PART_TEXT
      const list = partsByType.get(type) ?? []
      list.push(part)
      partsByType.set(type, list)
    }
  }
  const parts: unknown[] = blocks.map((block, k) => {
    if (block.type === PART_TEXT) return { type: PART_TEXT, text: block.text }
    if (block.type === LEGACY_TOOL_RESULT) {
      const own = (partsByType.get(LEGACY_TOOL_RESULT) ?? []).find(
        part => isRecord(part) && String(part.toolCallId ?? part.tool_use_id ?? '') === block.tool_use_id,
      )
      const base = isRecord(own) ? own : { type: PART_TOOL_RESULT, toolCallId: block.tool_use_id }
      const { isError: _e, is_error: _e2, ...rest } = base
      return { ...rest, result: block.content, ...(block.is_error === true ? { isError: true } : {}) }
    }
    const source = sources[k]
    const own = source !== undefined ? originalParts?.[source] : undefined
    return own ?? block
  })
  // A user row that was one string stays one string when it still is one.
  const content =
    typeof message.content === 'string' && parts.length === 1 && isRecord(parts[0]) && parts[0].type === PART_TEXT
      ? String(parts[0].text)
      : parts
  const rewritten: StoredRow = { ...row, message: { ...message, content } }
  // The tool-result mirror the transcript keeps follows the text.
  if (typeof row.toolUseResult === 'string' && before.some(b => b.type === LEGACY_TOOL_RESULT)) {
    const result = blocks.find(block => block.type === LEGACY_TOOL_RESULT)
    if (result && typeof result.content === 'string') rewritten.toolUseResult = result.content
  }
  // So does the detail record: the store persists the row's result redacted
  // and rebuilds it from this record on every later turn — left as the tool
  // made it, a scrubbed result went to the model again from turn two on.
  const detail = isRecord(row.toolCallDetail) ? row.toolCallDetail : undefined
  if (detail) {
    const result = blocks.find(
      block => block.type === LEGACY_TOOL_RESULT && block.tool_use_id === String(detail.toolCallId ?? ''),
    )
    if (result && result.type === LEGACY_TOOL_RESULT) {
      rewritten.toolCallDetail = {
        ...detail,
        result: result.content,
        ...(result.is_error === true ? { isError: true } : {}),
      }
    }
  }
  return rewritten
}
