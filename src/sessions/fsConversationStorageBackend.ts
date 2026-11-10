// The conversation backend over the runtime filesystem: JSONL transcripts plus meta sidecars.

import { processFs } from '../utils/fs/runtimeFs'
import {
  getConversationMetaPath,
  getConversationSessionDirectoryPath,
  getConversationToolDetailPath,
  getConversationToolDetailsDirectoryPath,
  getConversationTranscriptPath,
} from '../utils/conversationStoragePaths'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'
import {
  type BrowserSessionMetadata,
  type BrowserSessionSummary,
  type SessionMetaFile,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type BrowserConversationStoragePayload,
  type BrowserConversationStorageBackend,
  isBrowserConversationRecord,
  isBrowserSessionMetaEntry,
  isBrowserCustomTitleEntry,
  isBrowserAiTitleEntry,
  parseSessionMetaFile,
  isMessageLike,
  isToolCallDetailRecord,
} from './sessionRecords'
import { metadataFromSessionMeta, buildSessionSummaryFromMeta } from './sessionSummary'
import { deriveSessionMetaFromEntries } from './conversationNormalization'

function serializeTranscriptEntry(entry: BrowserTranscriptWriteEntry): string {
  return JSON.stringify(entry)
}

export class FsBackedConversationStorageBackend
  implements BrowserConversationStorageBackend
{
  constructor(private readonly basePath: string) {}

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    const fs = processFs()
    await this.ensureSessionDirectory(sessionId)

    const filePath = this.transcriptPath(sessionId)
    fs.appendFileSync(filePath, serializeTranscriptEntry(entry) + '\n')
  }

  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    const fs = processFs()
    try {
      const content = await fs.readFile(this.metaPath(sessionId), {
        encoding: 'utf-8',
      })
      return parseSessionMetaFile(content, sessionId)
    } catch {
      return null
    }
  }

  async writeSessionMeta(
    sessionId: string,
    meta: SessionMetaFile,
  ): Promise<void> {
    const fs = processFs()
    await this.ensureSessionDirectory(sessionId)
    const target = this.metaPath(sessionId)
    const encoded = JSON.stringify(meta)
    const temp = `${target}.tmp`
    try {
      await fs.writeFile(temp, encoded, { encoding: 'utf-8' })
      fs.renameSync(temp, target)
    } catch {
      await fs.writeFile(target, encoded, { encoding: 'utf-8' })
    }
  }

  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const derived = deriveSessionMetaFromEntries(
      sessionId,
      await this.load(sessionId),
    )
    if (!derived) {
      return null
    }
    const existing = await this.readSessionMeta(sessionId)
    if (existing) {
      return existing
    }
    await this.writeSessionMeta(sessionId, derived)
    return derived
  }

  async load(sessionId: string): Promise<BrowserConversationStoragePayload> {
    const fs = processFs()
    const filePath = this.transcriptPath(sessionId)

    try {
      const content = await fs.readFile(filePath, { encoding: 'utf-8' })
      const lines = content.split('\n')
      if (lines.every(line => line.trim().length === 0)) {
        return null
      }

      const nonEmpty = lines.filter(line => line.trim().length > 0)
      if (nonEmpty.length === 1) {
        try {
          const single = JSON.parse(nonEmpty[0]!) as unknown
          if (isBrowserConversationRecord(single)) {
            return single
          }
          if (Array.isArray(single)) {
            return single as BrowserTranscriptEntry[]
          }
        } catch {
        }
      }

      const entries: BrowserTranscriptEntry[] = []
      for (let physicalLine = 0; physicalLine < lines.length; physicalLine++) {
        const line = lines[physicalLine]!
        if (line.trim().length === 0) {
          continue
        }
        try {
          const parsed = JSON.parse(line) as unknown
          if (
            isMessageLike(parsed) ||
            isBrowserSessionMetaEntry(parsed) ||
            isBrowserCustomTitleEntry(parsed) ||
            isBrowserAiTitleEntry(parsed)
          ) {
            ;(parsed as { transcriptLine?: number }).transcriptLine =
              physicalLine
            entries.push(parsed as BrowserTranscriptEntry)
          }
        } catch {
        }
      }

      return entries.length > 0 ? entries : null
    } catch {
      return null
    }
  }

  async flush(): Promise<void> {}

  async listSessions(): Promise<string[]> {
    const fs = processFs()
    try {
      const entries = await fs.readdir(this.basePath)
      const sessionIds = await Promise.all(
        entries
          .filter(entry => entry.isDirectory())
          .map(async entry => {
            for (const path of [
              this.metaPath(entry.name),
              this.transcriptPath(entry.name),
            ]) {
              try {
                const stat = await fs.stat(path)
                if (stat.isFile()) return entry.name
              } catch {
              }
            }
            return null
          }),
      )

      return sessionIds.filter(
        (sessionId): sessionId is string => typeof sessionId === 'string',
      )
    } catch {
      return []
    }
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
    const fs = processFs()
    try {
      await fs.rm(this.sessionDirectoryPath(sessionId), {
        recursive: true,
        force: true,
      })
    } catch {
    }
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    const fs = processFs()
    await this.ensureToolDetailDirectory(sessionId)
    const filePath = this.toolDetailPath(sessionId, detail.toolCallId)
    await fs.rm(filePath, { recursive: false, force: true })
    const encoded = JSON.stringify(detail)
    fs.appendFileSync(filePath, encoded)
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const fs = processFs()
    try {
      const content = await fs.readFile(this.toolDetailPath(sessionId, toolCallId), {
        encoding: 'utf-8',
      })
      const parsed = JSON.parse(content) as unknown
      return isToolCallDetailRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private transcriptPath(sessionId: string): string {
    return getConversationTranscriptPath(this.basePath, sessionId)
  }

  private metaPath(sessionId: string): string {
    return getConversationMetaPath(this.basePath, sessionId)
  }

  private sessionDirectoryPath(sessionId: string): string {
    return getConversationSessionDirectoryPath(this.basePath, sessionId)
  }

  private toolDetailsDirectoryPath(sessionId: string): string {
    return getConversationToolDetailsDirectoryPath(this.basePath, sessionId)
  }

  private toolDetailPath(sessionId: string, toolCallId: string): string {
    return getConversationToolDetailPath(this.basePath, sessionId, toolCallId)
  }

  private async ensureBaseDirectory(): Promise<void> {
    const fs = processFs()
    try {
      await fs.mkdir(this.basePath)
    } catch {
    }
  }

  private async ensureSessionDirectory(sessionId: string): Promise<void> {
    const fs = processFs()
    await this.ensureBaseDirectory()
    try {
      await fs.mkdir(this.sessionDirectoryPath(sessionId))
    } catch {
    }
  }

  private async ensureToolDetailDirectory(sessionId: string): Promise<void> {
    const fs = processFs()
    await this.ensureSessionDirectory(sessionId)
    try {
      await fs.mkdir(this.toolDetailsDirectoryPath(sessionId))
    } catch {
    }
  }
}
