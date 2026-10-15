/**
 * Periodic memory consolidation. When enough time has passed and enough
 * other sessions have run since the last pass, a sub-agent reorganises the
 * memory directory. A lock file in that directory records the last pass and
 * keeps two windows from consolidating at once.
 */

import type { ToolCallContext } from '../../toolkit/toolCallContext'
import type { Message, InstructionText } from '../../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { fsForContext, type RuntimeFs } from '../../utils/fs/runtimeFs'
import { captureForkPrefix, launchFork } from '../../agents/forkedRun'
import type { SidechainTranscriptStore } from '../../utils/sidechainTranscripts'
import { makeUserRow } from '../../messages/messageFactories'
import { getModelForSessionType } from '../../engine/contextWindow'
import { getConversationTranscriptPath } from '../../utils/conversationStoragePaths'
import { isMemoryEnabled, resolveMemoryDir } from '../memoryPaths'
import { memoryWriterPermissionGate } from '../extract/extractionRunner'
import { RuntimeSlots } from '../runtimeSlots'
import { composeTidyBrief } from './consolidatorPrompt'
import {
  sessionsActiveSince,
  lastTidyStamp,
  stampTidyDone,
  releaseTidyLease,
  claimTidyLease,
} from './runLock'

export type MemoryConsolidationContext = {
  messages: Message[]
  systemPrompt: InstructionText
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolCallContext
}

export type MemoryConsolidatorDeps = {
  runtimeConfig: RuntimeConfig
  sidechainStore?: SidechainTranscriptStore
  logEvent?: (event: string, payload: Record<string, unknown>) => void
  /** Ids of this project's stored sessions. */
  listSessions?: () => Promise<string[]>
  /** Directory the session transcripts live under. */
  historyFolder?: string
  /** Threshold overrides (tests and e2e). */
  config?: { minHours?: number; minSessions?: number; scanIntervalMs?: number }
}

type Consolidator = { deps: MemoryConsolidatorDeps; lastScanAt: number }

const consolidators = new RuntimeSlots<Consolidator>()

const HOUR_MS = 3_600_000

export function registerMemoryConsolidator(deps: MemoryConsolidatorDeps): void {
  consolidators.put(deps.runtimeConfig, { deps, lastScanAt: 0 })
}

export function resetMemoryConsolidationForTests(): void {
  consolidators.clear()
}

function constraintsNote(sessionIds: string[]): string {
  const list = sessionIds.map(id => `- ${id}`).join('\n')
  return (
    '\n\n**Shell in this run is read-only:** `ls`, `find`, `grep`, `cat`, `stat`, `wc`, `head`, `tail` and similar commands work; anything that writes, redirects into a file or changes state is refused, so there is no need to test it.' +
    `\n\nSessions since the last tidy (${sessionIds.length}):\n${list}`
  )
}

type Eligible = { memoryDir: string; fs: RuntimeFs; since: number; sessions: string[]; priorAt: number }

/** Walks the gates in order; `undefined` means "not this turn". */
async function checkGates(
  job: Consolidator,
  ctx: MemoryConsolidationContext,
): Promise<Eligible | undefined> {
  const { deps } = job
  const options = ctx.toolUseContext.options
  const settings = options.memorySettings
  if (ctx.toolUseContext.agentId) return undefined
  if (!isMemoryEnabled(deps.runtimeConfig, settings)) return undefined
  if (settings?.memoryMaintenance !== 'periodic') return undefined

  const minHours = deps.config?.minHours ?? 24
  const minSessions = deps.config?.minSessions ?? 5
  const scanIntervalMs = deps.config?.scanIntervalMs ?? 600_000

  const fs = fsForContext(ctx.toolUseContext)
  const memoryDir = await resolveMemoryDir(options.cwd, deps.runtimeConfig, fs, {
    projectRoot: options.projectRoot,
    homeDir: options.homeDir,
    memorySettings: settings,
  })

  let since: number
  try {
    since = await lastTidyStamp(memoryDir, fs)
  } catch {
    return undefined
  }
  const now = Date.now()
  if ((now - since) / HOUR_MS < minHours) return undefined

  if (now - job.lastScanAt < scanIntervalMs) return undefined
  job.lastScanAt = now

  let sessions: string[] = []
  const { listSessions, historyFolder } = deps
  if (listSessions && historyFolder) {
    try {
      sessions = await sessionsActiveSince(
        since,
        { listSessions, transcriptPath: id => getConversationTranscriptPath(historyFolder, id) },
        fs,
      )
    } catch {
      return undefined
    }
  }
  sessions = sessions.filter(id => id !== options.sessionId)
  if (sessions.length < minSessions) return undefined

  let priorAt: number | null
  try {
    priorAt = await claimTidyLease(memoryDir, options.sessionId, fs)
  } catch {
    return undefined
  }
  if (priorAt === null) return undefined
  return { memoryDir, fs, since, sessions, priorAt }
}

/** Called at the end of a main-agent turn. Never throws. */
export async function runMemoryConsolidation(ctx: MemoryConsolidationContext): Promise<void> {
  const options = ctx.toolUseContext.options
  const job = consolidators.find(options.runtimeConfig)
  if (!job) return
  const log = job.deps.logEvent ?? (() => {})

  let ready: Eligible | undefined
  try {
    ready = await checkGates(job, ctx)
  } catch {
    return
  }
  if (!ready) return

  log('nexus_periodic_tidy_fired', {
    hours_since: Math.round((Date.now() - ready.since) / HOUR_MS),
    sessions_since: ready.sessions.length,
  })

  const started = Date.now()
  try {
    const prompt = composeTidyBrief(
      ready.memoryDir,
      job.deps.historyFolder ?? '',
      constraintsNote(ready.sessions),
    )
    const result = await launchFork({
      openingRows: [makeUserRow(job.deps.runtimeConfig, prompt)],
      forkPrefix: captureForkPrefix({
        systemPrompt: ctx.systemPrompt,
        userContext: ctx.userContext,
        systemContext: ctx.systemContext,
        toolUseContext: ctx.toolUseContext,
        messages: ctx.messages,
      }),
      canUseTool: memoryWriterPermissionGate(ready.memoryDir),
      modelLadder: getModelForSessionType(
        'memory_consolidate',
        options.mainLoopProviderId ?? '',
        options.mainLoopModel,
      ),
      querySource: 'periodic_tidy',
      forkLabel: 'periodic_tidy',
      useRealModelTransport: true,
      sidechainStore: job.deps.sidechainStore,
      spawnerSessionId: options.sessionId || undefined,
      maxTurns: 12,
      skipCacheWrite: true,
    })
    await stampTidyDone(ready.memoryDir, ready.fs)
    log('nexus_periodic_tidy_completed', {
      sessions_reviewed: ready.sessions.length,
      turn_count: result.messages.filter(m => (m as { type?: string }).type === 'assistant').length,
      duration_ms: Date.now() - started,
      agent_id: result.agentId,
    })
  } catch (error) {
    await releaseTidyLease(ready.memoryDir, ready.priorAt, ready.fs).catch(() => {})
    log('nexus_periodic_tidy_error', {
      duration_ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
