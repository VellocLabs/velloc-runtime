import { describe, expect, it } from 'vitest'
import {
  FAMILY_DEPTH_LIMIT,
  FAMILY_NAME_MAX_CHARS,
  FAMILY_NAME_PATTERN,
  allocateFamilyName,
  effectiveParentId,
  familyNameBase,
  familyOf,
  familyRootOf,
  isDelegated,
  isDetached,
  isSessionOrigin,
  originOf,
  reportTargetOf,
  resolveLineage,
  type SessionLineageInput,
  type SessionOrigin,
} from '../sessions/sessionLineage'

// A child session records where it came from; everything the list, the
// parent's model and the report path need is computed from that record.
// These pin the four answers apart: shown under, controlled by, copied from,
// reported to.

const started = (sessionId: string, extra: Partial<SessionOrigin> = {}): SessionOrigin => ({
  sessionId,
  taskId: 'task_1',
  kind: 'side_session',
  initiator: 'model',
  ...extra,
})

describe('resolveLineage', () => {
  it('is null for a session nobody started', () => {
    expect(resolveLineage({})).toBeNull()
    expect(effectiveParentId({})).toBeNull()
  })

  it('is the origin, model-initiated, for a fresh child the origin started', () => {
    const meta: SessionLineageInput = { spawnedFrom: started('A') }
    expect(resolveLineage(meta)).toEqual({ sessionId: 'A', kind: 'side_session', initiator: 'model' })
    expect(isDelegated(meta)).toBe(true)
  })

  it('keeps the model relation when the transcript was copied from the origin itself', () => {
    const meta: SessionLineageInput = {
      spawnedFrom: started('A', { kind: 'hand_off' }),
      forkedFromSessionId: 'A',
    }
    expect(resolveLineage(meta)).toEqual({ sessionId: 'A', kind: 'hand_off', initiator: 'model' })
  })

  it('is a user fork, with its cut, when a person forked the session', () => {
    const meta: SessionLineageInput = { forkedFromSessionId: 'B', forkedAtMessageUuid: 'u9' }
    expect(resolveLineage(meta)).toEqual({ sessionId: 'B', kind: 'fork', initiator: 'user', atMessageUuid: 'u9' })
    expect(isDelegated(meta)).toBe(false)
  })

  it('is a user fork when the origin is marked as one, whatever else it says', () => {
    const meta: SessionLineageInput = { spawnedFrom: started('A', { userFork: true }), forkedFromSessionId: 'A' }
    expect(resolveLineage(meta)).toEqual({ sessionId: 'A', kind: 'fork', initiator: 'user' })
  })

  it('separates the copy source from the delegation source: A starts B, a person forks B into C', () => {
    // C inherits A as its origin but was copied from B: it is shown under B as
    // a fork, A's model does not control it, and the two ids stay distinct.
    const c: SessionLineageInput = { spawnedFrom: started('A'), forkedFromSessionId: 'B' }
    expect(resolveLineage(c)).toEqual({ sessionId: 'B', kind: 'fork', initiator: 'user' })
    expect(isDelegated(c)).toBe(false)
    expect(originOf(c)?.sessionId).toBe('A')
  })

  it('is a suggested task when a person started a proposed session', () => {
    const meta: SessionLineageInput = { spawnedFrom: started('A', { initiator: 'user' }) }
    expect(resolveLineage(meta)).toEqual({ sessionId: 'A', kind: 'side_session', initiator: 'model' })
    // The origin's own `initiator` is who asked; the relation is still the
    // origin's model controlling the child unless a fork intervened.
    const proposed: SessionLineageInput = { spawnedFrom: started('A', { userFork: true }) }
    expect(resolveLineage(proposed)).toEqual({ sessionId: 'A', kind: 'suggested_task', initiator: 'user' })
    expect(isDelegated(proposed)).toBe(false)
  })

  it('reads a teammate link as a team origin', () => {
    const meta: SessionLineageInput = { spawnerSessionId: 'lead-1', teammateName: 'worker-a' }
    expect(originOf(meta)).toEqual({ sessionId: 'lead-1', taskId: '', kind: 'team', initiator: 'model', name: 'worker-a' })
    expect(resolveLineage(meta)).toEqual({ sessionId: 'lead-1', kind: 'team', initiator: 'model' })
  })

  it('has no lineage once detached, while the origin stays on record', () => {
    const meta: SessionLineageInput = { spawnedFrom: started('A'), lineageDetached: true }
    expect(resolveLineage(meta)).toBeNull()
    expect(isDelegated(meta)).toBe(false)
    expect(isDetached(meta)).toBe(true)
    expect(originOf(meta)?.sessionId).toBe('A')
    // A top-level session with the flag set is not "detached": nothing to detach from.
    expect(isDetached({ lineageDetached: true })).toBe(false)
  })

  it('ignores a malformed stored origin', () => {
    expect(isSessionOrigin({ sessionId: 'A' })).toBe(false)
    expect(isSessionOrigin({ sessionId: '', taskId: 't', kind: 'side_session', initiator: 'model' })).toBe(false)
    expect(isSessionOrigin({ sessionId: 'A', taskId: 't', kind: 'other', initiator: 'model' })).toBe(false)
    expect(resolveLineage({ spawnedFrom: { sessionId: 'A' } as unknown as SessionOrigin })).toBeNull()
  })
})

describe('family', () => {
  const index = new Map<string, SessionLineageInput>([
    ['root', {}],
    ['b', { spawnedFrom: started('root') }],
    ['c', { spawnedFrom: started('b') }],
    ['c-fork', { forkedFromSessionId: 'c' }],
    ['loose', { spawnedFrom: started('root'), lineageDetached: true }],
    ['loose-child', { spawnedFrom: started('loose') }],
    ['other', {}],
  ])

  it('walks attached origins up to the root and back down over every descendant', () => {
    expect(familyRootOf('c', index)).toBe('root')
    expect(familyOf('c', index)).toEqual(['root', 'b', 'c'])
    expect(familyOf('root', index)).toEqual(['root', 'b', 'c'])
  })

  it('does not cross a user fork or a detached link', () => {
    // A fork is a copy, not a delegation: it is its own family.
    expect(familyOf('c-fork', index)).toEqual(['c-fork'])
    // The detached session is its own root, with its own descendants.
    expect(familyRootOf('loose-child', index)).toBe('loose')
    expect(familyOf('loose-child', index)).toEqual(['loose', 'loose-child'])
    expect(familyOf('root', index)).not.toContain('loose')
  })

  it('stops at a missing origin and keeps the session itself', () => {
    const orphan = new Map<string, SessionLineageInput>([['x', { spawnedFrom: started('gone') }]])
    expect(familyRootOf('x', orphan)).toBe('x')
    expect(familyOf('x', orphan)).toEqual(['x'])
    expect(familyOf('unknown', orphan)).toEqual(['unknown'])
  })

  it('survives a cycle and a chain past the depth limit', () => {
    const cycle = new Map<string, SessionLineageInput>([
      ['p', { spawnedFrom: started('q') }],
      ['q', { spawnedFrom: started('p') }],
    ])
    expect(familyRootOf('p', cycle)).toBe('q')
    expect(familyOf('p', cycle).sort()).toEqual(['p', 'q'])
    const deep = new Map<string, SessionLineageInput>([['s0', {}]])
    for (let i = 1; i <= FAMILY_DEPTH_LIMIT + 5; i++) deep.set(`s${i}`, { spawnedFrom: started(`s${i - 1}`) })
    const tail = `s${FAMILY_DEPTH_LIMIT + 5}`
    expect(familyRootOf(tail, deep)).toBe('s5')
    expect(familyOf('s0', deep)).toHaveLength(FAMILY_DEPTH_LIMIT + 1)
  })
})

describe('reportTargetOf', () => {
  const index = new Map<string, SessionLineageInput>([
    ['a', {}],
    ['b', { spawnedFrom: started('a') }],
    ['c', { spawnedFrom: started('b') }],
    ['d', { spawnedFrom: started('c'), lineageDetached: true }],
    ['f', { forkedFromSessionId: 'c' }],
  ])

  it('reports to the nearest origin that still exists, past ones that do not', () => {
    const all = () => true
    expect(reportTargetOf('c', index, all)).toBe('b')
    expect(reportTargetOf('c', index, id => id !== 'b')).toBe('a')
  })

  it('has no target when detached, when the chain ends, or for a user fork', () => {
    const all = () => true
    expect(reportTargetOf('d', index, all)).toBeNull()
    expect(reportTargetOf('a', index, all)).toBeNull()
    expect(reportTargetOf('c', index, () => false)).toBeNull()
    expect(reportTargetOf('f', index, all)).toBeNull()
  })
})

describe('family names', () => {
  it('slugs the explicit name, else the title, else a fixed word', () => {
    expect(familyNameBase('Parser Review', 'ignored')).toBe('parser-review')
    expect(familyNameBase(undefined, 'Fix the  CSV_import!')).toBe('fix-the-csv-import')
    expect(familyNameBase('程序员', '测试')).toBe('session')
    expect(familyNameBase(undefined, undefined)).toBe('session')
  })

  it('caps a name without ending on a hyphen', () => {
    const name = familyNameBase('a very long session title that keeps going', undefined)
    expect(name.length).toBeLessThanOrEqual(FAMILY_NAME_MAX_CHARS)
    expect(name).toMatch(FAMILY_NAME_PATTERN)
    expect(name.endsWith('-')).toBe(false)
  })

  it('takes the base when free, then numbers it, then adds a random suffix it also checks', () => {
    expect(allocateFamilyName('review', new Set())).toBe('review')
    expect(allocateFamilyName('review', new Set(['review']))).toBe('review-2')
    expect(allocateFamilyName('review', new Set(['review', 'review-2']))).toBe('review-3')
    const taken = new Set<string>(['review'])
    for (let n = 2; n <= 99; n++) taken.add(`review-${n}`)
    const suffixes = ['zz', 'ok']
    taken.add('review-zz')
    expect(allocateFamilyName('review', taken, () => suffixes.shift() ?? 'xx')).toBe('review-ok')
  })

  it('never hands out a reserved name and keeps a suffixed name within the cap', () => {
    expect(allocateFamilyName('parent', new Set())).toBe('parent-2')
    expect(allocateFamilyName('self', new Set())).toBe('self-2')
    const long = 'x'.repeat(FAMILY_NAME_MAX_CHARS)
    const second = allocateFamilyName(long, new Set([long]))
    expect(second.length).toBeLessThanOrEqual(FAMILY_NAME_MAX_CHARS)
    expect(second.endsWith('-2')).toBe(true)
  })
})
