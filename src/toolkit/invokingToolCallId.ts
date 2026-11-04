/**
 * The id of the `toolName` call in the assistant row that invoked a tool, preferring the call whose arguments
 * equal `input`; with no exact match, the only such call. Empty string when it cannot tell.
 */
export function invokingToolCallId(invokingRow: unknown, toolName: string, input: unknown): string {
  const message = (invokingRow as { message?: { content?: unknown } } | undefined)?.message
  const parts = Array.isArray(message?.content) ? (message!.content as unknown[]) : []
  // A converted part is `tool-call` {toolCallId, toolName, args}; a wire block is `tool_use` {id, name, input}.
  const calls = parts.flatMap(part => {
    if (typeof part !== 'object' || part === null) return []
    const value = part as Record<string, unknown>
    if (value.type === 'tool-call' && value.toolName === toolName) return [{ id: value.toolCallId, args: value.args }]
    if (value.type === 'tool_use' && value.name === toolName) return [{ id: value.id, args: value.input }]
    return []
  })
  const same = calls.find(call => JSON.stringify(call.args) === JSON.stringify(input))
  const chosen = same ?? (calls.length === 1 ? calls[0] : undefined)
  return typeof chosen?.id === 'string' ? chosen.id : ''
}
