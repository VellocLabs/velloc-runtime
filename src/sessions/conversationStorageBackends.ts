// In-memory and localStorage conversation backends, and the backend factory.

import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'
import {
  cloneValue,
  cloneMessages,
  type BrowserSessionMetadata,
  type BrowserSessionSummary,
  type SessionMetaFile,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type BrowserConversationStoragePayload,
  type BrowserConversationStorageBackend,
  isBrowserConversationRecord,
  parseSessionMetaFile,
} from './sessionRecords'
import { metadataFromSessionMeta, buildSessionSummaryFromMeta } from './sessionSummary'
import { deriveSessionMetaFromEntries } from './conversationNormalization'
import { FsBackedConversationStorageBackend } from './fsConversationStorageBackend'

function convertPayloadToAppendableEntries(
  payload: BrowserConversationStoragePayload,
): BrowserTranscriptEntry[] {
  if (!payload) {
    return []
  }

  if (Array.isArray(payload)) {
    return cloneValue(payload)
  }

  return cloneMessages(payload.messages) as unknown as BrowserTranscriptEntry[]
}

class MemoryConversationStorageBackend
  implements BrowserConversationStorageBackend
{
  private readonly records = new Map<string, BrowserTranscriptEntry[]>()
  private readonly metas = new Map<string, SessionMetaFile>()
  private readonly toolCallDetails = new Map<
    string,
    Map<string, BrowserToolCallDetailRecord>
  >()

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    const existing = this.records.get(sessionId) ?? []
    existing.push(cloneValue(entry))
    this.records.set(sessionId, existing)
  }

  async load(sessionId: string): Promise<BrowserConversationStoragePayload> {
    const entries = this.records.get(sessionId)
    return entries ? cloneValue(entries) : null
  }

  async flush(): Promise<void> {}

  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    const meta = this.metas.get(sessionId)
    return meta ? cloneValue(meta) : null
  }

  async writeSessionMeta(
    sessionId: string,
    meta: SessionMetaFile,
  ): Promise<void> {
    this.metas.set(sessionId, cloneValue(meta))
  }

  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const existing = this.metas.get(sessionId)
    if (existing) {
      return cloneValue(existing)
    }
    const derived = deriveSessionMetaFromEntries(
      sessionId,
      this.records.get(sessionId) ?? null,
    )
    if (derived) {
      this.metas.set(sessionId, derived)
    }
    return derived ? cloneValue(derived) : null
  }

  async listSessions(): Promise<string[]> {
    return Array.from(new Set([...this.metas.keys(), ...this.records.keys()]))
  }

  async loadSessionSummary(
    sessionId: string,
  ): Promise<BrowserSessionSummary | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }

  async loadSessionMetadata(
    sessionId: string,
  ): Promise<BrowserSessionMetadata | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? metadataFromSessionMeta(meta) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.records.delete(sessionId)
    this.metas.delete(sessionId)
    this.toolCallDetails.delete(sessionId)
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    const details = this.toolCallDetails.get(sessionId) ?? new Map()
    details.set(detail.toolCallId, cloneValue(detail))
    this.toolCallDetails.set(sessionId, details)
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const detail = this.toolCallDetails.get(sessionId)?.get(toolCallId)
    return detail ? cloneValue(detail) : null
  }
}

const sharedMemoryConversationStorageBackend =
  new MemoryConversationStorageBackend()

class LocalStorageConversationStorageBackend
  implements BrowserConversationStorageBackend
{
  constructor(private readonly keyPrefix: string) {}

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    const existing = await this.load(sessionId)
    if (existing && !Array.isArray(existing)) {
      await this.migrateLegacySessionMeta(sessionId)
    }
    const entries = convertPayloadToAppendableEntries(existing)
    entries.push(cloneValue(entry))
    localStorage.setItem(this.key(sessionId), JSON.stringify(entries))
  }

  async load(sessionId: string): Promise<BrowserConversationStoragePayload> {
    const raw = localStorage.getItem(this.key(sessionId))
    if (!raw) {
      return null
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed) || isBrowserConversationRecord(parsed)) {
        return parsed as BrowserConversationStoragePayload
      }
    } catch {
      return null
    }

    return null
  }

  async flush(): Promise<void> {}

  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    const raw = localStorage.getItem(this.metaKey(sessionId))
    return raw ? parseSessionMetaFile(raw, sessionId) : null
  }

  async writeSessionMeta(
    sessionId: string,
    meta: SessionMetaFile,
  ): Promise<void> {
    localStorage.setItem(this.metaKey(sessionId), JSON.stringify(meta))
  }

  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const existing = await this.readSessionMeta(sessionId)
    if (existing) {
      return existing
    }
    const derived = deriveSessionMetaFromEntries(
      sessionId,
      await this.load(sessionId),
    )
    if (derived) {
      await this.writeSessionMeta(sessionId, derived)
    }
    return derived
  }

  async listSessions(): Promise<string[]> {
    const keys = new Set<string>()
    const prefix = `${this.keyPrefix}:`
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix) || key.endsWith(':tool-details')) {
        continue
      }
      const rest = key.slice(prefix.length)
      keys.add(rest.endsWith(':meta') ? rest.slice(0, -':meta'.length) : rest)
    }
    return Array.from(keys)
  }

  async loadSessionSummary(
    sessionId: string,
  ): Promise<BrowserSessionSummary | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }

  async loadSessionMetadata(
    sessionId: string,
  ): Promise<BrowserSessionMetadata | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? metadataFromSessionMeta(meta) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    localStorage.removeItem(this.key(sessionId))
    localStorage.removeItem(this.metaKey(sessionId))
    localStorage.removeItem(this.toolDetailKey(sessionId))
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    const existing = await this.loadAllToolCallDetails(sessionId)
    existing[detail.toolCallId] = cloneValue(detail)
    localStorage.setItem(this.toolDetailKey(sessionId), JSON.stringify(existing))
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const details = await this.loadAllToolCallDetails(sessionId)
    const detail = details[toolCallId]
    return detail ? cloneValue(detail) : null
  }

  private key(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}`
  }

  private metaKey(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}:meta`
  }

  private toolDetailKey(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}:tool-details`
  }

  private async loadAllToolCallDetails(
    sessionId: string,
  ): Promise<Record<string, BrowserToolCallDetailRecord>> {
    const raw = localStorage.getItem(this.toolDetailKey(sessionId))
    if (!raw) {
      return {}
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'object' && parsed !== null
        ? parsed as Record<string, BrowserToolCallDetailRecord>
        : {}
    } catch {
      return {}
    }
  }
}

export function createBrowserConversationStorageBackend(options?: {
  keyPrefix?: string
  fsBasePath?: string
}): BrowserConversationStorageBackend {
  if (options?.fsBasePath) {
    return new FsBackedConversationStorageBackend(options.fsBasePath)
  }

  if (typeof localStorage !== 'undefined') {
    return new LocalStorageConversationStorageBackend(
      options?.keyPrefix ?? 'chromium-runtime:conversation',
    )
  }

  return sharedMemoryConversationStorageBackend
}
