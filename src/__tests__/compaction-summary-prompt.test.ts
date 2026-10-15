import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import * as prompt from '../context/compaction/summaryPrompt'

// Spec for the compaction request text and the hand-over message built from
// the model's reply. The request text is pinned by digest: its wording is
// owned by the prompt lane and must not drift with code changes here.

const api = prompt as unknown as Record<string, (...args: unknown[]) => string>
const request = (extra?: string) => api.buildSummaryRequestPrompt!(extra)
const render = (raw: string) => api.renderSummaryForTranscript!(raw)
const resume = (raw: string, opts?: unknown) => api.buildResumeFromSummaryMessage!(raw, opts)
const hasContent = (raw: string) => (api.summaryHasContent as unknown as (r: string) => boolean)(raw)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const BASE_DIGEST = 'bbb8d59360743fa641b0bb4df3d460dd425aa091a015bf5fbb5cbd7eaed0d31c'
const CLOSING_DIGEST = '200ecc80db1214cf2842e3f18549a90b3bbb0b984c9c0ba68a197ae231b227df'
const CLOSING_LENGTH = 143
const closingOf = (s: string) => s.slice(-CLOSING_LENGTH)

describe('summary request prompt', () => {
  it('is the same fixed text when no extra instructions are given', () => {
    for (const extra of [undefined, '', '   ', '\n\t']) {
      const text = request(extra)
      expect(text.length).toBe(6993)
      expect(sha(text)).toBe(BASE_DIGEST)
    }
    expect(request().startsWith('Respond with text only. Do NOT call any tool of any kind')).toBe(true)
    expect(sha(closingOf(request()))).toBe(CLOSING_DIGEST)
  })

  it('inserts caller instructions, untrimmed, just before the closing reminder', () => {
    const text = request('Focus on tests')
    expect(sha(text)).toBe('a629c2532885b7a24c90129dbc8df6ad0613a372c64033a24a86319177a955bb')
    expect(sha(closingOf(text))).toBe(CLOSING_DIGEST)
    expect(text.slice(0, -CLOSING_LENGTH).endsWith('\n\n## Additional instructions from the caller\nFocus on tests\n\n')).toBe(true)
    expect(sha(request('  pad  '))).toBe('8dffae8fc7c39883d61dfb4aa1bd396919219bf85eb99d8eb218ed4a1263419a')
    const base = request()
    const shared = base.length - CLOSING_LENGTH
    expect(text.slice(0, shared)).toBe(base.slice(0, shared))
  })
})

describe('summary rendering', () => {
  it.each([
    ['plain', 'plain'],
    ['<worksheet>x</worksheet>\n<digest>\nbody\n</digest>', 'Summary:\nbody'],
    ['<worksheet>a\nb</worksheet>  <digest>s</digest>\n\n\n\nend', 'Summary:\ns\n\nend'],
    ['pre <digest>one</digest> post <digest>two</digest>', 'pre Summary:\none post <digest>two</digest>'],
    ['<worksheet>only</worksheet>', ''],
    ['  <digest>  </digest>  ', 'Summary:'],
    ['a\n\n\n\nb', 'a\n\nb'],
    ['<WORKSHEET>u</WORKSHEET>', '<WORKSHEET>u</WORKSHEET>'],
  ])('%j -> %j', (raw, expected) => {
    expect(render(raw)).toBe(expected)
  })
})

describe('summary content check', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['<worksheet>only notes</worksheet>', false],
    ['<digest></digest>', false],
    ['<worksheet>n</worksheet>\n<digest>\n  \n</digest>', false],
    ['<digest>S</digest>', true],
    ['plain text with no blocks', true],
    ['<worksheet>n</worksheet> trailing words', true],
  ])('%j -> %j', (raw, expected) => {
    expect(hasContent(raw)).toBe(expected)
  })
})

describe('resume message', () => {
  const LEAD =
    'This session continues an earlier segment of the same conversation that grew too large for the context window. The digest below covers that earlier segment.\n\nSummary:\nS'
  it('prefixes the rendered summary with the continuation lead', () => {
    expect(resume('<digest>S</digest>')).toBe(LEAD)
    expect(resume('<digest>S</digest>', {})).toBe(LEAD)
    expect(resume('<digest>S</digest>', { resumeSilently: false })).toBe(LEAD)
  })
  it('adds the no-questions directive when resuming silently', () => {
    expect(resume('<digest>S</digest>', { resumeSilently: true }).startsWith(LEAD + '\n\n')).toBe(true)
    expect(sha(resume('<digest>S</digest>', { resumeSilently: true }).slice(LEAD.length + 2))).toBe('f87d03e04b68478fea27f3d20418b2b38580b274c794909064633945b528d396')
  })
})
