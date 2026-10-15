/**
 * Contract: a `~/.claude/projects/<slug>/<uuid>.jsonl` transcript (plus its
 * `subagents/**\/agent-<id>.jsonl` files) → what `writeSessionBundle` /
 * `writeSubAgentBundle` write (F-8). Chain lines are user / assistant /
 * attachment and compact-boundary system lines; sidechains become background
 * sub-agents (no `agentId` → dropped); the chain is the latest leaf walked by
 * `parentUuid` (broken → file order); `tool_use` / `tool_result` become
 * `tool-call` / `tool-result`, one result per message; `Task` → `Agent`;
 * provenance stamps are not copied. Pure.
 */

import type { Message } from '../../../runtime/RuntimeTypes'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_ATTACHMENT,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_USER,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
} from '../../../runtime/VercelModelConstants'
import { type BrowserSessionMetadata } from '../../../sessions/sessionStore'
import {
  ImportConvertError,
  type ImportConvertResult,
  type ImportSubAgentBundle,
  type ImportSubAgentInput,
} from '../../protocol'
// Shared provider-neutral import core (the "implement is the same, only the map
// differs" half). Codex reuses the identical modules.
import { asRecord, asString, isTrue } from '../../core/json'
import { selectChain, type Converted, type Participant } from '../../core/chain'
import { deriveTaskId } from '../../core/taskId'
import {
  assembleConvertedBundle,
  finalizeImportResult,
  IMPORTED_SUBAGENT_TEMPLATE_TYPE,
  IMPORTED_TEMPLATE_TYPE,
  type ConvertedBundle,
} from '../../core/assemble'
import { pickSessionTitle, promptToTitle } from '../../core/sessionTitle'
import { sessionUuidFromFileName, userTextBlocks } from './parseLite'

// Re-exported so existing callers/tests that import these from this module
// keep working now that the implementations live in the shared core.
export { deriveTaskId, IMPORTED_TEMPLATE_TYPE, IMPORTED_SUBAGENT_TEMPLATE_TYPE }

type RawRecord = Record<string, unknown>

/** Velloc's Agent tool name; the CLI's older `Task` is the same tool. */
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const SPAWN_TOOL_ID = 'Agent'

/** The one-line records that name the session; last occurrence wins. */
type TitleRecords = {
  customTitle?: string
  aiTitle?: string
  lastPrompt?: string
  summary?: string
  permissionMode?: string
}

function collectTitleRecord(raw: RawRecord, into: TitleRecords): boolean {
  switch (raw.type) {
    case 'custom-title': {
      const value = asString(raw.customTitle)
      if (value) into.customTitle = value
      return true
    }
    case 'ai-title': {
      const value = asString(raw.aiTitle)
      if (value) into.aiTitle = value
      return true
    }
    // `{ type:'last-prompt', lastPrompt }` — the CLI re-appends the most recent
    // user prompt near EOF so a lite tail read can title the session by it;
    // it ranks above `summary`.
    case 'last-prompt': {
      const value = asString(raw.lastPrompt)
      if (value) into.lastPrompt = value
      return true
    }
    case 'summary': {
      const value = asString(raw.summary)
      if (value) into.summary = value
      return true
    }
    case 'mode': {
      const value = asString(raw.mode)
      if (value) into.permissionMode = value
      return true
    }
    default:
      return false
  }
}

function joinsReplyChain(raw: RawRecord): boolean {
  switch (raw.type) {
    case MSG_TYPE_USER:
    case MSG_TYPE_ASSISTANT:
    case MSG_TYPE_ATTACHMENT:
      return true
    case MSG_TYPE_SYSTEM:
      return raw.subtype === SYSTEM_SUBTYPE_COMPACT_BOUNDARY
    default:
      return false
  }
}

function normalizeContentBlocks(content: unknown): unknown[] | string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content : []
}

function flattenResultBody(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record && record.type === 'text' && typeof record.text === 'string') {
      texts.push(record.text)
    }
  }
  return texts.join('\n')
}

type ToolCallInfo = { toolName: string; args: unknown }

function convertAssistant(
  raw: RawRecord,
  uuid: string,
  timestamp: string,
  toolCalls: Map<string, ToolCallInfo>,
): Converted {
  const source = asRecord(raw.message) ?? {}
  const content = normalizeContentBlocks(source.content)
  const blocks =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const mapped = blocks.map(block => {
    const record = asRecord(block)
    if (!record || record.type !== 'tool_use') return block
    const toolCallId = asString(record.id)
    const rawName = asString(record.name)
    if (!toolCallId || !rawName) return block
    const toolName = AGENT_TOOL_NAMES.has(rawName) ? SPAWN_TOOL_ID : rawName
    toolCalls.set(toolCallId, { toolName, args: record.input })
    return {
      type: PART_TOOL_CALL,
      toolCallId,
      toolName,
      args: record.input,
    }
  })
  const { content: _content, ...rest } = source
  return {
    uuid,
    message: {
      type: MSG_TYPE_ASSISTANT,
      uuid,
      timestamp,
      message: { ...rest, role: 'assistant', content: mapped },
    } as Message,
  }
}

function convertUser(
  raw: RawRecord,
  uuid: string,
  timestamp: string,
  parentUuid: string | null,
  toolCalls: Map<string, ToolCallInfo>,
): Converted[] {
  const source = asRecord(raw.message) ?? {}
  const content = normalizeContentBlocks(source.content)
  const flags = {
    ...(isTrue(raw.isMeta) ? { isMeta: true } : {}),
    ...(isTrue(raw.isCompactSummary) ? { isCompactSummary: true } : {}),
  }
  if (typeof content === 'string') {
    return [
      {
        uuid,
        message: {
          type: MSG_TYPE_USER,
          uuid,
          timestamp,
          message: { role: 'user', content },
          ...flags,
        } as Message,
      },
    ]
  }

  const results: RawRecord[] = []
  const others: unknown[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record && record.type === 'tool_result') results.push(record)
    else others.push(block)
  }
  if (results.length === 0) {
    return [
      {
        uuid,
        message: {
          type: MSG_TYPE_USER,
          uuid,
          timestamp,
          message: { role: 'user', content: others },
          ...flags,
        } as Message,
      },
    ]
  }

  // One Velloc message per tool result. The CLI's `toolUseResult` is the
  // structured result for the FIRST (usually only) result; later splits
  // fall back to the text of their own content.
  const rawToolUseResult = raw.toolUseResult
  const converted: Converted[] = results.map((result, index) => {
    const toolCallId = asString(result.tool_use_id) ?? `unknown-${uuid}-${index}`
    const info = toolCalls.get(toolCallId)
    const isError = isTrue(result.is_error)
    const resultContent = result.content ?? ''
    const text =
      index === 0 && typeof rawToolUseResult === 'string'
        ? rawToolUseResult
        : flattenResultBody(resultContent)
    const messageUuid = index === 0 ? uuid : `${uuid}-r${index}`
    const detail = info
      ? {
          toolCallDetailRef: { toolCallId, toolName: info.toolName },
          toolCallDetail: {
            toolCallId,
            toolName: info.toolName,
            args: info.args,
            result: resultContent,
            ...(isError ? { isError: true } : {}),
          },
        }
      : {}
    return {
      uuid: messageUuid,
      message: {
        type: MSG_TYPE_USER,
        uuid: messageUuid,
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: PART_TOOL_RESULT_CANONICAL,
              result: resultContent,
              ...(isError ? { isError: true } : {}),
              toolCallId,
            },
          ],
        },
        toolUseResult: text,
        ...(parentUuid ? { sourceToolAssistantUUID: parentUuid } : {}),
        ...detail,
        ...flags,
      } as Message,
    }
  })

  // Non-result sibling blocks on the same line (text / `<system-reminder>` /
  // image the CLI can append beside a tool result) would otherwise be dropped:
  // the per-result split emits only tool-result rows. Emit them as one extra
  // trailing user message so nothing on the line is lost. Chained after the
  // results by array order (buildForkedTranscriptEntries rebuilds parentUuid).
  if (others.length > 0) {
    converted.push({
      uuid: `${uuid}-others`,
      message: {
        type: MSG_TYPE_USER,
        uuid: `${uuid}-others`,
        timestamp,
        message: { role: 'user', content: others },
        ...flags,
      } as Message,
    })
  }
  return converted
}

function convertCompactBoundary(
  raw: RawRecord,
  uuid: string,
  timestamp: string,
): Converted {
  const metadata = asRecord(raw.compactMetadata)
  return {
    uuid,
    message: {
      type: MSG_TYPE_SYSTEM,
      subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
      uuid,
      timestamp,
      // Same shape `messages/messageFactories.ts#makeFoldLine`
      // produces; built by hand so this module stays free of the runtime's
      // system-message renderer dependency.
      message: 'Conversation compacted',
      compactMetadata: {
        trigger: metadata?.trigger === 'manual' ? 'manual' : 'auto',
        preTokens:
          typeof metadata?.preTokens === 'number' ? metadata.preTokens : 0,
      },
    } as Message,
  }
}

function convertAttachment(
  raw: RawRecord,
  uuid: string,
  timestamp: string,
): Converted {
  return {
    uuid,
    message: {
      type: MSG_TYPE_ATTACHMENT,
      uuid,
      timestamp,
      attachment: raw.attachment,
    } as Message,
  }
}

/** The first meaningful user prompt in file order — the same answer the list
 *  pass's `firstPromptInHead` gives, reusing the same per-prompt logic
 *  (`promptToTitle`: slash-command fallback, `! bash`, skip auto-generated
 *  tags, 200-char cap) so an untitled import bears the same fallback title the
 *  dialog row showed. Skips tool-result rows and meta / compact-summary lines. */
function firstPromptFromParticipants(
  participants: readonly Participant[],
): string {
  let commandFallback = ''
  for (const p of participants) {
    if (p.raw.type !== MSG_TYPE_USER) continue
    if (isTrue(p.raw.isMeta) || isTrue(p.raw.isCompactSummary)) continue
    const content = asRecord(p.raw.message)?.content
    // A tool-result row carries no user prompt (the list pass skips those
    // lines too).
    if (
      Array.isArray(content) &&
      content.some(block => asRecord(block)?.type === 'tool_result')
    ) {
      continue
    }
    for (const raw of userTextBlocks(content)) {
      const candidate = promptToTitle(raw)
      if (!candidate) continue
      if ('command' in candidate) {
        if (!commandFallback) commandFallback = candidate.command
        continue
      }
      return candidate.title
    }
  }
  return commandFallback
}

/** Display title, with the list pass's `titleFromSlices` precedence
 *  (customTitle → aiTitle → lastPrompt → summary → firstPrompt) via the shared
 *  `pickSessionTitle`, so the imported session's title matches the dialog
 *  row the user clicked. */
function resolveTitle(
  records: TitleRecords,
  firstPrompt: string,
): string | undefined {
  return (
    pickSessionTitle({
      customTitle: records.customTitle,
      aiTitle: records.aiTitle,
      lastPrompt: records.lastPrompt,
      summary: records.summary,
      firstPrompt,
    }) ?? undefined
  )
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

type ParsedFile = {
  lines: number
  skippedLines: number
  droppedRecords: number
  droppedSidechain: number
  titles: TitleRecords
  /** Main-chain participants (non-sidechain). */
  participants: Participant[]
  /** Sidechain participants grouped by `agentId` (legacy inline form). */
  sidechains: Map<string, Participant[]>
  projectRoot: string | null
  recordedSessionId: string | null
}

function parseLines(
  text: string,
  options: { sidechainsAsMain?: boolean } = {},
): ParsedFile {
  const lines = text.split('\n')
  const out: ParsedFile = {
    lines: lines.length,
    skippedLines: 0,
    droppedRecords: 0,
    droppedSidechain: 0,
    titles: {},
    participants: [],
    sidechains: new Map(),
    projectRoot: null,
    recordedSessionId: null,
  }
  let generated = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let raw: RawRecord
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const record = asRecord(parsed)
      if (!record) {
        out.skippedLines++
        continue
      }
      raw = record
    } catch {
      out.skippedLines++
      continue
    }
    if (collectTitleRecord(raw, out.titles)) continue
    if (!joinsReplyChain(raw)) {
      out.droppedRecords++
      continue
    }
    out.projectRoot ??= asString(raw.cwd)
    out.recordedSessionId ??= asString(raw.sessionId)
    const uuid = asString(raw.uuid) ?? `import-generated-${generated++}`
    const parentUuid = asString(raw.parentUuid)
    const participant = { uuid, parentUuid, raw }
    if (isTrue(raw.isSidechain) && !options.sidechainsAsMain) {
      const agentId = asString(raw.agentId)
      if (!agentId) {
        out.droppedSidechain++
        continue
      }
      const group = out.sidechains.get(agentId) ?? []
      group.push(participant)
      out.sidechains.set(agentId, group)
      continue
    }
    out.participants.push(participant)
  }
  return out
}

// ---------------------------------------------------------------------------
// Chain → Velloc entries
// ---------------------------------------------------------------------------

/** The shared bundle plus the transcript's last-assistant-text (a sub-agent's
 *  task-summary fallback when the parent's result line does not carry one). */
type CcConvertedBundle = ConvertedBundle & { lastAssistantText: string }

function convertChain(
  participants: readonly Participant[],
  options: {
    sessionId: string
    now: number
    path: string
    title: string | undefined
    carryOver: BrowserSessionMetadata
  },
): CcConvertedBundle {
  const chain = selectChain(participants) ?? participants
  const fallbackTimestamp = new Date(options.now).toISOString()
  const toolCalls = new Map<string, ToolCallInfo>()
  const converted: Converted[] = []
  let lastAssistantText = ''
  for (const p of chain) {
    const timestamp = asString(p.raw.timestamp) ?? fallbackTimestamp
    switch (p.raw.type) {
      case MSG_TYPE_ASSISTANT: {
        const result = convertAssistant(p.raw, p.uuid, timestamp, toolCalls)
        converted.push(result)
        const text = flattenResultBody(
          (result.message as { message?: { content?: unknown } }).message?.content,
        )
        if (text) lastAssistantText = text
        break
      }
      case MSG_TYPE_USER:
        converted.push(
          ...convertUser(p.raw, p.uuid, timestamp, p.parentUuid, toolCalls),
        )
        break
      case MSG_TYPE_SYSTEM:
        converted.push(convertCompactBoundary(p.raw, p.uuid, timestamp))
        break
      default:
        converted.push(convertAttachment(p.raw, p.uuid, timestamp))
    }
  }
  // The tail (fork-builder wrap + tool-detail sidecar split + meta) is the
  // shared, provider-neutral assembly; only the mapping above is specific to
  // this format.
  const bundle = assembleConvertedBundle(converted, options)
  return { ...bundle, lastAssistantText }
}

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

/** An Agent tool call in the parent that a sub-agent transcript answers. */
type AgentLink = {
  toolCallId: string
  agentId: string
  taskId: string
  description: string | null
  prompt: string | null
  agentType: string | null
  /** The result text the parent recorded (the sub-agent's summary). */
  summary: string
  isError: boolean
}

/** Find every Agent tool call whose result line names its `agentId`. */
function findAgentLinks(participants: readonly Participant[]): AgentLink[] {
  const toolUses = new Map<string, { name: string; input: RawRecord | null }>()
  for (const p of participants) {
    if (p.raw.type !== MSG_TYPE_ASSISTANT) continue
    const content = asRecord(p.raw.message)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = asRecord(block)
      if (!record || record.type !== 'tool_use') continue
      const id = asString(record.id)
      const name = asString(record.name)
      if (id && name) toolUses.set(id, { name, input: asRecord(record.input) })
    }
  }
  const links: AgentLink[] = []
  const seen = new Set<string>()
  for (const p of participants) {
    if (p.raw.type !== MSG_TYPE_USER) continue
    const agentId = asString(asRecord(p.raw.toolUseResult)?.agentId)
    if (!agentId) continue
    const content = asRecord(p.raw.message)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = asRecord(block)
      if (!record || record.type !== 'tool_result') continue
      const toolCallId = asString(record.tool_use_id)
      if (!toolCallId || seen.has(toolCallId)) continue
      const use = toolUses.get(toolCallId)
      if (!use || !AGENT_TOOL_NAMES.has(use.name)) continue
      seen.add(toolCallId)
      links.push({
        toolCallId,
        agentId,
        taskId: deriveTaskId(agentId),
        description: asString(use.input?.description),
        prompt: asString(use.input?.prompt),
        agentType: asString(use.input?.subagent_type),
        summary: flattenResultBody(record.content),
        isError: isTrue(record.is_error),
      })
    }
  }
  return links
}

function buildSubAgentBundle(args: {
  agentId: string
  spawnerSessionId: string
  participants: readonly Participant[]
  link: AgentLink | undefined
  fileMeta: ImportSubAgentInput['meta'] | undefined
  path: string
  now: number
  projectRoot: string
}): ImportSubAgentBundle | null {
  if (args.participants.length === 0) return null
  const sessionId = `subagent-${args.agentId}`
  const description =
    args.link?.description ??
    args.fileMeta?.description ??
    `Sub-agent ${args.agentId}`
  const agentType = args.link?.agentType ?? args.fileMeta?.agentType ?? undefined
  const chain = convertChain(args.participants, {
    sessionId,
    now: args.now,
    path: args.path,
    title: description,
    carryOver: {
      templateType: IMPORTED_SUBAGENT_TEMPLATE_TYPE,
      projectRoot: args.projectRoot,
    },
  })
  const startedAt = chain.firstTimestamp ? Date.parse(chain.firstTimestamp) : NaN
  const finishedAt = chain.lastTimestamp ? Date.parse(chain.lastTimestamp) : NaN
  const taskId = args.link?.taskId ?? deriveTaskId(args.agentId)
  chain.meta.metadata = {
    ...chain.meta.metadata,
    templateType: IMPORTED_SUBAGENT_TEMPLATE_TYPE,
    projectRoot: args.projectRoot,
    lastTerminalReason: args.link?.isError ? 'api_error' : 'completed',
    importedFrom: {
      source: 'claude-code',
      path: args.path,
      importedAt: args.now,
      spawnerSessionId: args.spawnerSessionId,
    },
  }
  // The `task.json` restore seed — the same fields `taskFileFromFinishedRecord`
  // writes for a native background sub-agent (subAgentTaskFile.ts).
  const task: Record<string, unknown> = {
    schemaVersion: 1,
    taskId,
    sessionId,
    agentId: args.agentId,
    spawnerSessionId: args.spawnerSessionId,
    description,
    ...(agentType ? { agentType } : {}),
    status: args.link?.isError ? 'error' : 'success',
    summary: args.link?.summary || chain.lastAssistantText,
    ...(args.link?.prompt ? { prompt: args.link.prompt } : {}),
    startedAt: Number.isFinite(startedAt) ? startedAt : args.now,
    finishedAt: Number.isFinite(finishedAt) ? finishedAt : args.now,
    depth: 1,
    projectRoot: args.projectRoot,
  }
  return {
    agentId: args.agentId,
    taskId,
    sessionId,
    // The parent Agent tool call this sub-agent answers, if the result line
    // linked one. The write path stamps `(task id <taskId>)` onto that result
    // (agentTaskAck.ts) once this bundle lands — never before.
    ...(args.link ? { parentToolCallId: args.link.toolCallId } : {}),
    entries: chain.entries,
    meta: chain.meta,
    toolDetails: chain.toolDetails,
    task,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function convert(args: {
  path: string
  bytes: ArrayBuffer
  now: number
  subagents?: ImportSubAgentInput[]
}): ImportConvertResult {
  const decoder = new TextDecoder('utf-8')
  const main = parseLines(decoder.decode(args.bytes))

  if (main.participants.length === 0) {
    throw new ImportConvertError('empty', `No conversation in ${args.path}`)
  }
  const projectRoot = main.projectRoot
  if (!projectRoot) {
    throw new ImportConvertError(
      'no_project_root',
      `No working directory recorded in ${args.path}`,
    )
  }
  const sessionId =
    sessionUuidFromFileName(args.path) ?? main.recordedSessionId ?? null
  if (!sessionId) {
    throw new ImportConvertError('no_session_id', `No session id for ${args.path}`)
  }

  // Sub-agent sources: separate files first, then legacy inline groups the
  // parent file carried. A file wins over an inline group with the same id.
  const sources = new Map<
    string,
    { participants: Participant[]; meta?: ImportSubAgentInput['meta']; path: string }
  >()
  let droppedSidechain = main.droppedSidechain
  let skippedLines = main.skippedLines
  for (const input of args.subagents ?? []) {
    const parsed = parseLines(decoder.decode(input.bytes), { sidechainsAsMain: true })
    skippedLines += parsed.skippedLines
    if (parsed.participants.length === 0) continue
    sources.set(input.agentId, {
      participants: parsed.participants,
      meta: input.meta,
      path: input.path,
    })
  }
  for (const [agentId, participants] of main.sidechains) {
    if (!sources.has(agentId)) {
      sources.set(agentId, { participants, path: args.path })
    }
  }

  const links = findAgentLinks(main.participants)
  const linkByAgent = new Map(links.map(link => [link.agentId, link]))
  const subAgents: ImportSubAgentBundle[] = []
  for (const [agentId, source] of sources) {
    try {
      const bundle = buildSubAgentBundle({
        agentId,
        spawnerSessionId: sessionId,
        participants: source.participants,
        link: linkByAgent.get(agentId),
        fileMeta: source.meta,
        path: source.path,
        now: args.now,
        projectRoot,
      })
      if (bundle) subAgents.push(bundle)
    } catch {
      // A damaged sub-agent file must not sink the parent import; the Agent
      // card simply keeps its plain summary.
      droppedSidechain += source.participants.length
    }
  }
  // The `(task id …)` ack is NOT baked here: each bundle carries its
  // `parentToolCallId`, and the write path (sessionImportBridgeAdapter) stamps
  // the ack via applyAgentTaskAck only for a sub-agent that actually lands.

  const chain = convertChain(main.participants, {
    sessionId,
    now: args.now,
    path: args.path,
    title: resolveTitle(
      main.titles,
      firstPromptFromParticipants(main.participants),
    ),
    carryOver: { templateType: IMPORTED_TEMPLATE_TYPE, projectRoot },
  })
  return finalizeImportResult({
    source: 'claude-code',
    sessionId,
    projectRoot,
    path: args.path,
    now: args.now,
    bundle: chain,
    extraMetadata: main.titles.permissionMode
      ? { permissionMode: main.titles.permissionMode }
      : undefined,
    subAgents,
    stats: {
      lines: main.lines,
      skippedLines,
      droppedRecords: main.droppedRecords,
      droppedSidechain,
      messages: chain.messageCount,
      subAgents: subAgents.length,
    },
  })
}
