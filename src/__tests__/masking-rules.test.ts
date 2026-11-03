import { describe, expect, it } from 'vitest'
import {
  compileMasking,
  validateMaskingRules,
  type MaskingRule,
} from '../models/masking/maskingRules'

const RULES: MaskingRule[] = [
  { match: 'https://github.com/AcmeCo/widget', alias: 'https://github.com/north-co/beacon' },
  { match: 'AcmeCo', alias: 'Northwind' },
  { match: 'Widget', alias: 'Beacon' },
  { match: 'widget', alias: 'beacon' },
]

function compiled(rules: MaskingRule[] = RULES) {
  const validated = validateMaskingRules(rules)
  if (!validated.ok) throw new Error(`invalid: ${validated.problem.reason}`)
  return compileMasking(validated.rules)
}

describe('validateMaskingRules', () => {
  it('accepts a well-formed table', () => {
    expect(validateMaskingRules(RULES)).toEqual({ ok: true, rules: RULES })
  })

  it.each([
    ['not_a_list', { rules: [] }, undefined],
    ['not_a_rule', [{ match: 'a' }], 0],
    ['empty', [{ match: '', alias: 'b' }], 0],
    ['too_long', [{ match: 'x'.repeat(513), alias: 'b' }], 0],
    ['bad_char', [{ match: 'a\nb', alias: 'c' }], 0],
    ['bad_char', [{ match: 'a', alias: 'say "c"' }], 0],
    ['bad_char', [{ match: 'a', alias: 'c\\d' }], 0],
    ['alias_equals_match', [{ match: 'same', alias: 'same' }], 0],
    ['alias_overlaps_match', [{ match: 'Acme', alias: 'AcmeX' }], 0],
    ['duplicate_match', [{ match: 'a', alias: 'x' }, { match: 'a', alias: 'y' }], 1],
    ['alias_not_unique', [{ match: 'a', alias: 'x' }, { match: 'b', alias: 'x' }], 1],
    ['alias_overlaps_match', [{ match: 'Velo', alias: 'Kite' }, { match: 'b', alias: 'Velodrome' }], 1],
  ])('rejects %s', (reason, rules, rule) => {
    const result = validateMaskingRules(rules)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problem.reason).toBe(reason)
      expect(result.problem.rule).toBe(rule)
    }
  })

  it('counts a match in bytes, not characters', () => {
    // 171 three-byte characters = 513 bytes.
    const result = validateMaskingRules([{ match: '中'.repeat(171), alias: 'x' }])
    expect(result.ok).toBe(false)
  })

  it('rejects more than 256 rules', () => {
    const rules = Array.from({ length: 257 }, (_, i) => ({ match: `m${i}-`, alias: `a${i}-` }))
    expect(validateMaskingRules(rules)).toMatchObject({ ok: false, problem: { reason: 'too_many_rules' } })
  })
})

describe('compileMasking', () => {
  it('replaces substrings, longest match first, case-sensitively', () => {
    const masking = compiled()
    const input = 'see https://github.com/AcmeCo/widget and AcmeCo/widget, Widget\'s docs, WIDGET'
    const { text, collision } = masking.maskText(input)
    expect(text).toBe(
      'see https://github.com/north-co/beacon and Northwind/beacon, Beacon\'s docs, WIDGET',
    )
    expect(collision).toBe(false)
    expect(masking.restoreText(text)).toBe(input)
  })

  it('matches inside words: no word boundary is required', () => {
    expect(compiled().maskText('AcmeCoLabs widgets').text).toBe('NorthwindLabs beacons')
  })

  it('reports each hit with its rule and range', () => {
    const hits: Array<[number, number, number]> = []
    compiled().maskText('Widget AcmeCo', hit => hits.push([hit.rule, hit.start, hit.end]))
    expect(hits).toEqual([[2, 0, 6], [1, 7, 13]])
  })

  it('flags a collision when the input already holds an alias', () => {
    expect(compiled().maskText('the Beacon project').collision).toBe(true)
  })

  it('flags a collision when the text next to a match joins its alias into another alias', () => {
    const masking = compiled([
      { match: 'K1', alias: 'cd' },
      { match: 'K2', alias: 'ab' },
    ])
    const masked = masking.maskText('aK1')
    expect(masked.text).toBe('acd')
    expect(masked.collision).toBe(false)
    const joined = masking.maskText('xaK1')
    expect(joined.collision).toBe(false)
    const tricky = masking.maskText('K2K1')
    expect(tricky.text).toBe('abcd')
    expect(masking.restoreText(tricky.text)).toBe('K2K1')
    // "a" + "cd" reads back as alias "ac" + "d".
    const ambiguous = compiled([
      { match: 'K1', alias: 'cd' },
      { match: 'K2', alias: 'ac' },
    ]).maskText('aK1')
    expect(ambiguous.collision).toBe(true)
  })

  it('restorePartial holds back a tail that may grow into an alias', () => {
    const masking = compiled()
    expect(masking.restorePartial('hello Bea')).toEqual({ text: 'hello ', held: 'Bea' })
    expect(masking.restorePartial('hello Beacon!')).toEqual({ text: 'hello Widget!', held: '' })
    expect(masking.restorePartial('hello Bex')).toEqual({ text: 'hello Bex', held: '' })
  })

  it('allows one alias inside another and restores the longer first', () => {
    const masking = compiled()
    const reply = 'clone https://github.com/north-co/beacon, then build beacon'
    expect(masking.restoreText(reply)).toBe('clone https://github.com/AcmeCo/widget, then build widget')
    // Streaming: "beacon" alone could still be the start of a longer alias.
    const nested = compiled([
      { match: 'K1', alias: 'beacon' },
      { match: 'K2', alias: 'beacon labs' },
    ])
    expect(nested.restorePartial('x beacon la')).toEqual({ text: 'x ', held: 'beacon la' })
    expect(nested.restorePartial('x beacon labs!')).toEqual({ text: 'x K2!', held: '' })
    expect(nested.restorePartial('x beacon!')).toEqual({ text: 'x K1!', held: '' })
  })

  it('reports a collision where an alias inside another would restore wrongly', () => {
    // Another org's URL masks into the text of the repository URL's alias.
    expect(compiled().maskText('https://github.com/north-co/widget').collision).toBe(true)
  })

  it('finds residual matches', () => {
    const masking = compiled()
    expect(masking.residualIn('nothing here')).toBeUndefined()
    expect(masking.residualIn('x AcmeCo y')).toBe(1)
  })
})
