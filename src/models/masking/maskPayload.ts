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
 * is `text/*` (other documents are left whole). Never masked:
 * `requestContext`, `model`, `providerId`. The egress guard catches what is
 * left.
 */
import type {
  BridgeModelContentPart,
  BridgeModelInputMessage,
  BridgeModelRequestPayload,
  BridgeModelToolDefinition,
} from '../../browser/bridge/browserBridgeProtocol'
import type { CompiledMasking, MaskingHit } from './maskingRules'

export type MaskingWhere = 'messages' | 'system' | 'tools' | 'extension'

/** What one payload's masking did, for the log. */
export class MaskingTally {
  /** where -> rule -> count */
  readonly hits = new Map<string, Map<number, number>>()
  readonly collisions = new Set<string>()
  /** Present when the log asks for context around each hit. */
  readonly contexts: Array<{ rule: number; where: string; context: string }> | undefined

  constructor(withContext: boolean) {
    this.contexts = withContext ? [] : undefined
  }

  count(where: string, rule: number): void {
    const byRule = this.hits.get(where) ?? new Map<number, number>()
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
    this.hits.set(where, byRule)
  }

  get total(): number {
    let sum = 0
    for (const byRule of this.hits.values()) for (const n of byRule.values()) sum += n
    return sum
  }
}

/** Context entries kept per payload, so a huge transcript cannot flood the log. */
const MAX_CONTEXTS = 64
const CONTEXT_CHARS = 24

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
    return UTF8_DECODER.decode(bytes)
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

/** Masks strings for one payload and records what it did. */
export class PayloadMasker {
  constructor(
    private readonly masking: CompiledMasking,
    readonly tally: MaskingTally,
  ) {}

  text(value: string, where: string): string {
    const tally = this.tally
    const hits: MaskingHit[] = []
    const masked = this.masking.maskText(value, hit => {
      tally.count(where, hit.rule)
      if (tally.contexts) hits.push(hit)
    })
    if (masked.collision) tally.collisions.add(where)
    if (tally.contexts && hits.length > 0) this.recordContexts(masked.text, hits, where)
    return masked.text
  }

  /** Context around each hit, cut from the masked text: neighbouring
   *  matches appear as their aliases, never in clear. */
  private recordContexts(masked: string, hits: readonly MaskingHit[], where: string): void {
    const contexts = this.tally.contexts!
    let shift = 0
    for (const hit of hits) {
      const alias = this.masking.rules[hit.rule]!.alias
      const start = hit.start + shift
      const end = start + alias.length
      shift += alias.length - (hit.end - hit.start)
      if (contexts.length >= MAX_CONTEXTS) continue
      const before = masked.slice(Math.max(0, start - CONTEXT_CHARS), start)
      const after = masked.slice(end, end + CONTEXT_CHARS)
      contexts.push({ rule: hit.rule, where, context: `${before}⟦${alias}⟧${after}`.replace(/[\r\n|]/g, ' ') })
    }
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
    for (const [key, item] of Object.entries(value)) {
      const nextKey = this.text(key, where)
      const next = keep?.has(key) ? item : this.deep(item, where)
      if (nextKey !== key || next !== item) changed = true
      out[nextKey] = next
    }
    return changed ? out : value
  }

  /** A `text/*` document is masked inside its base64; any other is left whole. */
  private document(value: Record<string, unknown>, where: string): Record<string, unknown> {
    if (!mediaTypeOf(value).startsWith('text/')) return value
    let out: Record<string, unknown> | undefined
    for (const field of ['data', 'document'] as const) {
      const data = value[field]
      if (typeof data !== 'string') continue
      const text = decodeBase64Text(data)
      if (text === undefined) continue
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
