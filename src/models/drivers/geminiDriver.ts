/**
 * Gemini `streamGenerateContent` driver: the bridge payload as a Generative
 * Language API request, and its SSE stream as driver events (P-4).
 *
 * Contract: thought signatures are carried across turns in a reasoning replay
 * envelope bound to provider + model; tool schemas go out as
 * `parametersJsonSchema`; the key rides the `x-goog-api-key` header.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import {
  REASONING_REPLAY_PART_TYPE,
  buildHostCallOptions,
  buildHostRequest,
  buildProviderErrorMessage,
  encodeReasoningReplaySignature,
  extractApiErrorMessage,
  hostErrorEvent,
} from './hostCallOptions'
import {
  HostDouble,
  HostInt,
  findBool,
  findDict,
  findDouble,
  findInt,
  findList,
  findString,
  hostValueToJs,
  isHostDict,
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
  ProviderDriver,
} from './driverTypes'
import { geminiIdSites } from './idSites'

/** The replay envelope field holding one model message's thought signatures. */
export const GEMINI_SIGNATURES_FIELD = 'thoughtSignatures'

/**
 * The value Gemini accepts in place of a thought signature it did not issue
 * (history written by another model). Gemini 3+ rejects a function call
 * without any signature.
 */
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator'

/** Gemini finish reasons that mean the call itself was faulty (a malformed
 *  or unexpected call, a missing thought signature), shown as an error. */
const REQUEST_FAULT_FINISH_REASONS = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
  'MALFORMED_RESPONSE',
])

/** Gemini finish reasons that mean the reply was withheld for policy. */
const POLICY_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
])

// ── Request translation ───────────────────────────────────────────────────

function dict(entries: Array<[string, HostValue]>): HostDict {
  return new Map(entries)
}

function textPart(text: string): HostDict {
  return dict([['text', text]])
}

function inlineDataPart(mimeType: string, data: string): HostDict {
  return dict([
    [
      'inlineData',
      dict([
        ['mimeType', mimeType],
        ['data', data],
      ]),
    ],
  ])
}

function isRemoteUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

/** A user image (`image`: base64 bytes) or document (`data`) as inlineData;
 *  a remote image URL has no inline form and is skipped. */
function mediaPart(part: HostDict): HostDict | undefined {
  const type = findString(part, 'type')
  if (type === 'image') {
    const data = findString(part, 'image') ?? findString(part, 'data')
    if (!data || isRemoteUrl(data)) return undefined
    return inlineDataPart(findString(part, 'mimeType') ?? 'image/png', data)
  }
  if (type === 'document') {
    const data = findString(part, 'data')
    if (!data) return undefined
    return inlineDataPart(findString(part, 'mimeType') ?? 'application/pdf', data)
  }
  return undefined
}

/** User text (empty text is not sent), images and documents. */
function translateUserContentParts(parts: HostList): HostList {
  const out: HostList = []
  for (const partValue of parts) {
    if (!isHostDict(partValue)) continue
    if (findString(partValue, 'type') === 'text') {
      const text = findString(partValue, 'text')
      if (text) out.push(textPart(text))
      continue
    }
    const media = mediaPart(partValue)
    if (media) out.push(media)
  }
  return out
}

type SignatureRecord = { calls: Map<number, string>; text?: string }

/** The signatures a replay part carries: `{call: n, signature}` entries for the
 *  n-th function call, `{text: true, signature}` for the closing text part. */
function readSignatureRecord(parts: HostList): SignatureRecord | undefined {
  for (const partValue of parts) {
    if (!isHostDict(partValue)) continue
    if (findString(partValue, 'type') !== REASONING_REPLAY_PART_TYPE) continue
    if (findString(partValue, 'field') !== GEMINI_SIGNATURES_FIELD) continue
    const entries = findList(partValue, 'value')
    if (!entries) continue
    const record: SignatureRecord = { calls: new Map() }
    for (const entry of entries) {
      if (!isHostDict(entry)) continue
      const signature = findString(entry, 'signature')
      if (!signature) continue
      const call = findInt(entry, 'call')
      if (call !== undefined) record.calls.set(call, signature)
      else if (findBool(entry, 'text') === true) record.text = signature
    }
    return record
  }
  return undefined
}

/** Gemini 3 and later validate thought signatures on function calls. */
export function requiresThoughtSignatures(model: string): boolean {
  const match = /^(?:models\/)?gemini-(\d+)/.exec(model)
  return match !== null && Number(match[1]) >= 3
}

/** Model text (non-empty) and function calls, each with the thought signature
 *  Gemini issued for it. */
function translateAssistantContentParts(parts: HostList, model: string): HostList {
  const signatures = readSignatureRecord(parts)
  const out: HostList = []
  let callOrdinal = 0
  let lastText: HostDict | undefined
  for (const partValue of parts) {
    if (!isHostDict(partValue)) continue
    const type = findString(partValue, 'type')
    if (type === 'text') {
      const text = findString(partValue, 'text')
      if (text) {
        lastText = textPart(text)
        out.push(lastText)
      }
    } else if (type === 'tool-call') {
      const toolName = findString(partValue, 'toolName')
      if (toolName === undefined) continue
      const functionCall = dict([['name', toolName]])
      // Args: a dict, or a JSON string holding one; any other shape sends none.
      const argsString = findString(partValue, 'args')
      if (argsString !== undefined) {
        const parsed = parseHostJsonDict(argsString)
        if (parsed) functionCall.set('args', parsed)
      }
      const argsDict = findDict(partValue, 'args')
      if (argsDict) functionCall.set('args', argsDict)
      const part = dict([['functionCall', functionCall]])
      let signature = signatures?.calls.get(callOrdinal)
      if (signature === undefined && callOrdinal === 0 && !signatures && requiresThoughtSignatures(model)) {
        signature = GEMINI_SKIP_SIGNATURE
      }
      if (signature !== undefined) part.set('thoughtSignature', signature)
      out.push(part)
      callOrdinal += 1
    }
  }
  if (signatures?.text !== undefined && lastText) lastText.set('thoughtSignature', signatures.text)
  return out
}

/** The text a tool result carries once its media parts are lifted out. */
function toolResultContent(result: HostValue): HostValue {
  if (!Array.isArray(result)) return result
  const rest = result.filter(item => {
    if (!isHostDict(item)) return true
    const type = findString(item, 'type')
    return type !== 'image' && type !== 'document'
  })
  const texts: string[] = []
  for (const item of rest) {
    if (!isHostDict(item) || findString(item, 'type') !== 'text') return rest
    texts.push(findString(item, 'text') ?? '')
  }
  return texts.join('\n')
}

/** One functionResponse per named tool result (`output`, or `error` for a
 *  failed call), then an inlineData part per image / document it returned.
 *  A result without a toolName is dropped. */
function translateToolResultParts(parts: HostList): HostList {
  const out: HostList = []
  for (const partValue of parts) {
    if (!isHostDict(partValue)) continue
    if (findString(partValue, 'type') !== 'tool-result') continue
    const toolName = findString(partValue, 'toolName')
    if (toolName === undefined) continue

    const response: HostDict = new Map()
    const result = partValue.get('result')
    if (result !== undefined) {
      response.set(findBool(partValue, 'isError') === true ? 'error' : 'output', toolResultContent(result))
    }
    out.push(
      dict([
        [
          'functionResponse',
          dict([
            ['name', toolName],
            ['response', response],
          ]),
        ],
      ]),
    )

    for (const rpValue of findList(partValue, 'result') ?? []) {
      if (!isHostDict(rpValue)) continue
      const media = mediaPart(rpValue)
      if (media) out.push(media)
    }
  }
  return out
}

/** Consecutive turns of the same Gemini role are merged into one. */
function appendPartsToLastMessage(contents: HostDict[], role: string, parts: HostList): void {
  const last = contents[contents.length - 1]
  if (last && findString(last, 'role') === role) {
    const previous = findList(last, 'parts')
    if (previous) {
      previous.push(...parts)
      return
    }
  }
  contents.push(
    dict([
      ['role', role],
      ['parts', parts],
    ]),
  )
}

/** Host normalization writes an empty text part as the two characters `""`.
 *  Beside other parts it carries nothing and is dropped; alone it is kept so
 *  the turn is not lost. */
function withoutEmptyTextMarkers(parts: HostList): HostList {
  const kept = parts.filter(
    part => !(isHostDict(part) && part.size === 1 && findString(part, 'text') === '""'),
  )
  return kept.length > 0 ? kept : parts
}

/** system → systemInstruction parts; assistant → model, tool → user. */
function translateMessages(
  messages: HostList,
  model: string,
): { contents: HostDict[]; systemParts: HostList } {
  const contents: HostDict[] = []
  const systemParts: HostList = []
  for (const msgValue of messages) {
    if (!isHostDict(msgValue)) continue
    const role = findString(msgValue, 'role')
    if (role === undefined) continue

    if (role === 'system') {
      const text = findString(msgValue, 'content')
      if (text) systemParts.push(textPart(text))
      for (const cp of findList(msgValue, 'content') ?? []) {
        if (!isHostDict(cp)) continue
        const cpText = findString(cp, 'text')
        if (findString(cp, 'type') === 'text' && cpText) systemParts.push(textPart(cpText))
      }
      continue
    }

    const googleRole = role === 'assistant' ? 'model' : role === 'tool' ? 'user' : role
    let parts: HostList = []
    const textContent = findString(msgValue, 'content')
    if (textContent) parts.push(textPart(textContent))
    const contentParts = findList(msgValue, 'content')
    if (contentParts) {
      if (role === 'tool') parts = translateToolResultParts(contentParts)
      else if (role === 'assistant') parts = translateAssistantContentParts(contentParts, model)
      else parts = translateUserContentParts(contentParts)
    }
    parts = withoutEmptyTextMarkers(parts)
    if (parts.length === 0) continue
    appendPartsToLastMessage(contents, googleRole, parts)
  }
  return { contents, systemParts }
}

/** Function declarations; the tool's JSON Schema goes out as
 *  `parametersJsonSchema`, which takes full JSON Schema. */
function buildFunctionDeclarations(tools: HostList): HostList {
  const declarations: HostList = []
  for (const toolValue of tools) {
    if (!isHostDict(toolValue)) continue
    const name = findString(toolValue, 'name')
    if (!name) continue
    const declaration = dict([['name', name]])
    const description = findString(toolValue, 'description')
    if (description !== undefined) declaration.set('description', description)
    const parameters = findDict(toolValue, 'parameters')
    if (parameters) declaration.set('parametersJsonSchema', parameters)
    declarations.push(declaration)
  }
  return declarations
}

/** tool_choice → `toolConfig.functionCallingConfig`. */
function buildToolConfig(toolChoice: HostValue): HostDict {
  const callingConfig: HostDict = new Map()
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') callingConfig.set('mode', 'AUTO')
    else if (toolChoice === 'none') callingConfig.set('mode', 'NONE')
    else if (toolChoice === 'required') callingConfig.set('mode', 'ANY')
  } else if (isHostDict(toolChoice)) {
    callingConfig.set('mode', 'ANY')
    const fn = findDict(toolChoice, 'function')
    const name = fn ? findString(fn, 'name') : undefined
    if (name !== undefined) callingConfig.set('allowedFunctionNames', [name])
  }
  return dict([['functionCallingConfig', callingConfig]])
}

/** The request body over the host's call options. */
export function buildGoogleRequestBody(callOptions: HostDict, model = ''): HostDict {
  const body: HostDict = new Map()

  const messages = findList(callOptions, 'messages')
  if (messages) {
    const { contents, systemParts } = translateMessages(messages, model)
    if (systemParts.length > 0) body.set('systemInstruction', dict([['parts', systemParts]]))
    if (contents.length > 0) body.set('contents', contents)
  }

  const tools = findList(callOptions, 'tools')
  if (tools && tools.length > 0) {
    const declarations = buildFunctionDeclarations(tools)
    if (declarations.length > 0) {
      body.set('tools', [dict([['functionDeclarations', declarations]])])
    }
    const toolChoice = callOptions.get('tool_choice')
    if (toolChoice !== undefined) body.set('toolConfig', buildToolConfig(toolChoice))
  }

  // Thought summaries always stream, so the reasoning shows.
  const generationConfig: HostDict = dict([['thinkingConfig', dict([['includeThoughts', true]])]])
  const maxTokens = findInt(callOptions, 'max_tokens')
  if (maxTokens !== undefined) generationConfig.set('maxOutputTokens', new HostInt(maxTokens))
  const temperature = findDouble(callOptions, 'temperature')
  if (temperature !== undefined) generationConfig.set('temperature', new HostDouble(temperature))
  const topP = findDouble(callOptions, 'top_p')
  if (topP !== undefined) generationConfig.set('topP', new HostDouble(topP))
  const topK = findInt(callOptions, 'top_k')
  if (topK !== undefined) generationConfig.set('topK', new HostInt(topK))
  const stop = findList(callOptions, 'stop')
  if (stop && stop.length > 0) generationConfig.set('stopSequences', stop)
  body.set('generationConfig', generationConfig)

  // providerBodyExtension: top-level keys replace, except `generationConfig`
  // (and its `thinkingConfig`), which merge into the fields set above.
  const extension = findDict(callOptions, 'providerBodyExtension')
  if (extension) {
    for (const [key, value] of extension) {
      if (key === 'generationConfig' && isHostDict(value)) mergeGenerationConfig(generationConfig, value)
      else body.set(key, value)
    }
  }
  return body
}

function mergeGenerationConfig(target: HostDict, extension: HostDict): void {
  for (const [key, value] of extension) {
    const current = target.get(key)
    if (key === 'thinkingConfig' && isHostDict(value) && isHostDict(current)) {
      for (const [k, v] of value) current.set(k, v)
    } else {
      target.set(key, value)
    }
  }
}

/** The request body for a bridge payload (host normalization + provider). */
export function buildGeminiRequestBody(payload: BridgeModelRequestPayload, model: string, providerId?: string): HostDict {
  return buildGoogleRequestBody(buildHostCallOptions(buildHostRequest(payload), model, providerId), model)
}

/** The streaming endpoint: one trailing '/' dropped, model id appended raw. */
export function buildGeminiStreamUrl(baseUrl: string, model: string): string {
  const apiBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${apiBase}/models/${model}:streamGenerateContent?alt=sse`
}

// ── Response decoding ─────────────────────────────────────────────────────

const LF = 0x0a
const CR = 0x0d
const DATA_SPACE_PREFIX = new TextEncoder().encode('data: ')
const DATA_PREFIX = new TextEncoder().encode('data:')
const DONE = new TextEncoder().encode('[DONE]')

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false
  return true
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && startsWithBytes(a, b)
}

/** A Gemini finishReason in the driver's vocabulary. */
export function mapGeminiFinishReason(reason: string): DriverFinishReason {
  if (!reason) return 'unknown'
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  if (POLICY_FINISH_REASONS.has(reason)) return 'content_filter'
  if (REQUEST_FAULT_FINISH_REASONS.has(reason)) return 'error'
  return 'other'
}

type DecoderIdentity = { providerId: string; model: string }

class GeminiSseDecoder implements DriverResponseDecoder {
  private buffer = new Uint8Array(0)
  private scanFrom = 0
  private lastFinishReason = ''
  private blockReason = ''
  private promptTokens = 0
  private completionTokens = 0
  private thoughtsTokens = 0
  private cachedContentTokens = 0
  private callOrdinal = 0
  private readonly callSignatures: Array<[number, string]> = []
  private textSignature: string | undefined
  private failed = false
  private ended = false
  private readonly strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

  constructor(
    private readonly newToolCallId: () => string,
    private readonly identity: DecoderIdentity | undefined,
  ) {}

  push(bytes: Uint8Array): DriverStreamEvent[] {
    if (this.ended || this.failed || bytes.length === 0) return []
    const merged = new Uint8Array(this.buffer.length + bytes.length)
    merged.set(this.buffer)
    merged.set(bytes, this.buffer.length)
    this.buffer = merged
    return this.processBuffer()
  }

  /** Parses what is buffered (a trailing line without '\n' is not parsed),
   *  then the signature envelope and the finish with the last finishReason
   *  and usage. */
  end(): DriverStreamEvent[] {
    if (this.ended || this.failed) return []
    const events = this.processBuffer()
    this.ended = true
    this.buffer = new Uint8Array(0)
    if (this.failed) return events
    const signature = this.signatureEnvelope()
    if (signature !== undefined) events.push({ type: 'reasoning_signature', signature })
    const blocked = this.blockReason !== ''
    events.push({
      type: 'finish',
      finishReason: blocked ? 'content_filter' : mapGeminiFinishReason(this.lastFinishReason),
      usage: {
        // promptTokenCount includes the cached tokens; usage reports input
        // exclusive of cache.
        promptTokens:
          this.promptTokens > this.cachedContentTokens
            ? this.promptTokens - this.cachedContentTokens
            : 0,
        completionTokens: this.completionTokens + this.thoughtsTokens,
        promptCacheHits: this.cachedContentTokens,
      },
      ...(blocked
        ? { stopDetails: { type: 'prompt_blocked', category: this.blockReason } }
        : POLICY_FINISH_REASONS.has(this.lastFinishReason)
          ? { stopDetails: { type: 'response_blocked', category: this.lastFinishReason } }
          : {}),
    })
    return events
  }

  private signatureEnvelope(): string | undefined {
    if (!this.identity) return undefined
    const entries: HostList = this.callSignatures.map(([call, signature]) =>
      dict([
        ['call', new HostInt(call)],
        ['signature', signature],
      ]),
    )
    if (this.textSignature !== undefined) {
      entries.push(
        dict([
          ['text', true],
          ['signature', this.textSignature],
        ]),
      )
    }
    if (entries.length === 0) return undefined
    return encodeReasoningReplaySignature(
      this.identity.providerId,
      this.identity.model,
      dict([
        ['type', REASONING_REPLAY_PART_TYPE],
        ['field', GEMINI_SIGNATURES_FIELD],
        ['value', entries],
      ]),
    )
  }

  /** One payload per '\n'-terminated line; a trailing '\r' is stripped;
   *  `data: ` / `data:` prefixes; `[DONE]` skipped. */
  private processBuffer(): DriverStreamEvent[] {
    const events: DriverStreamEvent[] = []
    while (!this.failed) {
      const pos = this.buffer.indexOf(LF, this.scanFrom)
      if (pos === -1) {
        this.scanFrom = this.buffer.length
        break
      }
      let line = this.buffer.subarray(0, pos)
      this.buffer = this.buffer.slice(pos + 1)
      this.scanFrom = 0
      if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1)
      if (line.length === 0) continue
      let data: Uint8Array
      if (startsWithBytes(line, DATA_SPACE_PREFIX)) data = line.subarray(DATA_SPACE_PREFIX.length)
      else if (startsWithBytes(line, DATA_PREFIX)) data = line.subarray(DATA_PREFIX.length)
      else continue
      if (equalBytes(data, DONE)) continue
      this.processSsePayload(data, events)
    }
    return events
  }

  private processSsePayload(bytes: Uint8Array, events: DriverStreamEvent[]): void {
    let text: string
    try {
      text = this.strictUtf8.decode(bytes)
    } catch {
      return
    }
    const parsed = parseHostJsonDict(text)
    if (!parsed) return

    // An in-stream error object ends the stream as a provider error.
    const error = findDict(parsed, 'error')
    if (error) {
      const status = findInt(error, 'code') ?? 0
      events.push(hostErrorEvent(buildProviderErrorMessage(status, '', extractApiErrorMessage(text))))
      this.failed = true
      return
    }

    const usage = findDict(parsed, 'usageMetadata')
    if (usage) {
      const prompt = findInt(usage, 'promptTokenCount')
      if (prompt !== undefined) this.promptTokens = prompt
      const candidatesTokens = findInt(usage, 'candidatesTokenCount')
      if (candidatesTokens !== undefined) this.completionTokens = candidatesTokens
      const thoughts = findInt(usage, 'thoughtsTokenCount')
      if (thoughts !== undefined) this.thoughtsTokens = thoughts
      const cached = findInt(usage, 'cachedContentTokenCount')
      if (cached !== undefined) this.cachedContentTokens = cached
    }

    const feedback = findDict(parsed, 'promptFeedback')
    const blockReason = feedback ? findString(feedback, 'blockReason') : undefined
    if (blockReason) this.blockReason = blockReason

    const candidates = findList(parsed, 'candidates')
    if (!candidates || candidates.length === 0) return
    const candidate = candidates[0]
    if (!isHostDict(candidate)) return
    const content = findDict(candidate, 'content')
    const parts = content ? findList(content, 'parts') : undefined
    if (parts) this.emitStreamParts(parts, events)
    const finishReason = findString(candidate, 'finishReason')
    if (finishReason !== undefined) this.lastFinishReason = finishReason
  }

  /** A thought part with text is reasoning only; any other part may yield
   *  text and a function call. Signatures are kept for the next turn: per
   *  function call by ordinal, and the last one seen on a non-call part. */
  private emitStreamParts(parts: HostList, events: DriverStreamEvent[]): void {
    for (const partValue of parts) {
      if (!isHostDict(partValue)) continue
      const isThought = findBool(partValue, 'thought') === true
      const text = findString(partValue, 'text')
      const signature = findString(partValue, 'thoughtSignature')
      if (isThought && text) {
        events.push({ type: 'reasoning_delta', text })
        continue
      }
      if (text) events.push({ type: 'text_delta', text })
      const functionCall = findDict(partValue, 'functionCall')
      if (functionCall) {
        if (signature) this.callSignatures.push([this.callOrdinal, signature])
        this.callOrdinal += 1
        const name = findString(functionCall, 'name')
        const args = findDict(functionCall, 'args')
        events.push({
          type: 'tool_call',
          id: this.newToolCallId(),
          name: name ? name : undefined,
          input: args ? hostValueToJs(args) : {},
        })
      } else if (signature) {
        this.textSignature = signature
      }
    }
  }
}

/** The decoder with an injectable tool-call id source (tests); without an
 *  identity no signature envelope is emitted. */
export function createGeminiDecoder(
  newToolCallId: () => string = () => globalThis.crypto.randomUUID(),
  identity?: DecoderIdentity,
): DriverResponseDecoder {
  return new GeminiSseDecoder(newToolCallId, identity)
}

function findHeader(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return ''
}

// ── Driver ────────────────────────────────────────────────────────────────

export const geminiDriver: ProviderDriver = {
  id: 'gemini',
  idSites: geminiIdSites,
  // Security: the key goes in a header, not the URL, so it stays out of
  // proxy and server access logs.
  auth: { headers: { 'x-goog-api-key': '{{secret:api_key}}' } },
  buildRequest(payload, context) {
    // Codec switches (`context.compat`): none applies to this wire.
    const body = buildGeminiRequestBody(payload, context.model, context.providerId)
    return {
      url: buildGeminiStreamUrl(context.baseUrl, context.model),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': '{{secret:api_key}}',
      },
      body: new TextEncoder().encode(writeHostJson(body)),
    }
  },
  createDecoder(context: DriverRequestContext) {
    return createGeminiDecoder(undefined, { providerId: context.providerId, model: context.model })
  },
  errorFromResponse(response) {
    return hostErrorEvent(
      buildProviderErrorMessage(
        response.status,
        findHeader(response.headers, 'Retry-After'),
        extractApiErrorMessage(response.bodyText),
      ),
    )
  },
}
