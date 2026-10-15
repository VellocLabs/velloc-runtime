import { describe, expect, it } from 'vitest'
import {
  MAX_MEMBER_DISPLAY_NAME_CHARS,
  MEMBER_KEY_PATTERN,
  allocateMemberKey,
  deriveMemberKeyBase,
  normalizeMemberDisplayName,
  stableHash8,
} from '../team/memberKey'

// A teammate is shown to the user under the name the lead gave it — any
// language — while everything mechanical (session id, mailbox directory,
// frame address) uses an ASCII key derived from that name. These pin the
// derivation: deterministic, always a valid key, unique per lead.

describe('normalizeMemberDisplayName', () => {
  it('keeps any language and trims / collapses whitespace', () => {
    expect(normalizeMemberDisplayName('  程序员-小民 ')).toBe('程序员-小民')
    expect(normalizeMemberDisplayName('Reviewer   2')).toBe('Reviewer 2')
    expect(normalizeMemberDisplayName('worker-a')).toBe('worker-a')
  })

  it('strips the frame header\'s structural characters and controls', () => {
    expect(normalizeMemberDisplayName('x] (lead) <b> "q" \\ y')).toBe('x lead b q y')
  })

  it('is null when nothing displayable is left', () => {
    expect(normalizeMemberDisplayName('')).toBeNull()
    expect(normalizeMemberDisplayName('   ')).toBeNull()
    expect(normalizeMemberDisplayName('()[]')).toBeNull()
    expect(normalizeMemberDisplayName(undefined)).toBeNull()
    expect(normalizeMemberDisplayName(42)).toBeNull()
  })

  it('caps by code point, never splitting a surrogate pair', () => {
    const long = '😀'.repeat(MAX_MEMBER_DISPLAY_NAME_CHARS + 5)
    const out = normalizeMemberDisplayName(long)!
    expect(Array.from(out)).toHaveLength(MAX_MEMBER_DISPLAY_NAME_CHARS)
    expect(out.endsWith('😀')).toBe(true)
  })
})

describe('deriveMemberKeyBase', () => {
  it('keeps a readable slug for a name with Latin letters or digits', () => {
    expect(deriveMemberKeyBase('worker-a')).toBe('worker-a')
    expect(deriveMemberKeyBase('Reviewer 2')).toBe('reviewer-2')
    expect(deriveMemberKeyBase('程序员-bob')).toBe('bob')
  })

  it('hashes a name with nothing to slug, deterministically', () => {
    const a = deriveMemberKeyBase('程序员-小民')
    expect(a).toMatch(/^m-[0-9a-f]{8}$/)
    expect(deriveMemberKeyBase('程序员-小民')).toBe(a)
    expect(deriveMemberKeyBase('测试员')).not.toBe(a)
  })

  it('never yields a reserved key — a teammate cannot be addressed as the lead', () => {
    expect(deriveMemberKeyBase('team-lead')).toMatch(/^team-lead-[0-9a-f]{8}$/)
    expect(deriveMemberKeyBase('Lead')).toMatch(/^lead-[0-9a-f]{8}$/)
  })

  it('always satisfies the key grammar', () => {
    for (const name of ['worker-a', 'Reviewer 2', '程序员-小民', '--x--', 'a'.repeat(200), '!!!']) {
      expect(deriveMemberKeyBase(name)).toMatch(MEMBER_KEY_PATTERN)
    }
  })
})

describe('allocateMemberKey', () => {
  it('returns the base when it is free', () => {
    expect(allocateMemberKey('worker-a', new Set())).toBe('worker-a')
  })

  it('separates two display names that slug alike, then counts', () => {
    const taken = new Set(['bob'])
    const second = allocateMemberKey('Bob', taken)
    expect(second).toBe(`bob-${stableHash8('Bob')}`)
    taken.add(second)
    expect(allocateMemberKey('Bob', taken)).toBe(`bob-${stableHash8('Bob')}-2`)
  })
})

describe('stableHash8', () => {
  it('is 8 lowercase hex digits and stable', () => {
    expect(stableHash8('程序员-小民')).toMatch(/^[0-9a-f]{8}$/)
    expect(stableHash8('程序员-小民')).toBe(stableHash8('程序员-小民'))
    expect(stableHash8('')).toBe('811c9dc5')
  })
})
