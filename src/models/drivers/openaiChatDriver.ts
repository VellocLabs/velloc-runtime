/**
 * OpenAI-compatible Chat Completions (`POST {base}/chat/completions`, SSE): the JS
 * twin of the C++ `OpenAiProvider` chat branch plus the host's chunk handling,
 * reasoning details replayed via the `velloc-replay-v1:` envelope. The body is
 * byte-identical to the C++ body (hostValue.ts).
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import {
  buildHostCallOptions,
  buildHostRequest,
  buildProviderErrorMessage,
  encodeReasoningReplaySignature,
  extractApiErrorMessage,
  hostErrorEvent,
  HostToolCallTracker,
  parseFinishReasonString,
  REASONING_REPLAY_PART_TYPE,
} from './hostCallOptions'
import {
  HostInt,
  type HostDict,
  type HostList,
  type HostValue,
  findBool,
  findDict,
  findInt,
  findList,
  findString,
  isHostDict,
  parseHostJsonDict,
  sortedEntries,
  writeHostJson,
} from './hostValue'
import type { CodecCompat } from '../../config/nexusModelConfig/providerDefinition'
import type {
  DriverHttpRequest,
  DriverRequestContext,
  DriverResponseDecoder,
  DriverStreamEvent,
  DriverUsage,
  ProviderDriver,
} from './driverTypes'
import { chatIdSites } from './idSites'

// ── Request ───────────────────────────────────────────────────────────────

function dict(entries: Array<[string, HostValue]>): HostDict {
  return new Map(entries)
}

/** `DocumentUnavailableMarker` (openai_tool_result_messages.cc). */
export function documentUnavailableMarker(mimeType: string | undefined): string {
  return (
    '[document: '
    + (mimeType ?? 'application/pdf')
    + ' - its content cannot be shown through this provider. Read it with '
    + 'the pages parameter (e.g. pages: "1-5") to receive the pages as images.]'
  )
}

function isUrlOrDataUri(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')
}

/** `ImageUrlForPart` (openai_user_content.cc). */
export function imageUrlForPart(part: HostDict): string | undefined {
  const mimeType = findString(part, 'mimeType')
  const url = findString(part, 'url')
  if (url !== undefined) return url
  const image = findString(part, 'image')
  if (image !== undefined) {
    if (isUrlOrDataUri(image)) return image
    return `data:${mimeType ?? 'image/png'};base64,${image}`
  }
  const data = findString(part, 'data')
  if (data !== undefined) return `data:${mimeType ?? 'image/png'};base64,${data}`
  return undefined
}

// openai_tool_result_messages.cc
const IMAGE_NOTE =
  'The images below were returned by the tool calls above, grouped by tool call id.'
const MAX_IMAGE_CAPTION_CHARS = 300

/*
 * Codec switches (`wire.compat`) this codec reads; absent = default: maxTokensField,
 * developerRole, reasoningEffortField (false omits it), reasoningReplay (`none`
 * sends no earlier reasoning).
 */

type HoistedPart = { isImage: boolean; value: string }

/** UTF-8 byte length — C++ `std::string::size()`. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** `FlattenToolResult` (openai_tool_result_messages.cc). */
function flattenToolResult(part: HostDict): {
  toolCallId?: string
  text: string
  hoisted: HoistedPart[]
} {
  const toolCallId = findString(part, 'toolCallId')
  let text = ''
  let hoisted: HoistedPart[] = []
  let hasImage = false
  const resultParts = findList(part, 'result')
  if (resultParts) {
    for (const rpValue of resultParts) {
      if (!isHostDict(rpValue)) continue
      const rpType = findString(rpValue, 'type')
      if (rpType === 'text') {
        const t = findString(rpValue, 'text')
        if (t !== undefined) {
          if (text) text += '\n'
          text += t
          if (utf8Length(t) <= MAX_IMAGE_CAPTION_CHARS) hoisted.push({ isImage: false, value: t })
        }
      } else if (rpType === 'document') {
        if (text) text += '\n'
        text += documentUnavailableMarker(findString(rpValue, 'mimeType'))
      } else if (rpType === 'image') {
        const img = findString(rpValue, 'image')
        if (img) {
          hasImage = true
          if (isUrlOrDataUri(img)) {
            hoisted.push({ isImage: true, value: img })
          } else {
            const mime = findString(rpValue, 'mimeType')
            hoisted.push({ isImage: true, value: `data:${mime ?? 'image/jpeg'};base64,${img}` })
          }
        }
      }
    }
  } else if (typeof part.get('result') === 'string') {
    text = part.get('result') as string
  } else if (part.has('result')) {
    text = writeHostJson(part.get('result')!)
  }
  if (!hasImage) hoisted = []
  return { ...(toolCallId !== undefined ? { toolCallId } : {}), text, hoisted }
}

/** `AppendChatCompletionToolMessages`: one `role:"tool"` message per result,
 *  then ONE user message carrying every image of the batch, labelled per
 *  tool call. */
export function appendChatCompletionToolMessages(contentParts: HostList, messages: HostList): void {
  const groups: Array<{ toolCallId?: string; parts: HoistedPart[] }> = []
  for (const partValue of contentParts) {
    if (!isHostDict(partValue)) continue
    if (findString(partValue, 'type') !== 'tool-result') continue
    const flat = flattenToolResult(partValue)
    if (flat.hoisted.length > 0) groups.push({ toolCallId: flat.toolCallId, parts: flat.hoisted })
    const toolMsg = dict([['role', 'tool']])
    if (flat.toolCallId !== undefined) toolMsg.set('tool_call_id', flat.toolCallId)
    toolMsg.set('content', flat.text)
    messages.push(toolMsg)
  }
  if (groups.length === 0) return

  const text = (t: string) => dict([['type', 'text'], ['text', t]])
  const image = (url: string) => dict([['type', 'image_url'], ['image_url', dict([['url', url]])]])
  const parts: HostList = [text(IMAGE_NOTE)]
  for (const group of groups) {
    parts.push(text((group.toolCallId !== undefined ? 'Tool call ' + group.toolCallId : 'Tool call') + ':'))
    for (const hp of group.parts) parts.push(hp.isImage ? image(hp.value) : text(hp.value))
  }
  messages.push(dict([['role', 'user'], ['content', parts]]))
}

/** The wire role of a system / user message: `developerRole` moves system
 *  text to the `developer` role. */
function chatRole(role: string, compat: CodecCompat | undefined): string {
  return role === 'system' && compat?.developerRole === true ? 'developer' : role
}

/** `OpenAiProvider::TranslateMessages` (openai_provider.cc:511). */
export function translateChatMessages(prompt: HostList, compat?: CodecCompat): HostList {
  const messages: HostList = []
  for (const msgValue of prompt) {
    if (!isHostDict(msgValue)) continue
    const role = findString(msgValue, 'role')
    if (role === undefined) continue
    const contentParts = findList(msgValue, 'content')
    if (!contentParts) continue

    if (role === 'tool') {
      appendChatCompletionToolMessages(contentParts, messages)
      continue
    }

    if (role === 'assistant') {
      // Only text and tool-call parts survive; texts join with '\n'.
      let textContent = ''
      const toolCalls: HostList = []
      const reasoningDetails: HostList = []
      let replayedText: string | undefined
      let hasToolCalls = false
      for (const partValue of contentParts) {
        if (!isHostDict(partValue)) continue
        const pt = findString(partValue, 'type')
        if (pt === undefined) continue
        if (pt === 'tool-call') {
          hasToolCalls = true
          const tc = dict([['type', 'function']])
          const id = findString(partValue, 'toolCallId')
          if (id !== undefined) tc.set('id', id)
          const fn: HostDict = new Map()
          const name = findString(partValue, 'toolName')
          if (name !== undefined) fn.set('name', name)
          const args = findDict(partValue, 'args')
          // A non-object `args` (array, string, null) is sent as "{}"
          // (openai_provider.cc:559-565).
          fn.set('arguments', args ? writeHostJson(args) : '{}')
          tc.set('function', fn)
          toolCalls.push(tc)
        } else if (pt === 'text') {
          const t = findString(partValue, 'text')
          if (t !== undefined) {
            if (textContent) textContent += '\n'
            textContent += t
          }
        } else if (pt === REASONING_REPLAY_PART_TYPE) {
          // Only ever present when the host matched it to this provider +
          // model (hostCallOptions decodeReasoningReplaySignatureFor).
          // Several parts would mean several reasoning blocks in one turn;
          // their arrays concatenate.
          const field = findString(partValue, 'field')
          const replay = compat?.reasoningReplay
          if (replay === undefined) {
            const value = findList(partValue, 'value')
            if (field === 'reasoning_details' && value) reasoningDetails.push(...value)
          } else if (replay !== 'none' && field === replay) {
            // The switch names ONE field; text made for another is not sent.
            const text = partValue.get('value')
            if (typeof text === 'string' && text) replayedText = (replayedText ?? '') + text
          }
        }
      }
      const assistant = dict([['role', 'assistant']])
      if (reasoningDetails.length > 0) assistant.set('reasoning_details', reasoningDetails)
      if (replayedText !== undefined && compat?.reasoningReplay && compat.reasoningReplay !== 'none') {
        assistant.set(compat.reasoningReplay, replayedText)
      }
      if (textContent) assistant.set('content', textContent)
      else if (!hasToolCalls) assistant.set('content', '')
      if (hasToolCalls) assistant.set('tool_calls', toolCalls)
      messages.push(assistant)
      continue
    }

    // system / user
    const hasImages = contentParts.some(p => isHostDict(p) && findString(p, 'type') === 'image')
    if (hasImages) {
      const content: HostList = []
      for (const partValue of contentParts) {
        if (!isHostDict(partValue)) continue
        const pt = findString(partValue, 'type')
        if (pt === 'text') {
          const t = findString(partValue, 'text')
          if (t !== undefined) content.push(dict([['type', 'text'], ['text', t]]))
        } else if (pt === 'image') {
          const imageUrl: HostDict = new Map()
          const url = imageUrlForPart(partValue)
          if (url !== undefined) imageUrl.set('url', url)
          content.push(dict([['type', 'image_url'], ['image_url', imageUrl]]))
        } else if (pt === 'document') {
          content.push(
            dict([['type', 'text'], ['text', documentUnavailableMarker(findString(partValue, 'mimeType'))]]),
          )
        }
      }
      messages.push(dict([['role', chatRole(role, compat)], ['content', content]]))
    } else {
      // Text-only: one string. A tool-result part in a mixed user message is
      // silently dropped here (C++ does the same).
      let combined = ''
      for (const partValue of contentParts) {
        if (!isHostDict(partValue)) continue
        const pt = findString(partValue, 'type')
        if (pt === 'text') {
          const t = findString(partValue, 'text')
          if (t !== undefined) {
            if (combined) combined += '\n'
            combined += t
          }
        } else if (pt === 'document') {
          if (combined) combined += '\n'
          combined += documentUnavailableMarker(findString(partValue, 'mimeType'))
        }
      }
      messages.push(dict([['role', chatRole(role, compat)], ['content', combined]]))
    }
  }
  return messages
}

/** `OpenAiProvider::TranslateToolDefinition` (openai_provider.cc:670). */
export function translateChatToolDefinition(tool: HostDict): HostDict {
  const fn: HostDict = new Map()
  const name = findString(tool, 'name')
  if (name !== undefined) fn.set('name', name)
  const description = findString(tool, 'description')
  if (description !== undefined) fn.set('description', description)
  const parameters = findDict(tool, 'parameters')
  if (parameters) fn.set('parameters', parameters)
  const strict = findBool(tool, 'strict')
  if (strict !== undefined) fn.set('strict', strict)
  return dict([['type', 'function'], ['function', fn]])
}

/** `OpenAiProvider::BuildRequestBody(call_options, stream=true)`
 *  (openai_provider.cc:409). */
export function buildChatCompletionsBody(callOptions: HostDict, compat?: CodecCompat): HostDict {
  const body: HostDict = new Map()
  // ResolveModel: modelId, else the provider's configured model (the host's
  // state — here the caller always supplies the resolved model).
  body.set('model', findString(callOptions, 'modelId') || '')

  const prompt = findList(callOptions, 'prompt')
  if (prompt) body.set('messages', translateChatMessages(prompt, compat))

  body.set('stream', true)
  body.set('stream_options', dict([['include_usage', true]]))

  const mode = findDict(callOptions, 'mode')
  if (mode) {
    const type = findString(mode, 'type')
    if (type === 'regular') {
      const tools = findList(mode, 'tools')
      if (tools) {
        const openaiTools: HostList = []
        for (const tool of tools) if (isHostDict(tool)) openaiTools.push(translateChatToolDefinition(tool))
        if (openaiTools.length > 0) body.set('tools', openaiTools)
      }
      const tc = findDict(mode, 'toolChoice')
      const tcType = tc ? findString(tc, 'type') : undefined
      if (tc && tcType !== undefined) {
        if (tcType === 'auto' || tcType === 'none' || tcType === 'required') {
          body.set('tool_choice', tcType)
        } else if (tcType === 'tool') {
          const toolName = findString(tc, 'toolName')
          if (toolName !== undefined) {
            body.set('tool_choice', dict([['type', 'function'], ['function', dict([['name', toolName]])]]))
          }
        }
      }
    } else if (type === 'object-json') {
      const schema = findDict(mode, 'schema')
      body.set(
        'response_format',
        schema
          ? dict([
              ['type', 'json_schema'],
              ['json_schema', dict([['name', 'response'], ['strict', true], ['schema', schema]])],
            ])
          : dict([['type', 'json_object']]),
      )
    }
  }

  const maxTokens = findInt(callOptions, 'maxTokens')
  if (maxTokens !== undefined) body.set(compat?.maxTokensField ?? 'max_completion_tokens', new HostInt(maxTokens))
  // temperature / topP / stopSequences / penalties / seed: BuildRequestBody
  // reads them, but the host's BuildCallOptions never sets them, so they
  // reach the wire only through providerBodyExtension.

  // Merged last so the TS-built fields override base params (a flat, top-
  // level overwrite — never a deep merge).
  const ext = findDict(callOptions, 'providerBodyExtension')
  if (ext) {
    for (const [key, value] of sortedEntries(ext)) {
      if (compat?.reasoningEffortField === false && (key === 'reasoning_effort' || key === 'reasoning')) continue
      body.set(key, value)
    }
  }
  return body
}

// ── Response ──────────────────────────────────────────────────────────────

/** `NormalizeChatCompletionUsage` (openai_usage.cc): the cached subset is
 *  split out of prompt_tokens (FindInt: a double count reads as 0). */
export function normalizeChatCompletionUsage(usage: HostDict): HostDict {
  const prompt = findInt(usage, 'prompt_tokens') ?? 0
  const out: HostDict = new Map()
  out.set('completionTokens', new HostInt(findInt(usage, 'completion_tokens') ?? 0))
  const details = findDict(usage, 'prompt_tokens_details')
  const cached = details ? (findInt(details, 'cached_tokens') ?? 0) : 0
  if (cached > 0) out.set('promptCacheHits', new HostInt(cached))
  out.set('promptTokens', new HostInt(prompt > cached ? prompt - cached : 0))
  return out
}

/** `ExtractChatCompletionReasoningText` (openai_reasoning.cc): first
 *  non-empty of reasoning_content / reasoning / reasoning_details. */
export function extractChatCompletionReasoningText(delta: HostDict): string {
  for (const key of ['reasoning_content', 'reasoning']) {
    const text = findString(delta, key)
    if (text) return text
  }
  const details = findList(delta, 'reasoning_details')
  if (!details) return ''
  let out = ''
  for (const detail of details) {
    if (!isHostDict(detail)) continue
    const type = findString(detail, 'type')
    let text: string | undefined
    if (type === 'reasoning.text') text = findString(detail, 'text')
    else if (type === 'reasoning.summary') text = findString(detail, 'summary')
    if (text !== undefined) out += text
  }
  return out
}

const APPENDABLE_DETAIL_KEYS: ReadonlySet<string> = new Set(['text', 'summary', 'data'])

/**
 * `ChatCompletionReasoningDetailsAccumulator` (openai_reasoning.cc): rebuilds
 * the complete `reasoning_details` array of one response from its streamed
 * fragments, for replay on the next request's assistant message. Fragments
 * merge by their int `index` (arrival order when absent); for an index seen
 * before, string `text` / `summary` / `data` append and every other key takes
 * the latest value that is neither `""` nor null.
 */
export class ChatCompletionReasoningDetailsAccumulator {
  private readonly details = new Map<number, HostDict>()
  private nextImplicitIndex = 0

  /** Folds in the `reasoning_details` of one streaming `delta`. A chunk
   *  without the key is a no-op. */
  add(delta: HostDict): void {
    const details = findList(delta, 'reasoning_details')
    if (!details) return
    for (const fragment of details) {
      if (!isHostDict(fragment)) continue
      const index = findInt(fragment, 'index') ?? this.nextImplicitIndex
      this.nextImplicitIndex = Math.max(this.nextImplicitIndex, index + 1)
      let merged = this.details.get(index)
      if (!merged) {
        merged = new Map()
        this.details.set(index, merged)
      }
      for (const [key, value] of sortedEntries(fragment)) {
        if (APPENDABLE_DETAIL_KEYS.has(key) && typeof value === 'string') {
          const existing = findString(merged, key)
          merged.set(key, (existing ?? '') + value)
          continue
        }
        if (value === '' || value === null) continue
        merged.set(key, value)
      }
    }
  }

  get empty(): boolean {
    return this.details.size === 0
  }

  /** The merged array in index order; leaves the accumulator empty. */
  take(): HostList {
    const out: HostList = [...this.details.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d)
    this.details.clear()
    this.nextImplicitIndex = 0
    return out
  }
}

/** `UsageFromProviderDict` (nexus_llm_host.cc:939): FindInt, 0 default. */
function hostUsage(usage: HostDict | undefined): DriverUsage {
  return {
    promptTokens: (usage && findInt(usage, 'promptTokens')) ?? 0,
    completionTokens: (usage && findInt(usage, 'completionTokens')) ?? 0,
    promptCacheHits: (usage && findInt(usage, 'promptCacheHits')) ?? 0,
    promptCacheWrites: (usage && findInt(usage, 'promptCacheWrites')) ?? 0,
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

class ChatCompletionsDecoder implements DriverResponseDecoder {
  private lineBuffer: Uint8Array = new Uint8Array(0)
  private rawChunks: Uint8Array[] = []
  // ignoreBOM: C++ keeps a U+FEFF byte sequence in the line, so a BOM before
  // `data:` fails `starts_with("data:")`; one after `data: ` is dropped by
  // the JSON reader (parseHostJson).
  private readonly lineDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  // openai_provider.cc StreamContext
  private readonly toolCallIds = new Map<number, string>()
  private readonly reasoningDetails = new ChatCompletionReasoningDetailsAccumulator()
  // The reasoning TEXT of the response, for `compat.reasoningReplay` modes
  // that replay it as a plain string field.
  private reasoningText = ''
  private get replaysText(): boolean {
    const replay = this.context.compat?.reasoningReplay
    return replay === 'reasoning_content' || replay === 'reasoning'
  }
  private pendingFinishReason: string | undefined
  private pendingUsage: HostDict | undefined
  private finishEmitted = false
  // nexus_llm_host.cc StreamState
  private readonly toolCalls = new HostToolCallTracker()
  private terminal = false

  constructor(private readonly context: DriverRequestContext) {}

  push(bytes: Uint8Array): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    this.rawChunks.push(bytes)
    // LineSplitter::Feed — split on '\n' over BYTES, strip one trailing
    // '\r'. Bytes (not text) so a UTF-8 sequence or CRLF split across reads
    // is reassembled before decoding.
    const buffer = concatBytes(this.lineBuffer, bytes)
    let pos = 0
    for (;;) {
      const nl = buffer.indexOf(0x0a, pos)
      if (nl < 0) break
      let end = nl
      if (end > pos && buffer[end - 1] === 0x0d) end--
      this.processLine(buffer.subarray(pos, end), events)
      pos = nl + 1
    }
    this.lineBuffer = buffer.slice(pos)
    return events
  }

  end(): DriverStreamEvent[] {
    // The C++ never drains the splitter (no DrainRemaining on this path): a
    // final line without '\n' is dropped.
    const events = this.flushBufferedFinish()
    // An error body on a 2xx response (e.g. `data: {"error":{...}}`) —
    // surfaced only when no finish was produced. The status is the response's
    // own (2xx), so the canonical text reads "HTTP 200: <message>".
    // Only read when it can matter: re-decoding and re-parsing the whole
    // retained body after a finish would be thrown away (as ResponsesDecoder.end).
    const apiError = this.finishEmitted ? '' : extractApiErrorMessage(this.rawText())
    if (apiError) {
      this.emitError(buildProviderErrorMessage(200, '', apiError), events)
    } else if (!this.terminal) {
      // OnStreamDone(no error) without a finish: kUnknown, zero usage.
      this.emitFinish(undefined, undefined, events)
    }
    return events
  }

  /**
   * The buffered finish is flushed BEFORE the failure check, so a response that sent
   * `finish_reason` and then lost its connection ends the turn normally. Returns []
   * when nothing was buffered: the caller's error then ends the stream.
   */
  abort(): DriverStreamEvent[] {
    return this.flushBufferedFinish()
  }

  /** OnStreamComplete: flush a buffered finish (usage may never arrive). */
  private flushBufferedFinish(): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    if (!this.finishEmitted && this.pendingFinishReason !== undefined) {
      this.finishEmitted = true
      this.emitFinish(this.pendingFinishReason, this.pendingUsage, events)
      this.pendingUsage = undefined
    }
    return events
  }

  private rawText(): string {
    const total = new Uint8Array(this.rawChunks.reduce((n, c) => n + c.length, 0))
    let offset = 0
    for (const chunk of this.rawChunks) {
      total.set(chunk, offset)
      offset += chunk.length
    }
    // `raw_response` keeps a leading BOM (the JSON reader drops it; a line
    // scan does not match `data:` behind it).
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(total)
    } catch {
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(total)
    }
  }

  /** `ProcessSseLine` chat-completions branch (openai_provider.cc:1792). */
  private processLine(bytes: Uint8Array, events: DriverStreamEvent[]): void {
    let line: string
    try {
      line = this.lineDecoder.decode(bytes)
    } catch {
      return // invalid UTF-8: JSONReader rejects the payload
    }
    if (!line || line[0] === ':') return
    if (!line.startsWith('data:')) return
    let payload = line.slice(5)
    if (payload.startsWith(' ')) payload = payload.slice(1)
    if (payload === '[DONE]') return
    const parsed = parseHostJsonDict(payload)
    if (!parsed) return

    // DIVERGENCE (P-4, "Deliberate differences"): a gateway
    // (OpenRouter, the Vercel AI Gateway) reports a failure that happens after
    // the stream began as a data chunk with a top-level `error` — plus, on
    // OpenRouter, a choice with `finish_reason: "error"`. C++ reads only the
    // choice and ends the turn with no message; the user sees a reply that
    // simply stops. Surface the gateway's error instead: a numeric `code` in
    // the HTTP range is the upstream status, which drives retry.
    const streamError = findDict(parsed, 'error')
    if (streamError) {
      const message = extractApiErrorMessage(payload) || 'Stream error'
      const code = findInt(streamError, 'code')
      const status = code !== undefined && code >= 400 && code <= 599 ? code : 200
      this.emitError(buildProviderErrorMessage(status, '', message), events)
      return
    }

    const choices = findList(parsed, 'choices')
    if (!choices || choices.length === 0) {
      const usage = findDict(parsed, 'usage')
      if (usage) {
        this.pendingUsage = normalizeChatCompletionUsage(usage)
        this.maybeEmitFinish(events)
      }
      return
    }
    const first = choices[0]
    if (!isHostDict(first)) return

    const delta = findDict(first, 'delta')
    if (delta) {
      // Reasoning before text on the same chunk.
      const thought = extractChatCompletionReasoningText(delta)
      if (thought) {
        events.push({ type: 'reasoning_delta', text: thought })
        if (this.replaysText) this.reasoningText += thought
      }
      this.reasoningDetails.add(delta)
      const content = findString(delta, 'content')
      if (content) events.push({ type: 'text_delta', text: content })
      const toolCalls = findList(delta, 'tool_calls')
      if (toolCalls) {
        for (const tc of toolCalls) if (isHostDict(tc)) this.toolCallDelta(tc, events)
      }
    }

    const fr = findString(first, 'finish_reason')
    if (fr) {
      // The reasoning is complete once the choice finishes; hand it over
      // before the finish so it lands on the open message
      // (openai_provider.cc:1920-1930). The host wraps it into a replay
      // envelope carried as a signature (nexus_llm_host.cc:2041-2055).
      const replay = this.context.compat?.reasoningReplay
      const text = this.reasoningText
      this.reasoningText = ''
      if (replay === 'none') {
        this.reasoningDetails.take()
      } else if (replay !== undefined) {
        // One plain-text field, named by the switch; the structured details
        // are not sent in this mode.
        this.reasoningDetails.take()
        if (text) {
          const part: HostDict = dict([
            ['type', REASONING_REPLAY_PART_TYPE],
            ['field', replay],
            ['value', text],
          ])
          const signature = encodeReasoningReplaySignature(this.context.providerId, this.context.model, part)
          if (signature !== undefined) events.push({ type: 'reasoning_signature', signature })
        }
      } else if (!this.reasoningDetails.empty) {
        const part: HostDict = dict([
          ['type', REASONING_REPLAY_PART_TYPE],
          ['field', 'reasoning_details'],
          ['value', this.reasoningDetails.take()],
        ])
        const signature = encodeReasoningReplaySignature(this.context.providerId, this.context.model, part)
        if (signature !== undefined) events.push({ type: 'reasoning_signature', signature })
      }
      this.pendingFinishReason = fr
      // Usage on the same chunk (providers without split usage/finish).
      if (!this.pendingUsage) {
        const usage = findDict(parsed, 'usage')
        if (usage) this.pendingUsage = normalizeChatCompletionUsage(usage)
      }
      this.maybeEmitFinish(events)
    }
  }

  /** `TranslateChatCompletionToolCallDelta` + the host's
   *  tool-call-streaming-start / tool-call-delta branches. */
  private toolCallDelta(toolCall: HostDict, events: DriverStreamEvent[]): void {
    const index = findInt(toolCall, 'index') ?? 0
    const fn = findDict(toolCall, 'function')
    // Open once per index, only for a NON-EMPTY id (DashScope repeats the
    // object with id "" on every delta).
    const id = findString(toolCall, 'id')
    // DIVERGENCE (P-4, "Deliberate differences"): a NEW
    // non-empty id at an index already open is another call — Gemini's
    // OpenAI-compatible stream reports every parallel call at index 0. C++
    // keeps the first id and appends the next call's arguments to it, which
    // corrupts both. The index now names the latest call; a repeated id (or
    // DashScope's "") still continues the open one.
    if (id && this.toolCallIds.get(index) !== id) {
      this.toolCallIds.set(index, id)
      const name = fn ? findString(fn, 'name') : undefined
      events.push(this.toolCalls.streamingStart(id, name))
    }
    const args = fn ? findString(fn, 'arguments') : undefined
    if (args) {
      // No correlated id → the host gives the delta a fresh random id.
      events.push(this.toolCalls.delta(this.toolCallIds.get(index), undefined, args))
    }
  }

  private maybeEmitFinish(events: DriverStreamEvent[]): void {
    if (this.finishEmitted || this.pendingFinishReason === undefined || !this.pendingUsage) return
    this.finishEmitted = true
    this.emitFinish(this.pendingFinishReason, this.pendingUsage, events)
    this.pendingUsage = undefined
  }

  /** Host `finish` branch (and `OnStreamDone` without an error):
   *  `FlushPendingToolCalls`, then `QueueFinishEvent` — one terminal only;
   *  usage defaults to zeros. */
  private emitFinish(reason: string | undefined, usage: HostDict | undefined, events: DriverStreamEvent[]): void {
    if (this.terminal) return
    this.terminal = true
    events.push(...this.toolCalls.flush())
    events.push({
      type: 'finish',
      finishReason: reason ? parseFinishReasonString(reason) : 'unknown',
      usage: hostUsage(usage),
    })
  }

  private emitError(message: string, events: DriverStreamEvent[]): void {
    if (this.terminal) return
    this.terminal = true
    events.push(hostErrorEvent(message))
  }
}

function headerValue(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return ''
}

export const openaiChatDriver: ProviderDriver = {
  // openai_provider.cc OnStreamComplete: only a status >= 400 is an HTTP
  // error; anything below is decoded as the stream.
  isStreamStatus: status => status < 400,
  id: 'openai-chat',
  // Where this wire carries ids (idSites.ts): the id mapper's input.
  idSites: chatIdSites,
  auth: { headers: { authorization: 'Bearer {{secret:api_key}}' } },

  buildRequest(payload: BridgeModelRequestPayload, context: DriverRequestContext): DriverHttpRequest {
    const callOptions = buildHostCallOptions(buildHostRequest(payload), context.model, context.providerId)
    const body = buildChatCompletionsBody(callOptions, context.compat)
    return {
      // StartStream: plain concatenation, no slash normalization.
      url: context.baseUrl + '/chat/completions',
      method: 'POST',
      headers: {
        authorization: 'Bearer {{secret:api_key}}',
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(writeHostJson(body)),
    }
  },

  createDecoder(context: DriverRequestContext): DriverResponseDecoder {
    return new ChatCompletionsDecoder(context)
  },

  errorFromResponse(response) {
    // OnStreamComplete, http_status >= 400.
    const message = buildProviderErrorMessage(
      response.status,
      headerValue(response.headers, 'Retry-After'),
      extractApiErrorMessage(response.bodyText),
    )
    return hostErrorEvent(message)
  },
}
