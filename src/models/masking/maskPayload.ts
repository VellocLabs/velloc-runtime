/**
 * Contract: Outbound half of model egress masking (F-39): a copy of a model
 * request payload with every rule's `match` replaced by its alias in the text
 * the provider will read. The input payload is never mutated; parts of it that
 * hold no hit are shared with the copy. Masked: message content (text, tool
 * calls and their arguments, tool results, thinking text), the system prompt,
 * the user / system context values, tool definitions (name, description and
 * every string in the schema and examples), the body extension and the
 * tool-use context. Never masked: object keys, `requestContext`, `model`,
 * `providerId`, and opaque or binary fields (image and document data, redacted
 * thinking, signatures). The egress guard catches what is left.
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

function contextOf(text: string, hit: MaskingHit, alias: string): string {
  const before = text.slice(Math.max(0, hit.start - CONTEXT_CHARS), hit.start)
  const after = text.slice(hit.end, hit.end + CONTEXT_CHARS)
  return `${before}⟦${alias}⟧${after}`.replace(/[\r\n|]/g, ' ')
}

/** Masks strings for one payload and records what it did. */
export class PayloadMasker {
  constructor(
    private readonly masking: CompiledMasking,
    readonly tally: MaskingTally,
  ) {}

  text(value: string, where: string): string {
    const tally = this.tally
    const masked = this.masking.maskText(value, hit => {
      tally.count(where, hit.rule)
      if (tally.contexts && tally.contexts.length < MAX_CONTEXTS) {
        tally.contexts.push({ rule: hit.rule, where, context: contextOf(value, hit, this.masking.rules[hit.rule]!.alias) })
      }
    })
    if (masked.collision) tally.collisions.add(where)
    return masked.text
  }

  /** Every string value under `value`, keys excluded. */
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
    if (value && typeof value === 'object') {
      let out: Record<string, unknown> | undefined
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (OPAQUE_FIELDS.has(key)) continue
        const next = this.deep(item, where)
        if (next !== item) {
          out ??= { ...(value as Record<string, unknown>) }
          out[key] = next
        }
      }
      return (out ?? value) as T
    }
    return value
  }
}

/** Fields that hold bytes or provider-signed data, never prose. */
const OPAQUE_FIELDS: ReadonlySet<string> = new Set([
  'signature',
  'data',
  'image',
  'document',
  'encrypted_content',
  'encryptedContent',
])

/** Part types whose payload is opaque as a whole. */
const OPAQUE_PARTS: ReadonlySet<string> = new Set(['image', 'document', 'redacted_thinking'])

function maskContent(
  masker: PayloadMasker,
  content: string | BridgeModelContentPart[] | undefined,
): string | BridgeModelContentPart[] | undefined {
  if (typeof content === 'string') return masker.text(content, 'messages')
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map(part => {
    if (!part || typeof part !== 'object' || OPAQUE_PARTS.has(String(part.type))) return part
    const next = masker.deep(part, 'messages')
    if (next !== part) changed = true
    return next
  })
  return changed ? out : content
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
