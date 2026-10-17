/**
 * What the LLM host did to a `model.streamStart` payload before any provider saw
 * it (parse + validate, rebuild prompt messages, prepend the system message,
 * `BuildCallOptions`); this module is now the definition. Values are `HostValue`s:
 * int/double typing and sorted keys are observable in the request body.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import {
  HostDouble,
  HostInt,
  type HostDict,
  type HostList,
  type HostValue,
  findBool,
  findDict,
  findList,
  findNonEmptyString,
  findString,
  hostValueFromJs,
  hostValueToJs,
  isHostDict,
  isHostList,
  parseHostJson,
  sortedEntries,
  stringToInt,
  writeHostJson,
} from './hostValue'
import type { DriverStreamEvent } from './driverTypes'

/** The host rejected the payload (`BuildMojoLlmRequest` returned null; the
 *  guest gets INVALID_ARGS with this exact message). */
export class HostRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostRequestError'
  }
}

// ── mojom model (NexusLlmRequestParams, reduced to what providers read) ──

export type HostRole = 'system' | 'user' | 'assistant' | 'tool'

export type HostContentPart =
  | { type: 'text'; text: string; cache?: true }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'redacted_thinking' }
  | { type: 'image'; image: string; mimeType?: string }
  | { type: 'document'; data: string; mimeType: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: HostValue }
  | { type: 'tool_result'; toolUseId?: string; name?: string; result: HostValue; isError?: boolean }

export type HostMessage = { role: HostRole; content: HostContentPart[] }

export type HostTool = {
  name: string
  description?: string
  inputSchema: HostDict
  strict: boolean
  inputExamples?: HostList
}

export type HostRequest = {
  messages: HostMessage[]
  tools: HostTool[]
  systemPrompt?: HostValue
  userContext?: HostDict
  systemContext?: HostDict
  toolUseContext?: HostDict
  providerId?: string
  modelId?: string
  maxOutputTokens?: number
  providerBodyExtension?: HostDict
}

// ── text helpers ──────────────────────────────────────────────────────────

function joinNonEmpty(parts: string[]): string {
  let result = ''
  for (const part of parts) {
    if (!part) continue
    if (result) result += '\n'
    result += part
  }
  return result
}

/** `AppendFlattenedText` (llm_text_helpers.cc). NB a non-empty-string check:
 *  an EMPTY string falls through and is written as JSON — `""`. */
function appendFlattenedText(value: HostValue, out: string[]): void {
  if (typeof value === 'string' && value) {
    out.push(value)
    return
  }
  if (isHostList(value)) {
    for (const entry of value) appendFlattenedText(entry, out)
    return
  }
  if (value !== null) out.push(writeHostJson(value))
}

/** `FlattenTextValue` (llm_text_helpers.cc). */
export function flattenTextValue(value: HostValue | undefined): string {
  if (value === undefined) return ''
  const parts: string[] = []
  appendFlattenedText(value, parts)
  return joinNonEmpty(parts)
}

/** `AppendFormattedText` (nexus_llm_bridge_support.cc:23): like
 *  AppendFlattenedText, plus a dict's non-empty `text` field. */
function appendFormattedText(value: HostValue, out: string[]): void {
  if (typeof value === 'string' && value) {
    out.push(value)
    return
  }
  if (isHostList(value)) {
    for (const entry of value) appendFormattedText(entry, out)
    return
  }
  if (isHostDict(value)) {
    const text = findString(value, 'text')
    if (text) {
      out.push(text)
      return
    }
  }
  if (value !== null) out.push(writeHostJson(value))
}

/** `FormatTextValue` (nexus_llm_bridge_support.cc:49). */
export function formatTextValue(value: HostValue | undefined): string {
  if (value === undefined) return ''
  const parts: string[] = []
  appendFormattedText(value, parts)
  return joinNonEmpty(parts)
}

/** `FormatContextSection` (llm_text_helpers.cc): keys in DictValue (sorted
 *  byte) order. */
export function formatContextSection(title: string, context: HostDict | undefined): string {
  if (!context || context.size === 0) return ''
  let section = title + ':\n'
  let first = true
  for (const [key, value] of sortedEntries(context)) {
    if (!first) section += '\n'
    first = false
    section += '- ' + key + ': ' + flattenTextValue(value)
  }
  return section
}

// ── 1. BuildMojoLlmRequest (validation + conversion) ─────────────────────

function has(dict: HostDict, key: string): boolean {
  return dict.has(key)
}

function validateToolCallPart(part: HostDict): void {
  if (has(part, 'id') || has(part, 'name') || has(part, 'input')) {
    throw new HostRequestError(
      'Bridge tool-call parts must use toolCallId/toolName/args, not legacy id/name/input fields',
    )
  }
  if (!findNonEmptyString(part, 'toolCallId')) {
    throw new HostRequestError('Bridge tool-call parts must include toolCallId')
  }
  if (!findNonEmptyString(part, 'toolName')) {
    throw new HostRequestError('Bridge tool-call parts must include toolName')
  }
}

function validateToolResultPart(part: HostDict): void {
  if (
    has(part, 'tool_use_id')
    || has(part, 'tool_name')
    || has(part, 'name')
    || has(part, 'content')
    || has(part, 'is_error')
  ) {
    throw new HostRequestError(
      'Bridge tool-result parts must use toolCallId/toolName/result/isError, not legacy tool_use_id/tool_name/content/is_error fields',
    )
  }
  if (!findNonEmptyString(part, 'toolCallId')) {
    throw new HostRequestError('Bridge tool-result parts must include toolCallId')
  }
  if (!has(part, 'result')) {
    throw new HostRequestError('Bridge tool-result parts must include result')
  }
}

function validateContent(part: HostValue): void {
  if (typeof part === 'string') return
  if (!isHostDict(part)) {
    throw new HostRequestError('Bridge content parts must be strings or typed objects')
  }
  const type = findString(part, 'type')
  if (!type) throw new HostRequestError('Bridge content part objects must include type')
  if (type === 'tool_use' || type === 'tool_result') {
    throw new HostRequestError('Bridge content parts must use canonical tool-call/tool-result types')
  }
  if (type === 'tool-call') return validateToolCallPart(part)
  if (type === 'tool-result') return validateToolResultPart(part)
  if (
    type === 'text'
    || type === 'thinking'
    || type === 'redacted_thinking'
    || type === 'image'
    || type === 'document'
  ) {
    return
  }
  throw new HostRequestError(`Bridge content part type "${type}" is not supported`)
}

const ROLES: readonly string[] = ['system', 'user', 'assistant', 'tool']

function validateMessages(messages: HostValue | undefined): asserts messages is HostList {
  if (!isHostList(messages)) {
    throw new HostRequestError('LLM request "messages" must be an array')
  }
  for (const entry of messages) {
    if (!isHostDict(entry)) throw new HostRequestError('Bridge messages must be objects')
    if (entry.has('message') || entry.has('type')) {
      throw new HostRequestError(
        'Bridge messages must use plain {role, content} payloads without legacy wrapper fields',
      )
    }
    const role = findNonEmptyString(entry, 'role')
    if (!role || !ROLES.includes(role)) {
      throw new HostRequestError('Bridge messages must include a valid role')
    }
    const content = entry.get('content')
    if (content === undefined) throw new HostRequestError('Bridge messages must include content')
    if (isHostList(content)) {
      for (const part of content) validateContent(part)
    } else if (typeof content !== 'string') {
      throw new HostRequestError(
        'Bridge message content must be a string or an array of typed parts',
      )
    }
  }
}

function validateTools(tools: HostValue | undefined): void {
  if (tools === undefined) return
  if (!isHostList(tools)) throw new HostRequestError('LLM request "tools" must be an array')
  for (const entry of tools) {
    if (!isHostDict(entry)) throw new HostRequestError('Bridge tool definitions must be objects')
    if (findString(entry, 'type') !== 'function') {
      throw new HostRequestError('Bridge tool definitions must use type="function"')
    }
    if (entry.has('input_schema')) {
      throw new HostRequestError('Bridge tool definitions must use parameters, not input_schema')
    }
    if (!findNonEmptyString(entry, 'name')) {
      throw new HostRequestError('Bridge tool definitions must include name')
    }
    if (!findDict(entry, 'parameters')) {
      throw new HostRequestError('Bridge tool definitions must include a parameters object')
    }
  }
}

/** `AppendBridgeContentPart` (nexus_llm_bridge_support.cc:351). */
function appendContentPart(value: HostValue, out: HostContentPart[]): void {
  if (typeof value === 'string') {
    out.push({ type: 'text', text: value })
    return
  }
  if (!isHostDict(value)) return
  const type = findString(value, 'type')
  if (type === undefined) return

  switch (type) {
    case 'text':
      // FormatTextValue: a present-but-empty "text" becomes `""` (two quote
      // characters) — see appendFormattedText.
      // A caller's own breakpoint (`cache_control` on the part) rides as
      // `cache`; the native host drops it and places its own.
      out.push({
        type: 'text',
        text: formatTextValue(value.get('text')),
        ...(isHostDict(value.get('cache_control')) ? { cache: true as const } : {}),
      })
      return
    case 'thinking': {
      const signature = findNonEmptyString(value, 'signature')
      out.push({
        type: 'thinking',
        text: formatTextValue(value.get('thinking')),
        ...(signature ? { signature } : {}),
      })
      return
    }
    case 'redacted_thinking':
      out.push({ type: 'redacted_thinking' })
      return
    case 'image': {
      const image =
        findNonEmptyString(value, 'image')
        ?? findNonEmptyString(value, 'data')
        ?? findNonEmptyString(value, 'url')
      if (!image) return
      const mimeType = findNonEmptyString(value, 'mimeType') ?? findNonEmptyString(value, 'mime_type')
      out.push({ type: 'image', image, ...(mimeType ? { mimeType } : {}) })
      return
    }
    case 'document': {
      const data = findNonEmptyString(value, 'data')
      if (!data) return
      out.push({
        type: 'document',
        data,
        mimeType: findNonEmptyString(value, 'mimeType') ?? 'application/pdf',
      })
      return
    }
    case 'tool-call': {
      const toolUseId = findNonEmptyString(value, 'toolCallId')
      const name = findNonEmptyString(value, 'toolName')
      if (!toolUseId || !name) return
      const args = value.get('args')
      out.push({ type: 'tool_use', toolUseId, name, input: args === undefined ? new Map() : args })
      return
    }
    case 'tool-result': {
      const toolUseId = findNonEmptyString(value, 'toolCallId')
      const name = findNonEmptyString(value, 'toolName')
      const result = value.get('result')
      const isError = findBool(value, 'isError')
      out.push({
        type: 'tool_result',
        ...(toolUseId ? { toolUseId } : {}),
        ...(name ? { name } : {}),
        result: result === undefined ? '' : result,
        ...(isError !== undefined ? { isError } : {}),
      })
      return
    }
  }
}

/** `ConvertBridgeContent` (nexus_llm_bridge_support.cc:493). */
function convertContent(content: HostValue | undefined): HostContentPart[] {
  const converted: HostContentPart[] = []
  if (content === undefined) return converted
  if (typeof content === 'string') {
    converted.push({ type: 'text', text: content })
    return converted
  }
  if (!isHostList(content)) {
    const text = formatTextValue(content)
    if (text) converted.push({ type: 'text', text })
    return converted
  }
  for (const part of content) appendContentPart(part, converted)
  return converted
}

/** `FindIntegralValue` (nexus_bridge_support.cc:89). */
function findIntegralValue(dict: HostDict, key: string): number | undefined {
  const value = dict.get(key)
  if (value instanceof HostInt) return value.value
  if (value instanceof HostDouble) {
    const n = value.value
    if (Number.isFinite(n) && Math.floor(n) === n) return n
  }
  if (typeof value === 'string') return stringToInt(value)
  return undefined
}

/** `BuildMojoLlmRequest` (nexus_llm_bridge_support.cc:851). Throws
 *  `HostRequestError` where the host answers INVALID_ARGS. */
export function buildHostRequest(payload: BridgeModelRequestPayload): HostRequest {
  const root = hostValueFromJs(payload)
  if (!isHostDict(root)) throw new HostRequestError('LLM request payload must be an object')

  const messagesValue = root.get('messages')
  validateMessages(messagesValue)
  const messages: HostMessage[] = []
  for (const entry of messagesValue) {
    if (!isHostDict(entry)) continue
    const role = findNonEmptyString(entry, 'role')
    if (!role || !ROLES.includes(role)) continue
    const content = convertContent(entry.get('content'))
    if (content.length === 0) continue
    messages.push({ role: role as HostRole, content })
  }

  const toolsValue = root.get('tools')
  validateTools(toolsValue)
  const tools: HostTool[] = []
  if (isHostList(toolsValue)) {
    for (const def of toolsValue) {
      if (!isHostDict(def)) continue
      const name = findNonEmptyString(def, 'name')
      if (!name) continue
      const description = findNonEmptyString(def, 'description')
      const examples = findList(def, 'inputExamples')
      tools.push({
        name,
        ...(description ? { description } : {}),
        inputSchema: findDict(def, 'parameters') ?? new Map([['type', 'object']]),
        strict: findBool(def, 'strict') ?? false,
        ...(examples ? { inputExamples: examples } : {}),
      })
    }
  }

  const request: HostRequest = { messages, tools }
  if (root.has('systemPrompt')) request.systemPrompt = root.get('systemPrompt')
  const userContext = findDict(root, 'userContext')
  if (userContext) request.userContext = userContext
  const systemContext = findDict(root, 'systemContext')
  if (systemContext) request.systemContext = systemContext
  const toolUseContext = findDict(root, 'toolUseContext')
  if (toolUseContext) request.toolUseContext = toolUseContext
  const providerId = findNonEmptyString(root, 'providerId')
  if (providerId) request.providerId = providerId
  const modelId = findNonEmptyString(root, 'model')
  if (modelId) request.modelId = modelId
  const maxOutputTokens = findIntegralValue(root, 'maxOutputTokens')
  if (maxOutputTokens !== undefined) {
    if (maxOutputTokens < -2147483648 || maxOutputTokens > 2147483647) {
      throw new HostRequestError('"maxOutputTokens" is out of range')
    }
    request.maxOutputTokens = maxOutputTokens
  }
  const extension = findDict(root, 'providerBodyExtension')
  if (extension) request.providerBodyExtension = extension
  return request
}

// ── 2. BuildSystemInstruction ─────────────────────────────────────────────

/** `BuildSystemInstruction` (nexus_llm_host.cc:127) over a converted request. */
export function buildSystemInstructionFromRequest(request: HostRequest): string {
  const sections: string[] = []
  if (request.systemPrompt !== undefined) {
    const sp = request.systemPrompt
    if (isHostList(sp)) {
      // One section per element, so the "\n\n" join keeps block boundaries.
      for (const entry of sp) {
        const flattened = flattenTextValue(entry)
        if (flattened) sections.push(flattened)
      }
    } else {
      const flattened = flattenTextValue(sp)
      if (flattened) sections.push(flattened)
    }
  }
  for (const [title, context] of [
    ['User context', request.userContext],
    ['System context', request.systemContext],
    ['Tool use context', request.toolUseContext],
  ] as const) {
    const section = formatContextSection(title, context)
    if (section) sections.push(section)
  }
  return sections.filter(Boolean).join('\n\n')
}

/** `BuildSystemInstruction` for a bridge payload. */
export function buildSystemInstruction(payload: BridgeModelRequestPayload): string {
  return buildSystemInstructionFromRequest(buildHostRequest(payload))
}

// ── 3. TranslateBridgeMessages / TranslateBridgeTools ─────────────────────

/** `ParseToolPayloadValue` (nexus_llm_host.cc:190): a string result that
 *  parses as RFC JSON becomes that value. */
function parseToolPayloadValue(value: HostValue): HostValue {
  if (typeof value === 'string') {
    const parsed = parseHostJson(value)
    return parsed === undefined ? value : parsed
  }
  return value
}

function textPart(text: string): HostDict {
  return new Map<string, HostValue>([
    ['type', 'text'],
    ['text', text],
  ])
}

// ── Reasoning replay (reasoning_replay.h / reasoning_replay.cc) ───────────

/** `kReasoningReplayPrefix`: a thinking block `signature` carrying this
 *  prefix is a host-made replay envelope, not an Anthropic signature. */
export const REASONING_REPLAY_PREFIX = 'velloc-replay-v1:'

/** `kReasoningReplayPartType`: the stream part a provider emits to request a
 *  replay (`{type, field, value}`), and the prompt part the host puts back for
 *  that same provider + model. */
export const REASONING_REPLAY_PART_TYPE = 'reasoning-replay'

/**
 * `EncodeReasoningReplaySignature`: wraps a provider's `reasoning-replay`
 * part into `velloc-replay-v1:{"field":…,"model":…,"provider":…,"value":…}`
 * (JSONWriter: sorted keys), binding it to the provider + model that made it.
 * Undefined when the part is malformed (no/empty `field`, no/null `value`) or
 * either id is empty.
 */
export function encodeReasoningReplaySignature(
  providerId: string,
  modelId: string,
  replayPart: HostDict,
): string | undefined {
  const field = findString(replayPart, 'field')
  const value = replayPart.get('value')
  if (!field || value === undefined || value === null || !providerId || !modelId) {
    return undefined
  }
  const envelope: HostDict = new Map<string, HostValue>([
    ['provider', providerId],
    ['model', modelId],
    ['field', field],
    ['value', value],
  ])
  return REASONING_REPLAY_PREFIX + writeHostJson(envelope)
}

/**
 * `DecodeReasoningReplaySignatureFor`: unwraps a thinking block's signature
 * into a `reasoning-replay` prompt part — only when it was produced by
 * `providerId` + `modelId`. Undefined for any other signature (Anthropic's,
 * another provider's or model's, garbage).
 */
export function decodeReasoningReplaySignatureFor(
  signature: string,
  providerId: string,
  modelId: string,
): HostDict | undefined {
  if (!signature.startsWith(REASONING_REPLAY_PREFIX)) return undefined
  const envelope = parseHostJson(signature.slice(REASONING_REPLAY_PREFIX.length))
  if (!isHostDict(envelope)) return undefined
  const provider = findString(envelope, 'provider')
  const model = findString(envelope, 'model')
  const field = findString(envelope, 'field')
  const value = envelope.get('value')
  if (
    provider === undefined
    || provider !== providerId
    || model === undefined
    || model !== modelId
    || !field
    || value === undefined
    || value === null
  ) {
    return undefined
  }
  return new Map<string, HostValue>([
    ['type', REASONING_REPLAY_PART_TYPE],
    ['field', field],
    ['value', value],
  ])
}

/** The provider + model `TranslateBridgeParts` matches replay envelopes
 *  against (the host's resolved `provider_id` / `model_id`). */
export type ReplayTarget = { providerId: string; modelId: string }

/** `TranslateBridgeParts` (nexus_llm_host.cc:222). Thinking and redacted
 *  thinking are DROPPED here, for every provider — except a thinking block
 *  whose signature is a replay envelope made by `replay`'s provider + model,
 *  which goes back as a `reasoning-replay` part. Without `replay` (a caller
 *  that predates 84fe0bf) every thinking block is dropped. */
function translateParts(
  parts: HostContentPart[],
  toolNames: Map<string, string>,
  replay: ReplayTarget | undefined,
): HostList {
  const translated: HostList = []
  for (const part of parts) {
    switch (part.type) {
      case 'text': {
        const out = textPart(part.text)
        if (part.cache) out.set('cacheMark', true)
        translated.push(out)
        break
      }
      case 'image': {
        if (!part.image) break
        const out: HostDict = new Map<string, HostValue>([
          ['type', 'image'],
          ['image', part.image],
        ])
        if (part.mimeType) out.set('mimeType', part.mimeType)
        translated.push(out)
        break
      }
      case 'document':
        if (!part.data) break
        translated.push(
          new Map<string, HostValue>([
            ['type', 'document'],
            ['data', part.data],
            ['mimeType', part.mimeType],
          ]),
        )
        break
      case 'tool_use': {
        const out: HostDict = new Map<string, HostValue>([['type', 'tool-call']])
        if (part.toolUseId) out.set('toolCallId', part.toolUseId)
        if (part.name) {
          out.set('toolName', part.name)
          if (part.toolUseId) toolNames.set(part.toolUseId, part.name)
        }
        out.set('args', part.input)
        translated.push(out)
        break
      }
      case 'tool_result': {
        const out: HostDict = new Map<string, HostValue>([['type', 'tool-result']])
        const toolCallId = part.toolUseId ?? ''
        if (toolCallId) out.set('toolCallId', toolCallId)
        let toolName = part.name ?? ''
        if (!toolName && toolCallId) toolName = toolNames.get(toolCallId) ?? ''
        if (toolName) out.set('toolName', toolName)
        out.set('result', parseToolPayloadValue(part.result))
        if (part.isError !== undefined) out.set('isError', part.isError)
        translated.push(out)
        break
      }
      case 'thinking':
        // Dropped at the wire, except a replay payload
        // the SAME provider + model produced (nexus_llm_host.cc:321-333).
        if (part.signature !== undefined && replay) {
          const decoded = decodeReasoningReplaySignatureFor(
            part.signature,
            replay.providerId,
            replay.modelId,
          )
          if (decoded) translated.push(decoded)
        }
        break
      case 'redacted_thinking':
        break
    }
  }
  return translated
}

function hasOnlyToolResultParts(parts: HostList): boolean {
  if (parts.length === 0) return false
  return parts.every(p => isHostDict(p) && findString(p, 'type') === 'tool-result')
}

/** `TranslateBridgeMessages` (nexus_llm_host.cc:355): a user message holding
 *  only tool results becomes role "tool"; an emptied message is dropped. */
export function translateBridgeMessages(messages: HostMessage[], replay?: ReplayTarget): HostList {
  const translated: HostList = []
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    let role: string = message.role
    const content = translateParts(message.content, toolNames, replay)
    if (content.length === 0) continue
    if (role === 'user' && hasOnlyToolResultParts(content)) role = 'tool'
    translated.push(
      new Map<string, HostValue>([
        ['role', role],
        ['content', content],
      ]),
    )
  }
  return translated
}

/** `TranslateBridgeTools` (nexus_llm_host.cc:366). */
export function translateBridgeTools(tools: HostTool[]): HostList {
  const translated: HostList = []
  for (const tool of tools) {
    if (!tool.name) continue
    const out: HostDict = new Map<string, HostValue>([
      ['type', 'function'],
      ['name', tool.name],
    ])
    if (tool.description) out.set('description', tool.description)
    out.set('parameters', tool.inputSchema)
    if (tool.strict) out.set('strict', true)
    if (tool.inputExamples) out.set('inputExamples', tool.inputExamples)
    translated.push(out)
  }
  return translated
}

/** The `prompt` list a provider reads: the system instruction (if any) as a
 *  leading system message, then the translated conversation
 *  (`BuildCallOptions`, nexus_llm_host.cc:846-862). */
export function buildHostPrompt(request: HostRequest, replay?: ReplayTarget): HostList {
  const messages = translateBridgeMessages(request.messages, replay)
  const instruction = buildSystemInstructionFromRequest(request)
  if (!instruction) return messages
  return [
    new Map<string, HostValue>([
      ['role', 'system'],
      ['content', [textPart(instruction)]],
    ]),
    ...messages,
  ]
}

/**
 * `BuildCallOptions`, minus `requestId`. `model` is already resolved. With
 * `providerId`, replay envelopes this provider + `model` made come back as
 * `reasoning-replay` parts; without it every thinking block is dropped.
 */
export function buildHostCallOptions(request: HostRequest, model: string, providerId?: string): HostDict {
  const options: HostDict = new Map()
  if (model) {
    options.set('model', model)
    options.set('modelId', model)
  }
  const prompt = buildHostPrompt(
    request,
    providerId !== undefined ? { providerId, modelId: model } : undefined,
  )
  options.set('inputFormat', 'messages')
  options.set('messages', prompt)
  options.set('prompt', prompt)

  const tools = translateBridgeTools(request.tools)
  const mode: HostDict = new Map<string, HostValue>([['type', 'regular']])
  if (tools.length > 0) {
    const toolChoice: HostDict = new Map<string, HostValue>([['type', 'auto']])
    mode.set('tools', tools)
    mode.set('toolChoice', toolChoice)
    options.set('tools', tools)
    options.set('toolChoice', toolChoice)
    options.set('tool_choice', 'auto')
  }
  options.set('mode', mode)

  if (request.maxOutputTokens !== undefined) {
    options.set('maxTokens', new HostInt(request.maxOutputTokens))
    options.set('max_tokens', new HostInt(request.maxOutputTokens))
  }
  if (request.providerBodyExtension) {
    options.set('providerBodyExtension', request.providerBodyExtension)
  }
  return options
}

// ── Provider-error text (llm_error_extract.cc) ────────────────────────────

function extractFromDict(parsed: HostDict): string {
  const err = findDict(parsed, 'error')
  if (err) {
    const message = findString(err, 'message')
    if (message !== undefined) return message
  }
  return (
    findString(parsed, 'error')
    ?? findString(parsed, 'detail')
    ?? findString(parsed, 'message')
    ?? ''
  )
}

/** `ExtractApiErrorMessage`: a whole-body JSON error object, else the first
 *  SSE `data:` frame carrying one. "" when neither. */
export function extractApiErrorMessage(body: string): string {
  const whole = parseHostJson(body)
  if (isHostDict(whole)) {
    const message = extractFromDict(whole)
    if (message) return message
  }
  let rest = body
  while (rest) {
    const lineEnd = rest.indexOf('\n')
    let line = lineEnd < 0 ? rest : rest.slice(0, lineEnd)
    rest = lineEnd < 0 ? '' : rest.slice(lineEnd + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.startsWith('data:')) continue
    let payload = line.slice(5)
    if (payload.startsWith(' ')) payload = payload.slice(1)
    const parsed = parseHostJson(payload)
    if (isHostDict(parsed)) {
      const message = extractFromDict(parsed)
      if (message) return message
    }
  }
  return ''
}

function parseRetryAfterSeconds(raw: string): number | undefined {
  if (!raw) return undefined
  const seconds = stringToInt(raw)
  return seconds !== undefined && seconds >= 0 ? seconds : undefined
}

/** `BuildProviderErrorMessage`: "HTTP <status>: <message> (retry-after: <n>s)". */
export function buildProviderErrorMessage(
  httpStatus: number,
  waitHint: string,
  message: string,
): string {
  let out: string
  if (httpStatus >= 100 && httpStatus <= 599) {
    out = 'HTTP ' + httpStatus
    if (message) out += ': ' + message
  } else {
    out = message
  }
  const retryAfter = parseRetryAfterSeconds(waitHint)
  if (retryAfter !== undefined) {
    if (out) out += ' '
    out += `(retry-after: ${retryAfter}s)`
  }
  return out
}

/** `ParseProviderErrorMessage`: the typed fields the host's `QueueErrorEvent`
 *  recovers from the canonical text. */
export function parseProviderErrorMessage(message: string): {
  httpStatus?: number
  retryAfterSeconds?: number
} {
  const out: { httpStatus?: number; retryAfterSeconds?: number } = {}
  const open = '(retry-after: '
  if (message.endsWith('s)')) {
    const at = message.lastIndexOf(open)
    if (at >= 0) {
      const digits = message.slice(at + open.length, message.length - 2)
      const seconds = digits ? stringToInt(digits) : undefined
      if (seconds !== undefined && seconds >= 0) out.retryAfterSeconds = seconds
    }
  }
  if (message.startsWith('HTTP ')) {
    const rest = message.slice(5)
    if (rest.length >= 3) {
      const next = rest.length > 3 ? rest[3] : ''
      if (next === '' || next === ':' || next === ' ') {
        const status = stringToInt(rest.slice(0, 3))
        if (status !== undefined && status >= 100 && status <= 599) out.httpStatus = status
      }
    }
  }
  return out
}

/** The terminal `error` event the host queues for a provider error string
 *  (`QueueErrorEvent`, nexus_llm_host.cc:1172). */
export function hostErrorEvent(message: string): {
  type: 'error'
  message: string
  httpStatus?: number
  retryAfterSeconds?: number
} {
  return { type: 'error', message, ...parseProviderErrorMessage(message) }
}

// ── Host tool-call correlation (NexusLlmHost::OnStreamChunk) ──────────────

function newUuid(): string {
  // base::Uuid::GenerateRandomV4().AsLowercaseString()
  return globalThis.crypto.randomUUID()
}

/** `BuildToolUseInput` (nexus_llm_host.cc:1107): "" → `{}`, RFC JSON → that
 *  value, else the text itself. */
export function buildToolUseInput(argsJson: string): unknown {
  if (!argsJson) return {}
  const parsed = parseHostJson(argsJson)
  return parsed === undefined ? argsJson : hostValueToJs(parsed)
}

type HostPendingToolCall = { toolCallId: string; toolName: string; argsJson: string }

/**
 * The host's pending tool-call accumulation: a codec feeds it tool-call chunks and
 * forwards the events it returns; at `finish` every pending call is flushed whole
 * with the host's accumulated `input`. A repeated start with the same id RESETS the
 * entry here, while the bridge keeps its first name.
 */
export class HostToolCallTracker {
  private readonly pending = new Map<string, HostPendingToolCall>()
  private order: string[] = []

  /** `tool-call-streaming-start`. An empty id is treated as missing. */
  streamingStart(toolCallId: string | undefined, toolName: string | undefined): DriverStreamEvent {
    const id = toolCallId ? toolCallId : newUuid()
    const entry: HostPendingToolCall = { toolCallId: id, toolName: toolName || '', argsJson: '' }
    if (!this.pending.has(id)) this.order.push(id)
    this.pending.set(id, entry)
    return { type: 'tool_call_start', id, ...(entry.toolName ? { name: entry.toolName } : {}) }
  }

  /** `tool-call-delta`: an uncorrelated delta (no/empty id) gets a fresh
   *  random id — and so becomes a call of its own. */
  delta(
    toolCallId: string | undefined,
    toolName: string | undefined,
    argsTextDelta: string | undefined,
  ): DriverStreamEvent {
    const id = toolCallId ? toolCallId : newUuid()
    let entry = this.pending.get(id)
    if (!entry) {
      entry = { toolCallId: id, toolName: '', argsJson: '' }
      this.pending.set(id, entry)
      this.order.push(id)
    }
    if (toolName) entry.toolName = toolName
    if (argsTextDelta) entry.argsJson += argsTextDelta
    return {
      type: 'tool_call_delta',
      id,
      ...(entry.toolName ? { name: entry.toolName } : {}),
      ...(argsTextDelta ? { argsTextDelta } : {}),
    }
  }

  /** `tool-call`: a whole call; missing args / name come from the pending
   *  entry of the same id, which it closes. */
  complete(
    toolCallId: string | undefined,
    toolName: string | undefined,
    args: string | undefined,
  ): DriverStreamEvent {
    const id = toolCallId || ''
    let name = toolName || ''
    let argsJson = args || ''
    if (id) {
      const entry = this.pending.get(id)
      if (entry) {
        if (!argsJson) argsJson = entry.argsJson
        if (!name) name = entry.toolName
        this.pending.delete(id)
      }
      this.order = this.order.filter(x => x !== id)
    }
    return completedToolCallEvent(id, name, argsJson)
  }

  /** `FlushPendingToolCalls`: every still-pending call, in start order. */
  flush(): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    for (const id of this.order) {
      const entry = this.pending.get(id)
      if (!entry) continue
      events.push(completedToolCallEvent(entry.toolCallId, entry.toolName, entry.argsJson))
    }
    this.pending.clear()
    this.order = []
    return events
  }
}

/** `QueueCompletedToolCallEvent` (nexus_llm_host.cc:1142). */
function completedToolCallEvent(toolCallId: string, toolName: string, argsJson: string): DriverStreamEvent {
  return {
    type: 'tool_call',
    id: toolCallId || newUuid(),
    ...(toolName ? { name: toolName } : {}),
    input: buildToolUseInput(argsJson),
  }
}

/** `ParseFinishReasonString` (nexus_llm_host.cc:882). */
export function parseFinishReasonString(
  reason: string,
): 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' | 'other' | 'unknown' {
  const normalized = reason.replace(/[A-Z]/g, c => c.toLowerCase()).replace(/-/g, '_')
  if (normalized === 'stop' || normalized === 'end_turn') return 'stop'
  if (normalized === 'length' || normalized === 'max_tokens') return 'length'
  if (normalized === 'content_filter' || normalized === 'contentfiltered') return 'content_filter'
  if (normalized === 'tool_calls' || normalized === 'tool_use') return 'tool_calls'
  if (normalized === 'error') return 'error'
  if (!normalized) return 'unknown'
  return 'other'
}
