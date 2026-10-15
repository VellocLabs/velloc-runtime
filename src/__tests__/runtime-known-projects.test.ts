/**
 * Known projects (`runtimeHub/knownProjects.ts`): the folders a connection
 * below `full` may name. Pins what counts as known (the workspace index and
 * the sessions' folders, narrowed by a session-limited scope), that a match
 * returns the RUNTIME's spelling, what the match tolerates (separators,
 * trailing separators, case on a Windows path) and what it never does
 * (resolve `..`, match a prefix, accept a non-string).
 */
import { describe, expect, it } from 'vitest'
import {
  knownProjectRootOrRefuse,
  knownProjectRoots,
  matchKnownProjectRoot,
} from '../browser/runtimeHub'
import { EMPTY_WORKSPACE_STATE, type WorkspaceState } from '../utils/workspaceState'

const workspace: WorkspaceState = {
  ...EMPTY_WORKSPACE_STATE,
  projects: [{ path: '/repo', addedAt: 1 }],
  recentFolders: [{ path: 'C:\\Work\\Api', name: 'Api', lastUsedAt: 2 }],
  lastFolderByType: { code: '/code-last' },
}
const sessions = [
  { sessionId: 's1', projectRoot: '/s1-root' },
  { sessionId: 's2', projectRoot: '/s2-root' },
]

describe('knownProjectRoots', () => {
  it('an unrestricted connection knows the workspace index and every session folder', () => {
    expect(knownProjectRoots({ workspace, sessions }, 'all')).toEqual([
      '/repo',
      'C:\\Work\\Api',
      '/code-last',
      '/s1-root',
      '/s2-root',
    ])
  })

  it('a session-limited connection knows only its own sessions\u2019 folders', () => {
    expect(knownProjectRoots({ workspace, sessions }, ['s2'])).toEqual(['/s2-root'])
  })

  it('an unreadable workspace index leaves the session folders; blank entries are dropped', () => {
    expect(
      knownProjectRoots({ workspace: null, sessions: [...sessions, { sessionId: 's3', projectRoot: '  ' }] }, 'all'),
    ).toEqual(['/s1-root', '/s2-root'])
  })
})

describe('matchKnownProjectRoot', () => {
  const known = knownProjectRoots({ workspace, sessions }, 'all')

  it('returns the runtime\u2019s own spelling, whatever separators the client used', () => {
    expect(matchKnownProjectRoot('/repo', known)).toBe('/repo')
    expect(matchKnownProjectRoot('/repo/', known)).toBe('/repo')
    expect(matchKnownProjectRoot('c:/work/api/', known)).toBe('C:\\Work\\Api')
    expect(matchKnownProjectRoot('  C:\\WORK\\API\\ ', known)).toBe('C:\\Work\\Api')
  })

  it('is case-sensitive on a POSIX path, and never resolves `..` or matches a prefix', () => {
    expect(matchKnownProjectRoot('/Repo', known)).toBeNull()
    expect(matchKnownProjectRoot('/repo/../etc', known)).toBeNull()
    expect(matchKnownProjectRoot('/repo/sub', known)).toBeNull()
    expect(matchKnownProjectRoot('/re', known)).toBeNull()
    expect(matchKnownProjectRoot('', known)).toBeNull()
    expect(matchKnownProjectRoot('/', known)).toBeNull()
    expect(matchKnownProjectRoot('/', ['/'])).toBe('/')
  })
})

describe('knownProjectRootOrRefuse', () => {
  /** The wire error a call throws (a plain `WireError` object), or null. */
  const refusal = (fn: () => unknown): unknown => {
    try {
      fn()
      return null
    } catch (error) {
      return error
    }
  }

  it('answers the runtime\u2019s spelling, or refuses with forbidden_scope naming the route', () => {
    expect(knownProjectRootOrRefuse('/repo/', ['/repo'], 'session.open')).toBe('/repo')
    expect(refusal(() => knownProjectRootOrRefuse('/etc', ['/repo'], 'session.open'))).toMatchObject({
      code: 'forbidden_scope',
      message: expect.stringContaining('session.open'),
    })
    expect(refusal(() => knownProjectRootOrRefuse(42, ['/repo'], 'x.y'))).toMatchObject({ code: 'forbidden_scope' })
  })
})
