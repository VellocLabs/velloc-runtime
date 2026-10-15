/**
 * Short count label for token totals: "999", "12.5", "1.3k", "159.2k", "1.2m".
 *
 * At most one decimal; a decimal that rounds to zero is not shown ("1k", not
 * "1.0k"); the magnitude suffix is lower-case. English abbreviations on every
 * locale — the label sits inside sentences that already carry the number.
 */
let compact: Intl.NumberFormat | undefined

export function compactCount(value: number): string {
  compact ??= new Intl.NumberFormat('en-US', {
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })
  return compact.format(value).toLowerCase()
}
