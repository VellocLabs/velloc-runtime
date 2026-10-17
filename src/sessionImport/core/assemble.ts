/**
 * Provider-neutral import assembly: a provider supplies an ordered
 * `Converted[]`; the fork-builder wrap, tool-detail sidecar split, meta.json
 * projection and `ImportConvertResult` are shared. Pure: no fs, no bridge.
 */

import type { Message } from '../../runtime/RuntimeTypes'
import {
  buildForkedTranscriptEntries,
  type BrowserSessionMetadata,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../../sessions/sessionStore'
import {
  getToolCallDetailsFromMessage,
  sanitizeMessageForPersistence,
  type BrowserToolCallDetailRecord,
} from '../../utils/toolCallDetails'
import {
  ImportConvertError,
  type ImportConvertResult,
  type ImportSource,
  type ImportSubAgentBundle,
} from '../protocol'
import type { Converted } from './chain'
import { asString } from './json'

/** `templateType` of every imported session: the folder-bound type, so the
 *  session lands under its project folder in the sidebar. */
export const IMPORTED_TEMPLATE_TYPE = 'code'

/** `templateType` of an imported sub-agent's own session. */
export const IMPORTED_SUBAGENT_TEMPLATE_TYPE = 'agent'

export type ConvertedBundle = {
  entries: BrowserTranscriptWriteEntry[]
  meta: SessionMetaFile
  toolDetails: BrowserToolCallDetailRecord[]
  messageCount: number
  firstTimestamp: string | null
  lastTimestamp: string | null
}

/**
 * Velloc messages → transcript entries, meta.json projection and tool-detail
 * sidecars, by the same assembly a native fork uses. Canonical
 * `tool-call`/`tool-result` parts get sidecars.
 */
export function assembleConvertedBundle(
  converted: readonly Converted[],
  options: {
    sessionId: string
    now: number
    path: string
    title: string | undefined
    carryOver: BrowserSessionMetadata
  },
): ConvertedBundle {
  if (converted.length === 0) {
    throw new ImportConvertError('empty', `No conversation in ${options.path}`)
  }
  const sourceEntries: BrowserTranscriptEntry[] = converted.map(
    c =>
      ({
        ...c.message,
        sessionId: options.sessionId,
        parentUuid: null,
      }) as unknown as BrowserTranscriptEntry,
  )
  const lastUuid = converted[converted.length - 1]!.uuid
  const built = buildForkedTranscriptEntries(
    sourceEntries,
    lastUuid,
    options.sessionId,
    options.now,
    options.carryOver,
    undefined,
    { title: options.title, as: 'import' },
  )
  if (!built) {
    throw new ImportConvertError(
      'chain',
      `Could not build the chain for ${options.path}`,
    )
  }

  const details = new Map<string, BrowserToolCallDetailRecord>()
  const entries: BrowserTranscriptWriteEntry[] = built.entries.map(entry => {
    const type = (entry as { type?: unknown }).type
    if (type === 'custom-title' || type === 'ai-title') return entry
    const message = entry as unknown as Message
    for (const detail of getToolCallDetailsFromMessage(message)) {
      details.set(detail.toolCallId, {
        ...(details.get(detail.toolCallId) ?? {}),
        ...detail,
      })
    }
    return sanitizeMessageForPersistence(
      message,
    ) as unknown as BrowserTranscriptWriteEntry
  })

  return {
    entries,
    meta: built.meta,
    toolDetails: Array.from(details.values()),
    messageCount: converted.length,
    firstTimestamp: asString(converted[0]!.message.timestamp),
    lastTimestamp: asString(converted[converted.length - 1]!.message.timestamp),
  }
}

/**
 * Stamp the final session metadata (templateType, projectRoot, provider-
 * specific `extraMetadata`, and `importedFrom`) onto a bundle and assemble the
 * `ImportConvertResult`. Shared shape; `source` + `extraMetadata` are the only
 * provider inputs.
 */
export function finalizeImportResult(args: {
  source: ImportSource
  sessionId: string
  projectRoot: string
  path: string
  now: number
  bundle: ConvertedBundle
  extraMetadata?: Partial<BrowserSessionMetadata>
  subAgents: ImportSubAgentBundle[]
  stats: ImportConvertResult['stats']
}): ImportConvertResult {
  const meta = args.bundle.meta
  meta.metadata = {
    ...meta.metadata,
    templateType: IMPORTED_TEMPLATE_TYPE,
    projectRoot: args.projectRoot,
    ...(args.extraMetadata ?? {}),
    importedFrom: {
      source: args.source,
      path: args.path,
      importedAt: args.now,
    },
  }
  return {
    source: args.source,
    sessionId: args.sessionId,
    entries: args.bundle.entries,
    meta,
    toolDetails: args.bundle.toolDetails,
    projectRoot: args.projectRoot,
    subAgents: args.subAgents,
    stats: args.stats,
  }
}
