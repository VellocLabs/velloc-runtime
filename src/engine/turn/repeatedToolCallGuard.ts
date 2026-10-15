// Mid-stream guard against a model re-emitting one tool call: cuts a run of identical CONSECUTIVE
// READ-ONLY calls (`tool.readsOnly(args)`); identity is tool name + key-sorted args. Mutating calls
// are never cut (P-4).

export const REPEATED_TOOL_CALL_LIMIT = 8

/** Evidence stamped on the assistant message whose stream the guard cut. */
export type RepeatedToolCallCut = {
  toolName: string
  /** Identical consecutive calls seen when the stream was cut. */
  repeatCount: number
  providerId?: string
  model?: string
  thinkingTier?: string
  maxOutputTokens?: number
  /** Request shape, so a later report can be compared with a normal turn. */
  systemPromptChars: number
  systemPromptHash: string
  toolCount: number
  transcriptLength: number
  /** Milliseconds from stream start to the cut. */
  elapsedMs: number
}

type ContentBlock = Record<string, unknown>

export type RepeatedToolCallGuard = {
  /**
   * Feed every content block in stream order. Returns true when this block
   * completes a run of `REPEATED_TOOL_CALL_LIMIT` identical consecutive
   * read-only tool calls.
   */
  observe(block: ContentBlock): boolean
}

export function createRepeatedToolCallGuard(
  isReadOnlyCall: (toolName: string, args: unknown) => boolean,
  limit: number = REPEATED_TOOL_CALL_LIMIT,
): RepeatedToolCallGuard {
  let lastKey: string | undefined
  let run = 0
  return {
    observe(block) {
      const key = readOnlyCallKey(block, isReadOnlyCall)
      if (key === undefined) {
        lastKey = undefined
        run = 0
        return false
      }
      run = key === lastKey ? run + 1 : 1
      lastKey = key
      return run === limit
    },
  }
}

function readOnlyCallKey(
  block: ContentBlock,
  isReadOnlyCall: (toolName: string, args: unknown) => boolean,
): string | undefined {
  if (block.type !== 'tool-call') return undefined
  const toolName = block.toolName
  if (typeof toolName !== 'string' || !toolName) return undefined
  let readOnly = false
  try {
    readOnly = isReadOnlyCall(toolName, block.args)
  } catch {
    readOnly = false
  }
  if (!readOnly) return undefined
  return `${toolName}\u0000${stableStringify(block.args)}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`
}

/** FNV-1a over a string, hex. Only for comparing request shapes in reports. */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
