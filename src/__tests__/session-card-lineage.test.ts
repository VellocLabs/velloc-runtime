import { describe, expect, it } from 'vitest'
import { projectSessionInfo } from '../browser/worker/sessionInfoProjection'
import {
  buildSessionSummaryFromMeta,
  SESSION_META_FILE_SCHEMA_VERSION,
  type SessionMetaFile,
} from '../sessions/sessionStore'

// The session card the page lists carries the relation computed on the
// persisted record (F-36): the parent it is listed under, the kind, the
// family name and the detached flag. Without them the page nests nothing.

const meta = (fields: Partial<SessionMetaFile>): SessionMetaFile => ({
  schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
  sessionId: 'child',
  updatedAt: 1_000,
  metadata: {},
  ...fields,
})

const card = (fs: SessionMetaFile, entry?: { templateType?: string; snapshot: { initialized: boolean; messageCount?: number } }) =>
  projectSessionInfo({
    sessionId: 'child',
    entry: entry as never,
    live: undefined,
    fs: buildSessionSummaryFromMeta(fs) ?? undefined,
  })

describe('the session card carries the relation', () => {
  it('a fork is listed under its copy source', () => {
    const fork = card(meta({ metadata: { forkedFromSessionId: 'source', forkedAtMessageUuid: 'cut' } }))
    expect(fork).toMatchObject({ parentSessionId: 'source', lineageKind: 'fork' })
    expect(fork?.detached).toBeUndefined()
  })

  it('a model-started child carries its origin, kind and family name, live or not', () => {
    const metadata = {
      spawnedFrom: { sessionId: 'parent', taskId: 'task-1', kind: 'side_session', initiator: 'model', name: 'parser-review' },
    } as SessionMetaFile['metadata']
    const persisted = card(meta({ metadata }))
    expect(persisted).toMatchObject({
      parentSessionId: 'parent',
      lineageKind: 'side_session',
      familyName: 'parser-review',
    })
    const live = card(meta({ metadata }), { templateType: 'agent', snapshot: { initialized: true, messageCount: 3 } })
    expect(live).toMatchObject({ parentSessionId: 'parent', lineageKind: 'side_session', familyName: 'parser-review' })
  })

  it('a detached child carries the flag and no parent', () => {
    const detached = card(
      meta({
        metadata: {
          spawnedFrom: { sessionId: 'parent', taskId: 'task-1', kind: 'side_session', initiator: 'model', name: 'x' },
          lineageDetached: true,
        } as SessionMetaFile['metadata'],
      }),
    )
    expect(detached?.detached).toBe(true)
    expect(detached?.parentSessionId).toBeUndefined()
    expect(detached?.lineageKind).toBeUndefined()
  })

  it('a top-level session carries none of the fields', () => {
    const top = card(meta({ metadata: { templateType: 'agent' } }))
    expect(top?.parentSessionId).toBeUndefined()
    expect(top?.lineageKind).toBeUndefined()
    expect(top?.familyName).toBeUndefined()
    expect(top?.detached).toBeUndefined()
  })
})
