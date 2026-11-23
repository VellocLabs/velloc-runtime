/**
 * Contract: the images and documents of a routed request (F-27). A router's
 * row takes images when any member does, so a request built for the row may
 * carry media its target cannot read. Here the request's media is counted,
 * a target's support is read, and a request is rewritten for a target without
 * it: each such part becomes its text placeholder, top-level or inside a tool
 * result. The rewrite copies; the payload a call's retries share is never
 * changed.
 *
 * A target whose support is not stated is sent the media. When it refuses the
 * request for that media, the refusal is remembered for the life of the
 * runtime and later requests to it are rewritten from their first send.
 */
import type { BridgeModelInputMessage } from '../../browser/bridge/browserBridgeProtocol'
import { omitMediaPart, type OmittedMedia } from '../../runtime/mediaPlaceholders'
import {
  LEGACY_PART_TOOL_RESULT,
  PART_DOCUMENT,
  PART_IMAGE,
  PART_TOOL_RESULT_CANONICAL,
} from '../../runtime/VercelModelConstants'
import type { FailureEvent } from './providerClassify'
import { mergedModels, runtimeProviderConfigs } from './runtimeProviders'

/** The kinds of media a request carries, or a target is to be spared. */
export type MediaKinds = { images: boolean; documents: boolean }

const NONE: MediaKinds = { images: false, documents: false }

type Part = Record<string, unknown>

const isRecord = (value: unknown): value is Part => typeof value === 'object' && value !== null

const isToolResult = (part: Part): boolean =>
  part.type === PART_TOOL_RESULT_CANONICAL || part.type === LEGACY_PART_TOOL_RESULT

/** The items of a tool result part that may be media parts. */
function resultItems(part: Part): { key: 'result' | 'content'; items: unknown[] } | undefined {
  if (Array.isArray(part.result)) return { key: 'result', items: part.result }
  if (Array.isArray(part.content)) return { key: 'content', items: part.content }
  return undefined
}

/** Where a message keeps its parts: on itself or on its nested message. */
function contentOf(message: BridgeModelInputMessage): unknown {
  const nested = message.message as { content?: unknown } | undefined
  return isRecord(nested) && nested.content !== undefined ? nested.content : message.content
}

function note(kinds: MediaKinds, part: unknown): void {
  if (!isRecord(part)) return
  if (part.type === PART_IMAGE) kinds.images = true
  else if (part.type === PART_DOCUMENT) kinds.documents = true
}

/** The kinds of media among the request's messages. */
export function mediaIn(messages: readonly BridgeModelInputMessage[] | undefined): MediaKinds {
  const kinds: MediaKinds = { ...NONE }
  for (const message of messages ?? []) {
    const content = contentOf(message)
    if (!Array.isArray(content)) continue
    for (const part of content) {
      note(kinds, part)
      if (isRecord(part) && isToolResult(part)) {
        for (const item of resultItems(part)?.items ?? []) note(kinds, item)
      }
    }
    if (kinds.images && kinds.documents) break
  }
  return kinds
}

function partWithout(part: unknown, omit: OmittedMedia): unknown {
  if (!isRecord(part)) return part
  if (!isToolResult(part)) return omitMediaPart(part, omit)
  const held = resultItems(part)
  if (!held) return part
  const items = held.items.map(item => omitMediaPart(item, omit))
  return items.some((item, at) => item !== held.items[at]) ? { ...part, [held.key]: items } : part
}

/**
 * `messages` with every part of the kinds in `omit` as its placeholder. A
 * message without such a part is the same object; with none at all, the same
 * array.
 */
export function withoutMedia(
  messages: readonly BridgeModelInputMessage[],
  omit: MediaKinds,
): BridgeModelInputMessage[] {
  if (!omit.images && !omit.documents) return messages as BridgeModelInputMessage[]
  let changed = false
  const out = messages.map(message => {
    const content = contentOf(message)
    if (!Array.isArray(content)) return message
    const parts = content.map(part => partWithout(part, omit))
    if (parts.every((part, at) => part === content[at])) return message
    changed = true
    const nested = message.message as Part | undefined
    return (isRecord(nested) && nested.content !== undefined
      ? { ...message, message: { ...nested, content: parts } }
      : { ...message, content: parts }) as BridgeModelInputMessage
  })
  return changed ? out : (messages as BridgeModelInputMessage[])
}

// ── a target's support ──────────────────────────────────────────────────────

/** What a target states about media input; an absent field is not stated. */
export type MediaSupport = { images?: boolean; documents?: boolean }

const refused = new Map<string, MediaKinds>()

const keyOf = (provider: string, model: string): string => JSON.stringify([provider, model])

/**
 * What the target's row states, the same reading the peers table gives a
 * router: its listed row, else a custom provider's own model.
 */
export function statedMediaSupport(provider: string, model: string): MediaSupport {
  const listed = mergedModels(provider).find(row => row.id === model)
  if (listed) {
    return {
      ...(listed.supportsImageInput !== undefined ? { images: listed.supportsImageInput } : {}),
      ...(listed.supportsPdfInput !== undefined ? { documents: listed.supportsPdfInput } : {}),
    }
  }
  const config = runtimeProviderConfigs()[provider]
  const custom = config?.isCustomProvider ? config.customModels?.find(row => row.modelId === model) : undefined
  const vision = custom?.capabilities?.vision
  return vision !== undefined ? { images: vision } : {}
}

/** The kinds a request to the target leaves out: stated as unsupported, or refused before. */
export function mediaOmittedFor(provider: string, model: string, stated: MediaSupport): MediaKinds {
  const learned = refused.get(keyOf(provider, model)) ?? NONE
  return {
    images: stated.images === false || learned.images,
    documents: stated.documents === false || learned.documents,
  }
}

/** The target refused a request for media of these kinds. */
export function rememberMediaRefusal(provider: string, model: string, kinds: MediaKinds): void {
  const key = keyOf(provider, model)
  const held = refused.get(key) ?? NONE
  refused.set(key, { images: held.images || kinds.images, documents: held.documents || kinds.documents })
}

export function __resetMediaRefusalsForTest(): void {
  refused.clear()
}

// ── a refusal for media ─────────────────────────────────────────────────────

const REFUSAL_STATUSES = new Set([400, 404, 413, 415, 422])

const UNSUPPORTED =
  /not support|unsupported|no endpoints? found|only supports? text|text[- ]only|not (?:allowed|accepted|available|enabled)|cannot (?:read|process|accept|handle)|can(?:'|no)t (?:read|process|accept|handle)|invalid (?:content|message) type|unknown (?:content|message|part) type/i
const ABOUT_IMAGES = /\bimages?\b|image_url|input_image|\bvision\b|multi-?modal/i
const ABOUT_DOCUMENTS = /\bpdfs?\b|\bdocuments?\b|input_file|\bfile (?:input|content|part)s?\b/i

/**
 * The kinds of media a failed send was refused for, among the kinds it was
 * sent: a client-error status (or none stated) and a message that names the
 * kind as not supported. Nothing else is read as a refusal for media.
 */
export function mediaRefusedBy(failure: FailureEvent, sent: MediaKinds): MediaKinds {
  if (!sent.images && !sent.documents) return NONE
  if (failure.httpStatus !== undefined && !REFUSAL_STATUSES.has(failure.httpStatus)) return NONE
  const message = failure.message ?? ''
  if (!UNSUPPORTED.test(message)) return NONE
  return {
    images: sent.images && ABOUT_IMAGES.test(message),
    documents: sent.documents && ABOUT_DOCUMENTS.test(message),
  }
}
