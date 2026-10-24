/**
 * Where a CLI session's conversation id lives (F-34): `cliConversation` in
 * the session's metadata — through its bound store when it has one, else in
 * `meta.json` directly. The first record of a session that never persisted
 * writes that `meta.json`, so the session is listed and survives a relaunch.
 * The session's automatic title, which follows the CLI's terminal title, is
 * written the same two ways.
 */
import {
  applyDiskOnlyAiTitle,
  applyDiskOnlyMetadataPatch,
  SESSION_META_FILE_SCHEMA_VERSION,
  type BrowserConversationStorageBackend,
  type BrowserSessionMetadata,
  type SessionMetaFile,
} from '../../sessions/sessionStore'
import type { CliConversationRecord, CliConversationStore } from '../../terminal/TerminalService'
import { parseCliConversation } from '../../terminal/cliAgents'

/** The parts of a live session entry the store reads. */
export type CliConversationEntry = {
  conversationStore?: {
    getSessionMetadata(): Promise<BrowserSessionMetadata | undefined>
    updateSessionMetadata(patch: Partial<BrowserSessionMetadata>): Promise<unknown>
    storeAutoTitle(aiTitle: string): Promise<unknown>
  }
  templateType?: string
  projectRoot?: string
}

export type CliConversationStoreDeps = {
  storage(): Pick<
    BrowserConversationStorageBackend,
    'readSessionMeta' | 'writeSessionMeta' | 'migrateLegacySessionMeta'
  > | null
  entry(sessionId: string): CliConversationEntry | undefined
  ensureRouting(): Promise<void>
  refreshSummary(sessionId: string): Promise<void>
  /** Writes a whole new session (route, `meta.json`, summary) — the manager's `writeSessionBundle`. */
  writeNewSession(args: {
    sessionId: string
    meta: SessionMetaFile
    projectRoot?: string
    templateType?: string
  }): Promise<void>
  now?(): number
}

export function createCliConversationStore(deps: CliConversationStoreDeps): CliConversationStore {
  // A store that bound while the disk write ran holds metadata loaded before
  // it, and its next write would drop the record.
  const throughStoreBoundMeanwhile = async (
    sessionId: string,
    record: CliConversationRecord,
  ): Promise<void> => {
    await deps.entry(sessionId)?.conversationStore?.updateSessionMetadata({ cliConversation: record })
  }
  return {
    read: async sessionId => {
      const bound = deps.entry(sessionId)?.conversationStore
      const metadata = bound
        ? await bound.getSessionMetadata()
        : (await deps.storage()?.readSessionMeta(sessionId))?.metadata
      return parseCliConversation(metadata?.cliConversation)
    },
    record: async (sessionId, record) => {
      const storage = deps.storage()
      if (!storage) throw new Error('session storage is not available')
      const entry = deps.entry(sessionId)
      if (entry?.conversationStore) {
        await entry.conversationStore.updateSessionMetadata({ cliConversation: record })
        return
      }
      await deps.ensureRouting()
      if (await applyDiskOnlyMetadataPatch(storage, sessionId, { cliConversation: record })) {
        await throughStoreBoundMeanwhile(sessionId, record)
        await deps.refreshSummary(sessionId)
        return
      }
      const now = (deps.now ?? Date.now)()
      await deps.writeNewSession({
        sessionId,
        meta: {
          schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
          sessionId,
          updatedAt: now,
          metadata: {
            ...(entry?.templateType ? { templateType: entry.templateType } : {}),
            ...(entry?.projectRoot ? { projectRoot: entry.projectRoot } : {}),
            createdAt: now,
            cliConversation: record,
          },
        },
        projectRoot: entry?.projectRoot,
        templateType: entry?.templateType,
      })
      await throughStoreBoundMeanwhile(sessionId, record)
    },
    retitle: async (sessionId, title) => {
      const bound = deps.entry(sessionId)?.conversationStore
      if (bound) {
        await bound.storeAutoTitle(title)
      } else {
        const storage = deps.storage()
        if (!storage) return
        await deps.ensureRouting()
        if (!(await applyDiskOnlyAiTitle(storage, sessionId, title, (deps.now ?? Date.now)()))) return
      }
      await deps.refreshSummary(sessionId)
    },
  }
}
