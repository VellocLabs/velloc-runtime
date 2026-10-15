import { describe, expect, it } from 'vitest'
import {
  buildProjectTree,
  isSandboxProjectRoot,
  normalizeProjectPath,
} from '../browser/webview/projectTree'
import { getNexusWorkspaceDirForType } from '../utils/conversationStoragePaths'

type Session = {
  sessionId: string
  projectRoot?: string
  updatedAt: number
  lastComposerEditAt?: number
}

function session(
  sessionId: string,
  updatedAt: number,
  projectRoot?: string,
): Session {
  return { sessionId, updatedAt, ...(projectRoot ? { projectRoot } : {}) }
}

describe('normalizeProjectPath', () => {
  it('trims trailing separators so both shapes of the same folder collapse', () => {
    // `resolveProjectRoot` returns its result WITH a trailing separator; a path
    // straight from the picker has none. Same folder, one node.
    expect(normalizeProjectPath('D:\\work\\repo\\')).toBe('D:\\work\\repo')
    expect(normalizeProjectPath('/home/me/repo/')).toBe('/home/me/repo')
    expect(normalizeProjectPath('  /home/me/repo  ')).toBe('/home/me/repo')
  })

  it('preserves case — the on-disk dir name is case-sensitive', () => {
    expect(normalizeProjectPath('/Repo')).toBe('/Repo')
  })
})

describe('isSandboxProjectRoot', () => {
  it('recognises the bare shared workspace', () => {
    expect(isSandboxProjectRoot('/home/me/.velloc/shared-workspace')).toBe(true)
    expect(isSandboxProjectRoot('/home/me/.velloc/shared-workspace/')).toBe(true)
  })

  it('recognises a per-type sandbox subdir', () => {
    expect(isSandboxProjectRoot('/home/me/.velloc/shared-workspace/agent')).toBe(
      true,
    )
    expect(isSandboxProjectRoot('/home/me/.velloc/shared-workspace/chat')).toBe(
      true,
    )
  })

  it('recognises Windows-separated sandbox roots', () => {
    expect(
      isSandboxProjectRoot('C:\\Users\\me\\.velloc\\shared-workspace\\agent'),
    ).toBe(true)
  })

  it('agrees with the real path builder for every live template type', () => {
    // Pins the predicate to the layout `getNexusWorkspaceDirForType` actually
    // produces, so a change to the on-disk shape cannot silently start leaking
    // sandbox pseudo-projects into the user's project list.
    for (const type of ['agent', 'chat', 'code', undefined]) {
      expect(
        isSandboxProjectRoot(getNexusWorkspaceDirForType('/home/me', type)),
      ).toBe(true)
    }
  })

  it('does not match a real project that merely contains the words', () => {
    expect(isSandboxProjectRoot('/home/me/code/shared-workspace')).toBe(false)
    expect(isSandboxProjectRoot('/home/me/.velloc-old/shared-workspace')).toBe(
      false,
    )
    expect(isSandboxProjectRoot('D:\\work\\repo')).toBe(false)
  })
})

describe('buildProjectTree', () => {
  it('groups sessions by their project root', () => {
    const tree = buildProjectTree(
      [
        session('a', 30, '/repo/one'),
        session('b', 20, '/repo/two'),
        session('c', 10, '/repo/one'),
      ],
      [],
    )
    expect(tree.map(n => n.path)).toEqual(['/repo/one', '/repo/two'])
    expect(tree[0].sessions.map(s => s.sessionId)).toEqual(['a', 'c'])
    expect(tree[0].isEmpty).toBe(false)
  })

  it('collapses trailing-separator variants of one folder into a single node', () => {
    const tree = buildProjectTree(
      [session('a', 30, '/repo/one'), session('b', 20, '/repo/one/')],
      [],
    )
    expect(tree).toHaveLength(1)
    expect(tree[0].sessions.map(s => s.sessionId)).toEqual(['a', 'b'])
  })

  it('excludes unbound sessions living in the shared sandbox', () => {
    const tree = buildProjectTree(
      [
        session('a', 30, '/home/me/.velloc/shared-workspace/agent'),
        session('b', 20, '/home/me/.velloc/shared-workspace'),
        session('c', 10, '/repo/one'),
      ],
      [],
    )
    expect(tree.map(n => n.path)).toEqual(['/repo/one'])
  })

  it('excludes sessions with no project root at all', () => {
    const tree = buildProjectTree([session('a', 30)], [])
    expect(tree).toEqual([])
  })

  it('includes an added project that has no sessions yet', () => {
    const tree = buildProjectTree([], ['/repo/fresh'])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({
      path: '/repo/fresh',
      name: 'fresh',
      isEmpty: true,
    })
    expect(tree[0].sessions).toEqual([])
  })

  it('emits ONE node when an added project also has sessions', () => {
    const tree = buildProjectTree(
      [session('a', 30, '/repo/one/')],
      ['/repo/one'],
    )
    expect(tree).toHaveLength(1)
    expect(tree[0].isEmpty).toBe(false)
    expect(tree[0].sessions.map(s => s.sessionId)).toEqual(['a'])
  })

  it('orders projects by their newest session, most recent first', () => {
    const tree = buildProjectTree(
      [
        session('a', 10, '/repo/old'),
        session('b', 90, '/repo/new'),
        session('c', 50, '/repo/mid'),
      ],
      [],
    )
    expect(tree.map(n => n.path)).toEqual(['/repo/new', '/repo/mid', '/repo/old'])
  })

  it('lets a pending composer draft float a project up', () => {
    const tree = buildProjectTree(
      [
        { sessionId: 'a', updatedAt: 10, lastComposerEditAt: 99, projectRoot: '/repo/drafting' },
        { sessionId: 'b', updatedAt: 50, projectRoot: '/repo/quiet' },
      ],
      [],
    )
    expect(tree.map(n => n.path)).toEqual(['/repo/drafting', '/repo/quiet'])
  })

  it('sorts empty projects after populated ones, newest addition first', () => {
    const tree = buildProjectTree(
      [session('a', 10, '/repo/used')],
      ['/repo/older', '/repo/newer'],
      new Map([
        ['/repo/older', 1],
        ['/repo/newer', 2],
      ]),
    )
    expect(tree.map(n => n.path)).toEqual([
      '/repo/used',
      '/repo/newer',
      '/repo/older',
    ])
  })

  it('never lists a sandbox path even if one is somehow in the added list', () => {
    const tree = buildProjectTree([], ['/home/me/.velloc/shared-workspace'])
    expect(tree).toEqual([])
  })

  it('derives the display name from the last path segment', () => {
    const tree = buildProjectTree([session('a', 1, 'D:\\work\\repo')], [])
    expect(tree[0].name).toBe('repo')
  })
})
