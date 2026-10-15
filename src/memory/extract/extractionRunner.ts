/**
 * End-of-turn memory extraction. After a main-agent turn, a restricted
 * sub-agent reads the new part of the conversation and files durable
 * memories; the topic files it wrote are announced at the start of the next
 * turn.
 */

import type { PermissionDecider } from '../../toolkit/permissionVerdict'
import type { ToolCallContext } from '../../toolkit/toolCallContext'
import type { Message, InstructionText } from '../../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { fsForContext } from '../../utils/fs/runtimeFs'
import { captureForkPrefix, launchFork } from '../../agents/forkedRun'
import type { SidechainTranscriptStore } from '../../utils/sidechainTranscripts'
import { makeUserRow } from '../../messages/messageFactories'
import { getModelForSessionType } from '../../engine/contextWindow'
import {
  SHELL_TOOL_ID,
  FIND_FILES_TOOL_ID,
  SEARCH_TEXT_TOOL_ID,
} from '../../prompting/processToolNames'
import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from '../../prompting/fileToolNames'
import { isMemoryEnabled, resolveMemoryDir } from '../memoryPaths'
import { MEMORY_INDEX_FILE } from '../memoryPrompt'
import { listMemoryFiles, renderMemoryManifest } from '../memoryManifest'
import { RuntimeSlots } from '../runtimeSlots'
import { composeExtractionBrief } from './extractorPrompt'

export type MemoryExtractionContext = {
  messages: Message[]
  systemPrompt: InstructionText
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolCallContext
}

export type MemoryExtractorDeps = {
  runtimeConfig: RuntimeConfig
  sidechainStore?: SidechainTranscriptStore
  logEvent?: (event: string, payload: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Paths and tool calls
// ---------------------------------------------------------------------------

function comparable(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** True when `path` sits under `dir` (slash style and case ignored). */
export function isInsideDir(path: string, dir: string): boolean {
  return comparable(path).startsWith(comparable(dir))
}

type ToolCall = { name: string; input: Record<string, unknown> }

function toolCallsOf(message: Message): ToolCall[] {
  const m = message as { type?: string; message?: { content?: unknown } }
  if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) return []
  const calls: ToolCall[] = []
  for (const block of m.message!.content as Array<Record<string, unknown>>) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      calls.push({ name: block.name, input: (block.input ?? {}) as Record<string, unknown> })
    } else if (block?.type === 'tool-call' && typeof block.toolName === 'string') {
      const input = block.args ?? block.input ?? {}
      calls.push({ name: block.toolName, input: input as Record<string, unknown> })
    }
  }
  return calls
}

/** `file_path`s of every Write/Edit call in `messages`, first-seen order, no repeats. */
function writtenFiles(messages: Message[]): string[] {
  const seen = new Set<string>()
  for (const message of messages) {
    for (const call of toolCallsOf(message)) {
      if (call.name !== WRITE_TOOL_ID && call.name !== EDIT_TOOL_ID) continue
      const target = call.input.file_path
      if (typeof target === 'string') seen.add(target)
    }
  }
  return [...seen]
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

type GateTool = { name?: string; readsOnly?: (input: unknown) => boolean }

/** Read-only tools anywhere; writes only inside `memoryDir`. */
export function memoryWriterPermissionGate(memoryDir: string): PermissionDecider {
  const readers = new Set([READ_TOOL_ID, SEARCH_TEXT_TOOL_ID, FIND_FILES_TOOL_ID])
  const writers = new Set([EDIT_TOOL_ID, WRITE_TOOL_ID])
  const allow = (input: unknown) => ({ behavior: 'allow' as const, updatedInput: input })
  const deny = (message: string) => ({ behavior: 'deny' as const, message })

  return async (tool: unknown, input: unknown) => {
    const name = (tool as GateTool | undefined)?.name
    if (!name) return deny('unknown tool')
    if (readers.has(name)) return allow(input)
    if (name === SHELL_TOOL_ID) {
      return (tool as GateTool).readsOnly?.(input) === true
        ? allow(input)
        : deny(
            'only read-only shell commands are permitted in extractMemories (ls, find, grep, cat, stat, wc, head, tail, and similar)',
          )
    }
    if (writers.has(name)) {
      const target = (input as { file_path?: unknown } | undefined)?.file_path
      return typeof target === 'string' && isInsideDir(target, memoryDir)
        ? allow(input)
        : deny(`${name} is only permitted for paths inside ${memoryDir}`)
    }
    return deny(`${name} is not permitted in extractMemories`)
  }
}

// ---------------------------------------------------------------------------
// Per-runtime state
// ---------------------------------------------------------------------------

type Extractor = {
  deps: MemoryExtractorDeps
  /** uuid of the last message the previous run covered. */
  cursor?: string
  busy: boolean
  queued?: MemoryExtractionContext
  saved: string[]
}

const extractors = new RuntimeSlots<Extractor>()
const inFlight = new Set<Promise<void>>()
let lastSaved: Extractor | undefined

export function registerMemoryExtractor(deps: MemoryExtractorDeps): void {
  extractors.put(deps.runtimeConfig, { deps, busy: false, saved: [] })
}

export function resetMemoryExtractionForTests(): void {
  extractors.clear()
  inFlight.clear()
  lastSaved = undefined
}

/** Topic files saved since the last call, or `null`; the list is cleared. */
export function takeSavedMemoryPaths(rc: RuntimeConfig | undefined): string[] | null {
  const owner = rc ? extractors.find(rc) : lastSaved
  if (!owner || owner.saved.length === 0) return null
  const paths = owner.saved
  owner.saved = []
  if (owner === lastSaved) lastSaved = undefined
  return paths
}

/** Resolves once every running extraction settles, or after `timeoutMs`. */
export async function awaitMemoryExtractions(timeoutMs = 60_000): Promise<void> {
  if (inFlight.size === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), timeout])
  if (timer !== undefined) clearTimeout(timer)
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function isConversationTurn(message: Message): boolean {
  const type = (message as { type?: string }).type
  return type === 'user' || type === 'assistant'
}

function messagesAfter(messages: Message[], cursor: string | undefined): Message[] {
  if (cursor === undefined) return messages
  const at = messages.findIndex(m => (m as { uuid?: string }).uuid === cursor)
  return at < 0 ? messages : messages.slice(at + 1)
}

function lastUuid(messages: Message[]): string | undefined {
  return (messages[messages.length - 1] as { uuid?: string } | undefined)?.uuid
}

async function extractOnce(
  state: Extractor,
  ctx: MemoryExtractionContext,
  trailing: boolean,
): Promise<void> {
  const log = state.deps.logEvent ?? (() => {})
  const started = Date.now()
  try {
    const options = ctx.toolUseContext.options
    const settings = options.memorySettings
    const fs = fsForContext(ctx.toolUseContext)
    const memoryDir = await resolveMemoryDir(options.cwd, state.deps.runtimeConfig, fs, {
      projectRoot: options.projectRoot,
      homeDir: options.homeDir,
      memorySettings: settings,
    })

    const fresh = messagesAfter(ctx.messages, state.cursor)
    const newCount = fresh.filter(isConversationTurn).length
    const wroteDirectly = writtenFiles(fresh).some(p => isInsideDir(p, memoryDir))
    if (wroteDirectly) {
      state.cursor = lastUuid(ctx.messages) ?? state.cursor
      log('nexus_extract_memories_skipped_direct_write', { message_count: newCount })
      return
    }

    let manifest = ''
    try {
      manifest = renderMemoryManifest(
        await listMemoryFiles(memoryDir, ctx.toolUseContext.cancelSource.signal, fs),
      )
    } catch {
      manifest = ''
    }
    const prompt = composeExtractionBrief(
      newCount,
      manifest,
      settings?.memoryMaintenance === 'dailyLog',
    )

    const result = await launchFork({
      openingRows: [makeUserRow(state.deps.runtimeConfig, prompt)],
      forkPrefix: captureForkPrefix({
        systemPrompt: ctx.systemPrompt,
        userContext: ctx.userContext,
        systemContext: ctx.systemContext,
        toolUseContext: ctx.toolUseContext,
        messages: ctx.messages,
      }),
      canUseTool: memoryWriterPermissionGate(memoryDir),
      modelLadder: getModelForSessionType(
        'memory_extract',
        options.mainLoopProviderId ?? '',
        options.mainLoopModel,
      ),
      querySource: 'extract_memories',
      forkLabel: 'extract_memories',
      useRealModelTransport: true,
      sidechainStore: state.deps.sidechainStore,
      spawnerSessionId: options.sessionId || undefined,
      maxTurns: 5,
      skipCacheWrite: true,
    })

    state.cursor = lastUuid(ctx.messages) ?? state.cursor
    const written = writtenFiles(result.messages)
    const topics = written.filter(p => p.split(/[\\/]/).pop() !== MEMORY_INDEX_FILE)
    if (topics.length > 0) {
      state.saved = [...new Set([...state.saved, ...topics])]
      lastSaved = state
    }
    log('nexus_extract_memories_extraction', {
      message_count: newCount,
      turn_count: result.messages.filter(m => (m as { type?: string }).type === 'assistant').length,
      files_written: written.length,
      memories_saved: topics.length,
      duration_ms: Date.now() - started,
      agent_id: result.agentId,
      is_trailing_run: trailing,
    })
  } catch (error) {
    log('nexus_extract_memories_error', {
      duration_ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function drive(state: Extractor, first: MemoryExtractionContext): Promise<void> {
  let next: MemoryExtractionContext | undefined = first
  let trailing = false
  try {
    while (next) {
      await extractOnce(state, next, trailing)
      next = state.queued
      state.queued = undefined
      trailing = true
    }
  } finally {
    state.busy = false
  }
}

/** Called at the end of a main-agent turn. Never throws. */
export function runMemoryExtraction(ctx: MemoryExtractionContext): Promise<void> {
  const options = ctx.toolUseContext.options
  const state = extractors.find(options.runtimeConfig)
  if (!state) return Promise.resolve()
  if (ctx.toolUseContext.agentId) return Promise.resolve()
  if (!isMemoryEnabled(state.deps.runtimeConfig, options.memorySettings)) return Promise.resolve()
  if (options.memorySettings?.autoExtractEnabled !== true) return Promise.resolve()

  if (state.busy) {
    state.queued = ctx
    state.deps.logEvent?.('nexus_extract_memories_coalesced', {})
    return Promise.resolve()
  }
  state.busy = true
  const job = drive(state, ctx)
  inFlight.add(job)
  void job.finally(() => inFlight.delete(job))
  return job
}
