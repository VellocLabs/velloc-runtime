import type { ConversationStore } from '../runtime/interfaces/ConversationStore'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message } from '../runtime/RuntimeTypes'
import { restoreInvokedSkillsFromMessages } from '../skillLibrary/invokedSkillsStore'
import { readTranscriptLineCount } from '../utils/transcriptLineCount'
import {
  getLazyToolCallRefsFromMessage,
  getToolCallDetailsFromMessage,
  hydrateMessageToolPayloads,
  mergeToolCallDetails,
  sanitizeMessageForPersistence,
  shouldLazyLoadToolDetail,
  type BrowserToolCallDetailRecord,
} from '../utils/toolCallDetails'
import { CUSTOM_TITLE_TYPE, AI_TITLE_TYPE } from '../runtime/VercelModelConstants'
import {
  cloneValue,
  cloneMessages,
  type BrowserSessionMetadata,
  type BrowserSessionSummary,
  SESSION_META_FILE_SCHEMA_VERSION,
  type SessionMetaFile,
  type BrowserTranscriptMessage,
  type BrowserTranscriptWriteEntry,
  type BrowserConversationStorageBackend,
} from './sessionRecords'
import {
  deriveSessionMetadataFromMessages,
  nonEmptyTitle,
  resolveSessionTitle,
  pickTitleFields,
} from './sessionSummary'
import {
  createFallbackUUID,
  type NormalizedConversationState,
  buildSessionSummary,
  getGeneratedMessageUuid,
  newGeneratedUuidScope,
  normalizeTranscriptMessage,
  stripTransientRuntimeMessageFields,
  normalizeConversationState,
  deriveSessionMetaFromNormalized,
  reconcileMetaWithLog,
} from './conversationNormalization'
import { createBrowserConversationStorageBackend } from './conversationStorageBackends'

export {
  SESSION_SUMMARY_TAIL_BYTES,
  SESSION_META_FILE_SCHEMA_VERSION,
  isBrowserSessionMetaEntry,
  isBrowserAiTitleEntry,
  isSessionMetaFile,
  parseSessionMetaFile,
  isMessageLike,
  isConversationResumable,
} from './sessionRecords'
export type {
  BrowserConversationRecord,
  BrowserSessionMetadata,
  BrowserSessionCounters,
  BrowserSessionSummary,
  SessionMetaFile,
  BrowserTranscriptEntry,
  BrowserTranscriptWriteEntry,
  BrowserConversationStoragePayload,
  BrowserConversationStorageBackend,
} from './sessionRecords'
export {
  deriveSessionMetadataFromMessages,
  buildSessionSummaryFromMetadata,
  normalizeSessionCounters,
  buildSessionSummaryFromMessages,
  metadataFromSessionMeta,
  buildSessionSummaryFromMeta,
} from './sessionSummary'
export {
  extractLatestSessionSummaryFromText,
  extractLatestSessionMetadataFromText,
  deriveSessionMetaFromText,
} from './sessionTextScan'
export {
  normalizeConversationState,
  deriveSessionMetaFromEntries,
  reconcileMetaWithLog,
} from './conversationNormalization'
export {
  applyDiskOnlyRename,
  applyDiskOnlyMetadataPatch,
  applyDiskOnlyAiTitle,
  applyDiskOnlyActivity,
} from './diskOnlySessionMeta'
export {
  resolvePromptCutForToolCall,
  openToolCallsAtCut,
  modelForkCut,
  buildForkedTranscriptEntries,
} from './sessionFork'
export type { ModelForkCut } from './sessionFork'
export { createBrowserConversationStorageBackend } from './conversationStorageBackends'


function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Maps each loaded entry's uuid to the physical line it was read from. */
function transcriptLinesFromPayload(payload: unknown): Record<string, number> {
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : (((payload as { messages?: unknown[] } | null)?.messages ?? []) as unknown[])
  const lines: Record<string, number> = {}
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const line = (entry as { transcriptLine?: unknown }).transcriptLine
    const uuid = (entry as { uuid?: unknown }).uuid
    if (typeof line === 'number' && typeof uuid === 'string' && uuid) {
      lines[uuid] = line
    }
  }
  return lines
}

type HydrationMemo = {
  deps: Array<[id: string, wasReferenced: boolean, record: BrowserToolCallDetailRecord | undefined]>
  hydrated: Message
}

const HYDRATION_SINGLE_READS_IN_FLIGHT = 6

export type BrowserConversationStoreOptions = {
  runtimeConfig: RuntimeConfig
  sessionId?: string
  persistenceDisabled?: boolean
  storageBackend?: BrowserConversationStorageBackend
  restoredSessionId?: boolean
}

type RecordedConversationStore = ConversationStore & {
  getRecordedMessages?: () => Promise<readonly Message[]> | readonly Message[]
  getRecordedMessagesForSession?: (
    sessionId: string,
  ) => Promise<readonly Message[]> | readonly Message[]
  hydrateMessagesForModel?: () =>
    | Promise<readonly Message[]>
    | readonly Message[]
  getSessionSummaries?: () =>
    | Promise<readonly BrowserSessionSummary[]>
    | readonly BrowserSessionSummary[]
  storeUserTitle?: (
    customTitle: string,
    source?: 'user' | 'auto',
  ) => Promise<unknown> | unknown
  storeAutoTitle?: (aiTitle: string) => Promise<unknown> | unknown
  getSessionMetadata?: () =>
    | Promise<BrowserSessionMetadata | undefined>
    | BrowserSessionMetadata
    | undefined
}

// The store the rest of the runtime reads through; tests swap it.
let activeConversationStore: ConversationStore | null = null

function resolveConversationStore(
  store?: ConversationStore,
): ConversationStore {
  const resolved = store ?? activeConversationStore
  if (!resolved) {
    throw new Error(
      'No active ConversationStore is configured in chromium-runtime.',
    )
  }

  return resolved
}

const META_REPAIR_DELAYS_MS = [250, 1_000, 4_000] as const

export class BrowserConversationStore implements ConversationStore {
  private readonly runtimeConfig: RuntimeConfig
  private readonly sessionId: string
  private readonly persistenceDisabled: boolean
  private readonly storageBackend: BrowserConversationStorageBackend
  private hasLoadedStoredMessages = false
  private storedMessages: BrowserTranscriptMessage[] = []
  private transcriptLinesCache: {
    size: number
    map: Record<string, number>
  } | null = null
  private transcriptLines: {
    map: Record<string, number>
    nextLine: number
  } | undefined
  private transcriptAppendsInFlight = 0
  private transcriptAppendEpoch = 0
  private recordedMessages: Message[] = []
  private recordedMessageUuids = new Set<string>()
  private generatedUuidScope = newGeneratedUuidScope()
  private currentLeafUuid: string | null = null
  private currentUpdatedAt = 0
  private currentMetadata: BrowserSessionMetadata | undefined
  private currentCustomTitle: string | undefined
  private currentCustomTitleAt: number | undefined
  private currentAiTitle: string | undefined
  private readonly toolCallDetails = new Map<
    string,
    BrowserToolCallDetailRecord
  >()
  private readonly pendingCompactResults = new Map<string, string>()
  private hydrationMemo = new WeakMap<Message, HydrationMemo>()
  private lazyRefIdsMemo = new WeakMap<Message, readonly string[]>()
  private readonly missingToolCallDetails = new Set<string>()
  private readonly persistedDetailRecords = new WeakSet<BrowserToolCallDetailRecord>()
  private readonly releasedDetailIds = new Set<string>()
  private metaRepairTimer: ReturnType<typeof setTimeout> | null = null
  private readonly restoredSessionId: boolean
  private isPhantomRestoredSession = false
  private metaUnreadableAtLoad = false
  /** Creation time of a session that loaded with no meta and no transcript,
   *  folded into its metadata by the first persist. */
  private pendingCreatedAt: number | undefined

  constructor(options: BrowserConversationStoreOptions) {
    this.runtimeConfig = options.runtimeConfig
    this.sessionId =
      options.sessionId ??
      options.runtimeConfig.createUUID?.() ??
      globalThis.crypto?.randomUUID?.() ??
      createFallbackUUID()
    this.persistenceDisabled = options.persistenceDisabled ?? false
    this.restoredSessionId = options.restoredSessionId ?? false
    this.storageBackend =
      options.storageBackend ?? createBrowserConversationStorageBackend()
  }

  async saveTranscriptRows(messages: readonly Message[]): Promise<void> {
    await this.ensureLoaded()

    let parentUuid = this.currentLeafUuid
    const appendedMessages: Message[] = []
    let messageIndex = 0

    for (const message of messages) {
      const existingUuid =
        typeof message.uuid === 'string' && message.uuid.length > 0
          ? message.uuid
          : getGeneratedMessageUuid(this.sessionId, messageIndex, this.generatedUuidScope)

      if (this.recordedMessageUuids.has(existingUuid)) {
        messageIndex++
        continue
      }

      await this.persistToolCallDetails([message])
      const persistedMessage = sanitizeMessageForPersistence(message)
      const storedMessage = normalizeTranscriptMessage(
        persistedMessage,
        this.sessionId,
        parentUuid,
        this.runtimeConfig,
        messageIndex,
        this.generatedUuidScope,
      )
      const runtimeMessage = stripTransientRuntimeMessageFields(message)

      if (!this.persistenceDisabled) {
        await this.appendToTranscript(storedMessage, storedMessage.uuid)
      }
      this.storedMessages.push(storedMessage)
      this.recordedMessageUuids.add(storedMessage.uuid)
      this.recordedMessages.push(runtimeMessage)
      parentUuid = storedMessage.uuid
      appendedMessages.push(runtimeMessage)
      messageIndex++
    }

    if (appendedMessages.length === 0) {
      return
    }

    this.isPhantomRestoredSession = false

    this.currentLeafUuid = parentUuid
    this.currentUpdatedAt = this.runtimeConfig.now()
    this.currentMetadata = {
      ...(this.currentMetadata ? cloneValue(this.currentMetadata) : {}),
      ...deriveSessionMetadataFromMessages(
        this.recordedMessages,
        this.currentLeafUuid,
      ),
    }

    await this.persistSessionMetaBestEffort()
  }

  async drainWrites(): Promise<void> {
    if (this.persistenceDisabled) {
      return
    }

    await this.storageBackend.flush()
  }

  getSessionId(): string {
    return this.sessionId
  }

  isEphemeral(): boolean {
    return this.persistenceDisabled
  }

  async getTranscriptLinesByUuid(): Promise<Record<string, number>> {
    await this.ensureLoaded()
    if (this.transcriptLines) {
      return this.transcriptLines.map
    }
    if (this.transcriptLinesCache?.size === this.storedMessages.length) {
      return this.transcriptLinesCache.map
    }
    const size = this.storedMessages.length
    const lines: Record<string, number> = {}
    const appendEpoch = this.transcriptAppendEpoch
    const quietAtStart = this.transcriptAppendsInFlight === 0
    try {
      const payload = await this.storageBackend.load(this.sessionId)
      Object.assign(lines, transcriptLinesFromPayload(payload))
      this.adoptTranscriptLines(payload, lines, quietAtStart, appendEpoch)
    } catch {
      for (const message of this.storedMessages) {
        const line = (message as { transcriptLine?: number }).transcriptLine
        if (typeof line === 'number' && message.uuid) {
          lines[message.uuid] = line
        }
      }
    }
    this.transcriptLinesCache = { size, map: lines }
    return lines
  }

  /**
   * Keeps a line map read from `payload` as the live map that appends extend,
   * but only when the load counted its lines and no append raced the read —
   * otherwise the map could miss a line written meanwhile.
   */
  private adoptTranscriptLines(
    payload: unknown,
    map: Record<string, number>,
    quietAtStart: boolean,
    appendEpoch: number,
  ): void {
    const lineCount = readTranscriptLineCount(payload)
    if (
      lineCount !== undefined
      && quietAtStart
      && appendEpoch === this.transcriptAppendEpoch
    ) {
      this.transcriptLines = { map, nextLine: lineCount }
    }
  }

  async getRecordedMessages(): Promise<readonly Message[]> {
    await this.ensureLoaded()
    return cloneMessages(this.recordedMessages)
  }

  async getRecordedMessagesForSession(
    sessionId: string,
  ): Promise<readonly Message[]> {
    const normalized = await this.loadSessionState(sessionId)
    return cloneMessages(normalized.activeMessages)
  }

  releaseToolPayloads(): boolean {
    if (this.persistenceDisabled || !this.hasLoadedStoredMessages) {
      return false
    }
    for (const [id, record] of this.toolCallDetails) {
      if (this.persistedDetailRecords.has(record)) {
        this.toolCallDetails.delete(id)
        this.releasedDetailIds.add(id)
      }
    }
    this.recordedMessages = this.recordedMessages.map(sanitizeMessageForPersistence)
    this.hydrationMemo = new WeakMap()
    this.lazyRefIdsMemo = new WeakMap()
    return true
  }

  async startNewConversation(): Promise<void> {
    await this.ensureLoaded()
    this.recordedMessages = []
    this.currentLeafUuid = null
    this.generatedUuidScope = newGeneratedUuidScope()
    this.hydrationMemo = new WeakMap()
    this.lazyRefIdsMemo = new WeakMap()
  }

  isRecordedMessage(uuid: string): boolean {
    return this.recordedMessageUuids.has(uuid)
  }

  async hydrateMessagesForModel(): Promise<readonly Message[]> {
    await this.ensureLoaded()

    const messages = this.recordedMessages
    const refIds = new Set<string>()
    for (const message of messages) {
      for (const ref of this.lazyRefIdsOf(message)) refIds.add(ref)
    }
    await this.loadToolCallDetailsForHydration(refIds)

    let anyDetail = false
    for (const id of refIds) {
      if (this.toolCallDetails.has(id)) {
        anyDetail = true
        break
      }
    }
    if (!anyDetail) {
      return cloneMessages(messages)
    }

    const hydrated = messages.map(message => this.hydrateOne(message, refIds))
    this.recordedMessages = hydrated
    return cloneMessages(hydrated)
  }

  private lazyRefIdsOf(message: Message): readonly string[] {
    let ids = this.lazyRefIdsMemo.get(message)
    if (!ids) {
      ids = getLazyToolCallRefsFromMessage(message).map(ref => ref.toolCallId)
      this.lazyRefIdsMemo.set(message, ids)
    }
    return ids
  }

  private hydrateOne(message: Message, refIds: ReadonlySet<string>): Message {
    const memo = this.hydrationMemo.get(message)
    if (
      memo
      && memo.deps.every(
        ([id, wasReferenced, record]) =>
          refIds.has(id) === wasReferenced && this.toolCallDetails.get(id) === record,
      )
    ) {
      return memo.hydrated
    }
    const deps: HydrationMemo['deps'] = []
    const view = {
      get: (id: string): BrowserToolCallDetailRecord | undefined => {
        const wasReferenced = refIds.has(id)
        const record = this.toolCallDetails.get(id)
        deps.push([id, wasReferenced, record])
        if (!wasReferenced || !record) return undefined
        const { origin: _origin, ...visible } = record
        return visible
      },
    }
    const hydrated = hydrateMessageToolPayloads(message, view)
    const entry: HydrationMemo = { deps, hydrated }
    this.hydrationMemo.set(message, entry)
    this.hydrationMemo.set(hydrated, entry)
    return hydrated
  }

  private async loadToolCallDetailsForHydration(
    refIds: ReadonlySet<string>,
  ): Promise<void> {
    const wanted: string[] = []
    for (const id of refIds) {
      if (!this.toolCallDetails.has(id) && !this.missingToolCallDetails.has(id)) {
        wanted.push(id)
      }
    }
    if (wanted.length === 0) {
      return
    }
    const backend = this.storageBackend
    let found: Map<string, BrowserToolCallDetailRecord>
    const unreadable = new Set<string>()
    if (backend.loadToolCallDetails) {
      found = await backend.loadToolCallDetails(this.sessionId, wanted, unreadable)
    } else {
      found = new Map()
      if (backend.loadToolCallDetail) {
        for (let start = 0; start < wanted.length; start += HYDRATION_SINGLE_READS_IN_FLIGHT) {
          const slice = wanted.slice(start, start + HYDRATION_SINGLE_READS_IN_FLIGHT)
          const records = await Promise.all(
            slice.map(id => backend.loadToolCallDetail!(this.sessionId, id)),
          )
          records.forEach((record, index) => {
            if (record) found.set(slice[index]!, record)
          })
        }
      }
    }
    for (const id of wanted) {
      if (this.toolCallDetails.has(id)) continue
      const record = found.get(id)
      if (record) {
        this.toolCallDetails.set(id, record)
        this.persistedDetailRecords.add(record)
        this.releasedDetailIds.delete(id)
      } else if (!unreadable.has(id)) {
        this.missingToolCallDetails.add(id)
        this.releasedDetailIds.delete(id)
      }
    }
  }

  async getSessionSummaries(): Promise<readonly BrowserSessionSummary[]> {
    const sessionIds = await this.listSessions()
    const summaries: BrowserSessionSummary[] = []

    for (const sessionId of sessionIds) {
      const summary = await this.loadSessionSummary(sessionId)
      if (summary) {
        summaries.push(summary)
      }
    }

    summaries.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt
      }

      return left.sessionId.localeCompare(right.sessionId)
    })

    return summaries
  }

  async getSessionMetadata(): Promise<BrowserSessionMetadata | undefined> {
    await this.ensureLoaded()
    return this.getResolvedMetadata()
  }

  async getToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    await this.ensureLoaded()

    const cached = this.toolCallDetails.get(toolCallId)
    if (cached) {
      return cloneValue(cached)
    }

    const detail = await this.storageBackend.loadToolCallDetail?.(
      this.sessionId,
      toolCallId,
    )
    if (!detail) {
      return null
    }

    this.toolCallDetails.set(toolCallId, detail)
    this.persistedDetailRecords.add(detail)
    this.missingToolCallDetails.delete(toolCallId)
    this.releasedDetailIds.delete(toolCallId)
    return cloneValue(detail)
  }

  async saveToolCallDetail(
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    await this.ensureLoaded()
    await this.storeToolCallDetail(detail)
  }

  async promoteToolCallDetailToOrigin(
    toolCallId: string,
    compactResult: string,
  ): Promise<void> {
    await this.ensureLoaded()

    const existing = await this.getToolCallDetail(toolCallId)
    if (existing?.origin !== undefined) {
      return
    }

    if (!existing) {
      this.pendingCompactResults.set(toolCallId, compactResult)
      return
    }

    const parsedCompact = safeParseJson(compactResult)
    const updated: BrowserToolCallDetailRecord = {
      ...existing,
      origin: existing.result,
      result: parsedCompact,
      updatedAt: this.runtimeConfig.now(),
    }
    this.toolCallDetails.set(toolCallId, updated)

    if (!this.persistenceDisabled) {
      await this.storageBackend.saveToolCallDetail?.(this.sessionId, updated)
      if (this.storageBackend.saveToolCallDetail) this.persistedDetailRecords.add(updated)
    }
  }

  async updateSessionMetadata(
    metadata: Partial<BrowserSessionMetadata>,
  ): Promise<BrowserSessionMetadata> {
    await this.ensureLoaded()

    const { customTitle: customTitleUpdate, ...rest } = metadata

    const nextMetadata: BrowserSessionMetadata = {
      ...(this.currentMetadata ? cloneValue(this.currentMetadata) : {}),
      ...deriveSessionMetadataFromMessages(
        this.recordedMessages,
        this.currentLeafUuid,
      ),
      ...cloneValue(rest),
    }
    delete nextMetadata.customTitle

    if (customTitleUpdate !== undefined) {
      await this.recordCustomTitle(
        typeof customTitleUpdate === 'string' ? customTitleUpdate : '',
      )
    }

    if (this.currentUpdatedAt === 0) {
      this.currentUpdatedAt = this.runtimeConfig.now()
    }
    this.currentMetadata = nextMetadata
    await this.persistSessionMeta()

    return this.getResolvedMetadata() ?? cloneValue(nextMetadata)
  }

  async storeUserTitle(
    customTitle: string,
    _source: 'user' | 'auto' = 'user',
  ): Promise<BrowserSessionMetadata | undefined> {
    await this.ensureLoaded()
    await this.recordCustomTitle(customTitle)
    await this.persistSessionMeta()
    return this.getResolvedMetadata()
  }

  private async recordCustomTitle(customTitle: string): Promise<void> {
    const trimmed = typeof customTitle === 'string' ? customTitle.trim() : ''
    const now = this.runtimeConfig.now()
    this.currentCustomTitle = trimmed.length > 0 ? trimmed : undefined
    this.currentCustomTitleAt = now
    this.currentUpdatedAt = now
    this.isPhantomRestoredSession = false
    if (!this.persistenceDisabled) {
      await this.appendToTranscript({
        type: CUSTOM_TITLE_TYPE,
        sessionId: this.sessionId,
        customTitle: trimmed,
        updatedAt: now,
      })
    }
  }

  async storeAutoTitle(aiTitle: string): Promise<void> {
    await this.ensureLoaded()
    const trimmed = typeof aiTitle === 'string' ? aiTitle.trim() : ''
    if (!trimmed) {
      return
    }
    this.currentAiTitle = trimmed
    if (!this.persistenceDisabled) {
      await this.appendToTranscript({
        type: AI_TITLE_TYPE,
        sessionId: this.sessionId,
        aiTitle: trimmed,
        updatedAt: this.runtimeConfig.now(),
      })
    }
    await this.persistSessionMeta()
  }

  /** Moves the session's activity time forward to `at`; an earlier time changes nothing. */
  async storeActivity(at: number): Promise<void> {
    await this.ensureLoaded()
    if (at <= this.currentUpdatedAt) return
    this.currentUpdatedAt = at
    await this.persistSessionMeta()
  }

  private getResolvedMetadata(): BrowserSessionMetadata | undefined {
    return resolveSessionTitle(
      this.currentMetadata ? cloneValue(this.currentMetadata) : undefined,
      this.currentCustomTitle,
      this.currentAiTitle,
    )
  }

  private stripTitleFromMetadata(
    metadata: BrowserSessionMetadata | undefined,
  ): BrowserSessionMetadata | undefined {
    if (!metadata) {
      return undefined
    }
    const cloned = cloneValue(metadata)
    delete cloned.customTitle
    return cloned
  }

  async listSessions(): Promise<string[]> {
    if (!this.storageBackend.listSessions) {
      await this.ensureLoaded()
      return this.recordedMessages.length > 0 ? [this.sessionId] : []
    }
    return this.storageBackend.listSessions()
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.storageBackend.deleteSession) {
      return
    }

    await this.storageBackend.deleteSession(sessionId)

    if (sessionId === this.sessionId) {
      this.hasLoadedStoredMessages = true
      this.storedMessages = []
      this.recordedMessages = []
      this.recordedMessageUuids.clear()
      this.currentLeafUuid = null
      this.currentUpdatedAt = 0
      this.currentMetadata = undefined
      this.currentCustomTitle = undefined
      this.currentCustomTitleAt = undefined
      this.currentAiTitle = undefined
      this.toolCallDetails.clear()
      this.missingToolCallDetails.clear()
      this.releasedDetailIds.clear()
      this.cancelMetaRepair()
      this.hydrationMemo = new WeakMap()
      this.lazyRefIdsMemo = new WeakMap()
      this.transcriptLines = undefined
    }
  }

  private async loadSessionState(
    sessionId: string,
  ): Promise<NormalizedConversationState> {
    if (sessionId === this.sessionId) {
      await this.ensureLoaded()
      return {
        messages: cloneValue(this.storedMessages),
        activeMessages: cloneMessages(this.recordedMessages),
        leafUuid: this.currentLeafUuid,
        updatedAt: this.currentUpdatedAt,
        metadata: this.currentMetadata
          ? cloneValue(this.currentMetadata)
          : undefined,
        customTitle: this.currentCustomTitle,
        customTitleAt: this.currentCustomTitleAt,
        aiTitle: this.currentAiTitle,
      }
    }

    const payload = await this.storageBackend.load(sessionId)
    const normalized = normalizeConversationState(
      sessionId,
      payload,
      this.runtimeConfig,
    )
    return normalized
  }

  private async ensureLoaded(): Promise<void> {
    if (this.hasLoadedStoredMessages) {
      return
    }

    const appendEpoch = this.transcriptAppendEpoch
    const quietAtStart = this.transcriptAppendsInFlight === 0
    const payload = await this.storageBackend.load(this.sessionId)
    // Seeds the search-jump line map from this same read so the first
    // lookup after open does not read the transcript again.
    if (!this.transcriptLines) {
      this.adoptTranscriptLines(
        payload,
        transcriptLinesFromPayload(payload),
        quietAtStart,
        appendEpoch,
      )
    }
    const normalized = normalizeConversationState(
      this.sessionId,
      payload,
      this.runtimeConfig,
    )
    let meta: SessionMetaFile | null = null
    let metaUnreadable = false
    try {
      meta = await this.storageBackend.readSessionMeta(this.sessionId)
    } catch {
      metaUnreadable = true
    }
    this.metaUnreadableAtLoad = metaUnreadable

    this.storedMessages = normalized.messages
    this.recordedMessages = cloneMessages(normalized.activeMessages)
    this.recordedMessageUuids = new Set(
      normalized.messages.map(message => message.uuid),
    )
    this.currentLeafUuid = normalized.leafUuid
    this.hasLoadedStoredMessages = true

    if (meta) {
      const { meta: reconciled, changed } = reconcileMetaWithLog(
        meta,
        normalized,
      )
      this.adoptSessionMeta(reconciled)
      this.isPhantomRestoredSession = false
      if (changed) {
        await this.persistSessionMetaBestEffort()
      }
    } else {
      const derived = deriveSessionMetaFromNormalized(this.sessionId, normalized)
      this.isPhantomRestoredSession =
        this.restoredSessionId && !metaUnreadable && derived === null
      if (derived) {
        this.adoptSessionMeta(derived)
        if (!metaUnreadable) {
          await this.persistSessionMetaBestEffort()
        }
      } else {
        this.currentUpdatedAt = normalized.updatedAt
        this.currentMetadata = undefined
        this.currentCustomTitle = nonEmptyTitle(normalized.customTitle)
        this.currentCustomTitleAt = normalized.customTitleAt
        this.currentAiTitle = nonEmptyTitle(normalized.aiTitle)
        // Nothing on disk at all: a new session. An unreadable meta may hide
        // an old one, so its creation stays unknown.
        if (!metaUnreadable) {
          this.pendingCreatedAt = this.runtimeConfig.now()
        }
      }
    }

    restoreInvokedSkillsFromMessages(this.sessionId, this.recordedMessages)
  }

  private async loadSessionSummary(
    sessionId: string,
  ): Promise<BrowserSessionSummary | null> {
    if (sessionId === this.sessionId) {
      await this.ensureLoaded()
      return buildSessionSummary(sessionId, {
        messages: cloneValue(this.storedMessages),
        activeMessages: cloneMessages(this.recordedMessages),
        leafUuid: this.currentLeafUuid,
        updatedAt: this.currentUpdatedAt,
        metadata: this.currentMetadata
          ? cloneValue(this.currentMetadata)
          : undefined,
        customTitle: this.currentCustomTitle,
        aiTitle: this.currentAiTitle,
      })
    }

    if (this.storageBackend.loadSessionSummary) {
      return this.storageBackend.loadSessionSummary(sessionId)
    }

    const normalized = await this.loadSessionState(sessionId)
    return buildSessionSummary(sessionId, normalized)
  }

  private adoptSessionMeta(meta: SessionMetaFile): void {
    this.currentUpdatedAt = meta.updatedAt
    this.currentMetadata = this.stripTitleFromMetadata(meta.metadata) ?? {}
    this.currentCustomTitle = nonEmptyTitle(meta.customTitle)
    this.currentCustomTitleAt = meta.customTitleAt
    this.currentAiTitle = nonEmptyTitle(meta.aiTitle)
  }

  private buildSessionMetaFile(): SessionMetaFile {
    return {
      schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
      sessionId: this.sessionId,
      updatedAt: this.currentUpdatedAt,
      ...pickTitleFields(
        this.currentCustomTitle,
        this.currentCustomTitleAt,
        this.currentAiTitle,
      ),
      metadata: this.stripTitleFromMetadata(this.currentMetadata) ?? {},
    }
  }

  private async persistSessionMeta(): Promise<void> {
    if (this.isPhantomRestoredSession || this.persistenceDisabled) {
      return
    }
    if (this.pendingCreatedAt !== undefined) {
      this.currentMetadata = {
        createdAt: this.pendingCreatedAt,
        ...(this.currentMetadata ?? {}),
      }
      this.pendingCreatedAt = undefined
    }
    if (this.metaUnreadableAtLoad) {
      try {
        const onDisk = await this.storageBackend.readSessionMeta(this.sessionId)
        if (onDisk) {
          this.currentMetadata = {
            ...this.stripTitleFromMetadata(onDisk.metadata),
            ...(this.currentMetadata ?? {}),
          }
          this.currentAiTitle ??= nonEmptyTitle(onDisk.aiTitle)
          if (
            this.currentCustomTitleAt === undefined &&
            onDisk.customTitleAt !== undefined
          ) {
            this.currentCustomTitle = nonEmptyTitle(onDisk.customTitle)
            this.currentCustomTitleAt = onDisk.customTitleAt
          }
        }
        this.metaUnreadableAtLoad = false
      } catch {
      }
    }
    await this.storageBackend.writeSessionMeta(
      this.sessionId,
      this.buildSessionMetaFile(),
    )
    this.metaUnreadableAtLoad = false
    this.cancelMetaRepair()
  }

  private async persistSessionMetaBestEffort(): Promise<boolean> {
    try {
      await this.persistSessionMeta()
      return true
    } catch (error) {
      console.warn(
        `[sessionStorage] meta.json write failed for ${this.sessionId}; ` +
          'the transcript is intact and the next write repairs the projection',
        error,
      )
      return false
    }
  }

  private scheduleMetaRepair(attempt = 0): void {
    if (this.metaRepairTimer !== null || attempt >= META_REPAIR_DELAYS_MS.length) {
      return
    }
    this.metaRepairTimer = setTimeout(() => {
      this.metaRepairTimer = null
      void this.persistSessionMeta().catch(() => this.scheduleMetaRepair(attempt + 1))
    }, META_REPAIR_DELAYS_MS[attempt])
  }

  private cancelMetaRepair(): void {
    if (this.metaRepairTimer !== null) {
      clearTimeout(this.metaRepairTimer)
      this.metaRepairTimer = null
    }
  }

  async saveTerminalState(reason: string, timestamp: number): Promise<void> {
    await this.ensureLoaded()
    this.currentMetadata = {
      ...this.currentMetadata,
      lastTerminalReason: reason,
      lastTerminalTimestamp: timestamp,
    }
    if (!(await this.persistSessionMetaBestEffort())) {
      this.scheduleMetaRepair()
    }
  }

  private async appendToTranscript(
    entry: BrowserTranscriptWriteEntry,
    uuid?: string,
  ): Promise<void> {
    const lines = this.transcriptLines
    if (this.transcriptAppendsInFlight > 0) {
      this.transcriptLines = undefined
    }
    this.transcriptAppendsInFlight++
    this.transcriptAppendEpoch++
    try {
      await this.storageBackend.append(this.sessionId, entry)
    } catch (error) {
      this.transcriptLines = undefined
      throw error
    } finally {
      this.transcriptAppendsInFlight--
    }
    if (lines && this.transcriptLines === lines) {
      if (uuid) lines.map[uuid] = lines.nextLine
      lines.nextLine++
    }
  }

  private async persistToolCallDetails(
    messages: readonly Message[],
  ): Promise<void> {
    const details = messages.flatMap(getToolCallDetailsFromMessage)

    for (const detail of details) {
      await this.storeToolCallDetail(detail)
    }
  }

  private async storeToolCallDetail(
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    if (!shouldLazyLoadToolDetail(detail.toolName)) {
      return
    }

    let existing = this.toolCallDetails.get(detail.toolCallId)

    if (!existing && this.releasedDetailIds.has(detail.toolCallId)) {
      const onDisk =
        (await this.storageBackend.loadToolCallDetail?.(
          this.sessionId,
          detail.toolCallId,
        )) ?? null
      existing = this.toolCallDetails.get(detail.toolCallId)
      if (!existing) {
        if (!onDisk) {
          return
        }
        this.toolCallDetails.set(detail.toolCallId, onDisk)
        this.persistedDetailRecords.add(onDisk)
        this.releasedDetailIds.delete(detail.toolCallId)
        existing = onDisk
        detail = mergeToolCallDetails(detail, onDisk)
      }
    }

    if (existing?.origin !== undefined && detail.origin === undefined) {
      return
    }

    const merged = mergeToolCallDetails(existing, detail)
    this.missingToolCallDetails.delete(detail.toolCallId)

    const pendingCompact = this.pendingCompactResults.get(detail.toolCallId)
    if (pendingCompact !== undefined && merged.result !== undefined) {
      this.pendingCompactResults.delete(detail.toolCallId)
      const parsedCompact = safeParseJson(pendingCompact)
      const promoted: BrowserToolCallDetailRecord = {
        ...merged,
        origin: merged.result,
        result: parsedCompact,
        updatedAt: this.runtimeConfig.now(),
      }
      this.toolCallDetails.set(detail.toolCallId, promoted)

      if (!this.persistenceDisabled) {
        await this.storageBackend.saveToolCallDetail?.(this.sessionId, promoted)
        if (this.storageBackend.saveToolCallDetail) this.persistedDetailRecords.add(promoted)
      }
      return
    }

    this.toolCallDetails.set(detail.toolCallId, merged)

    if (!this.persistenceDisabled) {
      await this.storageBackend.saveToolCallDetail?.(this.sessionId, merged)
      if (this.storageBackend.saveToolCallDetail) this.persistedDetailRecords.add(merged)
    }
  }
}

export function setConversationStore(store: ConversationStore): void {
  activeConversationStore = store
}

export function getConversationStore(): ConversationStore | null {
  return activeConversationStore
}

export function clearConversationStore(): void {
  activeConversationStore = null
}

export async function saveTranscriptRows(
  messages: readonly Message[],
  store?: ConversationStore,
): Promise<void> {
  await resolveConversationStore(store).saveTranscriptRows(messages)
}

export async function storeUserTitle(
  customTitle: string,
  source: 'user' | 'auto' = 'user',
  store?: ConversationStore,
): Promise<void> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  await resolved.storeUserTitle?.(customTitle, source)
}

export async function storeAutoTitle(
  aiTitle: string,
  store?: ConversationStore,
): Promise<void> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  await resolved.storeAutoTitle?.(aiTitle)
}

export async function getSessionMetadata(
  store?: ConversationStore,
): Promise<BrowserSessionMetadata | undefined> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  return resolved.getSessionMetadata ? resolved.getSessionMetadata() : undefined
}

export async function drainWrites(
  store?: ConversationStore,
): Promise<void> {
  await resolveConversationStore(store).drainWrites()
}

export function getSessionId(store?: ConversationStore): string {
  return resolveConversationStore(store).getSessionId()
}

export function isEphemeral(
  store?: ConversationStore,
): boolean {
  return resolveConversationStore(store).isEphemeral()
}

export async function getRecordedMessages(
  store?: ConversationStore,
): Promise<readonly Message[]> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.getRecordedMessages) {
    return []
  }

  return await resolved.getRecordedMessages()
}

export async function getRecordedMessagesForSession(
  sessionId: string,
  store?: ConversationStore,
): Promise<readonly Message[]> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.getRecordedMessagesForSession) {
    return []
  }

  return await resolved.getRecordedMessagesForSession(sessionId)
}

export async function hydrateMessagesForModel(
  store?: ConversationStore,
): Promise<readonly Message[] | null> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.hydrateMessagesForModel) {
    return null
  }

  return await resolved.hydrateMessagesForModel()
}

export async function getSessionSummaries(
  store?: ConversationStore,
): Promise<readonly BrowserSessionSummary[]> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.getSessionSummaries) {
    return []
  }

  return await resolved.getSessionSummaries()
}
