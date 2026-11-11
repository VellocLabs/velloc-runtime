/**
 * Tool aliases (F-27): the names a provider's wire uses for the runtime's tools.
 *
 * Contract: an alias map is `{ <wire name>: <tool name> }`. `wireToolNames` renames
 * a request on its way out (tool definitions, replayed tool calls and results, a
 * tool named by the body extension's tool choice); `hostToolNames` renames a
 * decoder's tool-call events on the way back. Both hand back their input itself
 * when there are no aliases, so a provider without them sends the same bytes.
 * Everything above the codec (the engine, session mods, permissions, the
 * transcript) only ever holds the runtime's own names.
 *
 * Security: a map comes from a plugin manifest or a model listing and is
 * untrusted; `readToolAliases` is the one reader and refuses a map that is not
 * one-to-one.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import type { DriverResponseDecoder, DriverStreamEvent } from './driverTypes'

/** Wire name → the runtime's tool name. */
export type ToolAliases = Readonly<Record<string, string>>

export const TOOL_ALIASES_MAX = 64
/** A name every wire format accepts as a function name. */
const WIRE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const MCP_PREFIX = 'mcp__'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const has = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key)

/**
 * Reads an untrusted alias map. `aliases` is absent for an empty map; `problem`
 * says why a map is refused (it is then refused whole).
 */
export function readToolAliases(raw: unknown): { aliases?: ToolAliases; problem?: string } {
  if (!isRecord(raw)) return { problem: 'expected an object of wire name: tool name' }
  const entries = Object.entries(raw)
  if (entries.length === 0) return {}
  if (entries.length > TOOL_ALIASES_MAX) return { problem: `at most ${TOOL_ALIASES_MAX} aliases` }
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>
  const wireNameOf = new Map<string, string>()
  for (const [wireName, toolName] of entries) {
    if (!WIRE_TOOL_NAME.test(wireName)) {
      return { problem: `"${wireName}" is not a wire tool name (a letter or "_", then letters, digits, "_" or "-", at most 64)` }
    }
    if (typeof toolName !== 'string' || !WIRE_TOOL_NAME.test(toolName)) {
      return { problem: `"${wireName}": expected a tool name` }
    }
    if (wireName.startsWith(MCP_PREFIX) || toolName.startsWith(MCP_PREFIX)) {
      return { problem: `"${wireName}": a connector tool ("${MCP_PREFIX}…") cannot be aliased` }
    }
    const earlier = wireNameOf.get(toolName)
    if (earlier !== undefined) {
      return { problem: `"${earlier}" and "${wireName}" both name the tool "${toolName}"` }
    }
    wireNameOf.set(toolName, wireName)
    aliases[wireName] = toolName
  }
  for (const toolName of wireNameOf.keys()) {
    if (has(aliases, toolName)) {
      return { problem: `"${toolName}" is both a wire name and a tool name` }
    }
  }
  return { aliases }
}

function wireNamesByTool(aliases: ToolAliases): Map<string, string> {
  return new Map(Object.entries(aliases).map(([wireName, toolName]) => [toolName, wireName]))
}

/** Every string `name` under a tool-choice value, renamed. */
function renameChoice(value: unknown, byTool: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map(entry => renameChoice(entry, byTool))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = key === 'name' && typeof entry === 'string' ? (byTool.get(entry) ?? entry) : renameChoice(entry, byTool)
  }
  return out
}

/** The tool choice a body extension may carry, in each format's spelling. */
function renameExtension(extension: Record<string, unknown>, byTool: Map<string, string>): Record<string, unknown> {
  let out = extension
  if (isRecord(extension.tool_choice)) {
    out = { ...out, tool_choice: renameChoice(extension.tool_choice, byTool) }
  }
  const toolConfig = extension.toolConfig
  const calling = isRecord(toolConfig) ? toolConfig.functionCallingConfig : undefined
  if (isRecord(toolConfig) && isRecord(calling) && Array.isArray(calling.allowedFunctionNames)) {
    const allowedFunctionNames = calling.allowedFunctionNames.map(name =>
      typeof name === 'string' ? (byTool.get(name) ?? name) : (name as unknown),
    )
    out = { ...out, toolConfig: { ...toolConfig, functionCallingConfig: { ...calling, allowedFunctionNames } } }
  }
  return out
}

function renameParts(content: unknown, byTool: Map<string, string>): unknown {
  if (!Array.isArray(content)) return content
  let changed = false
  const parts = content.map((part: unknown) => {
    if (!isRecord(part) || (part.type !== 'tool-call' && part.type !== 'tool-result')) return part
    const wireName = typeof part.toolName === 'string' ? byTool.get(part.toolName) : undefined
    if (wireName === undefined) return part
    changed = true
    return { ...part, toolName: wireName }
  })
  return changed ? parts : content
}

/**
 * `payload` as the provider's wire names its tools. The payload itself is never
 * changed. Throws when a tool on offer has, as its own name, the wire name of
 * another tool: the provider's answer could not be told apart.
 */
export function wireToolNames(
  payload: BridgeModelRequestPayload,
  aliases: ToolAliases | undefined,
): BridgeModelRequestPayload {
  if (!aliases) return payload
  const byTool = wireNamesByTool(aliases)
  const out: BridgeModelRequestPayload = { ...payload }
  if (Array.isArray(payload.tools)) {
    out.tools = payload.tools.map(tool => {
      if (has(aliases, tool.name)) {
        throw new Error(`tool alias "${tool.name}" (for ${aliases[tool.name]}) is also the name of a tool in this request`)
      }
      const wireName = byTool.get(tool.name)
      return wireName === undefined ? tool : { ...tool, name: wireName }
    })
  }
  if (Array.isArray(payload.messages)) {
    out.messages = payload.messages.map(message => {
      if (!isRecord(message)) return message
      const content = renameParts(message.content, byTool)
      return content === message.content ? message : { ...message, content: content as typeof message.content }
    })
  }
  if (isRecord(payload.providerBodyExtension)) {
    out.providerBodyExtension = renameExtension(payload.providerBodyExtension, byTool)
  }
  return out
}

function hostEvent(event: DriverStreamEvent, aliases: ToolAliases): DriverStreamEvent {
  if (event.type !== 'tool_call_start' && event.type !== 'tool_call_delta' && event.type !== 'tool_call') return event
  if (event.name === undefined || !has(aliases, event.name)) return event
  return { ...event, name: aliases[event.name]! }
}

/**
 * `decoder` with its tool-call names turned back into the runtime's. A name
 * that is not an alias passes through as it came.
 */
export function hostToolNames(
  decoder: DriverResponseDecoder,
  aliases: ToolAliases | undefined,
): DriverResponseDecoder {
  if (!aliases) return decoder
  const mapped = (events: DriverStreamEvent[]): DriverStreamEvent[] => events.map(event => hostEvent(event, aliases))
  return {
    push: bytes => mapped(decoder.push(bytes)),
    end: () => mapped(decoder.end()),
    ...(decoder.abort ? { abort: () => mapped(decoder.abort!()) } : {}),
  }
}
