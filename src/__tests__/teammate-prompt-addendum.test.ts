import { describe, expect, it } from 'vitest'
import {
  TEAMMATE_ADDENDUM_HEADING,
  buildTeammatePromptAddendum,
} from '../team/teammateBrief'

/**
 * The teammate-side prompt addendum.
 * The two facts that must never drift: an untrusted child is told it has NO
 * messaging tool (it runs `safe_code`, which carries none), and every child
 * is told its final message IS the report (delivery is automatic in Velloc;
 * the teammate does not call SendMessage to report).
 */
describe('buildTeammatePromptAddendum', () => {
  it('names the teammate, the lead, and the automatic end-of-turn report', () => {
    const text = buildTeammatePromptAddendum({ teammateName: '程序员-小民', untrusted: false })
    expect(text.startsWith(TEAMMATE_ADDENDUM_HEADING)).toBe(true)
    expect(text).toContain('You are "程序员-小民"')
    expect(text).toContain('"team-lead"')
    expect(text).toContain('FINAL message is delivered to the lead')
    expect(text).toContain('cannot ask the user anything')
    expect(text).toContain('Do not spawn agents or teammates')
    expect(text).toContain('go idle')
  })

  it('a TRUSTED teammate is told to use SendMessage to reach the lead mid-turn', () => {
    const text = buildTeammatePromptAddendum({ teammateName: 'worker-a', untrusted: false })
    expect(text).toContain('`SendMessage` with `to: "team-lead"`')
    expect(text).not.toContain('no messaging tool')
  })

  it('an UNTRUSTED teammate is told it has no messaging tool — its report is the only channel', () => {
    const text = buildTeammatePromptAddendum({ teammateName: 'worker-a', untrusted: true })
    expect(text).toContain('no messaging tool')
    expect(text).toContain('only channel')
    // Naming a tool a safe_code session cannot call would send it hunting.
    expect(text).not.toContain('SendMessage')
  })

  it('names the prepared directory when the lead gave one', () => {
    expect(
      buildTeammatePromptAddendum({ teammateName: 'w', untrusted: true, cwd: '/repo/wt-a' }),
    ).toContain('(`/repo/wt-a`)')
    expect(
      buildTeammatePromptAddendum({ teammateName: 'w', untrusted: true }),
    ).toContain('Work where you were pointed. Everything')
  })

  it('tells an UNTRUSTED teammate where its wall is, and that a refusal is final', () => {
    // An untrusted teammate spent 14 minutes and 85 tool calls
    // hunting for C++ sources its worktree did not contain — its brief had
    // promised everything was there — and read a `Denied: the path is
    // outside this session's allowed root` as one more angle to route
    // around rather than as the answer. Nothing in its prompt said a wall
    // existed. `safe_code`'s own template says nothing about it either.
    const text = buildTeammatePromptAddendum({
      teammateName: 'w',
      untrusted: true,
      cwd: '/repo/wt-a',
      readRoot: '/repo/wt-a',
    })
    expect(text).toContain('WALLED IN to `/repo/wt-a`')
    expect(text).toContain('is FINAL')
    expect(text).toContain('stop looking')
    expect(text).toContain('If the lead asks you to work somewhere else, you cannot')
  })

  it('names the BOUNDARY, which is not always the cwd', () => {
    // The boundary falls back to the project root when the lead prepared no
    // directory, so inferring it from `cwd` would leave the child either
    // unwalled in the text or walled at the wrong path.
    expect(
      buildTeammatePromptAddendum({
        teammateName: 'w',
        untrusted: true,
        readRoot: '/repo',
      }),
    ).toContain('WALLED IN to `/repo`')
    // No boundary reported at all (a trusted-template child that still took
    // this branch): generic, never an empty pair of backticks.
    expect(
      buildTeammatePromptAddendum({ teammateName: 'w', untrusted: true }),
    ).toContain('WALLED IN to your working directory')
  })

  it('a TRUSTED teammate gets no wall text — it has none', () => {
    expect(
      buildTeammatePromptAddendum({
        teammateName: 'w',
        untrusted: false,
        cwd: '/repo/wt-a',
      }),
    ).not.toContain('WALLED IN')
  })

  it('falls back to a generic name rather than an empty one', () => {
    expect(buildTeammatePromptAddendum({ teammateName: '  ', untrusted: false })).toContain(
      'You are "teammate"',
    )
  })
})
