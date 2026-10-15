// Cheap, dependency-light detector used to gate the lazy <A2uiProviderHost>
// mount (the CopilotKit renderer + Material Symbols font). It imports ONLY the
// dependency-free tool-name module (no reducer, no renderer), so it stays in the
// resident bundle while the heavy A2UI chunk is fetched on demand. Mirrors
// `hasGenerativeToolParts` in AssistantUiThread.

import type { Message } from '../../../runtime/RuntimeTypes'
import { isA2uiToolName } from '../../../toolkit/builtin/a2ui/a2uiToolNames'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** True if any assistant message contains an `a2ui_*` tool-call. */
export function hasA2uiToolCall(messages: readonly Message[]): boolean {
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const inner = asRecord(message.message)
    const content = inner?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const record = asRecord(part)
      if (!record || record.type !== 'tool-call') continue
      const toolName =
        typeof record.toolName === 'string'
          ? record.toolName
          : typeof record.name === 'string'
            ? record.name
            : undefined
      if (isA2uiToolName(toolName)) return true
    }
  }
  return false
}
