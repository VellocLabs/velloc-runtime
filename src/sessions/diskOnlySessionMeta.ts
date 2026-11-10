// Sidecar edits for sessions with no live store: rename, metadata patch, AI title, activity.

import { CUSTOM_TITLE_TYPE } from '../runtime/VercelModelConstants'
import type {
  BrowserSessionMetadata,
  SessionMetaFile,
  BrowserConversationStorageBackend,
} from './sessionRecords'

// The disk-only writers of one session's sidecar run one at a time, so a rename
// and a metadata patch cannot each write back a copy lacking the other's field.
const diskOnlyMetaWrites = new Map<string, Promise<unknown>>()

function serializeDiskOnlyMeta<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = diskOnlyMetaWrites.get(sessionId) ?? Promise.resolve()
  const run = previous.then(task)
  const tail = run.catch(() => undefined)
  diskOnlyMetaWrites.set(sessionId, tail)
  void tail.then(() => {
    if (diskOnlyMetaWrites.get(sessionId) === tail) {
      diskOnlyMetaWrites.delete(sessionId)
    }
  })
  return run
}

// Renames a session that is not loaded: logs the title and updates the
// sidecar. Returns false when no sidecar exists. An empty title clears it.
export function applyDiskOnlyRename(
  backend: Pick<
    BrowserConversationStorageBackend,
    'append' | 'readSessionMeta' | 'writeSessionMeta' | 'migrateLegacySessionMeta'
  >,
  sessionId: string,
  title: string,
  now: number,
): Promise<boolean> {
  return serializeDiskOnlyMeta(sessionId, async () => {
    const trimmed = title.trim()
    const existing =
      (await backend.readSessionMeta(sessionId)) ??
      (await backend.migrateLegacySessionMeta?.(sessionId)) ??
      null
    if (!existing) {
      return false
    }
    await backend.append(sessionId, {
      type: CUSTOM_TITLE_TYPE,
      sessionId,
      customTitle: trimmed,
      updatedAt: now,
    })
    const { customTitle: _previous, ...rest } = existing
    await backend.writeSessionMeta(sessionId, {
      ...rest,
      updatedAt: now,
      customTitleAt: now,
      ...(trimmed.length > 0 ? { customTitle: trimmed } : {}),
    })
    return true
  })
}

// Merges `patch` into the metadata of a session that is not loaded. Returns
// false when no sidecar exists.
export function applyDiskOnlyMetadataPatch(
  backend: Pick<
    BrowserConversationStorageBackend,
    'readSessionMeta' | 'writeSessionMeta' | 'migrateLegacySessionMeta'
  >,
  sessionId: string,
  patch: Partial<BrowserSessionMetadata>,
): Promise<boolean> {
  return serializeDiskOnlyMeta(sessionId, async () => {
    const existing =
      (await backend.readSessionMeta(sessionId)) ??
      (await backend.migrateLegacySessionMeta?.(sessionId)) ??
      null
    if (!existing) {
      return false
    }
    await backend.writeSessionMeta(sessionId, {
      ...existing,
      metadata: { ...existing.metadata, ...patch },
    })
    return true
  })
}

// Sets the automatic title of a session that is not loaded. A manual
// `customTitle` still wins at every read. Returns false when no sidecar exists.
export function applyDiskOnlyAiTitle(
  backend: Pick<
    BrowserConversationStorageBackend,
    'readSessionMeta' | 'writeSessionMeta' | 'migrateLegacySessionMeta'
  >,
  sessionId: string,
  title: string,
  now: number,
): Promise<boolean> {
  return serializeDiskOnlyMeta(sessionId, async () => {
    const trimmed = title.trim()
    if (!trimmed) return false
    const existing =
      (await backend.readSessionMeta(sessionId)) ??
      (await backend.migrateLegacySessionMeta?.(sessionId)) ??
      null
    if (!existing) {
      return false
    }
    await backend.writeSessionMeta(sessionId, { ...existing, updatedAt: now, aiTitle: trimmed })
    return true
  })
}

// Moves the activity time of a session that is not loaded forward to `at`.
// Returns false when no sidecar exists or `at` is not later.
export function applyDiskOnlyActivity(
  backend: Pick<
    BrowserConversationStorageBackend,
    'readSessionMeta' | 'writeSessionMeta' | 'migrateLegacySessionMeta'
  >,
  sessionId: string,
  at: number,
): Promise<boolean> {
  return serializeDiskOnlyMeta(sessionId, async () => {
    const existing =
      (await backend.readSessionMeta(sessionId)) ??
      (await backend.migrateLegacySessionMeta?.(sessionId)) ??
      null
    if (!existing || at <= existing.updatedAt) {
      return false
    }
    await backend.writeSessionMeta(sessionId, { ...existing, updatedAt: at })
    return true
  })
}
