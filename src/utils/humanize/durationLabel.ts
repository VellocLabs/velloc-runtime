/**
 * Contract: elapsed-span label ("12s", "1m 11s", "1h 0m 0s", "1d 1h 1m").
 * Under a minute: whole seconds rounded down; under a millisecond (or negative):
 * one decimal ("0.0s"). From a minute: rounded to the second, from the largest
 * non-zero unit down three units, zeros inside kept. `'largest'` keeps only the
 * biggest unit and leaves sub-minute labels alone.
 */
export type DurationLabelMode = 'full' | 'largest'

const UNITS = [
  { suffix: 'd', seconds: 86_400 },
  { suffix: 'h', seconds: 3_600 },
  { suffix: 'm', seconds: 60 },
  { suffix: 's', seconds: 1 },
] as const

/** How many units a label shows, starting at its leading one. */
const FULL_WIDTH = 3

export function durationLabel(
  ms: number,
  mode: DurationLabelMode = 'full',
): string {
  if (ms === 0) return '0s'
  if (ms < 1) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`

  let remaining = Math.round(ms / 1000)
  const parts = UNITS.map(({ suffix, seconds }) => {
    const amount = Math.floor(remaining / seconds)
    remaining -= amount * seconds
    return `${amount}${suffix}`
  })
  const lead = parts.findIndex(part => !part.startsWith('0'))
  const width = mode === 'largest' ? 1 : FULL_WIDTH
  return parts.slice(lead, lead + width).join(' ')
}
