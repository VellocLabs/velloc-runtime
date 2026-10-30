/**
 * Anthropic Messages API driver: byte-for-byte the C++ provider's requests, fed the
 * exact `call_options` the host builds (hostCallOptions.ts), so a payload the host
 * rejects throws `HostRequestError` here too. The body is a `HostValue` tree written
 * as `base::JSONWriter` would (P-4). No thinking / redacted_thinking round trip and no
 * `signature_delta`, as in the C++ provider.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import {
  buildHostCallOptions,
  buildHostRequest,
  buildProviderErrorMessage,
  extractApiErrorMessage,
  hostErrorEvent,
} from './hostCallOptions'
import {
  HostDouble,
  HostInt,
  OrderedHostDict,
  findBool,
  findDict,
  findDouble,
  findInt,
  findList,
  findString,
  hostValueToJs,
  isHostDict,
  isHostList,
  parseHostJson,
  parseHostJsonDict,
  writeHostJson,
  type HostDict,
  type HostList,
  type HostValue,
} from './hostValue'
import type {
  DriverFinishReason,
  DriverRequestContext,
  DriverResponseDecoder,
  DriverStreamEvent,
  DriverUsage,
  ProviderDriver,
} from './driverTypes'
import { messagesIdSites } from './idSites'

// anthropic_provider.cc:46 / :1460.
const ANTHROPIC_API_VERSION = '2023-06-01'
const MESSAGES_PATH = '/v1/messages'
// anthropic_provider.cc:951 — used only when the guest sends no maxOutputTokens.
const DEFAULT_MAX_TOKENS = 8192

// ── HostValue helpers ─────────────────────────────────────────────────────

function cloneHost(value: HostValue): HostValue {
  if (isHostList(value)) return value.map(cloneHost)
  if (isHostDict(value)) {
    const out: HostDict = new Map()
    for (const [k, v] of value) out.set(k, cloneHost(v))
    return out
  }
  return value
}

function ephemeralCacheControl(): HostDict {
  return new Map<string, HostValue>([['type', 'ephemeral']])
}

function textPart(text: string): HostDict {
  return new Map<string, HostValue>([
    ['type', 'text'],
    ['text', text],
  ])
}

// ── Provider: schema sanitizer (anthropic_schema_sanitizer.cc) ────────────

function collapseNullableType(schema: HostDict): boolean {
  const typeList = findList(schema, 'type')
  if (!typeList) return false
  const remaining = typeList.filter(e => e !== 'null')
  if (remaining.length === typeList.length) return false
  if (remaining.length === 1 && typeof remaining[0] === 'string') {
    schema.set('type', remaining[0])
  } else {
    schema.set('type', remaining.map(cloneHost))
  }
  return true
}

function stripNullFromEnum(schema: HostDict): boolean {
  const enumList = findList(schema, 'enum')
  if (!enumList) return false
  const remaining = enumList.filter(e => e !== null)
  if (remaining.length === enumList.length) return false
  schema.set('enum', remaining.map(cloneHost))
  return true
}

const RANGE_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']

function sanitizeNode(schema: HostDict): boolean {
  let nullable = collapseNullableType(schema)
  nullable = stripNullFromEnum(schema) || nullable
  for (const key of RANGE_KEYS) schema.delete(key)

  const properties = findDict(schema, 'properties')
  if (properties) {
    const nowOptional = new Set<string>()
    for (const [key, prop] of properties) {
      if (isHostDict(prop) && sanitizeNode(prop)) nowOptional.add(key)
    }
    if (nowOptional.size > 0) {
      const required = findList(schema, 'required')
      if (required) {
        schema.set(
          'required',
          required.filter(name => !(typeof name === 'string' && nowOptional.has(name))),
        )
      }
    }
  }

  const items = findDict(schema, 'items')
  if (items) sanitizeNode(items)

  for (const defsKey of ['$defs', 'definitions']) {
    const defs = findDict(schema, defsKey)
    if (!defs) continue
    for (const def of defs.values()) {
      if (isHostDict(def)) sanitizeNode(def)
    }
  }

  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    const branches = findList(schema, combinator)
    if (!branches) continue
    const kept: HostList = []
    for (const branch of branches) {
      if (isHostDict(branch)) {
        if (findString(branch, 'type') === 'null') {
          nullable = true
          continue
        }
        sanitizeNode(branch)
      }
      kept.push(branch)
    }
    schema.set(combinator, kept)
  }
  if (nullable) dropNullAdvice(schema)
  return nullable
}

// Advice to pass `null` no longer holds once null has left the type.
const NULL_ADVICE = /\s*Use null\b[^.]*\.?/g

function dropNullAdvice(schema: HostDict): void {
  const description = findString(schema, 'description')
  if (description === undefined) return
  const kept = description.replace(NULL_ADVICE, '').trim()
  if (kept === description) return
  if (kept) schema.set('description', kept)
  else schema.delete('description')
}

/** SanitizeStrictSchemaForAnthropic: OpenAI-strict dialect → Anthropic. */
export function sanitizeStrictSchemaForAnthropic(schema: HostDict): HostDict {
  const sanitized = cloneHost(schema) as HostDict
  sanitizeNode(sanitized)
  return sanitized
}

// ── Provider: stop reason (anthropic_stop_reason.cc) ──────────────────────

/**
 * TranslateAnthropicStopReason, as the value the host ends up with: the
 * provider writes FinishReasonToString (kOther → "unknown") and the host's
 * ParseFinishReasonString reads "unknown" back as kOther.
 */
export function translateAnthropicStopReason(stopReason: string): DriverFinishReason {
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop'
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'tool_use') return 'tool_calls'
  if (stopReason === 'refusal') return 'content_filter'
  return 'other'
}

const STOP_DETAIL_FIELDS = ['type', 'category', 'explanation', 'recommended_model']

/** NormalizeAnthropicStopDetails: non-empty string fields only; nothing →
 *  undefined. */
export function normalizeAnthropicStopDetails(
  stopDetails: HostValue | undefined,
): Record<string, unknown> | undefined {
  if (stopDetails === undefined || !isHostDict(stopDetails)) return undefined
  const out: Record<string, unknown> = {}
  let any = false
  for (const field of STOP_DETAIL_FIELDS) {
    const value = findString(stopDetails, field)
    if (value) {
      out[field] = value
      any = true
    }
  }
  return any ? out : undefined
}

// ── Provider: request translation (anthropic_provider.cc) ─────────────────

function imageSource(image: string | undefined, mime: string | undefined): HostDict {
  if (image && (image.startsWith('http://') || image.startsWith('https://'))) {
    return new Map<string, HostValue>([
      ['type', 'url'],
      ['url', image],
    ])
  }
  return new Map<string, HostValue>([
    ['type', 'base64'],
    ['media_type', mime ?? 'image/png'],
    ['data', image ?? ''],
  ])
}

function documentBlock(data: string | undefined, mime: string | undefined): HostDict {
  return new Map<string, HostValue>([
    ['type', 'document'],
    [
      'source',
      new Map<string, HostValue>([
        ['type', 'base64'],
        ['media_type', mime ?? 'application/pdf'],
        ['data', data ?? ''],
      ]),
    ],
  ])
}

/** TranslateContentParts (anthropic_provider.cc:1054). */
function translateContentParts(parts: HostList): HostList {
  const result: HostList = []
  for (const partValue of parts) {
    if (!isHostDict(partValue)) continue
    const part = partValue
    const type = findString(part, 'type')
    if (type === 'text') {
      const block = textPart(findString(part, 'text') ?? '')
      if (findBool(part, 'cacheMark') === true) block.set('cache_control', ephemeralCacheControl())
      result.push(block)
    } else if (type === 'image') {
      result.push(
        new Map<string, HostValue>([
          ['type', 'image'],
          ['source', imageSource(findString(part, 'image'), findString(part, 'mimeType'))],
        ]),
      )
    } else if (type === 'document') {
      result.push(documentBlock(findString(part, 'data'), findString(part, 'mimeType')))
    } else if (type === 'tool-call') {
      // :1134 — args as a dict, or a JSON string holding a dict; else {}.
      const args = part.get('args')
      let input: HostDict = new Map()
      if (isHostDict(args)) input = cloneHost(args) as HostDict
      else if (typeof args === 'string') input = parseHostJsonDict(args) ?? new Map()
      result.push(
        new Map<string, HostValue>([
          ['type', 'tool_use'],
          ['id', findString(part, 'toolCallId') ?? ''],
          ['name', findString(part, 'toolName') ?? ''],
          ['input', input],
        ]),
      )
    } else if (type === 'tool-result') {
      const block: HostDict = new Map<string, HostValue>([
        ['type', 'tool_result'],
        ['tool_use_id', findString(part, 'toolCallId') ?? ''],
      ])
      const resultList = findList(part, 'result')
      if (resultList) {
        // :1182 — list-of-blocks form for multimodal results.
        const blocks: HostList = []
        for (const blockValue of resultList) {
          if (!isHostDict(blockValue)) continue
          const btype = findString(blockValue, 'type')
          if (btype === 'text') {
            blocks.push(textPart(findString(blockValue, 'text') ?? ''))
          } else if (btype === 'image') {
            blocks.push(
              new Map<string, HostValue>([
                ['type', 'image'],
                [
                  'source',
                  imageSource(findString(blockValue, 'image'), findString(blockValue, 'mimeType')),
                ],
              ]),
            )
          } else if (btype === 'document') {
            blocks.push(
              documentBlock(findString(blockValue, 'data'), findString(blockValue, 'mimeType')),
            )
          }
        }
        // :1235 — never `content: []`; fall back to the serialized list.
        block.set('content', blocks.length === 0 ? writeHostJson(resultList) : blocks)
      } else {
        let contentText = ''
        const resultValue = part.get('result')
        if (typeof resultValue === 'string') contentText = resultValue
        else if (resultValue !== undefined) contentText = writeHostJson(resultValue)
        block.set('content', contentText || '(no content)')
      }
      const isError = findBool(part, 'isError')
      if (isError !== undefined) block.set('is_error', isError)
      result.push(block)
    }
  }
  return result
}

/** TranslateMessages (anthropic_provider.cc:981): system → top level,
 *  tool → user, consecutive same-role messages merged. */
function translateMessages(messages: HostList): { messages: HostList; systemPrompt: string } {
  const result: HostDict[] = []
  let systemPrompt = ''
  const appendSystem = (text: string) => {
    if (systemPrompt) systemPrompt += '\n\n'
    systemPrompt += text
  }
  for (const msgValue of messages) {
    if (!isHostDict(msgValue)) continue
    const role = findString(msgValue, 'role')
    if (role === undefined) continue
    if (role === 'system') {
      const contentStr = findString(msgValue, 'content')
      if (contentStr !== undefined) appendSystem(contentStr)
      else {
        for (const p of findList(msgValue, 'content') ?? []) {
          if (!isHostDict(p)) continue
          const t = findString(p, 'text')
          if (t !== undefined) appendSystem(t)
        }
      }
      continue
    }
    const anthropicRole = role === 'tool' ? 'user' : role
    let contentParts: HostList = []
    const contentStr = findString(msgValue, 'content')
    if (contentStr !== undefined) contentParts = [textPart(contentStr)]
    else {
      const list = findList(msgValue, 'content')
      if (list) contentParts = translateContentParts(list)
    }
    const last = result[result.length - 1]
    if (last && findString(last, 'role') === anthropicRole) {
      const lastContent = findList(last, 'content')
      if (lastContent) {
        lastContent.push(...contentParts)
        continue
      }
    }
    result.push(
      new Map<string, HostValue>([
        ['role', anthropicRole],
        ['content', contentParts],
      ]),
    )
  }
  return { messages: result, systemPrompt }
}

/** Whether a message part already carries a caller's breakpoint. */
function hasCallerMark(messages: HostList): boolean {
  return messages.some(
    message => isHostDict(message) && (findList(message, 'content') ?? []).some(part => isHostDict(part) && part.has('cache_control')),
  )
}

/**
 * The schema with every object in its declared key order. Strict tool use samples
 * properties in the order the schema lists them, so a sorted `properties` would
 * fix an alphabetical argument order and drop what the model writes after a later
 * key (`path` after `pattern`).
 */
function inDeclaredOrder(value: HostValue): HostValue {
  if (isHostList(value)) return value.map(inDeclaredOrder)
  if (isHostDict(value)) {
    const out = new OrderedHostDict()
    for (const [k, v] of value) out.set(k, inDeclaredOrder(v))
    return out
  }
  return value
}

/** TranslateTools (anthropic_provider.cc:1272). */
function translateTools(tools: HostList, autoMark: boolean): HostList {
  const result: HostDict[] = []
  for (const toolValue of tools) {
    if (!isHostDict(toolValue)) continue
    const d: HostDict = new Map()
    const name = findString(toolValue, 'name')
    if (name !== undefined) d.set('name', name)
    const description = findString(toolValue, 'description')
    if (description !== undefined) d.set('description', description)
    const params = findDict(toolValue, 'parameters')
    const strict = findBool(toolValue, 'strict')
    if (params) {
      d.set('input_schema', strict ? sanitizeStrictSchemaForAnthropic(params) : cloneHost(params))
    }
    const schema = d.get('input_schema')
    if (schema !== undefined) d.set('input_schema', inDeclaredOrder(schema))
    if (strict !== undefined) d.set('strict', strict)
    const examples = findList(toolValue, 'inputExamples')
    if (examples) d.set('input_examples', cloneHost(examples))
    result.push(d)
  }
  // :1330 — breakpoint on the last tool caches the whole tools[] prefix.
  const last = result[result.length - 1]
  if (last && autoMark) last.set('cache_control', ephemeralCacheControl())
  return result
}

/** TranslateToolChoice (anthropic_provider.cc:1343). */
function translateToolChoice(choice: HostDict): HostDict {
  const result: HostDict = new Map()
  const type = findString(choice, 'type')
  if (type === undefined) return result
  if (type === 'auto') {
    result.set('type', 'auto')
  } else if (type === 'required') {
    result.set('type', 'any')
  } else if (type === 'tool' || type === 'function') {
    result.set('type', 'tool')
    const name = findString(choice, 'toolName') ?? findString(choice, 'name')
    if (name !== undefined) result.set('name', name)
  } else if (type === 'none') {
    result.set('type', 'none')
  }
  return result
}

/** BuildRequestBody (anthropic_provider.cc:895) over the host's
 *  `call_options` (buildHostCallOptions). */
function buildMessagesBody(callOptions: HostDict, modelId: string): HostDict {
  const body: HostDict = new Map()
  body.set('model', findString(callOptions, 'model') ?? modelId)

  let systemPrompt = ''
  // A request that places its own breakpoints gets those alone: the API
  // refuses a fifth, and the caller chose where its prefix ends (F-25).
  let autoMark = true
  const messageList = findList(callOptions, 'messages')
  if (messageList) {
    const translated = translateMessages(messageList)
    systemPrompt = translated.systemPrompt
    const messages = translated.messages
    autoMark = !hasCallerMark(messages)
    // :912 — third breakpoint on the conversation tail.
    const lastMessage = messages[messages.length - 1]
    if (autoMark && isHostDict(lastMessage)) {
      const content = findList(lastMessage, 'content')
      const lastPart = content?.[content.length - 1]
      if (isHostDict(lastPart)) lastPart.set('cache_control', ephemeralCacheControl())
    }
    body.set('messages', messages)
  }
  if (systemPrompt) {
    const block = textPart(systemPrompt)
    if (autoMark) block.set('cache_control', ephemeralCacheControl())
    body.set('system', [block])
  }

  body.set('max_tokens', new HostInt(findInt(callOptions, 'maxTokens') ?? DEFAULT_MAX_TOKENS))

  // :953-960 — BuildCallOptions never sets these; kept to match the C++ host.
  const temperature = findDouble(callOptions, 'temperature')
  if (temperature !== undefined) body.set('temperature', new HostDouble(temperature))
  const topP = findDouble(callOptions, 'topP')
  if (topP !== undefined) body.set('top_p', new HostDouble(topP))
  const topK = findInt(callOptions, 'topK')
  if (topK !== undefined) body.set('top_k', new HostInt(topK))
  const stops = findList(callOptions, 'stopSequences')
  if (stops) body.set('stop_sequences', cloneHost(stops))

  const tools = findList(callOptions, 'tools')
  if (tools) {
    const translated = translateTools(tools, autoMark)
    if (translated.length > 0) body.set('tools', translated)
  }
  const choice = findDict(callOptions, 'toolChoice')
  if (choice) body.set('tool_choice', translateToolChoice(choice))

  // :971 — providerBodyExtension overrides everything but `stream`.
  const ext = findDict(callOptions, 'providerBodyExtension')
  if (ext) {
    for (const [key, value] of ext) body.set(key, cloneHost(value))
  }
  body.set('stream', true)
  return body
}

/** The request body for a bridge payload: host validation + normalization
 *  (throws `HostRequestError` where the host answers INVALID_ARGS), then the
 *  provider. */
export function buildAnthropicRequestBody(
  payload: BridgeModelRequestPayload,
  model: string,
): HostDict {
  return buildMessagesBody(buildHostCallOptions(buildHostRequest(payload), model), model)
}

// ── Errors ────────────────────────────────────────────────────────────────

function findHeader(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return ''
}

// ── Response decoding (StreamSession, anthropic_provider.cc:277-486) ──────

const LF = 0x0a
const CR = 0x0d
const EVENT_PREFIX = new TextEncoder().encode('event: ')
const DATA_PREFIX = new TextEncoder().encode('data: ')

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false
  return true
}

/** nexus_llm_host.cc:1088 BuildToolUseInput. */
function buildToolUseInput(argsJson: string): unknown {
  if (!argsJson) return {}
  const parsed = parseHostJson(argsJson)
  return parsed !== undefined ? hostValueToJs(parsed) : argsJson
}

type OpenBlock = { type: string; toolCallId: string; toolName: string; json: string }

class AnthropicSseDecoder implements DriverResponseDecoder {
  private buffer = new Uint8Array(0)
  private scanFrom = 0
  private blocks = new Map<number, OpenBlock>()
  private promptTokens = 0
  private completionTokens = 0
  private cacheRead = 0
  private cacheCreation = 0
  /** C++ `completed_` (an SSE `error` ended the session). */
  private completed = false
  /** Host `terminal_event_queued`: the host drops a second finish/error. */
  private terminal = false
  private readonly strictUtf8 = new TextDecoder('utf-8', { fatal: true })
  private readonly lenientUtf8 = new TextDecoder('utf-8')

  constructor(private readonly context: DriverRequestContext) {}

  push(bytes: Uint8Array): DriverStreamEvent[] {
    if (this.completed || bytes.length === 0) return []
    const merged = new Uint8Array(this.buffer.length + bytes.length)
    merged.set(this.buffer)
    merged.set(bytes, this.buffer.length)
    this.buffer = merged
    return this.processBuffer()
  }

  end(): DriverStreamEvent[] {
    // OnComplete: the trailing partial block is never parsed; the host's
    // OnStreamDone finishes an unterminated stream with kUnknown + zero usage.
    this.buffer = new Uint8Array(0)
    if (this.terminal) return []
    this.terminal = true
    return [
      {
        type: 'finish',
        finishReason: 'unknown',
        usage: { promptTokens: 0, completionTokens: 0, promptCacheHits: 0, promptCacheWrites: 0 },
      },
    ]
  }

  /** ProcessBuffer: split on "\n\n" ONLY (a "\r\n\r\n" separator is not
   *  one, as in the C++ host), strip a trailing '\r' per line. */
  private processBuffer(): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    while (!this.completed) {
      let pos = -1
      for (let i = Math.max(0, this.scanFrom); i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === LF && this.buffer[i + 1] === LF) {
          pos = i
          break
        }
      }
      if (pos === -1) {
        this.scanFrom = Math.max(0, this.buffer.length - 1)
        break
      }
      const block = this.buffer.subarray(0, pos)
      this.buffer = this.buffer.slice(pos + 2)
      this.scanFrom = 0

      let eventType = ''
      const dataLines: Uint8Array[] = []
      let lineStart = 0
      while (lineStart < block.length) {
        let lineEnd = block.indexOf(LF, lineStart)
        if (lineEnd === -1) lineEnd = block.length
        let line = block.subarray(lineStart, lineEnd)
        if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1)
        if (startsWithBytes(line, EVENT_PREFIX)) {
          eventType = this.lenientUtf8.decode(line.subarray(EVENT_PREFIX.length))
        } else if (startsWithBytes(line, DATA_PREFIX)) {
          dataLines.push(line.subarray(DATA_PREFIX.length))
        }
        lineStart = lineEnd + 1
      }
      // `if (!event_data.empty())` — empty `data: ` lines add nothing but a
      // joining '\n'.
      const dataLength = dataLines.reduce((n, l) => n + l.length, 0) + Math.max(0, dataLines.length - 1)
      if (dataLength === 0) continue
      const data = new Uint8Array(dataLength)
      let offset = 0
      dataLines.forEach((l, i) => {
        if (i > 0) data[offset++] = LF
        data.set(l, offset)
        offset += l.length
      })
      this.handleEvent(eventType, data, events)
    }
    return events
  }

  private emit(events: DriverStreamEvent[], event: DriverStreamEvent): void {
    if (event.type === 'finish' || event.type === 'error') {
      if (this.terminal) return
      this.terminal = true
    }
    events.push(event)
  }

  private usage(completionTokens: number): DriverUsage {
    return {
      promptTokens: this.promptTokens,
      completionTokens,
      promptCacheHits: this.cacheRead,
      promptCacheWrites: this.cacheCreation,
    }
  }

  private handleEvent(eventType: string, dataBytes: Uint8Array, events: DriverStreamEvent[]): void {
    let text: string
    try {
      text = this.strictUtf8.decode(dataBytes)
    } catch {
      return // JSONReader rejects invalid UTF-8.
    }
    const dict = parseHostJsonDict(text)
    if (!dict) return

    if (eventType === 'message_start') {
      const usage = findDict(findDict(dict, 'message') ?? new Map(), 'usage')
      if (usage) {
        this.promptTokens = findInt(usage, 'input_tokens') ?? 0
        this.cacheRead = findInt(usage, 'cache_read_input_tokens') ?? 0
        this.cacheCreation = findInt(usage, 'cache_creation_input_tokens') ?? 0
        // The C++ `usage-update` chunk → host QueueUsageUpdate, a
        // kMessageStart carrying state->model_id.
        this.emit(events, { type: 'message_start', model: this.context.model, usage: this.usage(0) })
      }
    } else if (eventType === 'content_block_start') {
      const index = findInt(dict, 'index') ?? -1
      const block = findDict(dict, 'content_block')
      if (!block || index < 0) return
      const type = findString(block, 'type')
      if (type === undefined) return
      const open: OpenBlock = { type, toolCallId: '', toolName: '', json: '' }
      if (type === 'tool_use') {
        open.toolCallId = findString(block, 'id') ?? ''
        open.toolName = findString(block, 'name') ?? ''
        // Empty id/name = absent on the host side (it mints a uuid).
        this.emit(events, {
          type: 'tool_call_start',
          id: open.toolCallId || undefined,
          name: open.toolName || undefined,
        })
      }
      this.blocks.set(index, open)
    } else if (eventType === 'content_block_delta') {
      const delta = findDict(dict, 'delta')
      if (!delta) return
      const deltaType = findString(delta, 'type')
      if (deltaType === undefined) return
      const index = findInt(dict, 'index') ?? -1
      if (deltaType === 'text_delta') {
        const t = findString(delta, 'text')
        // The host drops an empty textDelta (nexus_llm_host.cc:1993).
        if (t) this.emit(events, { type: 'text_delta', text: t })
      } else if (deltaType === 'input_json_delta') {
        const partial = findString(delta, 'partial_json')
        if (partial === undefined) return
        const open = this.blocks.get(index)
        let id = ''
        if (open) {
          open.json += partial
          id = open.toolCallId
        }
        this.emit(events, {
          type: 'tool_call_delta',
          id: id || undefined,
          argsTextDelta: partial || undefined,
        })
      } else if (deltaType === 'thinking_delta') {
        const t = findString(delta, 'thinking')
        if (t) this.emit(events, { type: 'reasoning_delta', text: t })
      }
      // signature_delta: ignored by the C++ provider.
    } else if (eventType === 'content_block_stop') {
      const index = findInt(dict, 'index') ?? -1
      const open = this.blocks.get(index)
      if (!open) return
      if (open.type === 'tool_use') {
        this.emit(events, {
          type: 'tool_call',
          id: open.toolCallId || undefined,
          name: open.toolName || undefined,
          input: buildToolUseInput(open.json),
        })
      }
      this.blocks.delete(index)
    } else if (eventType === 'message_delta') {
      let reason: DriverFinishReason = 'other'
      let stopDetails: Record<string, unknown> | undefined
      const deltaObj = findDict(dict, 'delta')
      if (deltaObj) {
        const sr = findString(deltaObj, 'stop_reason')
        if (sr !== undefined) reason = translateAnthropicStopReason(sr)
        stopDetails = normalizeAnthropicStopDetails(deltaObj.get('stop_details'))
      }
      const usage = findDict(dict, 'usage')
      if (usage) this.completionTokens = findInt(usage, 'output_tokens') ?? 0
      const finish: DriverStreamEvent = {
        type: 'finish',
        finishReason: reason,
        usage: this.usage(this.completionTokens),
      }
      if (stopDetails) finish.stopDetails = stopDetails
      this.emit(events, finish)
    } else if (eventType === 'error') {
      const err = findDict(dict, 'error')
      const message = (err && findString(err, 'message')) ?? 'Unknown API error'
      this.emit(events, hostErrorEvent(message))
      this.completed = true
      this.buffer = new Uint8Array(0)
    }
    // message_stop / ping: ignored; completion is driven by end().
  }
}

// ── Driver ────────────────────────────────────────────────────────────────

export const anthropicMessagesDriver: ProviderDriver = {
  // anthropic_provider.cc:172 / :215-229: SSE is parsed only on exactly 200;
  // any other status (a proxy's 204 included) is BuildProviderErrorMessage.
  isStreamStatus: status => status === 200,
  id: 'anthropic-messages',
  // Where this wire carries ids (idSites.ts): the id mapper's input.
  idSites: messagesIdSites,
  auth: {
    headers: { 'x-api-key': '{{secret:api_key}}', 'anthropic-version': ANTHROPIC_API_VERSION },
  },

  buildRequest(payload, context) {
    // Codec switches (`context.compat`): none is read here. The Messages API
    // names its cap `max_tokens` itself, has its own system field and its own
    // thinking object, and replays thinking through signed blocks, so all four
    // switches are ignored.
    const body = buildAnthropicRequestBody(payload, context.model)
    return {
      // CreateResourceRequest: plain concatenation, no join logic.
      url: context.baseUrl + MESSAGES_PATH,
      method: 'POST',
      headers: {
        'x-api-key': '{{secret:api_key}}',
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(writeHostJson(body)),
    }
  },

  createDecoder(context) {
    return new AnthropicSseDecoder(context)
  },

  errorFromResponse(response) {
    const extracted = extractApiErrorMessage(response.bodyText)
    return hostErrorEvent(
      buildProviderErrorMessage(
        response.status,
        findHeader(response.headers, 'Retry-After'),
        extracted,
      ),
    )
  },
}
