import { describe, expect, it } from 'vitest'
import { compactCount } from '../utils/humanize/compactCount'
import { durationLabel } from '../utils/humanize/durationLabel'
import { timeAgoLabel } from '../utils/humanize/timeAgoLabel'

// Short human labels shown in the transcript, status bar, Background Tasks
// drawer and debug dumps: token counts ("159.2k"), elapsed spans ("1m 11s")
// and message ages ("3d ago").

describe('compactCount', () => {
  it('prints small counts as-is, with at most one decimal', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(7)).toBe('7')
    expect(compactCount(12.5)).toBe('12.5')
    expect(compactCount(999)).toBe('999')
    expect(compactCount(999.4)).toBe('999.4')
  })

  it('abbreviates thousands and up with a lower-case suffix', () => {
    expect(compactCount(1321)).toBe('1.3k')
    expect(compactCount(1050)).toBe('1.1k')
    expect(compactCount(159_200)).toBe('159.2k')
    expect(compactCount(1_234_567)).toBe('1.2m')
    expect(compactCount(2.5e12)).toBe('2.5t')
  })

  it('drops a zero decimal, including after rounding up', () => {
    expect(compactCount(999.96)).toBe('1k')
    expect(compactCount(1000)).toBe('1k')
    expect(compactCount(1049)).toBe('1k')
    expect(compactCount(9_999)).toBe('10k')
    expect(compactCount(10_000)).toBe('10k')
    expect(compactCount(99_950)).toBe('100k')
    expect(compactCount(100_000)).toBe('100k')
    expect(compactCount(999_999)).toBe('1m')
    expect(compactCount(1_000_000)).toBe('1m')
    expect(compactCount(1e9)).toBe('1b')
  })

  it('keeps the sign of negative counts', () => {
    expect(compactCount(-12)).toBe('-12')
    expect(compactCount(-1500)).toBe('-1.5k')
    expect(compactCount(-2000)).toBe('-2k')
  })
})

describe('durationLabel', () => {
  it('renders sub-minute spans as whole seconds', () => {
    expect(durationLabel(0)).toBe('0s')
    expect(durationLabel(30.5)).toBe('0s')
    expect(durationLabel(999)).toBe('0s')
    expect(durationLabel(12_000)).toBe('12s')
    expect(durationLabel(59_400)).toBe('59s')
    expect(durationLabel(59_999.9)).toBe('59s')
  })

  it('shows one decimal for spans under a millisecond, negatives included', () => {
    expect(durationLabel(0.5)).toBe('0.0s')
    expect(durationLabel(-5)).toBe('-0.0s')
    expect(durationLabel(-5000)).toBe('-5.0s')
  })

  it('renders every unit from the largest down once past a minute', () => {
    expect(durationLabel(60_000)).toBe('1m 0s')
    expect(durationLabel(71_000)).toBe('1m 11s')
    expect(durationLabel(3_600_000)).toBe('1h 0m 0s')
    expect(durationLabel(3_661_000)).toBe('1h 1m 1s')
    expect(durationLabel(90_061_000)).toBe('1d 1h 1m')
  })

  it('rounds to the nearest second and carries into larger units', () => {
    expect(durationLabel(119_600)).toBe('2m 0s')
    expect(durationLabel(3_599_500)).toBe('1h 0m 0s')
    expect(durationLabel(86_399_600)).toBe('1d 0h 0m')
  })

  it('largest mode keeps only the biggest non-zero unit', () => {
    expect(durationLabel(71_000, 'largest')).toBe('1m')
    expect(durationLabel(3_661_000, 'largest')).toBe('1h')
    expect(durationLabel(7_200_000, 'largest')).toBe('2h')
    expect(durationLabel(86_399_600, 'largest')).toBe('1d')
    expect(durationLabel(90_061_000, 'largest')).toBe('1d')
  })

  it('largest mode leaves sub-minute labels unchanged', () => {
    expect(durationLabel(0, 'largest')).toBe('0s')
    expect(durationLabel(59_999, 'largest')).toBe('59s')
    expect(durationLabel(0.5, 'largest')).toBe('0.0s')
  })
})

describe('timeAgoLabel', () => {
  const now = new Date(2026, 5, 4, 12, 0, 0)
  const S = 1000
  const M = 60 * S
  const H = 60 * M
  const D = 24 * H
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const ahead = (ms: number) => new Date(now.getTime() + ms)

  it('uses the largest whole unit, truncated', () => {
    expect(timeAgoLabel(ago(5 * S), now)).toBe('5s ago')
    expect(timeAgoLabel(ago(2 * M), now)).toBe('2m ago')
    expect(timeAgoLabel(ago(119 * S), now)).toBe('1m ago')
    expect(timeAgoLabel(ago(1 * H), now)).toBe('1h ago')
    expect(timeAgoLabel(ago(23 * H + 59 * M), now)).toBe('23h ago')
    expect(timeAgoLabel(ago(3 * D), now)).toBe('3d ago')
  })

  it('rolls up to weeks, 30-day months and 365-day years', () => {
    expect(timeAgoLabel(ago(7 * D), now)).toBe('1w ago')
    expect(timeAgoLabel(ago(8 * D), now)).toBe('1w ago')
    expect(timeAgoLabel(ago(29 * D), now)).toBe('4w ago')
    expect(timeAgoLabel(ago(30 * D), now)).toBe('1mo ago')
    expect(timeAgoLabel(ago(40 * D), now)).toBe('1mo ago')
    expect(timeAgoLabel(ago(364 * D), now)).toBe('12mo ago')
    expect(timeAgoLabel(ago(365 * D), now)).toBe('1y ago')
    expect(timeAgoLabel(ago(800 * D), now)).toBe('2y ago')
  })

  it('reads less than a second either way as "0s ago"', () => {
    expect(timeAgoLabel(now, now)).toBe('0s ago')
    expect(timeAgoLabel(ago(999), now)).toBe('0s ago')
    expect(timeAgoLabel(ahead(999), now)).toBe('0s ago')
  })

  it('labels future timestamps (clock skew) as "in N<unit>"', () => {
    expect(timeAgoLabel(ahead(2 * H), now)).toBe('in 2h')
    expect(timeAgoLabel(ahead(90 * S), now)).toBe('in 1m')
    expect(timeAgoLabel(ahead(5 * S), now)).toBe('in 5s')
  })

  it('defaults "now" to the current clock', () => {
    expect(timeAgoLabel(new Date(Date.now() - 3 * H))).toBe('3h ago')
  })
})
