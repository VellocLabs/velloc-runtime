/**
 * Transcript analyzer for the hidden `/debug` command: per-segment (split on
 * compaction boundaries) counts, tool-output sizes (UTF-8 bytes), token usage,
 * largest outputs and step wall times.
 */

import type { Message } from '../runtime/RuntimeTypes'
import {
  isAssistantMessage,
  isSystemMessage,
  isTextPart,
  isToolResultPart,
  isToolUsePart,
  isUserMessage,
} from '../runtime/VercelModelConstants'
import { isFoldLine } from '../context/compaction/boundary'
import { READ_TOOL_ID } from '../prompting/fileToolNames'
import { SEARCH_TEXT_TOOL_ID } from '../prompting/processToolNames'
import { compactCount } from './humanize/compactCount'
import { durationLabel } from './humanize/durationLabel'

const TEXT_ENCODER = new TextEncoder()

function byteLen(text: string): number {
  return TEXT_ENCODER.encode(text).length
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value ?? '')
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

/** The inner Anthropic-shaped message (`msg.message`), or the message itself. */
function innerOf(msg: Message): Record<string, unknown> {
  const inner = asRecord((msg as { message?: unknown }).message)
  return inner ?? (msg as unknown as Record<string, unknown>)
}

/** Normalize a message's content into a block array (string content → one text block). */
function contentBlocksOf(msg: Message): unknown[] {
  const content = innerOf(msg).content
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function blockType(block: unknown): { type: string } {
  const record = asRecord(block)
  return { type: typeof record?.type === 'string' ? record.type : '' }
}

function str(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function toolCallId(block: unknown): string | undefined {
  const record = asRecord(block)
  return str(record, 'toolCallId') ?? str(record, 'id')
}

function toolCallName(block: unknown): string | undefined {
  const record = asRecord(block)
  return str(record, 'toolName') ?? str(record, 'name')
}

function toolCallArgs(block: unknown): unknown {
  const record = asRecord(block)
  if (!record) return undefined
  return record.args !== undefined ? record.args : record.input
}

function toolResultId(block: unknown): string | undefined {
  const record = asRecord(block)
  return str(record, 'toolCallId') ?? str(record, 'tool_use_id')
}

function toolResultName(block: unknown): string | undefined {
  const record = asRecord(block)
  return (
    str(record, 'toolName') ?? str(record, 'tool_name') ?? str(record, 'name')
  )
}

function toolResultValue(block: unknown): unknown {
  const record = asRecord(block)
  if (!record) return undefined
  return record.result !== undefined ? record.result : record.content
}

/** UTF-8 byte size of a tool-result value (string, block array, or object). */
function valueSize(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return byteLen(value)
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) {
      const text = str(asRecord(item), 'text')
      total += text !== undefined ? byteLen(text) : byteLen(safeJson(item))
    }
    return total
  }
  return byteLen(safeJson(value))
}

/** A short, human-meaningful label for what a tool call targeted. */
function callTarget(args: unknown): string {
  const record = asRecord(args)
  if (!record) return ''
  const label =
    str(record, 'file_path') ??
    str(record, 'path') ??
    str(record, 'pattern') ??
    str(record, 'command') ??
    str(record, 'url') ??
    str(record, 'query') ??
    ''
  return label.length > 80 ? `${label.slice(0, 77)}…` : label
}

const UNKNOWN_TOOL = 'unknown'

export type ToolStat = { count: number; outputBytes: number }
export type LargeOutput = { toolName: string; target: string; bytes: number }
export type SlowStep = { kind: 'model' | 'tool'; label: string; ms: number }

export type SegmentStats = {
  /** 0-based ordinal in the split (segment 0 is the pre-first-compaction slice). */
  index: number
  messageCount: number
  userMessages: number
  assistantMessages: number
  systemMessages: number
  callTotal: number
  /** Tool results flagged as errors (`isError` / legacy `is_error`). */
  toolErrorCount: number
  /** Total UTF-8 bytes of every tool-result output in the segment. */
  toolResultBytes: number
  readBytes: number
  grepBytes: number
  /** Total UTF-8 bytes of assistant-authored text blocks. */
  assistantTextBytes: number
  /** Total UTF-8 bytes of thinking / reasoning blocks. */
  thinkingBytes: number
  /** Total UTF-8 bytes of each message serialized as JSON (rough transcript weight). */
  transcriptBytes: number
  inputTokens: number
  generatedTokens: number
  cachedPromptTokens: number
  cacheCreateTokens: number
  /**
   * Model-response wall time: each assistant message's timestamp minus the
   * previous message's (≈ request sent → response complete, plus loop overhead).
   */
  modelResponses: number
  modelResponseMs: number
  modelResponseMaxMs: number
  /**
   * Tool-execution wall time: for each tool_result block, `the result
   * message's timestamp − its tool_use assistant message's timestamp`.
   * Includes any permission-dialog wait for gated tools, and for
   * concurrent tool batches the per-tool spans overlap. Result messages
   * are stamped when the storage layer records them (right after the
   * result is emitted), so the delta ≈ dispatch → complete.
   */
  toolDurations: number
  toolDurationMs: number
  toolDurationMaxMs: number
  perTool: Map<string, ToolStat>
  /** Largest tool outputs in the segment, descending, capped. */
  largest: LargeOutput[]
  /** Slowest model/tool steps in the segment, descending, capped. */
  slowest: SlowStep[]
  firstTimestamp?: string
  lastTimestamp?: string
}

/**
 * A transcript entry that represents an actual conversation message (not a
 * legacy `__session_meta` / `custom-title` / `ai-title` record). Mirrors
 * `sessionStorage`'s `isMessageLike` so on-disk parsing keeps exactly
 * the entries the runtime treats as messages.
 */
function looksLikeRow(value: unknown): value is Message {
  const record = asRecord(value)
  const type = record?.type
  return (
    typeof type === 'string' &&
    type !== '__session_meta' &&
    type !== 'custom-title' &&
    type !== 'ai-title'
  )
}

export type ParsedTranscriptFile = {
  messages: Message[]
  /** Entries dropped because an earlier entry carried the same uuid. Nonzero
   *  means the on-disk file has redundant appends — itself a useful finding. */
  duplicateCount: number
  /** Lines skipped as malformed JSON (e.g. a partially-flushed tail). */
  malformedLines: number
}

/** Dedupe messages by uuid (first entry wins; uuid-less entries always kept). */
function dedupeByUuid(messages: Message[]): {
  messages: Message[]
  duplicateCount: number
} {
  const seen = new Set<string>()
  const out: Message[] = []
  let duplicateCount = 0
  for (const msg of messages) {
    const uuid = typeof msg.uuid === 'string' && msg.uuid.length > 0 ? msg.uuid : null
    if (uuid) {
      if (seen.has(uuid)) {
        duplicateCount++
        continue
      }
      seen.add(uuid)
    }
    out.push(msg)
  }
  return { messages: out, duplicateCount }
}

/**
 * Parse a raw `transcript.jsonl`: a single-line conversation record, a
 * single-line message array, or JSONL. Malformed and non-message lines are
 * skipped; same-uuid duplicates are dropped (first wins) and counted.
 */
export function parseTranscriptFile(fileText: string): ParsedTranscriptFile {
  const lines = fileText.split('\n').filter(Boolean)
  if (lines.length === 0) {
    return { messages: [], duplicateCount: 0, malformedLines: 0 }
  }

  if (lines.length === 1) {
    try {
      const single = JSON.parse(lines[0]!) as unknown
      const record = asRecord(single)
      if (
        record &&
        typeof record.sessionId === 'string' &&
        Array.isArray(record.messages)
      ) {
        return {
          ...dedupeByUuid(
            (record.messages as unknown[]).filter(looksLikeRow),
          ),
          malformedLines: 0,
        }
      }
      if (Array.isArray(single)) {
        return {
          ...dedupeByUuid((single as unknown[]).filter(looksLikeRow)),
          malformedLines: 0,
        }
      }
      // Otherwise it's a single JSONL message line — fall through.
    } catch {
      // Not JSON — fall through to the line loop (which will skip it).
    }
  }

  const messages: Message[] = []
  let malformedLines = 0
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (looksLikeRow(parsed)) messages.push(parsed)
    } catch {
      // Skip malformed lines — a partially-flushed tail shouldn't abort the scan.
      malformedLines++
    }
  }
  return { ...dedupeByUuid(messages), malformedLines }
}

/** Back-compat convenience: just the parsed messages. */
export function parseTranscriptMessages(fileText: string): Message[] {
  return parseTranscriptFile(fileText).messages
}

const LARGEST_PER_SEGMENT = 5

function newSegment(index: number): SegmentStats {
  return {
    index,
    messageCount: 0,
    userMessages: 0,
    assistantMessages: 0,
    systemMessages: 0,
    callTotal: 0,
    toolErrorCount: 0,
    toolResultBytes: 0,
    readBytes: 0,
    grepBytes: 0,
    assistantTextBytes: 0,
    thinkingBytes: 0,
    transcriptBytes: 0,
    inputTokens: 0,
    generatedTokens: 0,
    cachedPromptTokens: 0,
    cacheCreateTokens: 0,
    modelResponses: 0,
    modelResponseMs: 0,
    modelResponseMaxMs: 0,
    toolDurations: 0,
    toolDurationMs: 0,
    toolDurationMaxMs: 0,
    perTool: new Map(),
    largest: [],
    slowest: [],
  }
}

function bumpTool(
  seg: SegmentStats,
  name: string,
  outputBytes: number,
  count: number,
): void {
  const cur = seg.perTool.get(name) ?? { count: 0, outputBytes: 0 }
  cur.count += count
  cur.outputBytes += outputBytes
  seg.perTool.set(name, cur)
}

/** Parsed epoch-ms of a message's `timestamp`, if present and valid. */
function tsMsOf(msg: Message): number | undefined {
  const raw = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) : NaN
  return Number.isFinite(raw) ? raw : undefined
}

type ToolCallInfo = { name?: string; args?: unknown; tsMs?: number }

function accumulate(
  seg: SegmentStats,
  msg: Message,
  callById: Map<string, ToolCallInfo>,
  prevTsMs: number | undefined,
): void {
  seg.messageCount++
  seg.transcriptBytes += byteLen(safeJson(msg))
  const ts = typeof msg.timestamp === 'string' ? msg.timestamp : undefined
  if (ts) {
    if (!seg.firstTimestamp) seg.firstTimestamp = ts
    seg.lastTimestamp = ts
  }
  const tsMs = tsMsOf(msg)

  if (isAssistantMessage(msg)) {
    seg.assistantMessages++
    // Model response time — see the SegmentStats field docs for the
    // derivation and its caveats. Skips messages without usable stamps
    // (older transcripts) and clock-skewed negative deltas.
    if (tsMs !== undefined && prevTsMs !== undefined && tsMs >= prevTsMs) {
      const ms = tsMs - prevTsMs
      seg.modelResponses++
      seg.modelResponseMs += ms
      if (ms > seg.modelResponseMaxMs) seg.modelResponseMaxMs = ms
      seg.slowest.push({
        kind: 'model',
        label: str(innerOf(msg), 'model') ?? 'model response',
        ms,
      })
    }
    const usage = asRecord(innerOf(msg).usage)
    if (usage) {
      seg.inputTokens += num(usage.input_tokens)
      seg.generatedTokens += num(usage.output_tokens)
      seg.cachedPromptTokens += num(usage.cache_read_input_tokens)
      seg.cacheCreateTokens += num(usage.cache_creation_input_tokens)
    }
    for (const block of contentBlocksOf(msg)) {
      const type = blockType(block)
      if (isTextPart(type)) {
        const text = str(asRecord(block), 'text')
        if (text !== undefined) seg.assistantTextBytes += byteLen(text)
      } else if (isToolUsePart(type)) {
        seg.callTotal++
        bumpTool(seg, toolCallName(block) ?? UNKNOWN_TOOL, 0, 1)
      } else if (type.type === 'thinking' || type.type === 'reasoning') {
        // Anthropic thinking blocks carry `thinking`; Vercel reasoning
        // blocks carry `text`. Either way it's model output burning context.
        const record = asRecord(block)
        const text = str(record, 'thinking') ?? str(record, 'text')
        if (text !== undefined) seg.thinkingBytes += byteLen(text)
      }
    }
    return
  }

  if (isUserMessage(msg)) {
    seg.userMessages++
    for (const block of contentBlocksOf(msg)) {
      if (!isToolResultPart(blockType(block))) continue
      const id = toolResultId(block)
      const call = id ? callById.get(id) : undefined
      const name = toolResultName(block) ?? call?.name ?? UNKNOWN_TOOL
      const bytes = valueSize(toolResultValue(block))
      const record = asRecord(block)
      if (record?.isError === true || record?.is_error === true) {
        seg.toolErrorCount++
      }
      seg.toolResultBytes += bytes
      bumpTool(seg, name, bytes, 0)
      if (name === READ_TOOL_ID) seg.readBytes += bytes
      else if (name === SEARCH_TEXT_TOOL_ID) seg.grepBytes += bytes
      const target = callTarget(call?.args)
      seg.largest.push({ toolName: name, target, bytes })
      // Tool execution time — result stamp minus the tool_use assistant
      // message's stamp (see the SegmentStats field docs for caveats).
      if (tsMs !== undefined && call?.tsMs !== undefined && tsMs >= call.tsMs) {
        const ms = tsMs - call.tsMs
        seg.toolDurations++
        seg.toolDurationMs += ms
        if (ms > seg.toolDurationMaxMs) seg.toolDurationMaxMs = ms
        seg.slowest.push({
          kind: 'tool',
          label: target ? `${name} ${target}` : name,
          ms,
        })
      }
    }
    return
  }

  if (isSystemMessage(msg)) {
    seg.systemMessages++
  }
}

function finalizeSegment(seg: SegmentStats): void {
  seg.largest.sort((a, b) => b.bytes - a.bytes)
  seg.largest = seg.largest.slice(0, LARGEST_PER_SEGMENT)
  seg.slowest.sort((a, b) => b.ms - a.ms)
  seg.slowest = seg.slowest.slice(0, LARGEST_PER_SEGMENT)
}

/**
 * Split the transcript on compaction boundaries and compute per-segment stats.
 * A boundary marker starts a new segment (the marker itself belongs to the
 * post-boundary segment, matching `rowsSinceFoldLine`). Empty
 * segments (e.g. a leading boundary) are dropped and the survivors re-indexed.
 */
export function analyzeTranscript(
  messages: readonly Message[],
): SegmentStats[] {
  // First pass: global tool-call id → { name, args, tsMs }. Built ahead of
  // the split so a result can always resolve its call's name/target/start
  // time regardless of order.
  const callById = new Map<string, ToolCallInfo>()
  for (const msg of messages) {
    if (!isAssistantMessage(msg)) continue
    const msgTsMs = tsMsOf(msg)
    for (const block of contentBlocksOf(msg)) {
      if (!isToolUsePart(blockType(block))) continue
      const id = toolCallId(block)
      if (id) {
        callById.set(id, {
          name: toolCallName(block),
          args: toolCallArgs(block),
          tsMs: msgTsMs,
        })
      }
    }
  }

  const segments: SegmentStats[] = []
  let current = newSegment(0)
  let prevTsMs: number | undefined
  for (const msg of messages) {
    if (isFoldLine(msg)) {
      segments.push(current)
      current = newSegment(segments.length)
    }
    accumulate(current, msg, callById, prevTsMs)
    prevTsMs = tsMsOf(msg) ?? prevTsMs
  }
  segments.push(current)

  const nonEmpty = segments.filter(seg => seg.messageCount > 0)
  const result = nonEmpty.length > 0 ? nonEmpty : segments.slice(0, 1)
  result.forEach((seg, ordinal) => {
    seg.index = ordinal
    finalizeSegment(seg)
  })
  return result
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const KB = 1024
const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

function formatBytes(n: number): string {
  if (n < KB) return `${n} B`
  let value = n / KB
  let unit = 0
  while (value >= KB && unit < SIZE_UNITS.length - 1) {
    value /= KB
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${SIZE_UNITS[unit]}`
}

function tokensValue(seg: {
  inputTokens: number
  generatedTokens: number
  cachedPromptTokens: number
  cacheCreateTokens: number
}): string {
  return (
    `${compactCount(seg.inputTokens)} in, ${compactCount(seg.generatedTokens)} out, ` +
    `${compactCount(seg.cachedPromptTokens)} cache read, ` +
    `${compactCount(seg.cacheCreateTokens)} cache write`
  )
}

function segmentLabel(index: number, total: number): string {
  if (total === 1) return 'Segment 1 (no compaction)'
  if (index === 0) return 'Segment 1 (before first compaction)'
  return `Segment ${index + 1} (after compaction ${index})`
}

function otherBytes(seg: SegmentStats): number {
  return Math.max(0, seg.toolResultBytes - seg.readBytes - seg.grepBytes)
}

// The report renders in the transcript view, which treats assistant/system
// text as Markdown — plain-text indentation and single newlines collapse
// into one run-together paragraph there. So the report IS Markdown: tables
// for the metrics, headings for the sections. It stays scannable as raw
// text too (pipes read as column separators).

/** Escape a value for use inside a Markdown table cell. */
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Render a value as inline code (paths, targets) — keeps `\` and `_` literal. */
function mdCode(value: string): string {
  // A backtick inside a code span would need fence juggling; these values
  // are paths/ids where that never happens in practice — fall back to a
  // plain escaped cell if it does.
  return value.includes('`') ? mdCell(value) : `\`${mdCell(value)}\``
}

function renderMdTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  align?: ReadonlyArray<'left' | 'right'>,
): string[] {
  const separator = headers.map((_, i) =>
    align?.[i] === 'right' ? '---:' : '---',
  )
  return [
    `| ${headers.map(mdCell).join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.map(mdCell).join(' | ')} |`),
  ]
}

function messagesValue(seg: SegmentStats): string {
  const other =
    seg.messageCount -
    seg.userMessages -
    seg.assistantMessages -
    seg.systemMessages
  const parts = [
    `${seg.userMessages} user`,
    `${seg.assistantMessages} assistant`,
    `${seg.systemMessages} system`,
    // Attachment / summary / anything non-core, shown only when present so
    // the split always sums to the total.
    ...(other > 0 ? [`${other} other`] : []),
  ]
  return `${seg.messageCount} (${parts.join(', ')})`
}

function toolCallsValue(seg: SegmentStats): string {
  const errors = seg.toolErrorCount > 0 ? ` (${seg.toolErrorCount} error(s))` : ''
  return `${seg.callTotal}${errors}`
}

function assistantOutputValue(seg: SegmentStats): string {
  const thinking =
    seg.thinkingBytes > 0 ? ` + thinking ${formatBytes(seg.thinkingBytes)}` : ''
  return `${formatBytes(seg.assistantTextBytes)}${thinking}`
}

/**
 * Millisecond-precision duration for per-step timings — `durationLabel`
 * floors sub-minute values to whole seconds, which erases exactly the
 * tool-execution range (tens to hundreds of ms) this report cares about.
 */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return durationLabel(ms)
}

/** `<total> across N <noun>(s) (avg …, max …)`, or `—` when nothing timed. */
function timingValue(
  count: number,
  totalMs: number,
  maxMs: number,
  noun: string,
): string {
  if (count === 0) return '—'
  return (
    `${formatMs(totalMs)} across ${count} ${noun}(s) ` +
    `(avg ${formatMs(totalMs / count)}, max ${formatMs(maxMs)})`
  )
}

/** `<start> → <end> (duration)` from the segment's stamped range, if any. */
function timeValue(seg: SegmentStats): string | undefined {
  if (!seg.firstTimestamp || !seg.lastTimestamp) return undefined
  const start = Date.parse(seg.firstTimestamp)
  const end = Date.parse(seg.lastTimestamp)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const span = end > start ? ` (${durationLabel(end - start)})` : ''
  return `${seg.firstTimestamp} → ${seg.lastTimestamp}${span}`
}

/** The shared `Metric | Value` rows used by both the totals and each segment. */
function metricRows(seg: SegmentStats): string[][] {
  const time = timeValue(seg)
  return [
    ['Messages', messagesValue(seg)],
    ...(time ? [['Time', time]] : []),
    ['Tool calls', toolCallsValue(seg)],
    [
      'Tool output',
      `${formatBytes(seg.toolResultBytes)} total ` +
        `(Read ${formatBytes(seg.readBytes)}, Grep ${formatBytes(seg.grepBytes)}, ` +
        `other ${formatBytes(otherBytes(seg))})`,
    ],
    ['Assistant text output', assistantOutputValue(seg)],
    [
      'Model response time',
      timingValue(
        seg.modelResponses,
        seg.modelResponseMs,
        seg.modelResponseMaxMs,
        'response',
      ),
    ],
    [
      'Tool execution time',
      timingValue(
        seg.toolDurations,
        seg.toolDurationMs,
        seg.toolDurationMaxMs,
        'result',
      ),
    ],
    ['Tokens', tokensValue(seg)],
    ['Transcript weight', formatBytes(seg.transcriptBytes)],
  ]
}

function toolTable(perTool: Map<string, ToolStat>): string[] {
  const entries = [...perTool.entries()].sort(
    (a, b) => b[1].outputBytes - a[1].outputBytes || b[1].count - a[1].count,
  )
  if (entries.length === 0) return ['_(no tools)_']
  return renderMdTable(
    ['Tool', 'Calls', 'Output'],
    entries.map(([name, stat]) => [
      name,
      `${stat.count}×`,
      formatBytes(stat.outputBytes),
    ]),
    ['left', 'right', 'right'],
  )
}

function renderSegment(seg: SegmentStats, total: number): string[] {
  const lines: string[] = [
    `#### ${segmentLabel(seg.index, total)}`,
    '',
    ...renderMdTable(['Metric', 'Value'], metricRows(seg)),
    '',
    '**By tool (count → output)**',
    '',
    ...toolTable(seg.perTool),
  ]
  if (seg.largest.length > 0) {
    lines.push(
      '',
      '**Largest tool outputs**',
      '',
      ...renderMdTable(
        ['Size', 'Tool', 'Target'],
        seg.largest.map(item => [
          formatBytes(item.bytes),
          item.toolName,
          item.target ? mdCode(item.target) : '—',
        ]),
        ['right', 'left', 'left'],
      ),
    )
  }
  if (seg.slowest.length > 0) {
    lines.push(
      '',
      '**Slowest steps**',
      '',
      ...renderMdTable(
        ['Duration', 'Kind', 'What'],
        seg.slowest.map(step => [
          formatMs(step.ms),
          step.kind,
          step.kind === 'tool' ? mdCode(step.label) : step.label,
        ]),
        ['right', 'left', 'left'],
      ),
    )
  }
  return lines
}

function sumSegments(segments: readonly SegmentStats[]): SegmentStats {
  const total = newSegment(0)
  for (const seg of segments) {
    total.messageCount += seg.messageCount
    total.userMessages += seg.userMessages
    total.assistantMessages += seg.assistantMessages
    total.systemMessages += seg.systemMessages
    total.callTotal += seg.callTotal
    total.toolErrorCount += seg.toolErrorCount
    total.toolResultBytes += seg.toolResultBytes
    total.readBytes += seg.readBytes
    total.grepBytes += seg.grepBytes
    total.assistantTextBytes += seg.assistantTextBytes
    total.thinkingBytes += seg.thinkingBytes
    total.transcriptBytes += seg.transcriptBytes
    if (seg.firstTimestamp && !total.firstTimestamp) {
      total.firstTimestamp = seg.firstTimestamp
    }
    if (seg.lastTimestamp) total.lastTimestamp = seg.lastTimestamp
    total.inputTokens += seg.inputTokens
    total.generatedTokens += seg.generatedTokens
    total.cachedPromptTokens += seg.cachedPromptTokens
    total.cacheCreateTokens += seg.cacheCreateTokens
    total.modelResponses += seg.modelResponses
    total.modelResponseMs += seg.modelResponseMs
    total.modelResponseMaxMs = Math.max(
      total.modelResponseMaxMs,
      seg.modelResponseMaxMs,
    )
    total.toolDurations += seg.toolDurations
    total.toolDurationMs += seg.toolDurationMs
    total.toolDurationMaxMs = Math.max(
      total.toolDurationMaxMs,
      seg.toolDurationMaxMs,
    )
    for (const [name, stat] of seg.perTool) {
      bumpTool(total, name, stat.outputBytes, stat.count)
    }
  }
  return total
}

/**
 * Render the full `/debug` report as Markdown: a header table (transcript
 * path, source, size, diagnostics), a totals table, then one section per
 * compaction segment. Markdown because the transcript view renders the
 * system message through the same md pipeline as assistant text — the old
 * plain-text layout collapsed into one unreadable paragraph there.
 */
export function formatTranscriptDebugReport(
  messages: readonly Message[],
  meta: {
    sessionId?: string
    transcriptPath?: string | null
    /** Where `messages` came from — e.g. `'disk'` or `'in-memory (…)'`. */
    source?: string
    /** Exact byte size of the transcript file as read (disk source only). */
    fileBytes?: number
    /** Same-uuid entries dropped during parsing (disk source only). */
    duplicateCount?: number
    /** Malformed JSONL lines skipped during parsing (disk source only). */
    malformedLines?: number
  },
): string {
  const segments = analyzeTranscript(messages)
  const totals = sumSegments(segments)

  const headerRows: string[][] = [
    [
      'Path',
      meta.transcriptPath
        ? mdCode(meta.transcriptPath)
        : '(unavailable — mock / dev host)',
    ],
    ...(meta.source ? [['Source', meta.source]] : []),
    ...(meta.fileBytes !== undefined
      ? [['File size', formatBytes(meta.fileBytes)]]
      : []),
    [
      'Messages',
      `${totals.messageCount} across ${segments.length} compaction segment(s)`,
    ],
  ]
  if (meta.duplicateCount) {
    headerRows.push([
      '⚠',
      `${meta.duplicateCount} duplicate entr${meta.duplicateCount === 1 ? 'y' : 'ies'} on disk (same uuid; first kept)`,
    ])
  }
  if (meta.malformedLines) {
    headerRows.push(['⚠', `${meta.malformedLines} malformed line(s) skipped`])
  }

  const header: string[] = [
    `### Transcript debug — session ${meta.sessionId || '(unknown)'}`,
    '',
    ...renderMdTable(['Field', 'Value'], headerRows),
    '',
    '#### Totals',
    '',
    ...renderMdTable(['Metric', 'Value'], metricRows(totals)),
  ]

  if (totals.messageCount === 0) {
    return [...header, '', '_(No messages in this session yet.)_'].join('\n')
  }

  const body = segments.flatMap(seg => ['', ...renderSegment(seg, segments.length)])
  return [...header, ...body].join('\n')
}
