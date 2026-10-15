/**
 * Proactive memory recall, once per user turn: the fast model picks up to 5
 * memory files for the prompt; each is read, truncated, dated and emitted as a
 * `<system-reminder>`, with a hidden de-dup marker (reset by compaction). A
 * non-blocking prefetch; skipped when the memory dir is empty.
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  fsForContext,
  processFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import { queryFastModel } from '../models/fastModelCall'
import {
  MSG_TYPE_USER,
  PART_TEXT,
  PART_TOOL_CALL,
} from '../runtime/VercelModelConstants'
import { isMemoryEnabled, readEnvSwitch, resolveMemoryDir } from './memoryPaths'
import {
  renderMemoryManifest,
  listMemoryFiles,
  type MemoryFileEntry,
} from './memoryManifest'
import { describeSavedAge, staleMemoryCaveat } from './memoryStaleness'

export type RecallPick = {
  path: string
  mtimeMs: number
}

type SurfacedMemory = {
  path: string
  content: string
  mtimeMs: number
  header: string
}

// Per-file caps. A tight per-file byte cap
// keeps a 5-file injection bounded (5 × 4 KB = 20 KB/turn).
const RECALL_LINE_CAP = 200
const RECALL_BYTE_CAP = 4096
// Cumulative session cap: once the recalled bytes pass this, stop
// surfacing — the most-relevant memories are already in context.
const MAX_SESSION_BYTES = 60 * 1024
// Selector budget — the fast model returns at most this many filenames.
const MAX_SELECTED = 5
// Cap on how many recently-used tool names we feed the selector.
const MAX_RECENT_TOOLS = 12

// The selector's system prompt. It carries no "do not re-select memories
// already returned" rule: Nexus calls the selector one-shot per turn and
// drops already-surfaced files from `candidates` BEFORE building the manifest
// (see `pickRecallNotes`), so the model never sees them and the rule
// would be dead weight.

const RECALL_PICKER_BRIEF = `You pick which saved memory files the agent should read before it answers. You get the user's query, a list of memory files (type, filename, date and a one-line description), and sometimes the tools the agent used recently.

Pick at most 5 files whose description shows they will clearly help with this query. When in doubt, leave a file out; an empty list is a perfectly good answer.
- Choose by what the query is about, not by words it happens to share with a description.
- A [user] or [project] note describes the user's general focus. Pick it only when the query concerns that focus: a note saying the user "works on database tuning" does not belong with a question that merely mentions speed.
- For tools in the recent-tools list, skip notes that only explain how to use them, since the agent is already using them; still pick notes about their pitfalls or known problems.

Answer with a single JSON object and nothing else, with no prose and no code fences: {"files": ["name.md", ...]}`

// ---------------------------------------------------------------------------
// De-dup marker. Embedded in each injected message so the next turn can
// skip files already surfaced. JSON inside an HTML comment — file paths
// never contain the `-->` terminator, so this round-trips safely.
// ---------------------------------------------------------------------------

const MARKER_RE = /<!--nexus:relevant-memories:(\{.*?\})-->/g

/** Exported for round-trip testing against `collectSurfacedMemoryPaths`. */
export function buildMarker(paths: readonly string[], bytes: number): string {
  return `<!--nexus:relevant-memories:${JSON.stringify({ paths, bytes })}-->`
}

/**
 * Scan prior messages for relevant-memory markers. Returns the set of
 * already-surfaced absolute paths (so the selector spends its budget on
 * fresh files) and the cumulative injected byte count (session throttle).
 */
export function collectSurfacedMemoryPaths(messages: readonly Message[]): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const message of messages) {
    const text = getMessageText(message)
    if (!text || !text.includes('nexus:relevant-memories:')) continue
    for (const match of text.matchAll(MARKER_RE)) {
      try {
        const parsed = JSON.parse(match[1]!) as {
          paths?: unknown
          bytes?: unknown
        }
        if (Array.isArray(parsed.paths)) {
          for (const p of parsed.paths) {
            if (typeof p === 'string') paths.add(p)
          }
        }
        if (typeof parsed.bytes === 'number') totalBytes += parsed.bytes
      } catch {
        // Malformed marker — ignore, treat as no prior surfacing.
      }
    }
  }
  return { paths, totalBytes }
}

// ---------------------------------------------------------------------------
// Message text + recent-tools extraction
// ---------------------------------------------------------------------------

function getMessageText(message: Message): string | undefined {
  const content = (message as { message?: { content?: unknown } } | undefined)
    ?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null
    if (b && b.type === PART_TEXT && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Tool names used since the last real user message. Fed to the selector
 * so it can suppress reference-doc memories for tools already in active
 * use (keyword overlap would otherwise surface false positives).
 */
export function collectRecentToolNames(messages: readonly Message[]): string[] {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === MSG_TYPE_USER) {
      lastUserIdx = i
      break
    }
  }
  const names = new Set<string>()
  for (let i = Math.max(0, lastUserIdx); i < messages.length; i += 1) {
    const content = (
      messages[i] as { message?: { content?: unknown } } | undefined
    )?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: unknown; toolName?: unknown } | null
      if (b && b.type === PART_TOOL_CALL && typeof b.toolName === 'string') {
        names.add(b.toolName)
      }
    }
  }
  return [...names].slice(0, MAX_RECENT_TOOLS)
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

type FindParams = {
  query: string
  memoryDir: string
  signal: AbortSignal
  toolUseContext: ToolCallContext
  providerId: string
  recentTools?: readonly string[]
  alreadyInjected?: ReadonlySet<string>
}

/**
 * Find memory files relevant to a query by scanning topic-file headers
 * and asking the fast model to select the most relevant ones. Returns
 * absolute paths + mtime (up to 5). Excludes `MEMORY.md` (already in the
 * system prompt — `listMemoryFiles` skips the entrypoint) and any path in
 * `alreadyInjected`.
 */
export async function pickRecallNotes(
  params: FindParams,
): Promise<RecallPick[]> {
  const candidates = (
    await listMemoryFiles(
      params.memoryDir,
      params.signal,
      fsForContext(params.toolUseContext),
    )
  ).filter(m => !params.alreadyInjected?.has(m.filePath))
  if (candidates.length === 0) return []

  const selectedNames = await askRecallPicker(params, candidates)
  const byFilename = new Map(candidates.map(m => [m.filename, m]))
  return selectedNames
    .map(name => byFilename.get(name))
    .filter((m): m is MemoryFileEntry => m !== undefined)
    .map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function askRecallPicker(
  params: FindParams,
  candidates: MemoryFileEntry[],
): Promise<string[]> {
  const valid = new Set(candidates.map(m => m.filename))
  const manifest = renderMemoryManifest(candidates)
  const recentTools = params.recentTools ?? []
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecent tools: ${recentTools.join(', ')}`
      : ''

  try {
    const raw = await queryFastModel({
      userPrompt: `User query: ${params.query}\n\nMemory files:\n${manifest}${toolsSection}`,
      systemPrompt: RECALL_PICKER_BRIEF,
      signal: params.signal,
      toolUseContext: params.toolUseContext,
      providerId: params.providerId,
      querySource: 'memory_recall',
    })
    return parseRecallPicks(raw)
      .filter(f => valid.has(f))
      .slice(0, MAX_SELECTED)
  } catch {
    // Abort or provider error — recall is best-effort, never fatal.
    return []
  }
}

/**
 * Pull the `files` array out of the fast model's text. The
 * model is asked for a bare JSON object; this strips code fences and
 * slices to the outermost braces before parsing, so a chatty model that
 * wraps the JSON in prose still parses.
 */
export function parseRecallPicks(raw: string): string[] {
  const defenced = raw.replace(/```(?:json)?/gi, '')
  const start = defenced.indexOf('{')
  const end = defenced.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const obj = JSON.parse(defenced.slice(start, end + 1)) as {
      files?: unknown
    }
    if (!Array.isArray(obj.files)) return []
    return obj.files.filter(
      (x): x is string => typeof x === 'string',
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Surfacing — read selected files, truncate, annotate with freshness
// ---------------------------------------------------------------------------

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

function sliceToBytes(s: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(s)
  if (encoded.length <= maxBytes) return s
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
    encoded.slice(0, maxBytes),
  )
  // Drop a trailing replacement char left by a split multibyte sequence.
  return decoded.replace(/�$/, '')
}

function truncateMemoryForSurfacing(raw: string): {
  content: string
  truncated: boolean
} {
  let truncated = false
  let content = raw
  const lines = content.split('\n')
  if (lines.length > RECALL_LINE_CAP) {
    content = lines.slice(0, RECALL_LINE_CAP).join('\n')
    truncated = true
  }
  if (byteLength(content) > RECALL_BYTE_CAP) {
    content = sliceToBytes(content, RECALL_BYTE_CAP)
    truncated = true
  }
  return { content, truncated }
}

/**
 * Header string for a recalled memory. Stale (>1 day) memories lead with
 * the freshness caveat so the model treats file:line citations as
 * point-in-time rather than live state.
 */
export function recallNoteBanner(path: string, mtimeMs: number): string {
  const staleness = staleMemoryCaveat(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${describeSavedAge(mtimeMs)}): ${path}:`
}

/**
 * Read each selected memory file, truncate to the per-file caps, and
 * build its freshness-annotated header. Files that error (deleted
 * between scan and read, permission glitch) are dropped.
 */
export async function loadRecallNotes(
  selected: ReadonlyArray<RecallPick>,
  /** THIS session's fs; omitted → the realm-global slot (tests). */
  fs: RuntimeFs = processFs(),
): Promise<SurfacedMemory[]> {
  const results = await Promise.all(
    selected.map(async ({ path, mtimeMs }): Promise<SurfacedMemory | null> => {
      try {
        const raw = await fs.readFile(path, { encoding: 'utf-8' })
        const { content, truncated } = truncateMemoryForSurfacing(raw)
        const body = truncated
          ? `${content}\n\n> This memory file was truncated (limit: ${RECALL_LINE_CAP} lines / ${RECALL_BYTE_CAP} bytes). Use the Read tool to view the complete file at: ${path}`
          : content
        return { path, content: body, mtimeMs, header: recallNoteBanner(path, mtimeMs) }
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is SurfacedMemory => r !== null)
}

// ---------------------------------------------------------------------------
// Orchestrator — the single entry point the turn loop calls
// ---------------------------------------------------------------------------

export type RelevantMemoryInjectionParams = {
  /** The current turn's user-prompt text (already extracted). */
  query: string | undefined
  /** The conversation so far — scanned for prior recall markers. */
  messages: readonly Message[]
  toolUseContext: ToolCallContext
  /** User-selected provider; falls back to `mainLoopProviderId`. */
  providerId: string | undefined
  runtimeConfig: RuntimeConfig
  signal: AbortSignal
}

/**
 * This turn's recalled-memory block, or `null`. Null before any model call when
 * memory or recall is off, the prompt is empty / one word, no provider
 * resolves, the byte budget is spent, or there are no candidates.
 */
export async function buildRelevantMemoryInjection(
  params: RelevantMemoryInjectionParams,
): Promise<string | null> {
  const memorySettings = params.toolUseContext.options.memorySettings
  if (!isMemoryEnabled(params.runtimeConfig, memorySettings)) return null
  // Either `VELLOC_MEMORY_RECALL=off` or the Settings → Memory "proactive
  // recall" toggle turns recall off.
  if (readEnvSwitch(params.runtimeConfig, 'VELLOC_MEMORY_RECALL') === false) return null
  if (memorySettings?.memoryRecallEnabled === false) return null

  const query = params.query?.trim()
  // Single-word prompts lack enough context for meaningful selection.
  if (!query || !/\s/.test(query)) return null

  const providerId =
    params.providerId ?? params.toolUseContext.options.mainLoopProviderId
  if (!providerId) return null

  const surfaced = collectSurfacedMemoryPaths(params.messages)
  if (surfaced.totalBytes >= MAX_SESSION_BYTES) return null

  const memoryDir = await resolveMemoryDir(
    params.toolUseContext.options.cwd,
    params.runtimeConfig,
    fsForContext(params.toolUseContext),
    {
      projectRoot: params.toolUseContext.options.projectRoot,
      homeDir: params.toolUseContext.options.homeDir,
      memorySettings,
    },
  )

  const selected = await pickRecallNotes({
    query,
    memoryDir,
    signal: params.signal,
    toolUseContext: params.toolUseContext,
    providerId,
    recentTools: collectRecentToolNames(params.messages),
    alreadyInjected: surfaced.paths,
  })
  if (selected.length === 0) return null

  const memories = await loadRecallNotes(
    selected,
    fsForContext(params.toolUseContext),
  )
  if (memories.length === 0) return null

  const blocks = memories.map(
    m => `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`,
  )
  const injectedBytes = memories.reduce((sum, m) => sum + m.content.length, 0)
  const marker = buildMarker(
    memories.map(m => m.path),
    injectedBytes,
  )
  return `${blocks.join('\n\n')}\n${marker}`
}

// ---------------------------------------------------------------------------
// Async prefetch handle (`beginRecallLookahead`)
// ---------------------------------------------------------------------------

/**
 * Recall prefetch handle, started once per user turn; the consume point polls
 * `settledAt` and never blocks. The selector call follows the turn's abort
 * signal.
 */
export type MemoryRecallPrefetch = {
  /** Resolves to the injection text, or null (nothing to inject / error). */
  promise: Promise<string | null>
  /** Set when the promise settles. null while in flight. */
  settledAt: number | null
  /** Set by the consume point in engine/turnLoop.ts so it injects at most once. */
  consumed: boolean
}

/**
 * Start the recall selection as a non-blocking prefetch. All of
 * `buildRelevantMemoryInjection`'s gates run inside the promise (they are
 * cheap and mostly synchronous; the expensive step is the fast-model
 * selector call). Errors resolve to null — recall is best-effort and must
 * never break the turn.
 */
export function beginRecallLookahead(
  params: RelevantMemoryInjectionParams,
): MemoryRecallPrefetch {
  const handle: MemoryRecallPrefetch = {
    promise: buildRelevantMemoryInjection(params).catch(() => null),
    settledAt: null,
    consumed: false,
  }
  void handle.promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}
