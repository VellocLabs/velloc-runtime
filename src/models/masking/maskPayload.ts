/**
 * Contract: Outbound half of model egress masking (F-39): a copy of a model
 * request payload with every rule's `match` replaced by its alias in the text
 * the provider will read. The input payload is never mutated; parts of it that
 * hold no hit are shared with the copy. Masked: message content (text, tool
 * calls and their arguments, tool results, thinking text), the system prompt,
 * the user / system context values, tool definitions (name, description and
 * every string and object key in the schema and examples), the body extension
 * and the tool-use context. Object keys are masked like values. A part is
 * judged by its `type` wherever it sits (a tool result's content too): an
 * image and redacted thinking are left whole, a thinking part's `signature`
 * is left as is, and a document is masked after decoding when its media type
 * is `text/*` (other documents, PDF included, are sent whole). Never masked:
 * `requestContext`, `model`, `providerId`. The egress guard catches what is
 * left.
 *
 * Security: refused rather than sent (nothing is masked or sent): two object
 * keys that would mask to the same key (`MaskingResidualError`), and a
 * `text/*` document whose `data` / `document` field is not a base64 string of
 * UTF-8 text without NUL characters (`MaskingUndecodableError`); the guard
 * cannot see inside base64.
 */
import type {
  BridgeModelContentPart,
  BridgeModelInputMessage,
  BridgeModelRequestPayload,
  BridgeModelToolDefinition,
} from '../../browser/bridge/browserBridgeProtocol'
import type { CompiledMasking, MaskingHit } from './maskingRules'
import { MaskingResidualError, MaskingUndecodableError } from './egressGuard'
import { traceEntries, type ReplacementEntry } from './replacementTrace'

export type MaskingWhere = 'messages' | 'system' | 'tools' | 'extension'

/** Part types whose payload is opaque as a whole. */
const OPAQUE_PARTS: ReadonlySet<string> = new Set(['image', 'redacted_thinking'])
/** Fields of a part, by part type, that hold provider-signed or binary data. */
const OPAQUE_PART_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  thinking: new Set(['signature']),
  reasoning: new Set(['signature', 'encrypted_content', 'encryptedContent']),
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const UTF8_ENCODER = new TextEncoder()

function decodeBase64Text(data: string): string | undefined {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const text = UTF8_DECODER.decode(bytes)
    // NUL bytes mean UTF-16/32 or binary: a keyword there would not match.
    return text.includes('\u0000') ? undefined : text
  } catch {
    return undefined
  }
}

function encodeBase64Text(text: string): string {
  const bytes = UTF8_ENCODER.encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function mediaTypeOf(part: Record<string, unknown>): string {
  const value = part.mimeType ?? part.mime_type ?? part.media_type ?? part.mediaType
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/** Masks strings for one payload and adds one `entries` item per replacement. */
export class PayloadMasker {
  constructor(
    private readonly masking: CompiledMasking,
    readonly entries: ReplacementEntry[],
  ) {}

  text(value: string, where: string): string {
    const hits: MaskingHit[] = []
    const masked = this.masking.maskText(value, hit => hits.push(hit), false).text
    if (hits.length > 0) traceEntries('out', where, value, masked, hits, this.entries)
    return masked
  }

  /** Every string value and object key under `value`; parts by their type. */
  deep<T>(value: T, where: string): T {
    if (typeof value === 'string') return this.text(value, where) as T
    if (Array.isArray(value)) {
      let changed = false
      const out = value.map(item => {
        const next = this.deep(item, where)
        if (next !== item) changed = true
        return next
      })
      return (changed ? out : value) as T
    }
    if (value && typeof value === 'object') return this.object(value as Record<string, unknown>, where) as T
    return value
  }

  private object(value: Record<string, unknown>, where: string): Record<string, unknown> {
    const type = typeof value.type === 'string' ? value.type : undefined
    if (type !== undefined && OPAQUE_PARTS.has(type)) return value
    if (type === 'document') return this.document(value, where)
    const keep = type !== undefined ? OPAQUE_PART_FIELDS[type] : undefined
    let changed = false
    const out: Record<string, unknown> = {}
    const sourceKey = new Map<string, string>()
    for (const [key, item] of Object.entries(value)) {
      const nextKey = this.text(key, where)
      const next = keep?.has(key) ? item : this.deep(item, where)
      if (nextKey !== key || next !== item) changed = true
      // Two keys that mask to one would merge and lose a value: refuse.
      const earlier = sourceKey.get(nextKey)
      if (earlier !== undefined) {
        const rule = this.masking.residualIn(key) ?? this.masking.residualIn(earlier) ?? 0
        throw new MaskingResidualError({ where, rule })
      }
      sourceKey.set(nextKey, key)
      out[nextKey] = next
    }
    return changed ? out : value
  }

  /** A `text/*` document is masked inside its base64; any other is left whole.
   *  Throws `MaskingUndecodableError` when its data is not base64 UTF-8 text. */
  private document(value: Record<string, unknown>, where: string): Record<string, unknown> {
    if (!mediaTypeOf(value).startsWith('text/')) return value
    let out: Record<string, unknown> | undefined
    for (const field of ['data', 'document'] as const) {
      if (!(field in value) || value[field] === undefined) continue
      const data = value[field]
      const text = typeof data === 'string' ? decodeBase64Text(data) : undefined
      if (text === undefined) throw new MaskingUndecodableError(where)
      const masked = this.text(text, where)
      if (masked !== text) {
        out ??= { ...value }
        out[field] = encodeBase64Text(masked)
      }
    }
    return out ?? value
  }
}

function maskContent(
  masker: PayloadMasker,
  content: string | BridgeModelContentPart[] | undefined,
): string | BridgeModelContentPart[] | undefined {
  if (typeof content === 'string') return masker.text(content, 'messages')
  if (!Array.isArray(content)) return content
  return masker.deep(content, 'messages')
}

function maskMessage(masker: PayloadMasker, message: BridgeModelInputMessage): BridgeModelInputMessage {
  let out: BridgeModelInputMessage | undefined
  if (message.content !== undefined) {
    const content = maskContent(masker, message.content)
    if (content !== message.content) out = { ...message, content }
  }
  if (message.message && message.message.content !== undefined) {
    const content = maskContent(masker, message.message.content)
    if (content !== message.message.content) {
      out = { ...(out ?? message), message: { ...message.message, content } }
    }
  }
  return out ?? message
}

function maskTool(masker: PayloadMasker, tool: BridgeModelToolDefinition): BridgeModelToolDefinition {
  const { type: _type, strict: _strict, ...prose } = tool
  const masked = masker.deep(prose, 'tools')
  return masked === prose ? tool : { ...tool, ...masked }
}

/** `payload` with the rules applied; `payload` itself is unchanged. */
export function maskPayload(
  payload: BridgeModelRequestPayload,
  masker: PayloadMasker,
): BridgeModelRequestPayload {
  const out: BridgeModelRequestPayload = { ...payload }
  out.messages = payload.messages.map(message => maskMessage(masker, message))
  if (payload.systemPrompt !== undefined) out.systemPrompt = masker.deep(payload.systemPrompt, 'system')
  if (payload.userContext) out.userContext = masker.deep(payload.userContext, 'system')
  if (payload.systemContext) out.systemContext = masker.deep(payload.systemContext, 'system')
  if (payload.tools) out.tools = payload.tools.map(tool => maskTool(masker, tool))
  if (payload.providerBodyExtension) out.providerBodyExtension = masker.deep(payload.providerBodyExtension, 'extension')
  if (payload.toolUseContext) out.toolUseContext = masker.deep(payload.toolUseContext, 'extension')
  return out
}
