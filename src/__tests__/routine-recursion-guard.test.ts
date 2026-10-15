/**
 * The recursion guard: a scheduled routine cannot register more routines, including from a session-delivered fire
 * (a hidden turn where `isHeadless` is false), via the turn-scope marker. A failure here is security-shaped.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { routineRecursionDenial } from '../toolkit/builtin/routineRecursionGuard'
import {
  __resetRoutineTurnScopeForTests,
  beginRoutineFireTurn,
  endRoutineFireTurn,
  getRoutineFireTurn,
  isRoutineFireTurn,
} from '../routines/routineTurnScope'

afterEach(() => {
  __resetRoutineTurnScopeForTests()
})

describe('routineTurnScope', () => {
  it('begin marks the session, end clears it', () => {
    expect(isRoutineFireTurn('s1')).toBe(false)
    beginRoutineFireTurn('s1', 'rt_1')
    expect(isRoutineFireTurn('s1')).toBe(true)
    expect(getRoutineFireTurn('s1')).toBe('rt_1')
    endRoutineFireTurn('s1')
    expect(isRoutineFireTurn('s1')).toBe(false)
    expect(getRoutineFireTurn('s1')).toBeUndefined()
  })

  it('is scoped per session — one fire does not gate other conversations', () => {
    beginRoutineFireTurn('s1', 'rt_1')
    expect(isRoutineFireTurn('s1')).toBe(true)
    expect(isRoutineFireTurn('s2')).toBe(false)
  })

  it('an undefined sessionId is never treated as a routine fire', () => {
    // Test contexts and some tool paths carry no session id; failing OPEN
    // here is correct (the isHeadless arm still covers headless runs) and
    // failing closed would break ordinary CronCreate calls.
    expect(isRoutineFireTurn(undefined)).toBe(false)
    expect(isRoutineFireTurn('')).toBe(false)
  })

  it('clearing an unset session is a harmless no-op', () => {
    expect(() => endRoutineFireTurn('never-set')).not.toThrow()
  })

  it('survives a throwing turn body when end runs in a finally', () => {
    // Mirrors AgentRuntimeWorker.executeSubmit's try/finally. A stuck
    // marker would permanently disable CronCreate for that session.
    expect(() => {
      try {
        beginRoutineFireTurn('s1', 'rt_1')
        throw new Error('turn blew up')
      } finally {
        endRoutineFireTurn('s1')
      }
    }).toThrow('turn blew up')
    expect(isRoutineFireTurn('s1')).toBe(false)
  })
})

const TOOLS: Array<{ name: string; errorCode: number }> = [
  { name: 'CronCreate', errorCode: 6 },
  { name: 'ScheduleCron', errorCode: 6 },
  { name: 'RemoteTrigger.register', errorCode: 8 },
]

describe('routineRecursionDenial', () => {
  for (const tool of TOOLS) {
    describe(tool.name, () => {
      it('allows an ordinary user turn', () => {
        expect(
          routineRecursionDenial(
            { sessionId: 's1' },
            tool.name,
            tool.errorCode,
          ),
        ).toBeNull()
      })

      it('denies a headless routine session', () => {
        const denial = routineRecursionDenial(
          { isHeadless: true, sessionId: 'headless-1' },
          tool.name,
          tool.errorCode,
        )
        expect(denial).not.toBeNull()
        expect(denial!.result).toBe(false)
        expect(denial!.errorCode).toBe(tool.errorCode)
        expect(denial!.message).toContain(tool.name)
      })

      it('denies a session-delivered fire, where isHeadless is FALSE', () => {
        // The regression this whole module exists for.
        beginRoutineFireTurn('s1', 'rt_loop')
        const denial = routineRecursionDenial(
          { isHeadless: false, sessionId: 's1' },
          tool.name,
          tool.errorCode,
        )
        expect(denial).not.toBeNull()
        expect(denial!.errorCode).toBe(tool.errorCode)
      })

      it('allows again once the fired turn ends', () => {
        beginRoutineFireTurn('s1', 'rt_loop')
        endRoutineFireTurn('s1')
        expect(
          routineRecursionDenial(
            { sessionId: 's1' },
            tool.name,
            tool.errorCode,
          ),
        ).toBeNull()
      })

      it('does not deny a DIFFERENT session while one is mid-fire', () => {
        beginRoutineFireTurn('s1', 'rt_loop')
        expect(
          routineRecursionDenial(
            { sessionId: 's2' },
            tool.name,
            tool.errorCode,
          ),
        ).toBeNull()
      })
    })
  }
})
