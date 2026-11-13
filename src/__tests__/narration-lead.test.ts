import { describe, expect, it } from 'vitest'
import {
  isCompactNarration,
  NARRATION_LEAD_MAX_CHARS,
} from '../utils/narrationLead'

describe('isCompactNarration', () => {
  it('accepts one short paragraph, wrapped or not', () => {
    expect(isCompactNarration('Claiming the handoff first.')).toBe(true)
    expect(isCompactNarration('  Tips match the handoff;\nrunning the checklist now.  ')).toBe(true)
    expect(isCompactNarration('Checking `git diff` against **main**.')).toBe(true)
  })

  it('rejects nothing-to-show and non-strings', () => {
    expect(isCompactNarration(undefined)).toBe(false)
    expect(isCompactNarration('')).toBe(false)
    expect(isCompactNarration('  \n ')).toBe(false)
  })

  it('rejects more than one block', () => {
    expect(isCompactNarration('First.\n\nSecond.')).toBe(false)
    expect(isCompactNarration('Run:\n```\nnpm test\n```')).toBe(false)
    expect(isCompactNarration('Findings:\n- one\n- two')).toBe(false)
    expect(isCompactNarration('1. first\n2. second')).toBe(false)
    expect(isCompactNarration('## Result')).toBe(false)
    expect(isCompactNarration('> quoted')).toBe(false)
    expect(isCompactNarration('| a | b |\n| - | - |')).toBe(false)
    expect(isCompactNarration('Summary\n---')).toBe(false)
    expect(isCompactNarration('Summary\n===')).toBe(false)
    expect(isCompactNarration('Summary\n--')).toBe(false)
    expect(isCompactNarration('Only\n--|')).toBe(false)
    expect(isCompactNarration('a | b\n--|--')).toBe(false)
    expect(isCompactNarration('Above.\n* * *')).toBe(false)
  })

  it('keeps a hyphenated or dashed sentence', () => {
    expect(isCompactNarration('Re-running the build - then the tests.')).toBe(true)
  })

  it('rejects a paragraph past the length cap', () => {
    expect(isCompactNarration('x'.repeat(NARRATION_LEAD_MAX_CHARS))).toBe(true)
    expect(isCompactNarration('x'.repeat(NARRATION_LEAD_MAX_CHARS + 1))).toBe(false)
  })
})
