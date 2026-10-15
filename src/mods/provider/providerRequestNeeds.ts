/**
 * Security: what a provider's request hooks may see. By default `provider.request`
 * gets the small facts only; `requestNeeds` (`system`, `tools`, `body`, `cwd`) and
 * `signNeeds: 'body'` opt into more. Binary parts cross as held placeholders; a
 * placeholder naming a ref the request never gave refuses the rewrite.
 */
import { holdBodies, restoreBodies, type HeldBody } from '../turnRequestEvent'

export type ProviderRequestNeed = 'system' | 'tools' | 'body' | 'cwd'

export const PROVIDER_REQUEST_NEEDS: readonly ProviderRequestNeed[] = Object.freeze(['system', 'tools', 'body', 'cwd'])

/** The declaration, normalised. */
export type ProviderNeedsDeclaration = {
  requestNeeds: readonly ProviderRequestNeed[]
  signNeeds?: 'body'
}

export type ProviderNeedsCheck =
  | { ok: true; needs: ProviderNeedsDeclaration }
  | { ok: false; error: string }

/**
 * Check a descriptor's `requestNeeds` / `signNeeds`. Both are optional; a
 * declaration with an unknown word, a repeated word or the wrong shape is
 * refused whole (a typo must not quietly mean "nothing").
 */
export function checkProviderNeeds(input: { requestNeeds?: unknown; signNeeds?: unknown }): ProviderNeedsCheck {
  const seen: ProviderRequestNeed[] = []
  if (input.requestNeeds !== undefined) {
    if (!Array.isArray(input.requestNeeds)) {
      return { ok: false, error: 'requestNeeds must be a list of "system", "tools", "body" and "cwd"' }
    }
    for (const need of input.requestNeeds as unknown[]) {
      if (typeof need !== 'string' || !(PROVIDER_REQUEST_NEEDS as readonly string[]).includes(need)) {
        return {
          ok: false,
          error: `requestNeeds: ${JSON.stringify(need)} is not one of ${PROVIDER_REQUEST_NEEDS.map(n => `"${n}"`).join(', ')}`,
        }
      }
      if (seen.includes(need as ProviderRequestNeed)) {
        return { ok: false, error: `requestNeeds: "${need}" is listed twice` }
      }
      seen.push(need as ProviderRequestNeed)
    }
  }
  if (input.signNeeds !== undefined && input.signNeeds !== 'body') {
    return { ok: false, error: `signNeeds: ${JSON.stringify(input.signNeeds)} is not "body"` }
  }
  return {
    ok: true,
    needs: { requestNeeds: seen, ...(input.signNeeds === 'body' ? { signNeeds: 'body' as const } : {}) },
  }
}

// ── held parts of a codec body ──

/** Wire spellings of an image or document part, across the codecs. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image', 'image_url', 'input_image'])
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(['document', 'input_file', 'file'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a node of a codec body is a binary part to hold, and which kind. */
export function wirePartKind(part: Record<string, unknown>): HeldBody['kind'] | undefined {
  const type = part.type
  if (typeof type === 'string') {
    if (IMAGE_TYPES.has(type)) return 'image'
    if (DOCUMENT_TYPES.has(type)) return 'document'
  }
  // Gemini: `{ inlineData: { mimeType, data } }`, no `type`.
  if (type === undefined && isRecord(part.inlineData)) return 'image'
  return undefined
}

export type HeldRequestBody = {
  /** The body as a hook sees it: binary parts are placeholders. */
  view: unknown
  /** What the placeholders stand for, by ref. */
  held: Map<string, unknown>
}

/** The codec JSON of `body`, binary parts held. Throws when it is not JSON. */
export function holdRequestBody(body: Uint8Array): HeldRequestBody {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new Error('the request body is not JSON, so it cannot be shown to the hook')
  }
  const held = new Map<string, unknown>()
  return { view: holdBodies(json, held, wirePartKind), held }
}

/** `value` with each placeholder replaced by the part it names; a ref the
 *  request never gave refuses it (throws). */
export function restoreRequestBody(value: unknown, held: ReadonlyMap<string, unknown>): unknown {
  const restored = restoreBodies(value, held)
  if ('refused' in restored) throw new Error(`the body is refused: ${restored.refused}`)
  return restored.value
}
