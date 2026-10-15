/**
 * Where each wire format carries ids in the request body (the codecs' `idSites`).
 * Pure readers in request order; a non-string or empty value is not listed. Response
 * ids come from the decoders' stream events instead.
 */
import type { IdSite } from './driverTypes'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function roleOf(message: Record<string, unknown>, fallback: string): string {
  return typeof message.role === 'string' ? message.role : fallback
}

/** openai-chat and ollama-chat. */
export function chatIdSites(body: unknown): IdSite[] {
  const sites: IdSite[] = []
  if (!isObject(body) || !Array.isArray(body.messages)) return sites
  body.messages.forEach((message, index) => {
    if (!isObject(message)) return
    const role = roleOf(message, '')
    const messagePath = ['messages', index] as const
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call, j) => {
        if (isObject(call) && idString(call.id)) {
          sites.push({ kind: 'toolCall', value: call.id, path: [...messagePath, 'tool_calls', j, 'id'], index, role, messagePath })
        }
      })
    }
    if (idString(message.tool_call_id)) {
      sites.push({ kind: 'toolCall', value: message.tool_call_id, path: [...messagePath, 'tool_call_id'], index, role, messagePath })
    }
  })
  return sites
}

/** openai-responses. */
export function responsesIdSites(body: unknown): IdSite[] {
  const sites: IdSite[] = []
  if (!isObject(body) || !Array.isArray(body.input)) return sites
  body.input.forEach((item, index) => {
    if (!isObject(item)) return
    const type = typeof item.type === 'string' ? item.type : ''
    const role = roleOf(item, type === 'function_call_output' ? 'tool' : 'assistant')
    const messagePath = ['input', index] as const
    if ((type === 'function_call' || type === 'function_call_output') && idString(item.call_id)) {
      sites.push({ kind: 'toolCall', value: item.call_id, path: [...messagePath, 'call_id'], index, role, messagePath })
    }
    if (idString(item.id)) {
      sites.push({
        kind: type === 'reasoning' ? 'reasoning' : 'message',
        value: item.id,
        path: [...messagePath, 'id'],
        index,
        role,
        messagePath,
      })
    }
  })
  return sites
}

/** anthropic-messages. */
export function messagesIdSites(body: unknown): IdSite[] {
  const sites: IdSite[] = []
  if (!isObject(body) || !Array.isArray(body.messages)) return sites
  body.messages.forEach((message, index) => {
    if (!isObject(message) || !Array.isArray(message.content)) return
    const role = roleOf(message, '')
    const messagePath = ['messages', index] as const
    message.content.forEach((block, j) => {
      if (!isObject(block)) return
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && idString(block.id)) {
        sites.push({ kind: 'toolCall', value: block.id, path: [...messagePath, 'content', j, 'id'], index, role, messagePath })
      } else if (block.type === 'tool_result' && idString(block.tool_use_id)) {
        sites.push({ kind: 'toolCall', value: block.tool_use_id, path: [...messagePath, 'content', j, 'tool_use_id'], index, role, messagePath })
      }
    })
  })
  return sites
}

/** gemini. */
export function geminiIdSites(body: unknown): IdSite[] {
  const sites: IdSite[] = []
  if (!isObject(body) || !Array.isArray(body.contents)) return sites
  body.contents.forEach((content, index) => {
    if (!isObject(content) || !Array.isArray(content.parts)) return
    const role = roleOf(content, '')
    const messagePath = ['contents', index] as const
    content.parts.forEach((part, j) => {
      if (!isObject(part)) return
      for (const key of ['functionCall', 'functionResponse'] as const) {
        const call = part[key]
        if (isObject(call) && idString(call.id)) {
          sites.push({ kind: 'toolCall', value: call.id, path: [...messagePath, 'parts', j, key, 'id'], index, role, messagePath })
        }
      }
    })
  })
  return sites
}
