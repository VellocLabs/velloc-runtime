// Cheap, dependency-light detector used to gate the lazy <A2uiProviderHost>
// mount (the A2UI renderer). It imports ONLY the
// dependency-free tool-name module (no reducer, no renderer), so it stays in the
// resident bundle while the heavy A2UI chunk is fetched on demand. Mirrors
// `hasGenerativeToolParts` in AssistantUiThread.

import type { Message } from '../../../runtime/RuntimeTypes'
import { isA2uiToolName } from '../../../toolkit/builtin/a2ui/a2uiToolNames'
import { hasA2uiBlock } from '../../../toolkit/builtin/a2ui/express/a2uiBlocks'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** The `a2ui_*` tool name of a transcript content part, or undefined. */
export function a2uiToolNameOf(part: unknown): string | undefined {
  const record = asRecord(part)
  if (!record || record.type !== 'tool-call') return undefined
  const toolName =
    typeof record.toolName === 'string'
      ? record.toolName
      : typeof record.name === 'string'
        ? record.name
        : undefined
  return toolName && isA2uiToolName(toolName) ? toolName : undefined
}

/** True if `message` is an assistant message holding an `<a2ui>` block or an `a2ui_*` tool-call. */
export function messageHasA2uiContent(message: Message): boolean {
  if (message.type !== 'assistant') return false
  const content = asRecord(message.message)?.content
  return (
    Array.isArray(content) &&
    content.some(part => {
      const record = asRecord(part)
      if (record?.type === 'text') return typeof record.text === 'string' && hasA2uiBlock(record.text)
      return a2uiToolNameOf(part) !== undefined
    })
  )
}

/** True if any assistant message holds an `<a2ui>` block or an `a2ui_*` tool-call. */
export function hasA2uiContent(messages: readonly Message[]): boolean {
  return messages.some(messageHasA2uiContent)
}
