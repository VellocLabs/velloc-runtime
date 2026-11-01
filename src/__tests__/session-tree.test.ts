import { describe, expect, it } from 'vitest'
import {
  aggregateDescendantState,
  countDescendants,
  flattenSessionTree,
  nestSessions,
  rootOf,
  SESSION_TREE_MAX_DEPTH,
  type TreeableSession,
} from '../browser/webview/sessionTree'

// How the sidebar nests child rows: under a listed parent, one level per
// link, never for a team member or a detached session, and flat (reported)
// when the parent is missing, the chain loops, or it runs too deep. (F-36)

type Row = TreeableSession & { title: string }

function row(sessionId: string, extra: Partial<Row> = {}): Row {
  return { sessionId, title: sessionId, ...extra }
}

const ids = (rows: readonly Row[]) => rows.map(r => r.sessionId)

describe('nestSessions', () => {
  it('nests a child under its listed parent and keeps every order as given', () => {
    const tree = nestSessions([
      row('c2', { parentSessionId: 'p', lineageKind: 'side_session' }),
      row('p'),
      row('q'),
      row('c1', { parentSessionId: 'p', lineageKind: 'fork' }),
    ])
    expect(ids(tree.roots)).toEqual(['p', 'q'])
    expect(ids(tree.childrenOf.get('p')!)).toEqual(['c2', 'c1'])
    expect(tree.depthOf.get('c1')).toBe(1)
    expect(tree.depthOf.get('p')).toBe(0)
    expect(tree.fallbackIds).toEqual([])
  })

  it('nests several levels deep', () => {
    const tree = nestSessions([
      row('p'),
      row('c', { parentSessionId: 'p', lineageKind: 'side_session' }),
      row('g', { parentSessionId: 'c', lineageKind: 'hand_off' }),
    ])
    expect(ids(tree.roots)).toEqual(['p'])
    expect(tree.depthOf.get('g')).toBe(2)
    expect(ids(flattenSessionTree(tree.roots, tree.childrenOf))).toEqual(['p', 'c', 'g'])
    expect(countDescendants('p', tree.childrenOf)).toBe(2)
    expect(rootOf('g', tree)).toBe('p')
  })

  it('draws a child whose parent is not listed at the top level and reports it', () => {
    const tree = nestSessions([row('orphan', { parentSessionId: 'gone', lineageKind: 'fork' })])
    expect(ids(tree.roots)).toEqual(['orphan'])
    expect(tree.depthOf.get('orphan')).toBe(0)
    expect(tree.fallbackIds).toEqual(['orphan'])
  })

  it('breaks a cycle at one link, keeps every row, and reports the break', () => {
    const tree = nestSessions([
      row('a', { parentSessionId: 'b', lineageKind: 'side_session' }),
      row('b', { parentSessionId: 'a', lineageKind: 'side_session' }),
    ])
    const drawn = flattenSessionTree(tree.roots, tree.childrenOf)
    expect(ids(drawn).sort()).toEqual(['a', 'b'])
    expect(tree.roots).toHaveLength(1)
    expect(tree.fallbackIds).toHaveLength(1)
    // A row naming itself is the shortest cycle: top-level, reported.
    const self = nestSessions([row('me', { parentSessionId: 'me', lineageKind: 'fork' })])
    expect(self.depthOf.get('me')).toBe(0)
    expect(self.fallbackIds).toEqual(['me'])
  })

  it('flattens a chain past the depth cap from where it exceeds it', () => {
    const rows: Row[] = [row('r0')]
    for (let i = 1; i <= SESSION_TREE_MAX_DEPTH + 2; i++) {
      rows.push(row(`r${i}`, { parentSessionId: `r${i - 1}`, lineageKind: 'side_session' }))
    }
    const tree = nestSessions(rows)
    expect(tree.depthOf.get(`r${SESSION_TREE_MAX_DEPTH}`)).toBe(SESSION_TREE_MAX_DEPTH)
    expect(tree.depthOf.get(`r${SESSION_TREE_MAX_DEPTH + 1}`)).toBe(0)
    expect(tree.fallbackIds).toEqual([`r${SESSION_TREE_MAX_DEPTH + 1}`])
    // The row below the break nests under the new top-level row.
    expect(tree.depthOf.get(`r${SESSION_TREE_MAX_DEPTH + 2}`)).toBe(1)
    expect(flattenSessionTree(tree.roots, tree.childrenOf)).toHaveLength(rows.length)
  })

  it('never nests a team member or a detached session, and reports neither', () => {
    const tree = nestSessions([
      row('lead'),
      row('mate', { parentSessionId: 'lead', lineageKind: 'team' }),
      row('loose', { parentSessionId: 'lead', lineageKind: 'side_session', detached: true }),
    ])
    expect(ids(tree.roots)).toEqual(['lead', 'mate', 'loose'])
    expect(tree.childrenOf.has('lead')).toBe(false)
    expect(tree.fallbackIds).toEqual([])
  })
})

describe('flattenSessionTree', () => {
  it('skips the children of a collapsed parent, at every depth below it', () => {
    const tree = nestSessions([
      row('p'),
      row('c', { parentSessionId: 'p', lineageKind: 'side_session' }),
      row('g', { parentSessionId: 'c', lineageKind: 'side_session' }),
      row('q'),
    ])
    expect(ids(flattenSessionTree(tree.roots, tree.childrenOf, new Set(['p'])))).toEqual(['p', 'q'])
    expect(ids(flattenSessionTree(tree.roots, tree.childrenOf, new Set(['c'])))).toEqual(['p', 'c', 'q'])
  })
})

describe('aggregateDescendantState', () => {
  it('reports a running or waiting descendant at any depth, not the row itself', () => {
    const tree = nestSessions([
      row('p', { running: true }),
      row('c', { parentSessionId: 'p', lineageKind: 'side_session' }),
      row('g', { parentSessionId: 'c', lineageKind: 'side_session', needsAnswer: true }),
    ])
    expect(aggregateDescendantState('p', tree.childrenOf)).toEqual({
      running: false,
      needsAnswer: true,
    })
    expect(aggregateDescendantState('g', tree.childrenOf)).toEqual({
      running: false,
      needsAnswer: false,
    })
  })
})
