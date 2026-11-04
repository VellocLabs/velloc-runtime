import { describe, expect, it } from 'vitest'
import { completeReviewArguments } from './completion'
import { REVIEW_LEVELS } from './contracts'
import { REVIEW_SWITCHES } from './arguments'

const values = (input: string) => completeReviewArguments(input).items.map(item => item.value)

describe('review argument completion', () => {
  it.each(['', '/review ', '/code-review ', '  /review   '])('offers levels only at the first position: %s', input => {
    expect(values(input)).toEqual([...REVIEW_LEVELS, ...REVIEW_SWITCHES])
  })

  it.each(['high ', '--fix ', '--fix high ', 'target ', '--max-findings 12 ', '"high" '])('offers only switches after a completed argument: %s', input => {
    expect(values(input)).toEqual(REVIEW_SWITCHES)
  })

  it('filters first-position level and switch prefixes', () => {
    expect(values('/review x')).toEqual(['xhigh'])
    expect(values('h')).toEqual(['high'])
    expect(values('--c')).toEqual(['--comment'])
    expect(values('high h')).toEqual([])
    expect(values('--')).toEqual(REVIEW_SWITCHES.filter(value => value.startsWith('--')))
  })

  it.each(['-- ', '-- --f', '--fix -- ', '--fix -- high ', 'high -- --max-findings=', '/ultrareview ', '/other ', '/review'])('does not suggest syntax outside the command option context: %s', input => {
    expect(values(input)).toEqual([])
  })

  it.each(['"C:\\Program Files\\', "'some folder", '"high"', '--max-findings "'])('does not complete inside quoted targets or values: %s', input => {
    expect(values(input)).toEqual([])
  })

  it('does not mistake a quoted terminator for the options terminator', () => {
    expect(values('"--" --f')).toEqual(['--fix'])
  })

  it('offers finite examples and symbolic quantity choices with a semantic hint', () => {
    const result = completeReviewArguments('/review high --max-findings ')
    expect(result.valueHint).toBe('safe-positive-integer-or-all-or-default')
    expect(result.items.map(item => item.value)).toEqual(['4', '8', '10', '15', '32', 'all', 'default'])
    expect(values('--max-findings a')).toEqual(['all'])
    expect(values('--max-findings=1')).toEqual(['--max-findings=10', '--max-findings=15'])
    expect(values('--max-findings=d')).toEqual(['--max-findings=default'])
    expect(completeReviewArguments('--max-findings 123')).toMatchObject({ items: [], valueHint: 'safe-positive-integer-or-all-or-default' })
  })

  it.each(['ultra ', '--post ', 'high extra target ', '--unknown --max-findings ', '--max-findings nope '])('does not suggest completions for invalid preceding arguments: %s', input => {
    expect(values(input)).toEqual([])
  })

  it('returns replacement ranges and honors the requested cursor', () => {
    const input = '/review high --co trailing'
    const cursor = input.indexOf(' trailing')
    expect(completeReviewArguments(input, cursor).items).toEqual([{ value: '--comment', kind: 'switch', replace: { start: 13, end: cursor } }])
    for (const invalid of [-1, 0.5, Infinity, input.length + 1]) expect(completeReviewArguments(input, invalid)).toEqual({ items: [] })
  })

  it('offers nothing for the -C value, then the levels, and never a second -C', () => {
    expect(values('-C ')).toEqual([])
    expect(values('-C nexus_web ')).toEqual([...REVIEW_LEVELS, ...REVIEW_SWITCHES.filter(value => value !== '-C')])
    expect(values('/code-review -C nexus_web m')).toEqual(['medium', 'max'])
    expect(values('max -C nexus_web ')).toEqual(REVIEW_SWITCHES.filter(value => value !== '-C'))
    expect(values('max ')).toEqual(REVIEW_SWITCHES)
  })
})
