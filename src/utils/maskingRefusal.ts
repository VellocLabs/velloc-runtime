/**
 * Marks a model request that model egress masking refused to send (F-39), so
 * the classifier and the API-error card name the cause in the reader's own
 * language. `residual`: the request still held a rule's match. `unknown`: the
 * masking settings are not read yet. `broken`: masking is on but its table is
 * empty or invalid. Dependency-free: worker and webview.
 */
export type MaskingRefusal =
  | { kind: 'residual'; rule: number; where: string }
  | { kind: 'unknown' }
  | { kind: 'broken' }

const MARKER = 'model_masking_refused'

/** The error message carried on the stream: `model_masking_refused: <kind>[ rule=<n> where=<w>]`. */
export function maskingRefusalMessage(refusal: MaskingRefusal): string {
  if (refusal.kind === 'residual') {
    return `${MARKER}: residual rule=${refusal.rule} where=${refusal.where.replace(/\s/g, '_')}`
  }
  return `${MARKER}: ${refusal.kind}`
}

export function maskingRefusalOf(text: string): MaskingRefusal | undefined {
  const at = text.indexOf(`${MARKER}: `)
  if (at < 0) return undefined
  const rest = text.slice(at + MARKER.length + 2)
  const residual = /^residual rule=(\d+) where=(\S+)/.exec(rest)
  if (residual) return { kind: 'residual', rule: Number(residual[1]), where: residual[2]! }
  if (rest.startsWith('broken')) return { kind: 'broken' }
  if (rest.startsWith('unknown')) return { kind: 'unknown' }
  return undefined
}
