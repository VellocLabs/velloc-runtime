/**
 * OpenAI Responses API (`POST {base}/responses`): byte-for-byte the C++ `/responses`
 * path, from the host's `call_options`, written as `base::JSONWriter` would,
 * including the JSON-serialized text the body carries.
 */
import {
  buildHostCallOptions,
  buildHostRequest,
  buildProviderErrorMessage,
  extractApiErrorMessage,
  hostErrorEvent,
  parseFinishReasonString,
} from './hostCallOptions'
import {
  HostInt,
  type HostDict,
  type HostList,
  type HostValue,
  findDict,
  findInt,
  findList,
  findNonEmptyString,
  findString,
  isHostDict,
  parseHostJsonDict,
  sortedEntries,
  writeHostJson,
} from './hostValue'
import type { CodecCompat } from '../../config/nexusModelConfig/providerDefinition'
import type {
  DriverHttpRequest,
  DriverResponseDecoder,
  DriverStreamEvent,
  DriverUsage,
  ProviderDriver,
} from './driverTypes'
import { responsesIdSites } from './idSites'

const utf8Encoder = new TextEncoder()

function dict(entries: Array<[string, HostValue]>): HostDict {
  return new Map(entries)
}

function isUrlOrDataUri(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')
}

// ── openai_tool_result_messages.cc (Responses half) ───────────────────────

const IMAGE_NOTE =
  'The images below were returned by the tool calls above, grouped by tool call id.'
// kMaxImageCaptionChars compares std::string::size() — UTF-8 BYTES.
const MAX_IMAGE_CAPTION_BYTES = 300

type HoistedPart = { isImage: boolean; value: string }
type ImageGroup = { toolCallId?: string; parts: HoistedPart[] }

/** `DocumentUnavailableMarker`. */
export function documentUnavailableMarker(mimeType: string | undefined): string {
  return (
    '[document: '
    + (mimeType ?? 'application/pdf')
    + ' - its content cannot be shown through this provider. Read it with '
    + 'the pages parameter (e.g. pages: "1-5") to receive the pages as images.]'
  )
}

/** `FlattenToolResult` (openai_tool_result_messages.cc:59). */
function flattenToolResult(part: HostDict): { toolCallId?: string; text: string; hoisted: HoistedPart[] } {
  const toolCallId = findString(part, 'toolCallId')
  let text = ''
  let hoisted: HoistedPart[] = []
  let hasImage = false
  const resultParts = findList(part, 'result')
  if (resultParts) {
    for (const rp of resultParts) {
      if (!isHostDict(rp)) continue
      const type = findString(rp, 'type')
      if (type === 'text') {
        const t = findString(rp, 'text')
        if (t !== undefined) {
          if (text) text += '\n'
          text += t
          if (utf8Encoder.encode(t).length <= MAX_IMAGE_CAPTION_BYTES) {
            hoisted.push({ isImage: false, value: t })
          }
        }
      } else if (type === 'document') {
        if (text) text += '\n'
        text += documentUnavailableMarker(findString(rp, 'mimeType'))
      } else if (type === 'image') {
        const img = findString(rp, 'image')
        if (img) {
          hasImage = true
          hoisted.push({
            isImage: true,
            value: isUrlOrDataUri(img)
              ? img
              : `data:${findString(rp, 'mimeType') ?? 'image/jpeg'};base64,${img}`,
          })
        }
      }
    }
  } else if (findString(part, 'result') !== undefined) {
    text = findString(part, 'result') as string
  } else if (part.has('result')) {
    text = writeHostJson(part.get('result') as HostValue)
  }
  if (!hasImage) hoisted = []
  return { toolCallId, text, hoisted }
}

/** `AppendResponsesToolOutputItems` (openai_tool_result_messages.cc:207):
 *  one function_call_output per result part, then ONE user message carrying
 *  every result image under its `Tool call <id>:` label. */
function appendResponsesToolOutputItems(contentParts: HostList, input: HostList): void {
  const groups: ImageGroup[] = []
  for (const part of contentParts) {
    if (!isHostDict(part) || findString(part, 'type') !== 'tool-result') continue
    const flat = flattenToolResult(part)
    if (flat.hoisted.length > 0) groups.push({ toolCallId: flat.toolCallId, parts: flat.hoisted })
    const item = dict([['type', 'function_call_output']])
    if (flat.toolCallId !== undefined) item.set('call_id', flat.toolCallId)
    item.set('output', flat.text)
    input.push(item)
  }
  if (groups.length === 0) return
  const text = (t: string): HostDict => dict([['type', 'input_text'], ['text', t]])
  const parts: HostList = [text(IMAGE_NOTE)]
  for (const group of groups) {
    parts.push(text((group.toolCallId !== undefined ? `Tool call ${group.toolCallId}` : 'Tool call') + ':'))
    for (const hp of group.parts) {
      parts.push(hp.isImage ? dict([['type', 'input_image'], ['image_url', hp.value]]) : text(hp.value))
    }
  }
  input.push(dict([['type', 'message'], ['role', 'user'], ['content', parts]]))
}

// ── openai_user_content.cc ────────────────────────────────────────────────

/** First extension of Chromium's static mime tables (net/base/mime_util.cc
 *  kPrimaryMappings / kSecondaryMappings) for types a document can carry.
 *  C++ consults the OS registry FIRST (`GetPlatformPreferredExtension...`),
 *  which a runtime cannot see — see the divergence note on DocumentFilename. */
const MIME_TO_SUFFIX: Record<string, string> = {
  'application/epub+zip': 'epub',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/xhtml+xml': 'xhtml',
  'application/zip': 'zip',
  'text/calendar': 'ics',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/javascript': 'js',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/xml': 'xml',
}

/** `DocumentFilename` (openai_user_content.cc:33). */
function documentFilename(mimeType: string | undefined): string {
  if (mimeType === undefined || mimeType === 'application/pdf') return 'document.pdf'
  const extension = MIME_TO_SUFFIX[mimeType]
  return extension ? `document.${extension}` : 'document'
}

function dataUri(mimeType: string | undefined, fallback: string, base64: string): string {
  return `data:${mimeType ?? fallback};base64,${base64}`
}

/** `ImageUrlForPart` (openai_user_content.cc:62). */
function imageUrlForPart(part: HostDict): string | undefined {
  const mimeType = findString(part, 'mimeType')
  const url = findString(part, 'url')
  if (url !== undefined) return url
  const image = findString(part, 'image')
  if (image !== undefined) return isUrlOrDataUri(image) ? image : dataUri(mimeType, 'image/png', image)
  const data = findString(part, 'data')
  if (data !== undefined) return dataUri(mimeType, 'image/png', data)
  return undefined
}

/** `BuildResponsesUserContent` (openai_user_content.cc:78): a plain string
 *  unless the message carries an image or document. */
function buildResponsesUserContent(parts: HostList, acceptsInputFile: boolean): HostValue {
  const textOnly = !parts.some(p => {
    const type = isHostDict(p) ? findString(p, 'type') : undefined
    return type === 'image' || type === 'document'
  })
  if (textOnly) {
    let combined = ''
    for (const part of parts) {
      if (!isHostDict(part)) continue
      const text = findString(part, 'text')
      if (findString(part, 'type') === 'text' && text !== undefined) {
        if (combined) combined += '\n'
        combined += text
      }
    }
    return combined
  }
  const content: HostList = []
  for (const part of parts) {
    if (!isHostDict(part)) continue
    const type = findString(part, 'type')
    const mimeType = findString(part, 'mimeType')
    if (type === 'text') {
      const text = findString(part, 'text')
      if (text !== undefined) content.push(dict([['type', 'input_text'], ['text', text]]))
    } else if (type === 'image') {
      const url = imageUrlForPart(part)
      if (url !== undefined) content.push(dict([['type', 'input_image'], ['image_url', url]]))
    } else if (type === 'document') {
      const data = findString(part, 'data')
      if (acceptsInputFile && data) {
        content.push(
          dict([
            ['type', 'input_file'],
            ['filename', documentFilename(mimeType)],
            ['file_data', dataUri(mimeType, 'application/pdf', data)],
          ]),
        )
      } else {
        content.push(dict([['type', 'input_text'], ['text', documentUnavailableMarker(mimeType)]]))
      }
    }
  }
  return content
}

// ── openai_provider.cc — request ──────────────────────────────────────────

/** `IsCodexBackend` (openai_provider.cc:957). */
function isCodexBackend(baseUrl: string): boolean {
  return baseUrl.includes('/backend-api/codex')
}

/** `TranslateToolDefinitionForResponses` (openai_provider.cc:813): the flat
 *  `{type, name, description, parameters, strict}` shape. */
function translateToolDefinition(tool: HostDict): HostDict {
  const out = dict([['type', 'function']])
  const name = findString(tool, 'name')
  if (name !== undefined) out.set('name', name)
  const description = findString(tool, 'description')
  if (description !== undefined) out.set('description', description)
  const parameters = findDict(tool, 'parameters')
  if (parameters) out.set('parameters', parameters)
  const strict = tool.get('strict')
  if (typeof strict === 'boolean') out.set('strict', strict)
  return out
}

/*
 * Codec switches (`wire.compat`) this codec reads: developerRole, reasoningEffortField.
 * `maxTokensField` and `reasoningReplay` are ignored.
 */

/** `TranslateMessagesToResponsesInput` (openai_provider.cc:831). */
function translateMessagesToResponsesInput(
  prompt: HostList,
  acceptsInputFile: boolean,
  compat?: CodecCompat,
): { input: HostList; instructions: string } {
  const input: HostList = []
  let instructions = ''
  for (const msg of prompt) {
    if (!isHostDict(msg)) continue
    const role = findString(msg, 'role')
    if (role === undefined) continue
    const parts = findList(msg, 'content')
    if (!parts) continue

    if (role === 'tool') {
      appendResponsesToolOutputItems(parts, input)
      continue
    }

    if (role === 'assistant') {
      let textContent = ''
      const toolCallItems: HostList = []
      for (const part of parts) {
        if (!isHostDict(part)) continue
        const type = findString(part, 'type')
        if (type === 'tool-call') {
          const item = dict([['type', 'function_call']])
          const id = findString(part, 'toolCallId')
          if (id !== undefined) item.set('call_id', id)
          const name = findString(part, 'toolName')
          if (name !== undefined) item.set('name', name)
          const args = findDict(part, 'args')
          item.set('arguments', args ? writeHostJson(args) : '{}')
          toolCallItems.push(item)
        } else if (type === 'text') {
          const text = findString(part, 'text')
          if (text !== undefined) {
            if (textContent) textContent += '\n'
            textContent += text
          }
        }
      }
      if (textContent) {
        input.push(dict([['type', 'message'], ['role', 'assistant'], ['content', textContent]]))
      }
      input.push(...toolCallItems)
      continue
    }

    if (role === 'system') {
      let combined = ''
      for (const part of parts) {
        if (!isHostDict(part) || findString(part, 'type') !== 'text') continue
        const text = findString(part, 'text')
        if (text !== undefined) {
          if (combined) combined += '\n'
          combined += text
        }
      }
      if (combined && compat?.developerRole === true) {
        input.push(dict([['type', 'message'], ['role', 'developer'], ['content', combined]]))
      } else if (combined) {
        if (instructions) instructions += '\n\n'
        instructions += combined
      }
      continue
    }

    input.push(
      dict([
        ['type', 'message'],
        ['role', role],
        ['content', buildResponsesUserContent(parts, acceptsInputFile)],
      ]),
    )
  }
  return { input, instructions }
}

/** `BuildResponsesApiRequestBody(call_options, stream=true)`
 *  (openai_provider.cc:961), over the host's call_options. */
export function buildResponsesApiRequestBody(
  callOptions: HostDict,
  baseUrl: string,
  compat?: CodecCompat,
): HostDict {
  const codex = isCodexBackend(baseUrl)
  const body: HostDict = new Map()
  // ResolveModel: modelId, else the configured model (never empty here).
  body.set('model', findNonEmptyString(callOptions, 'modelId') ?? '')

  const prompt = findList(callOptions, 'prompt')
  if (prompt) {
    const { input, instructions } = translateMessagesToResponsesInput(prompt, !codex, compat)
    body.set('input', input)
    if (instructions) body.set('instructions', instructions)
  }
  if (codex && !body.has('instructions')) body.set('instructions', 'You are a helpful assistant.')
  body.set('stream', true)
  body.set('store', false)

  const mode = findDict(callOptions, 'mode')
  const modeType = mode ? findString(mode, 'type') : undefined
  if (mode && modeType === 'regular') {
    const tools = findList(mode, 'tools')
    if (tools) {
      const respTools: HostList = []
      for (const tool of tools) if (isHostDict(tool)) respTools.push(translateToolDefinition(tool))
      if (respTools.length > 0) body.set('tools', respTools)
    }
    const toolChoice = findDict(mode, 'toolChoice')
    const tcType = toolChoice ? findString(toolChoice, 'type') : undefined
    if (toolChoice && tcType !== undefined) {
      if (tcType === 'auto' || tcType === 'none' || tcType === 'required') {
        body.set('tool_choice', tcType)
      } else if (tcType === 'tool') {
        const toolName = findString(toolChoice, 'toolName')
        if (toolName !== undefined) {
          body.set('tool_choice', dict([['type', 'function'], ['name', toolName]]))
        }
      }
    }
  } else if (mode && modeType === 'object-json') {
    const schema = findDict(mode, 'schema')
    if (schema) {
      body.set(
        'text',
        dict([
          [
            'format',
            dict([
              ['type', 'json_schema'],
              ['name', 'response'],
              ['strict', true],
              ['schema', schema],
            ]),
          ],
        ]),
      )
    }
  }

  if (!codex) {
    const maxTokens = findInt(callOptions, 'maxTokens')
    if (maxTokens !== undefined) body.set('max_output_tokens', new HostInt(maxTokens))
  }

  // DictValue iteration is sorted: `reasoning` precedes `reasoning_effort`,
  // so a string effort wins when both are present.
  const residue: Array<[string, HostValue]> = []
  const ext = findDict(callOptions, 'providerBodyExtension')
  if (ext) {
    for (const [key, val] of sortedEntries(ext)) {
      if (compat?.reasoningEffortField === false && (key === 'reasoning_effort' || key === 'reasoning')) {
        continue
      } else if (key === 'reasoning_effort') {
        if (typeof val === 'string') body.set('reasoning', dict([['effort', val]]))
      } else if (key === 'reasoning') {
        body.set('reasoning', val)
      } else {
        residue.push([key, val])
      }
    }
  }

  if (!codex) {
    const stop = findList(callOptions, 'stopSequences')
    if (stop) body.set('stop', stop)
    const seed = callOptions.get('seed')
    if (seed !== undefined && findInt(callOptions, 'seed') !== undefined) body.set('seed', seed)
  }

  for (const [key, val] of residue) body.set(key, val)
  return body
}

// ── openai_responses_error.cc ─────────────────────────────────────────────

const MAX_SERIALIZED_ERROR_EVENT_BYTES = 1024 // kMaxSerializedErrorEventChars
const RESPONSE_DIAGNOSTIC_KEYS = ['error', 'id', 'incomplete_details', 'status']

/** `base::TruncateUTF8ToByteSize`: never split a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return new TextDecoder().decode(bytes.subarray(0, cut))
}

/** `SerializeEventForDiagnosis` (openai_responses_error.cc:40): the
 *  `response` object is pruned to non-request keys first. */
export function serializeEventForDiagnosis(data: HostDict): string {
  const pruned: HostDict = new Map(data)
  const response = findDict(data, 'response')
  if (response) {
    const kept: HostDict = new Map()
    for (const key of RESPONSE_DIAGNOSTIC_KEYS) {
      if (response.has(key)) kept.set(key, response.get(key) as HostValue)
    }
    pruned.set('response', kept)
  }
  let serialized = writeHostJson(pruned)
  if (utf8Encoder.encode(serialized).length > MAX_SERIALIZED_ERROR_EVENT_BYTES) {
    serialized = truncateUtf8(serialized, MAX_SERIALIZED_ERROR_EVENT_BYTES) + '...(truncated)'
  }
  return serialized
}

function nestedNonEmpty(parent: HostDict | undefined, outer: string, inner: string): string | undefined {
  const sub = parent ? findDict(parent, outer) : undefined
  return sub ? findNonEmptyString(sub, inner) : undefined
}

/** `ExtractResponsesApiErrorMessage`. */
export function extractResponsesApiErrorMessage(data: HostDict): string {
  return (
    nestedNonEmpty(findDict(data, 'response'), 'error', 'message')
    ?? nestedNonEmpty(data, 'error', 'message')
    ?? findNonEmptyString(data, 'message')
    ?? findNonEmptyString(data, 'error')
    ?? ''
  )
}

/** `ExtractResponsesApiErrorCode`: `code`/`type` inside an error object
 *  only; the top-level `type` of a bare `error` event is not a code. */
export function extractResponsesApiErrorCode(data: HostDict): string {
  const response = findDict(data, 'response')
  for (const err of [response ? findDict(response, 'error') : undefined, findDict(data, 'error')]) {
    if (!err) continue
    for (const key of ['code', 'type']) {
      const code = findNonEmptyString(err, key)
      if (code) return code
    }
  }
  return findNonEmptyString(data, 'code') ?? ''
}

/** `BuildResponsesApiErrorMessage` (openai_responses_error.cc:117). */
export function buildResponsesApiErrorMessage(data: HostDict): string {
  const message = extractResponsesApiErrorMessage(data)
  if (!message) return 'unrecognized error event: ' + serializeEventForDiagnosis(data)
  const code = extractResponsesApiErrorCode(data)
  if (code && !message.includes(code)) return `${code}: ${message}`
  return message
}

// ── openai_provider.cc — response ─────────────────────────────────────────

/** Responses usage → host usage (openai_provider.cc:1313): `input_tokens`
 *  INCLUDES `cached_tokens`; the host wants input exclusive of cache. */
function responsesUsage(usage: HostDict): DriverUsage {
  const input = findInt(usage, 'input_tokens') ?? 0
  const details = findDict(usage, 'input_tokens_details')
  const cached = (details ? findInt(details, 'cached_tokens') : undefined) ?? 0
  const out: DriverUsage = {
    promptTokens: input > cached ? input - cached : 0,
    completionTokens: findInt(usage, 'output_tokens') ?? 0,
  }
  if (cached > 0) out.promptCacheHits = cached
  return out
}

/** `IsResponsesReasoningTextDeltaEvent` (openai_reasoning.cc:81). */
function isReasoningTextDeltaEvent(eventType: string): boolean {
  return (
    eventType === 'response.reasoning_summary_text.delta'
    || eventType === 'response.reasoning_text.delta'
  )
}

// `ignoreBOM: true` KEEPS a byte-order mark: C++ matches `data:` against the
// raw line bytes, so a BOM before it makes that line a non-data line.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

class ResponsesDecoder implements DriverResponseDecoder {
  private lineBuffer = new Uint8Array(0)
  private readonly raw: Uint8Array[] = []
  private pendingEventType = ''
  private readonly callIds = new Map<string, string>()
  private readonly callNames = new Map<string, string>()
  private sawToolCall = false
  private finishEmitted = false
  private errorEmitted = false

  push(bytes: Uint8Array): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    if (bytes.length === 0) return events
    this.raw.push(bytes.slice()) // ctx.raw_response, read by OnStreamComplete
    // LineSplitter::Feed (llm_line_splitter.cc): split on '\n', drop one '\r'.
    const merged = new Uint8Array(this.lineBuffer.length + bytes.length)
    merged.set(this.lineBuffer)
    merged.set(bytes, this.lineBuffer.length)
    let pos = 0
    for (let nl = merged.indexOf(0x0a); nl !== -1; nl = merged.indexOf(0x0a, pos)) {
      let end = nl
      if (end > pos && merged[end - 1] === 0x0d) end--
      this.processLine(merged.subarray(pos, end), events)
      pos = nl + 1
    }
    this.lineBuffer = merged.slice(pos)
    return events
  }

  /** `OnStreamComplete` (openai_provider.cc:1912) + the host's
   *  `OnStreamDone`. An unterminated last line is never parsed (C++ never
   *  drains the splitter). */
  end(): DriverStreamEvent[] {
    // Already terminal: C++ still runs the checks below, but the host drops
    // any second terminal event (`terminal_event_queued`).
    if (this.finishEmitted || this.errorEmitted) return []
    // A 2xx body carrying an error envelope instead of SSE (the Codex
    // backend's `{"detail": ...}`) and no finish → the done error.
    const rawText = new TextDecoder().decode(concatBytes(this.raw))
    const apiError = extractApiErrorMessage(rawText)
    if (apiError) {
      this.errorEmitted = true
      // The decoder only ever sees a 2xx response; see the report's note.
      return [hostErrorEvent(buildProviderErrorMessage(200, '', apiError))]
    }
    // done(nullopt) without a terminal event → finish(kUnknown), no usage.
    return [{ type: 'finish', finishReason: 'unknown' }]
  }

  /** `ProcessSseLine`, Responses branch (openai_provider.cc:1763). */
  private processLine(lineBytes: Uint8Array, events: DriverStreamEvent[]): void {
    if (lineBytes.length === 0) {
      this.pendingEventType = '' // event-block boundary
      return
    }
    if (lineBytes[0] === 0x3a) return // ':' comment
    let line: string
    try {
      line = strictUtf8.decode(lineBytes)
    } catch {
      // Invalid UTF-8: base::JSONReader rejects the payload outright.
      return
    }
    if (line.startsWith('event:')) {
      this.pendingEventType = line.slice(6).replace(/^ +/, '')
      return
    }
    if (!line.startsWith('data:')) return
    let payload = line.slice(5)
    if (payload.startsWith(' ')) payload = payload.slice(1)
    if (payload === '[DONE]') return
    const parsed = parseHostJsonDict(payload)
    if (!parsed) return
    // The explicit `event:` line wins; the JSON `type` is the fallback.
    let eventName = this.pendingEventType
    if (!eventName) eventName = findString(parsed, 'type') ?? ''
    this.processEvent(eventName, parsed, events)
  }

  /** `ProcessResponsesApiSseEvent` (openai_provider.cc:1194). */
  private processEvent(eventType: string, data: HostDict, events: DriverStreamEvent[]): void {
    if (isReasoningTextDeltaEvent(eventType)) {
      const delta = findString(data, 'delta')
      if (delta) events.push({ type: 'reasoning_delta', text: delta })
      return
    }

    // A summary's parts arrive separately; C++ separates them with "\n\n".
    if (
      eventType === 'response.reasoning_summary_part.added'
      && (findInt(data, 'summary_index') ?? 0) > 0
    ) {
      events.push({ type: 'reasoning_delta', text: '\n\n' })
      return
    }

    if (eventType === 'response.output_text.delta') {
      const delta = findString(data, 'delta')
      if (delta) events.push({ type: 'text_delta', text: delta })
      return
    }

    if (eventType === 'response.output_item.added') {
      const item = findDict(data, 'item')
      if (!item || findString(item, 'type') !== 'function_call') return
      const itemId = findString(item, 'id')
      if (!itemId) return
      // No call_id yet: the item id is the placeholder (openai_provider.cc:1260).
      const callId = findString(item, 'call_id') ?? itemId
      this.callIds.set(itemId, callId)
      this.sawToolCall = true
      const name = findString(item, 'name') ?? ''
      if (name) this.callNames.set(itemId, name)
      // The host treats an empty toolCallId as absent.
      const event: Extract<DriverStreamEvent, { type: 'tool_call_start' }> = { type: 'tool_call_start' }
      if (callId) event.id = callId
      if (name) event.name = name
      events.push(event)
      return
    }

    if (eventType === 'response.function_call_arguments.delta') {
      const itemId = findString(data, 'item_id')
      const delta = findString(data, 'delta')
      if (itemId === undefined || !delta) return
      const callId = this.callIds.get(itemId)
      if (callId === undefined) return
      const event: Extract<DriverStreamEvent, { type: 'tool_call_delta' }> = {
        type: 'tool_call_delta',
        argsTextDelta: delta,
      }
      if (callId) event.id = callId
      events.push(event)
      return
    }

    if (eventType === 'response.completed') {
      const response = findDict(data, 'response')
      if (!response) return
      const event: Extract<DriverStreamEvent, { type: 'finish' }> = {
        type: 'finish',
        finishReason: this.sawToolCall ? 'tool_calls' : 'stop',
      }
      const usage = findDict(response, 'usage')
      if (usage) event.usage = responsesUsage(usage)
      this.finishEmitted = true
      events.push(event)
      return
    }

    if (eventType === 'response.incomplete') {
      const response = findDict(data, 'response')
      if (!response) return
      let reason = 'stop'
      const details = findDict(response, 'incomplete_details')
      const r = details ? findString(details, 'reason') : undefined
      // openai_provider.cc:1346: max_output_tokens → "max_tokens" (→ length).
      if (r !== undefined) reason = r === 'max_output_tokens' ? 'max_tokens' : r
      const event: Extract<DriverStreamEvent, { type: 'finish' }> = {
        type: 'finish',
        finishReason: parseFinishReasonString(reason),
      }
      const usage = findDict(response, 'usage')
      if (usage) event.usage = responsesUsage(usage)
      this.finishEmitted = true
      events.push(event)
      return
    }

    if (eventType === 'response.failed' || eventType === 'error') {
      this.errorEmitted = true
      events.push(hostErrorEvent(buildResponsesApiErrorMessage(data)))
    }
    // Everything else — response.created / in_progress, output_item.done,
    // function_call_arguments.done, content_part.*, refusal, tool-specific
    // events — carries nothing C++ surfaces.
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** `HttpResponseHeaders::EnumerateHeader(nullptr, "Retry-After")`. */
function headerValue(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return ''
}

export const openaiResponsesDriver: ProviderDriver = {
  // openai_provider.cc OnStreamComplete: only a status >= 400 is an HTTP
  // error; anything below is decoded as the stream.
  isStreamStatus: status => status < 400,
  id: 'openai-responses',
  // Where this wire carries ids (idSites.ts): the id mapper's input.
  idSites: responsesIdSites,
  auth: { headers: { authorization: 'Bearer {{secret:api_key}}' } },

  buildRequest(payload, context): DriverHttpRequest {
    const callOptions = buildHostCallOptions(buildHostRequest(payload), context.model)
    const body = buildResponsesApiRequestBody(callOptions, context.baseUrl, context.compat)
    return {
      // StartStream: base_url_ + "/responses", unchanged (openai_provider.cc:1651).
      url: context.baseUrl + '/responses',
      method: 'POST',
      headers: {
        authorization: 'Bearer {{secret:api_key}}',
        'content-type': 'application/json',
      },
      body: utf8Encoder.encode(writeHostJson(body)),
    }
  },

  createDecoder(): DriverResponseDecoder {
    return new ResponsesDecoder()
  },

  errorFromResponse(response) {
    // OnStreamComplete, http_status >= 400 (openai_provider.cc:1966).
    return hostErrorEvent(
      buildProviderErrorMessage(
        response.status,
        headerValue(response.headers, 'retry-after'),
        extractApiErrorMessage(response.bodyText),
      ),
    )
  },
}
