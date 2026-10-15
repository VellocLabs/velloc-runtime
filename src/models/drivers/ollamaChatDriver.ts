/**
 * Ollama (`POST {base}/v1/chat/completions`): the JS twin of the C++ `OllamaProvider`
 * from the host's `call_options`. Not the `openai-chat` codec: the bytes differ (no
 * Authorization, `max_tokens`, no tool `strict`, NDJSON lines accepted). A non-2xx
 * reports BuildProviderErrorMessage, and images are read as openai-chat does (P-4).
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import {
  buildHostCallOptions,
  buildHostRequest,
  buildProviderErrorMessage,
  extractApiErrorMessage,
  hostErrorEvent,
  HostToolCallTracker,
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
  findString,
  isHostDict,
  parseHostJsonDict,
  sortedEntries,
  writeHostJson,
} from './hostValue'
import {
  appendChatCompletionToolMessages,
  documentUnavailableMarker,
  extractChatCompletionReasoningText,
  imageUrlForPart,
  normalizeChatCompletionUsage,
} from './openaiChatDriver'
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

/** `OllamaProvider::TranslateToolDefinition`: no `strict`. */
export function translateOllamaToolDefinition(tool: HostDict): HostDict {
  const fn: HostDict = new Map()
  const name = findString(tool, 'name')
  if (name !== undefined) fn.set('name', name)
  const description = findString(tool, 'description')
  if (description !== undefined) fn.set('description', description)
  const parameters = findDict(tool, 'parameters')
  if (parameters) fn.set('parameters', parameters)
  return dict([['type', 'function'], ['function', fn]])
}

/** `OllamaProvider::TranslateMessages`. */
export function translateOllamaMessages(prompt: HostList): HostList {
  const messages: HostList = []
  for (const msgValue of prompt) {
    if (!isHostDict(msgValue)) continue
    const role = findString(msgValue, 'role')
    if (role === undefined) continue
    const message = dict([['role', role]])
    const contentList = findList(msgValue, 'content')
    if (!contentList) {
      const contentString = findString(msgValue, 'content')
      if (contentString !== undefined) message.set('content', contentString)
      messages.push(message)
      continue
    }

    if (role === 'tool') {
      appendChatCompletionToolMessages(contentList, messages)
      continue
    }

    if (role === 'assistant') {
      let textContent = ''
      const toolCalls: HostList = []
      for (const partValue of contentList) {
        if (!isHostDict(partValue)) continue
        const type = findString(partValue, 'type')
        if (type === 'text') {
          const text = findString(partValue, 'text')
          if (text !== undefined) textContent += text
        } else if (type === 'tool-call') {
          const call: HostDict = new Map()
          const id = findString(partValue, 'toolCallId')
          if (id !== undefined) call.set('id', id)
          call.set('type', 'function')
          const fn: HostDict = new Map()
          const name = findString(partValue, 'toolName')
          if (name !== undefined) fn.set('name', name)
          // `part.Find("args")` — any type, written by JSONWriter.
          const args = partValue.get('args')
          if (args !== undefined) fn.set('arguments', writeHostJson(args))
          call.set('function', fn)
          toolCalls.push(call)
        }
      }
      if (textContent) message.set('content', textContent)
      if (toolCalls.length > 0) message.set('tool_calls', toolCalls)
      messages.push(message)
      continue
    }

    // User / system messages: check for images.
    const hasImage = contentList.some(p => isHostDict(p) && findString(p, 'type') === 'image')
    if (hasImage) {
      const parts: HostList = []
      for (const partValue of contentList) {
        if (!isHostDict(partValue)) continue
        const type = findString(partValue, 'type')
        if (type === 'text') {
          const textPart = dict([['type', 'text']])
          const text = findString(partValue, 'text')
          if (text !== undefined) textPart.set('text', text)
          parts.push(textPart)
        } else if (type === 'image') {
          // The host's image part carries its bytes under `image` (a URL or
          // a data URI passes through), as openai-chat reads it.
          const imageUrl: HostDict = new Map()
          const url = imageUrlForPart(partValue)
          if (url !== undefined) imageUrl.set('url', url)
          parts.push(dict([['type', 'image_url'], ['image_url', imageUrl]]))
        } else if (type === 'document') {
          parts.push(dict([['type', 'text'], ['text', documentUnavailableMarker(findString(partValue, 'mimeType'))]]))
        }
      }
      message.set('content', parts)
    } else {
      let textContent = ''
      for (const partValue of contentList) {
        if (!isHostDict(partValue)) continue
        if (findString(partValue, 'type') === 'document') {
          // No document part on this wire: say so rather than drop it.
          textContent += documentUnavailableMarker(findString(partValue, 'mimeType'))
          continue
        }
        const text = findString(partValue, 'text')
        if (text !== undefined) textContent += text
      }
      message.set('content', textContent)
    }
    messages.push(message)
  }
  return messages
}

/** `OllamaProvider::BuildRequestBody(call_options, stream=true)`. */
export function buildOllamaChatBody(callOptions: HostDict): HostDict {
  const body: HostDict = new Map()
  // ResolveModel: `model`, else the configured model (the host's state —
  // here the caller always supplies the resolved model).
  body.set('model', findString(callOptions, 'model') || '')
  body.set('stream', true)
  body.set('stream_options', dict([['include_usage', true]]))

  const prompt = findList(callOptions, 'prompt')
  if (prompt) body.set('messages', translateOllamaMessages(prompt))

  const maxTokens = findInt(callOptions, 'maxTokens')
  if (maxTokens !== undefined) body.set('max_tokens', new HostInt(maxTokens))
  // temperature / topP / stopSequences / seed: read by BuildRequestBody, but
  // the host's BuildCallOptions never sets them (as on openai-chat).

  const mode = findDict(callOptions, 'mode')
  if (mode) {
    if (findString(mode, 'type') === 'object-json') {
      body.set('response_format', dict([['type', 'json_object']]))
    }
    const tools = findList(mode, 'tools')
    if (tools) {
      const ollamaTools: HostList = []
      for (const tool of tools) if (isHostDict(tool)) ollamaTools.push(translateOllamaToolDefinition(tool))
      body.set('tools', ollamaTools)
    }
    const toolChoiceString = findString(mode, 'toolChoice')
    if (toolChoiceString !== undefined) {
      body.set('tool_choice', toolChoiceString)
    } else {
      // The host's `{type: "auto"}` goes out as the object.
      const toolChoiceDict = findDict(mode, 'toolChoice')
      if (toolChoiceDict) body.set('tool_choice', toolChoiceDict)
    }
  }

  // Merged last so the TS-built fields override base params.
  const ext = findDict(callOptions, 'providerBodyExtension')
  if (ext) for (const [key, value] of sortedEntries(ext)) body.set(key, value)
  return body
}

// ── Response ──────────────────────────────────────────────────────────────

/** `UsageFromProviderDict` (nexus_llm_host.cc): FindInt, 0 default. */
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

class OllamaChatDecoder implements DriverResponseDecoder {
  private lineBuffer: Uint8Array = new Uint8Array(0)
  // ignoreBOM: C++ keeps a U+FEFF byte sequence in the line (a BOM before
  // `data:` makes the line unparseable JSON); the JSON reader drops one at
  // the start of a payload (parseHostJson).
  private readonly lineDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  // ollama_provider.h StreamContext
  private readonly toolCallIds = new Map<number, string>()
  private pendingFinishReason: string | undefined
  private pendingUsage: HostDict | undefined
  private finishEmitted = false
  // nexus_llm_host.cc StreamState
  private readonly toolCalls = new HostToolCallTracker()
  private terminal = false

  push(bytes: Uint8Array): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    // LineSplitter::Feed — split on '\n' over BYTES, strip one trailing '\r'.
    const buffer = concatBytes(this.lineBuffer, bytes)
    let pos = 0
    for (;;) {
      const nl = buffer.indexOf(0x0a, pos)
      if (nl < 0) break
      let end = nl
      if (end > pos && buffer[end - 1] === 0x0d) end--
      if (end > pos) this.processLine(buffer.subarray(pos, end), events)
      pos = nl + 1
    }
    this.lineBuffer = buffer.slice(pos)
    return events
  }

  /** `OnStreamComplete(success=true)`, then the host's `OnStreamDone`. */
  end(): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    // DrainRemaining: NDJSON may close without a trailing newline — the
    // final line is a regular record (one trailing '\r' dropped).
    let tail = this.lineBuffer
    this.lineBuffer = new Uint8Array(0)
    if (tail.length > 0 && tail[tail.length - 1] === 0x0d) tail = tail.subarray(0, tail.length - 1)
    if (tail.length > 0) this.processLine(tail, events)
    if (!this.finishEmitted && this.pendingFinishReason !== undefined) {
      this.finishEmitted = true
      this.emitFinish(this.pendingFinishReason, this.pendingUsage, events)
      this.pendingUsage = undefined
    }
    // OnStreamDone(no error) without a finish: kUnknown, zero usage.
    if (!this.terminal) this.emitFinish(undefined, undefined, events)
    return events
  }

  /**
   * `OnStreamComplete(success=false)` returns the error BEFORE any flush: a
   * buffered finish is lost and the transport error ends the stream.
   */
  abort(): DriverStreamEvent[] {
    return []
  }

  /** `ProcessNdjsonLine`: SSE framing tolerated, bare JSON lines read too. */
  private processLine(bytes: Uint8Array, events: DriverStreamEvent[]): void {
    let payload: string
    try {
      payload = this.lineDecoder.decode(bytes)
    } catch {
      return // invalid UTF-8: JSONReader rejects the payload
    }
    if (!payload || payload[0] === ':') return
    if (payload.startsWith('event:')) return
    if (payload.startsWith('data:')) {
      payload = payload.slice(5)
      // `data:` with and without the space — every leading space goes.
      let i = 0
      while (i < payload.length && payload[i] === ' ') i++
      payload = payload.slice(i)
      if (payload === '[DONE]') return
    }
    const parsed = parseHostJsonDict(payload)
    if (!parsed) return
    this.emitStreamEvents(parsed, events)
  }

  /** `EmitStreamEvents` + the host's chunk branches. */
  private emitStreamEvents(chunk: HostDict, events: DriverStreamEvent[]): void {
    const choices = findList(chunk, 'choices')
    // Usage-only chunk (stream_options.include_usage).
    if (!choices || choices.length === 0) {
      const usage = findDict(chunk, 'usage')
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
      const thought = extractChatCompletionReasoningText(delta)
      if (thought) events.push({ type: 'reasoning_delta', text: thought })
      const content = findString(delta, 'content')
      if (content) events.push({ type: 'text_delta', text: content })
      const toolCalls = findList(delta, 'tool_calls')
      if (toolCalls) {
        for (const tc of toolCalls) {
          if (!isHostDict(tc)) continue
          const index = findInt(tc, 'index') ?? 0
          const fn = findDict(tc, 'function')
          // Every delta with a non-empty id opens (or, for a repeated id,
          // resets) its call — the host's tool-call-streaming-start.
          const id = findString(tc, 'id')
          if (id) {
            this.toolCallIds.set(index, id)
            events.push(this.toolCalls.streamingStart(id, fn ? findString(fn, 'name') : undefined))
          }
          const args = fn ? findString(fn, 'arguments') : undefined
          if (args) {
            // No id seen at this index → the host gives the delta a fresh id.
            events.push(this.toolCalls.delta(this.toolCallIds.get(index), undefined, args))
          }
        }
      }
    }

    const finishReason = findString(first, 'finish_reason')
    if (finishReason) {
      this.pendingFinishReason = finishReason
      if (!this.pendingUsage) {
        const usage = findDict(chunk, 'usage')
        if (usage) this.pendingUsage = normalizeChatCompletionUsage(usage)
      }
      this.maybeEmitFinish(events)
    }
  }

  /** `MaybeEmitFinish`: only once both the reason and the usage are known. */
  private maybeEmitFinish(events: DriverStreamEvent[]): void {
    if (this.finishEmitted || this.pendingFinishReason === undefined || !this.pendingUsage) return
    this.finishEmitted = true
    this.emitFinish(this.pendingFinishReason, this.pendingUsage, events)
    this.pendingUsage = undefined
  }

  /** Host `finish` branch (and `OnStreamDone` without an error):
   *  `FlushPendingToolCalls`, then `QueueFinishEvent` — one terminal only. */
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
}

function headerValue(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return ''
}

export const ollamaChatDriver: ProviderDriver = {
  id: 'ollama-chat',
  // Where this wire carries ids (idSites.ts): the id mapper's input.
  idSites: chatIdSites,
  // Keyless: the host class sends no credential at all.
  auth: {},

  buildRequest(payload: BridgeModelRequestPayload, context: DriverRequestContext): DriverHttpRequest {
    // Codec switches (`context.compat`): none is read here. The native chat
    // API takes `num_predict` and a `think` flag, so all four switches are
    // ignored.
    const callOptions = buildHostCallOptions(buildHostRequest(payload), context.model, context.providerId)
    const body = buildOllamaChatBody(callOptions)
    return {
      // DoStream: StrCat, no slash normalization.
      url: context.baseUrl + '/v1/chat/completions',
      method: 'POST',
      // Content-Type and the host-applied User-Agent; no Authorization.
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(writeHostJson(body)),
    }
  },

  createDecoder(_context: DriverRequestContext): DriverResponseDecoder {
    return new OllamaChatDecoder()
  },

  errorFromResponse(response) {
    // DIVERGENCE (see file header): C++ ends the stream with "Stream error.
    // Is Ollama running at <base>?"; this is the canonical provider-error text.
    return hostErrorEvent(
      buildProviderErrorMessage(
        response.status,
        headerValue(response.headers, 'Retry-After'),
        extractApiErrorMessage(response.bodyText),
      ),
    )
  },
}
