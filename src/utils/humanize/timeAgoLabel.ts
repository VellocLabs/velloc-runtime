/**
 * Message-age label: "5s ago", "3d ago", "1mo ago", or "in 2h" for a timestamp
 * ahead of the clock (skew between devices).
 *
 * One unit only — the largest whole unit that fits, counted down (8 days is
 * "1w", never "1w 1d"). Months are 30 days and years 365. Under a second in
 * either direction reads "0s ago". The unit letters are not localized.
 */
const STEPS: ReadonlyArray<readonly [suffix: string, seconds: number]> = [
  ['s', 1],
  ['m', 60],
  ['h', 3_600],
  ['d', 86_400],
  ['w', 7 * 86_400],
  ['mo', 30 * 86_400],
  ['y', 365 * 86_400],
]

export function timeAgoLabel(at: Date, now: Date = new Date()): string {
  const offset = Math.trunc((at.getTime() - now.getTime()) / 1000)
  const span = Math.abs(offset)
  let pick: (typeof STEPS)[number] | undefined
  for (const step of STEPS) {
    if (span < step[1]) break
    pick = step
  }
  if (!pick) return '0s ago'
  const count = `${Math.trunc(span / pick[1])}${pick[0]}`
  return offset < 0 ? `${count} ago` : `in ${count}`
}
