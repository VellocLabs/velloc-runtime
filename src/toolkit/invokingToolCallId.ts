/**
 * The id of the `toolName` call in the assistant row that invoked a tool, preferring the call whose arguments
 * equal `input`; with no exact match, the only such call. Empty string when it cannot tell.
 */
export function invokingToolCallId(invokingRow: unknown, toolName: string, input: unknown): string {
  const message = (invokingRow as { message?: { content?: unknown } } | undefined)?.message
  const parts = Array.isArray(message?.content) ? (message!.content as unknown[]) : []
  const calls = parts.filter(
    (part): part is { toolCallId?: string; toolName?: string; args?: unknown } =>
      typeof part === 'object' &&
      part !== null &&
      ((part as { type?: string }).type === 'tool-call' || (part as { type?: string }).type === 'tool_use') &&
      ((part as { toolName?: string }).toolName ?? (part as { name?: string }).name) === toolName,
  )
  const same = calls.find(call => JSON.stringify(call.args) === JSON.stringify(input))
  const chosen = same ?? (calls.length === 1 ? calls[0] : undefined)
  return typeof chosen?.toolCallId === 'string' ? chosen.toolCallId : ''
}
