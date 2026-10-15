import { beforeEach, describe, expect, it } from 'vitest'
import {
  SKILL_EVENT_LOG_MAX,
  __resetSkillInvocationLogForTests,
  clearSkillInvocationLogForSession,
  getAllSkillInvocationEvents,
  getSkillInvocationEventsForAgent,
  recordSkillInvocationEvent,
  seedSkillInvocationEvents,
  setSkillEventLogPersister,
  type SkillInvocationEvent,
} from '../skillLibrary/skillInvocationLog'

const ev = (over: Partial<SkillInvocationEvent> = {}): SkillInvocationEvent => ({
  id: 'e1',
  skillName: 'pdf',
  skillPath: '/s/pdf/SKILL.md',
  invokedAt: 1000,
  status: 'loaded',
  agentId: null,
  ...over,
})

describe('skillInvocationLog — event log', () => {
  beforeEach(() => __resetSkillInvocationLogForTests())

  it('appends events and returns them newest-first, scoped by agent', () => {
    recordSkillInvocationEvent('S1', ev({ id: 'a', invokedAt: 1 }))
    recordSkillInvocationEvent(
      'S1',
      ev({ id: 'b', invokedAt: 2, status: 'failed' }),
    )
    recordSkillInvocationEvent('S1', ev({ id: 'c', invokedAt: 3, agentId: 'fork-1' }))
    // Main scope (agentId null): newest-first, fork event excluded.
    expect(getSkillInvocationEventsForAgent('S1', null).map(e => e.id)).toEqual([
      'b',
      'a',
    ])
    expect(
      getSkillInvocationEventsForAgent('S1', 'fork-1').map(e => e.id),
    ).toEqual(['c'])
  })

  it('ignores unkeyable events (no session id / no skill name)', () => {
    recordSkillInvocationEvent('', ev())
    recordSkillInvocationEvent('S1', ev({ skillName: '' }))
    expect(getSkillInvocationEventsForAgent('S1', null)).toEqual([])
  })

  it('caps the log at SKILL_EVENT_LOG_MAX, dropping the oldest first', () => {
    for (let i = 0; i < SKILL_EVENT_LOG_MAX + 5; i++) {
      recordSkillInvocationEvent('S1', ev({ id: `e${i}`, invokedAt: i }))
    }
    const events = getSkillInvocationEventsForAgent('S1', null)
    expect(events.length).toBe(SKILL_EVENT_LOG_MAX)
    // Newest retained at the front; the first five appended are gone.
    expect(events[0]!.id).toBe(`e${SKILL_EVENT_LOG_MAX + 4}`)
    expect(events.some(e => e.id === 'e0')).toBe(false)
  })

  it('clearSkillInvocationLogForSession drops just that session', () => {
    recordSkillInvocationEvent('S1', ev())
    recordSkillInvocationEvent('S2', ev())
    clearSkillInvocationLogForSession('S1')
    expect(getSkillInvocationEventsForAgent('S1', null)).toEqual([])
    expect(getSkillInvocationEventsForAgent('S2', null).length).toBe(1)
  })
})

describe('skillInvocationLog — restart-persistence seam', () => {
  beforeEach(() => __resetSkillInvocationLogForTests())

  it('getAllSkillInvocationEvents returns every agent scope, oldest-first, as a copy', () => {
    recordSkillInvocationEvent('S1', ev({ id: 'a', invokedAt: 1 }))
    recordSkillInvocationEvent('S1', ev({ id: 'b', invokedAt: 2, agentId: 'fork-1' }))
    recordSkillInvocationEvent('S1', ev({ id: 'c', invokedAt: 3 }))
    // Stored order (append/oldest-first), main + fork scopes together — the
    // on-disk serialization order.
    expect(getAllSkillInvocationEvents('S1').map(e => e.id)).toEqual(['a', 'b', 'c'])
    // A copy: mutating the result must not corrupt the live log.
    getAllSkillInvocationEvents('S1').push(ev({ id: 'x' }))
    expect(getAllSkillInvocationEvents('S1').map(e => e.id)).toEqual(['a', 'b', 'c'])
    expect(getAllSkillInvocationEvents('unknown')).toEqual([])
  })

  it('recordSkillInvocationEvent notifies the registered persister with the session id', () => {
    const seen: string[] = []
    setSkillEventLogPersister(sid => seen.push(sid))
    recordSkillInvocationEvent('S1', ev({ id: 'a' }))
    recordSkillInvocationEvent('S2', ev({ id: 'b' }))
    // An unkeyable event returns before notifying.
    recordSkillInvocationEvent('', ev())
    recordSkillInvocationEvent('S1', ev({ skillName: '' }))
    expect(seen).toEqual(['S1', 'S2'])
  })

  it('__reset clears the persister so a later record does not notify a stale closure', () => {
    const seen: string[] = []
    setSkillEventLogPersister(sid => seen.push(sid))
    __resetSkillInvocationLogForTests()
    recordSkillInvocationEvent('S1', ev())
    expect(seen).toEqual([])
  })

  describe('seedSkillInvocationEvents', () => {
    it('seeds an empty log (returns true) and is readable newest-first', () => {
      expect(
        seedSkillInvocationEvents('S1', [
          ev({ id: 'a', invokedAt: 1 }),
          ev({ id: 'b', invokedAt: 2 }),
        ]),
      ).toBe(true)
      expect(getSkillInvocationEventsForAgent('S1', null).map(e => e.id)).toEqual([
        'b',
        'a',
      ])
    })

    it('merges recovered (older) BEFORE current (newer), so a post-restart invocation never drops the pre-restart history', () => {
      // The first invocation after a restart lands in memory BEFORE recovery runs.
      recordSkillInvocationEvent('S1', ev({ id: 'new', invokedAt: 5 }))
      expect(
        seedSkillInvocationEvents('S1', [
          ev({ id: 'old1', invokedAt: 1 }),
          ev({ id: 'old2', invokedAt: 2 }),
        ]),
      ).toBe(true)
      // Serialization order is recovered-first then the in-memory newer event —
      // so the very next persist writes the FULL history, not just `new`.
      expect(getAllSkillInvocationEvents('S1').map(e => e.id)).toEqual([
        'old1',
        'old2',
        'new',
      ])
    })

    it('is idempotent — re-seeding the same set is a no-op returning false', () => {
      seedSkillInvocationEvents('S1', [ev({ id: 'a', invokedAt: 1 })])
      expect(seedSkillInvocationEvents('S1', [ev({ id: 'a', invokedAt: 1 })])).toBe(
        false,
      )
      expect(getAllSkillInvocationEvents('S1').map(e => e.id)).toEqual(['a'])
    })

    it('dedupes an id already held in memory (a re-run recovery)', () => {
      recordSkillInvocationEvent('S1', ev({ id: 'dup', invokedAt: 1 }))
      expect(
        seedSkillInvocationEvents('S1', [
          ev({ id: 'older', invokedAt: 0 }),
          ev({ id: 'dup', invokedAt: 1 }),
        ]),
      ).toBe(true)
      expect(getAllSkillInvocationEvents('S1').map(e => e.id)).toEqual([
        'older',
        'dup',
      ])
    })

    it('caps the merged log at SKILL_EVENT_LOG_MAX, keeping the newest', () => {
      const recovered = Array.from({ length: SKILL_EVENT_LOG_MAX + 5 }, (_, i) =>
        ev({ id: `e${i}`, invokedAt: i }),
      )
      seedSkillInvocationEvents('S1', recovered)
      const all = getAllSkillInvocationEvents('S1')
      expect(all.length).toBe(SKILL_EVENT_LOG_MAX)
      expect(all[all.length - 1]!.id).toBe(`e${SKILL_EVENT_LOG_MAX + 4}`)
      expect(all.some(e => e.id === 'e0')).toBe(false)
    })

    it('ignores empty / unkeyable input and drops malformed events', () => {
      expect(seedSkillInvocationEvents('S1', [])).toBe(false)
      expect(seedSkillInvocationEvents('', [ev()])).toBe(false)
      seedSkillInvocationEvents('S1', [
        ev({ id: '' }),
        ev({ id: 'good', skillName: 'pdf' }),
        ev({ id: 'x', skillName: '' }),
      ])
      expect(getAllSkillInvocationEvents('S1').map(e => e.id)).toEqual(['good'])
    })
  })
})
