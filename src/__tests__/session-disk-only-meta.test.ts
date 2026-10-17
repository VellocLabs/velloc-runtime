import { describe, expect, it } from 'vitest'
import {
  applyDiskOnlyMetadataPatch,
  applyDiskOnlyRename,
  type SessionMetaFile,
} from '../sessions/sessionStore'

// Disk-only writers of one session's meta.json run one at a time, so each
// keeps the other's field. (F-17)

describe('disk-only meta writes', () => {
  it('a rename and a pin racing on one session both land', async () => {
    let stored: SessionMetaFile = {
      schemaVersion: 1,
      sessionId: 's',
      updatedAt: 1,
      metadata: {},
    }
    const tick = () => new Promise(resolve => setTimeout(resolve, 1))
    const backend = {
      append: async () => {},
      readSessionMeta: async () => {
        const copy = structuredClone(stored)
        await tick()
        return copy
      },
      writeSessionMeta: async (_id: string, meta: SessionMetaFile) => {
        await tick()
        stored = meta
      },
    }
    await Promise.all([
      applyDiskOnlyRename(backend, 's', 'Renamed', 5),
      applyDiskOnlyMetadataPatch(backend, 's', { pinned: true }),
    ])
    expect(stored.customTitle).toBe('Renamed')
    expect(stored.metadata.pinned).toBe(true)
  })
})
