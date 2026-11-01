import { describe, expect, it } from 'vitest'
import { buildSessionSummaryFromMetadata } from '../sessions/sessionStore'

// The list entry carries the relation the runtime computed, never the raw
// origin: the page nests rows by `parentSessionId` and shows nothing else.

describe('buildSessionSummaryFromMetadata — lineage', () => {
  it('lists a model-started child under its origin with the family name', () => {
    const summary = buildSessionSummaryFromMetadata('c', 1, {
      spawnedFrom: { sessionId: 'p', taskId: 't', kind: 'hand_off', initiator: 'model', name: 'parser-review' },
    })
    expect(summary).toMatchObject({ parentSessionId: 'p', lineageKind: 'hand_off', familyName: 'parser-review' })
    expect(summary?.detached).toBeUndefined()
  })

  it('lists a user fork under the session it was copied from', () => {
    const summary = buildSessionSummaryFromMetadata('f', 1, { forkedFromSessionId: 's', forkedAtMessageUuid: 'u' })
    expect(summary).toMatchObject({ parentSessionId: 's', lineageKind: 'fork' })
    expect(summary?.familyName).toBeUndefined()
  })

  it('lists a teammate under its lead as a team child named by its member name', () => {
    const summary = buildSessionSummaryFromMetadata('t', 1, { spawnerSessionId: 'lead', teammateName: 'worker-a' })
    expect(summary).toMatchObject({
      spawnerSessionId: 'lead',
      teammateName: 'worker-a',
      parentSessionId: 'lead',
      lineageKind: 'team',
      familyName: 'worker-a',
    })
  })

  it('lists a detached child top-level and says so', () => {
    const summary = buildSessionSummaryFromMetadata('d', 1, {
      spawnedFrom: { sessionId: 'p', taskId: 't', kind: 'side_session', initiator: 'model' },
      lineageDetached: true,
    })
    expect(summary?.parentSessionId).toBeUndefined()
    expect(summary?.lineageKind).toBeUndefined()
    expect(summary?.detached).toBe(true)
  })

  it('carries none of it for a top-level session', () => {
    const summary = buildSessionSummaryFromMetadata('s', 1, { firstPrompt: 'hi', lineageDetached: true })
    expect(summary?.parentSessionId).toBeUndefined()
    expect(summary?.detached).toBeUndefined()
    expect(summary?.familyName).toBeUndefined()
  })
})
