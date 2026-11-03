/**
 * Security: The egress guard of model egress masking (F-39). Scans what is
 * about to be sent to a model provider (URL, header values, query values,
 * body) for any rule's `match`, after the driver, a provider mod's request
 * hooks and the id mapper have run. The body is read as UTF-8 whatever its
 * type, so a JSON or protobuf body is scanned alike; in addition each match is
 * looked for in its JSON-escaped forms. Host-side placeholders
 * (`{{secret:NAME}}`, `{{oauth:NAME}}`) are not scanned: the host expands
 * them, and their names are not content.
 */
import type { CompiledMasking } from './maskingRules'

export type EgressRequest = {
  url: string
  headers?: Record<string, string>
  queryParams?: Record<string, string>
  body?: Uint8Array
}

export type EgressResidual = { where: string; rule: number }

/** Thrown before a request that still holds a `match` is sent. */
export class MaskingResidualError extends Error {
  constructor(readonly residual: EgressResidual) {
    super(
      `Request blocked by model masking: it still contains the text of masking rule ${residual.rule + 1} (in ${residual.where}).`,
    )
    this.name = 'MaskingResidualError'
  }
}

const PLACEHOLDER = /\{\{(?:secret|oauth):[^}]*\}\}/g
const DECODER = new TextDecoder('utf-8')

function escapedForms(match: string): string[] {
  const forms = new Set<string>()
  const json = JSON.stringify(match).slice(1, -1)
  if (json !== match) forms.add(json)
  const toAscii = (upper: boolean) =>
    json.replace(/[^\x00-\x7f]/g, ch => {
      const hex = ch.charCodeAt(0).toString(16).padStart(4, '0')
      return `\\u${upper ? hex.toUpperCase() : hex}`
    })
  for (const form of [toAscii(false), toAscii(true)]) if (form !== match) forms.add(form)
  return [...forms]
}

/** Scans one request; the first residual found, or undefined. */
export function findEgressResidual(
  masking: CompiledMasking,
  request: EgressRequest,
): EgressResidual | undefined {
  const inText = (text: string, where: string): EgressResidual | undefined => {
    const rule = masking.residualIn(text)
    return rule === undefined ? undefined : { where, rule }
  }
  const found = inText(request.url, 'url')
  if (found) return found
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const hit = inText(`${name}: ${value.replace(PLACEHOLDER, '')}`, `header:${name.toLowerCase()}`)
    if (hit) return hit
  }
  for (const [name, value] of Object.entries(request.queryParams ?? {})) {
    const hit = inText(`${name}=${value.replace(PLACEHOLDER, '')}`, `query:${name}`)
    if (hit) return hit
  }
  if (request.body && request.body.byteLength > 0) {
    const body = DECODER.decode(request.body)
    const hit = inText(body, 'body')
    if (hit) return hit
    for (let rule = 0; rule < masking.rules.length; rule += 1) {
      for (const form of escapedForms(masking.rules[rule]!.match)) {
        if (body.includes(form)) return { where: 'body', rule }
      }
    }
  }
  return undefined
}
