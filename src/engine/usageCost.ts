/**
 * Session token usage + cost for `/cost`, summed from the transcript's assistant `usage` blocks. USD
 * only for models with exact pricing; others show tokens only.
 */

import type { Message, SystemMessagePart } from '../runtime/RuntimeTypes'
import { isAssistantMessage } from '../runtime/VercelModelConstants'
import {
  BLOCK,
  key,
  leadIn,
  renderPartsEnglish,
  text,
  title,
} from '../input/systemMessageParts'

export type ModelTokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Walk the transcript and sum per-model token usage from assistant messages. */
export function accumulateSessionUsage(
  messages: readonly Message[],
): Map<string, ModelTokenUsage> {
  const byModel = new Map<string, ModelTokenUsage>()
  for (const msg of messages) {
    if (!isAssistantMessage(msg)) continue
    const inner = msg.message as Record<string, unknown> | undefined
    const usage = inner?.usage as Record<string, unknown> | undefined
    if (!usage) continue
    const model =
      typeof inner?.model === 'string' && inner.model.length > 0
        ? inner.model
        : 'unknown'
    const cur = byModel.get(model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    }
    cur.input += num(usage.input_tokens)
    cur.output += num(usage.output_tokens)
    cur.cacheRead += num(usage.cache_read_input_tokens)
    cur.cacheCreate += num(usage.cache_creation_input_tokens)
    byModel.set(model, cur)
  }
  return byModel
}

/** USD per 1M tokens, by the published Anthropic price tiers. */
type Pricing = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}
const TIER_SONNET: Pricing = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 }
const TIER_OPUS_LEGACY: Pricing = { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 }
const TIER_OPUS_45: Pricing = { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 }
// Opus 5 lands on the same published $5/$25 as Opus 4.5-4.8, but it is its own
// entry: a repricing of either line must not silently move the other.
const TIER_OPUS_5: Pricing = { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 }
// Opus 5.5 is the first Opus repriced BELOW its predecessor:
// $4/$20, 5m cache write $5, cache read $0.20 (0.05x, not the usual 0.1x).
const TIER_OPUS_55: Pricing = { input: 4, output: 20, cacheRead: 0.2, cacheCreate: 5 }
const TIER_HAIKU_45: Pricing = { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 }

/**
 * A bare major-version id, optionally carrying a dated snapshot suffix — e.g.
 * `opus-5` and `opus-5-20260101`, but NOT `opus-5-1`. An unreleased minor is
 * left unmatched on purpose: minors have repriced before (Opus 4 → 4.5), so
 * matching one would be guessing, which is what the `return null` below exists
 * to prevent. Eight digits is what separates a date from a minor.
 */
function exactModelRe(base: string): RegExp {
  return new RegExp(`${base}(?:-\\d{8})?(?![-\\w])`)
}
const OPUS_5_RE = exactModelRe('opus-5')
const OPUS_55_RE = exactModelRe('opus-5-5')
const HAIKU_45_RE = exactModelRe('haiku-4-5')

/**
 * Best-effort pricing for a model id, or `null` when we have no exact figures.
 * Only Anthropic first-party tiers we can cite are matched
 * (https://platform.claude.com/docs/en/about-claude/pricing).
 */
export function getModelPricing(modelId: string): Pricing | null {
  const m = modelId.toLowerCase()
  if (m.includes('opus')) {
    // Opus 5.5 is $4/$20; Opus 5 and Opus 4.5+ are the $5/$25 tier; Opus 4 /
    // 4.1 are $15/$75. The 5.5 test runs first: `opus-5` is anchored against
    // a minor, so order only matters for readability, but keep it explicit.
    if (OPUS_55_RE.test(m)) return TIER_OPUS_55
    if (OPUS_5_RE.test(m)) return TIER_OPUS_5
    if (/opus-4-(?:[5-9]|\d\d)/.test(m)) return TIER_OPUS_45
    if (/opus-4(?:-(?:0|1))?\b/.test(m) || /opus-4\b/.test(m)) return TIER_OPUS_LEGACY
    return null // unrecognized Opus minor — don't guess
  }
  // Every Sonnet released to date is the same $3/$15 tier, so the unconditional
  // match is exact rather than a guess. (An introductory Sonnet price is not
  // modelled; we bill the standard list rate — a date-gated price would go
  // silently wrong the day it lapses.)
  if (m.includes('sonnet')) return TIER_SONNET
  if (m.includes('haiku')) {
    if (HAIKU_45_RE.test(m)) return TIER_HAIKU_45
    return null // Haiku 3 / 3.5 and unrecognized minors price differently
  }
  // Every non-Anthropic provider: no exact figure → no $.
  return null
}

function usdFor(usage: ModelTokenUsage, p: Pricing): number {
  return (
    (usage.input / 1_000_000) * p.input +
    (usage.output / 1_000_000) * p.output +
    (usage.cacheRead / 1_000_000) * p.cacheRead +
    (usage.cacheCreate / 1_000_000) * p.cacheCreate
  )
}

/**
 * The session's cost in USD as `/cost` totals it, or undefined when there is
 * no priced figure for all of it: no usage yet, or a model `getModelPricing`
 * does not price (a partial sum would read as the whole). For the mods'
 * `$.session.usage()` — "absent only where the host keeps no cost ledger".
 */
export function sessionCostUsd(messages: readonly Message[]): number | undefined {
  const byModel = accumulateSessionUsage(messages)
  if (byModel.size === 0) return undefined
  let total = 0
  for (const [model, usage] of byModel) {
    const pricing = getModelPricing(model)
    if (!pricing) return undefined
    total += usdFor(usage, pricing)
  }
  return total
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}

/**
 * Render the `/cost` report as translatable parts: per-model breakdown, totals, a USD estimate for
 * priced models and a caveat for unpriced ones.
 */
export function formatCostReport(
  byModel: Map<string, ModelTokenUsage>,
): SystemMessagePart[] {
  if (byModel.size === 0) {
    return [key('slash.out.cost.empty')]
  }
  const pricingUnavailable = renderPartsEnglish([
    key('slash.out.cost.pricingUnavailable'),
  ])

  const parts: SystemMessagePart[] = title(key('slash.out.cost.header'))
  let totInput = 0
  let totOutput = 0
  let totCacheRead = 0
  let totCacheCreate = 0
  let totUsd = 0
  let anyUnpriced = false

  // Stable order: highest total tokens first.
  const entries = [...byModel.entries()].sort(
    (a, b) =>
      b[1].input + b[1].output + b[1].cacheRead + b[1].cacheCreate -
      (a[1].input + a[1].output + a[1].cacheRead + a[1].cacheCreate),
  )

  let first = true
  for (const [model, u] of entries) {
    totInput += u.input
    totOutput += u.output
    totCacheRead += u.cacheRead
    totCacheCreate += u.cacheCreate
    const pricing = getModelPricing(model)
    let costLabel: string
    if (pricing) {
      const usd = usdFor(u, pricing)
      totUsd += usd
      costLabel = fmtUsd(usd)
    } else {
      anyUnpriced = true
      costLabel = pricingUnavailable
    }
    parts.push(
      // One bullet per model; the first opens the list after the title.
      text(first ? `${BLOCK}- ` : '\n- '),
      key('slash.out.cost.modelLine', {
        model,
        input: fmtTokens(u.input),
        output: fmtTokens(u.output),
        cacheRead: fmtTokens(u.cacheRead),
        cacheCreate: fmtTokens(u.cacheCreate),
        cost: costLabel,
      }),
    )
    first = false
  }

  // The session total is a LEAD-IN, not a fourth bullet. A blank line between
  // bullets does not start a second list in markdown — it makes the same list
  // loose, so the total and its caveats rendered as two more models (and every
  // row picked up a wrapping <p>). Bolding the total ends the per-model list
  // and makes the caveats below read as what they are: qualifiers on the
  // total, not entries beside it.
  const totalTokens = totInput + totOutput + totCacheRead + totCacheCreate
  parts.push(
    ...leadIn(
      key('slash.out.cost.total', {
        total: fmtTokens(totalTokens),
        input: fmtTokens(totInput),
        output: fmtTokens(totOutput),
        cacheRead: fmtTokens(totCacheRead),
        cacheCreate: fmtTokens(totCacheCreate),
      }),
    ),
  )
  if (totUsd > 0) {
    parts.push(
      text(`${BLOCK}- `),
      key('slash.out.cost.estimated', { cost: fmtUsd(totUsd) }),
    )
  }
  if (anyUnpriced) {
    parts.push(
      text(totUsd > 0 ? '\n- ' : `${BLOCK}- `),
      key('slash.out.cost.unpricedNote'),
    )
  }
  return parts
}
