import { describe, expect, it } from 'vitest'
import {
  compileIdRule,
  compileIdRules,
  parseIdTemplate,
  validateIdRule,
  type IdRuleShape,
} from '../mods/provider/ids/idRules'

describe('id templates', () => {
  it('composes fixed-width parts and literal text', () => {
    expect(parseIdTemplate('{hex:12}{base62:14}')).toEqual({
      parts: [
        { type: 'run', alphabet: 'hex', width: 12 },
        { type: 'run', alphabet: 'base62', width: 14 },
      ],
    })
    expect(parseIdTemplate('{time:hex:12}-{base64url:8}')).toEqual({
      parts: [
        { type: 'time', alphabet: 'hex', width: 12 },
        { type: 'literal', text: '-' },
        { type: 'run', alphabet: 'base64url', width: 8 },
      ],
    })
  })

  const bad: Array<[string, string, RegExp]> = [
    ['unclosed', '{hex:12', /never closed/],
    ['no width', '{hex}', /whole width/],
    ['zero width', '{hex:0}', /whole width/],
    ['unknown alphabet', '{octal:4}', /not \{hex\|base62\|base64url:N\}/],
    ['time with a bad alphabet', '{time:base64url:8}', /not \{time:hex:N\}/],
    ['too wide for hex', '{hex:65}', /wider than the 64/],
    ['too wide for base62', '{base62:44}', /wider than the 43/],
    ['literal-only', 'abc', /at least one/],
    ['a literal with a space', '{hex:4} {hex:4}', /may hold only letters/],
  ]
  for (const [what, template, message] of bad) {
    it(`refuses ${what}`, () => {
      const parsed = parseIdTemplate(template)
      expect('error' in parsed && parsed.error).toMatch(message)
    })
  }
})

describe('id rule validation', () => {
  const ok: Array<[string, IdRuleShape]> = [
    ['keep', { derive: 'keep' }],
    ['hook', { derive: 'hook' }],
    ['encrypt with a prefix', { derive: 'encrypt', prefix: 'e_' }],
    ['hmac with alphabet and length', { derive: 'hmac', prefix: 'call_', alphabet: 'base62', length: 24 }],
    ['hmac with a template', { derive: 'hmac', template: '{hex:12}{base62:14}' }],
    ['chain over fields', { derive: 'chain', over: ['prev', 'contentSha256'] }],
    ['random with a clock', { derive: 'random', template: '{time:hex:12}{base62:14}' }],
  ]
  for (const [what, rule] of ok) {
    it(`accepts ${what}`, () => {
      expect(validateIdRule('toolCall', rule)).toBeUndefined()
    })
  }

  const refused: Array<[string, Parameters<typeof validateIdRule>[0], IdRuleShape, RegExp]> = [
    ['keep with a prefix', 'toolCall', { derive: 'keep', prefix: 'x' }, /"keep" takes no prefix/],
    ['hook with a length', 'message', { derive: 'hook', length: 4 }, /"hook" takes no length/],
    ['encrypt with a template', 'toolCall', { derive: 'encrypt', template: '{hex:4}' }, /"encrypt" takes no template/],
    ['a template with a length', 'toolCall', { derive: 'hmac', template: '{hex:4}', length: 4 }, /cannot both be given/],
    ['a clock in a deterministic rule', 'session', { derive: 'hmac', template: '{time:hex:12}' }, /"random" only/],
    ['a length over the alphabet', 'toolCall', { derive: 'hmac', alphabet: 'base62', length: 44 }, /at most 43/],
    ['a default-alphabet length over base62', 'toolCall', { derive: 'hmac', length: 64 }, /base62 gives at most 43/],
    ['a chain on the session kind', 'session', { derive: 'chain', over: ['prev'] }, /not the session kind/],
    ['a chain on the request kind', 'request', { derive: 'chain', over: ['prev'] }, /not the request kind/],
    ['a bad template', 'toolCall', { derive: 'hmac', template: '{hex:x}' }, /template: .*whole width/],
  ]
  for (const [what, kind, rule, message] of refused) {
    it(`refuses ${what}`, () => {
      expect(validateIdRule(kind, rule)).toMatch(message)
    })
  }
})

describe('compiling rules', () => {
  it('defaults a body to base62 x 24 and keeps the prefix apart', () => {
    expect(compileIdRule('toolCall', { derive: 'hmac', prefix: 'call_' })).toEqual({
      derive: 'hmac',
      prefix: 'call_',
      parts: [{ type: 'run', alphabet: 'base62', width: 24 }],
      over: [],
    })
  })

  it('gives encrypt, keep and hook no body', () => {
    expect(compileIdRule('toolCall', { derive: 'encrypt', prefix: 'e_' }).parts).toEqual([])
    expect(compileIdRule('toolCall', { derive: 'keep' }).parts).toEqual([])
    expect(compileIdRule('toolCall', { derive: 'hook' }).parts).toEqual([])
  })

  it('throws on a rule validation refuses, naming the kind', () => {
    expect(() => compileIdRule('session', { derive: 'chain', over: ['prev'] })).toThrow(/ids\.session/)
  })

  it('compiles a whole table, skipping kinds without a rule', () => {
    const rules = compileIdRules({ toolCall: { derive: 'hmac' }, request: { derive: 'random' } })
    expect(Object.keys(rules).sort()).toEqual(['request', 'toolCall'])
  })
})
