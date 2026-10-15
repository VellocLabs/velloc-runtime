// Behaviour spec for the memory kind table and the extraction brief: every
// exported text block and every brief variant the extraction runner can ask
// for is pinned byte-for-byte by a SHA-256 digest of its JSON form.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import spec from './fixtures/memory-prompt-assembly.json'
import {
  MEMORY_KIND_IDS as kindIds,
  toMemoryKind as toKind,
  KIND_GUIDE_LINES as kindGuide,
  EXCLUSION_LINES as exclusions,
  PROJECT_NOTES_BULLETS as notesBullets,
  PROJECT_NOTES_BULLETS_STANDALONE as notesBulletsStandalone,
  STALE_RECALL_NOTE as staleNote,
  RECALL_TIMING_LINES as recallTiming,
  RECALL_VERIFY_LINES as recallVerify,
  NOTE_HEADER_SAMPLE as headerSample,
} from '../memory/memoryKinds'
import { composeExtractionBrief as brief } from '../memory/extract/extractorPrompt'

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

describe('memory kinds', () => {
  it('lists the four kinds in order', () => {
    expect([...kindIds]).toEqual(spec.kindIds)
  })
  it('accepts only exact kind ids', () => {
    for (const [input, want] of spec.parse) {
      expect(toKind(input === '__undef__' ? undefined : input)).toBe(want ?? undefined)
    }
  })
  it('keeps every text block unchanged', () => {
    expect(digest([...kindGuide])).toBe(spec.kindGuide)
    expect(digest([...exclusions])).toBe(spec.exclusions)
    expect(digest([...notesBullets])).toBe(spec.notesBullets)
    expect(digest([...notesBulletsStandalone])).toBe(spec.notesBulletsStandalone)
    expect(digest(staleNote)).toBe(spec.staleNote)
    expect(digest([...recallTiming])).toBe(spec.recallTiming)
    expect(digest([...recallVerify])).toBe(spec.recallVerify)
    expect(digest([...headerSample])).toBe(spec.headerSample)
  })
})

describe('extraction brief', () => {
  it.each(spec.brief)('count $n, index skipped $s', ({ n, e, s, text }) => {
    expect(digest(brief(n, e, s))).toBe(text)
  })
  it('maintains the index by default', () => {
    expect(digest(brief(3, ''))).toBe(spec.briefDefault)
  })
})
