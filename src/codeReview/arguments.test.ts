import { describe, expect, it } from 'vitest'
import { parseFindingLimit, parseReviewArguments, parseReviewCommand } from './arguments'
import { REVIEW_LEVELS } from './contracts'

function parsed(input: string) {
  const result = parseReviewArguments(input)
  if (!result.ok) throw new Error(result.error.code)
  return result.arguments
}

describe('review arguments', () => {
  it('normalizes the command aliases', () => {
    expect(parseReviewCommand('/review')).toEqual(parseReviewCommand('/code-review'))
    expect(parsed('')).toEqual({ fix: false, comment: false })
  })

  it.each(REVIEW_LEVELS)('accepts %s only in the first argument position', level => {
    expect(parsed(`${level} main...HEAD`)).toEqual({ level, target: 'main...HEAD', fix: false, comment: false })
    expect(parsed(`--fix ${level}`)).toEqual({ target: level, fix: true, comment: false })
    expect(parsed(`-- ${level}`).target).toBe(level)
    expect(parsed(`"${level}"`).target).toBe(level)
    expect(parseReviewArguments(`src ${level}`)).toMatchObject({ ok: false, error: { code: 'multiple-targets' } })
  })

  it.each(['higher', 'highway', 'maximal', 'medium-test', './ultra', 'ultrasonic', 'feature/high', '/src/auth', 'A..B', 'A...B', '124', 'https://example.test/group/repo/-/merge_requests/12'])('preserves target %s', target => {
    expect(parsed(target).target).toBe(target)
  })

  it('preserves quoted Windows paths and literal shell syntax', () => {
    expect(parsed(String.raw`high "C:\Program Files\app\" --fix`).target).toBe('C:\\Program Files\\app\\')
    expect(parsed(String.raw`'\\server\share\some folder'`).target).toBe('\\\\server\\share\\some folder')
    expect(parsed(String.raw`C:\repo\src`).target).toBe('C:\\repo\\src')
    expect(parsed('"$(touch secret); echo nope"').target).toBe('$(touch secret); echo nope')
    expect(parsed("'path with \"quotes\"'").target).toBe('path with "quotes"')
  })

  it('stops option processing', () => {
    expect(parsed('-- ultra')).toEqual({ fix: false, comment: false, target: 'ultra', targetLiteral: true })
    expect(parsed('-- --post').target).toBe('--post')
    expect(parsed('high -- --fix')).toEqual({ level: 'high', fix: false, comment: false, target: '--fix', targetLiteral: true })
  })

  it('makes repeated switches idempotent and uses the last limit', () => {
    expect(parsed('--fix --comment --fix --comment --max-findings 2 --max-findings=12')).toEqual({ fix: true, comment: true, maxFindings: 12 })
    expect(parsed('--max-findings all --max-findings=default').maxFindings).toBe('default')
  })

  it.each(['ultra', 'high ultra', '--post', '--post=true', '--no-post', '--no-post=false', '/ultrareview'])('rejects removed input %s', input => {
    expect(parseReviewArguments(input)).toMatchObject({ ok: false, error: { code: 'removed-option' } })
  })

  it.each(['0', '-1', '1.2', 'Infinity', 'NaN', '9007199254740992', '9007199254740993', '1e2', '+2', '0x10', '', 'All', 'defaultx'])('rejects invalid count %s', raw => {
    expect(parseFindingLimit(raw)).toBeUndefined()
    expect(parseReviewArguments(`--max-findings=${raw}`)).toMatchObject({ ok: false, error: { code: 'invalid-limit' } })
  })

  it.each([['1', 1], ['0012', 12], ['9007199254740991', Number.MAX_SAFE_INTEGER], ['all', 'all'], ['default', 'default']] as const)('accepts valid count %s', (raw, value) => {
    expect(parsed(`--max-findings=${raw}`).maxFindings).toBe(value)
  })

  it.each([
    ['--max-findings', 'missing-value'],
    ['--max-findings --fix', 'missing-value'],
    ['--max-findings --', 'missing-value'],
    ['--other', 'unknown-option'],
    ['--fix=true', 'unknown-option'],
    ['--comment=false', 'unknown-option'],
    ['foo bar', 'multiple-targets'],
    ['""', 'empty-target'],
    ['"file', 'unclosed-quote'],
    ["'file", 'unclosed-quote'],
  ])('rejects malformed input %s', (input, code) => {
    expect(parseReviewArguments(input!)).toMatchObject({ ok: false, error: { code } })
  })

  it('rejects unrelated command invocations separately from path arguments', () => {
    expect(parseReviewCommand('/other high')).toMatchObject({ ok: false, error: { code: 'unknown-command' } })
    expect(parseReviewCommand('/ultrareview')).toMatchObject({ ok: false, error: { code: 'removed-option' } })
    expect(parsed('/absolute/path').target).toBe('/absolute/path')
  })
})
