// A hosted Read's bookkeeping: the session's read ledger (what Edit/Write
// safety and the post-compact stub consult), the post-compact "unchanged"
// stub, and the memory-file staleness caveat.
import type { ToolCallContext } from '../../toolCallContext'
import { fsForContext } from '../../../utils/fs/runtimeFs'
import { getMemoryDir } from '../../../memory/memoryPaths'
import { staleMemoryReminder } from '../../../memory/memoryStaleness'
import { READ_UNCHANGED_NOTE } from './resultText'

// Read-state stats below go through THIS session's fs (`fsForContext`) — what
// the Read they describe went through. The realm-global slot belongs to
// whichever runtime scope wrote it last, so a `stat` through it after that
// scope is disposed throws, and both callers swallow the throw: the read state
// was recorded with no mtime, and the post-compact stub — which requires a
// matching mtime — was silently never served.
const SAME_AS_BEFORE_NOTE = READ_UNCHANGED_NOTE

export function numericArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function inferReadOffsetFromResult(content: string): number | undefined {
  const match = content.match(/^(\d+)	/m)
  if (!match?.[1]) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}


export async function recordHostedReadState(
  context: ToolCallContext,
  filePath: string,
  callArgs: Record<string, unknown>,
  data: unknown,
): Promise<void> {
  const content =
    typeof data === 'string'
      ? data
      : data === undefined
        ? ''
        : JSON.stringify(data, null, 2)
  if (!content || content === SAME_AS_BEFORE_NOTE || !context.fileReadLedger) return

  let mtimeMs: number | undefined
  try {
    const stat = await fsForContext(context).stat(filePath)
    if (stat.isFile() && typeof stat.mtimeMs === 'number') {
      mtimeMs = stat.mtimeMs
    }
  } catch {
    // Best-effort mtime only; Edit/Write safety stays native-side.
  }

  context.fileReadLedger.set(filePath, {
    content,
    timestamp: Date.now(),
    mtimeMs,
    offset: numericArg(callArgs.offset),
    limit: numericArg(callArgs.limit),
    partialRead:
      callArgs.offset !== undefined ||
      callArgs.limit !== undefined ||
      content.includes('[file truncated after line'),
  })
  context.postCompactReadFileState?.delete(filePath)
}

/**
 * A Read stub when the requested range was restored into the post-compact context
 * and the file is unchanged on disk. Edit/Write safety stays tied to the native
 * full-read state.
 */
export async function maybeBuildPostCompactReadStub(
  context: ToolCallContext,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const filePath = typeof args.file_path === 'string' ? args.file_path : undefined
  if (!filePath) return undefined

  const restored = context.postCompactReadFileState?.get(filePath)
  if (!restored?.postCompactRestored) return undefined
  // A full-file restore (no offset/limit, untruncated) carries the ENTIRE file
  // into post-compact context, so a re-read of ANY sub-range can safely refer to
  // it — match regardless of the requested offset/limit. A partial or truncated
  // restore only captured one slice, so keep the strict exact-range match to
  // avoid pointing the model at lines that were truncated away. (A multi-file
  // survey that paginates large files still re-reads deep ranges — the real
  // lever there is fewer compactions via a correctly-sized window, not the stub.)
  if (restored.partialRead) {
    if (restored.offset !== numericArg(args.offset)) return undefined
    if (restored.limit !== numericArg(args.limit)) return undefined
  } else if (restored.restoredCoverageLines !== undefined) {
    // Full-file restore that was truncated to fit the per-file token cap: only
    // lines [1, restoredCoverageLines] reached the model. Stub a re-read only
    // when its whole requested range falls inside that delivered prefix; a deep
    // or open-ended (no-limit) re-read must fall through to a real read.
    const start = numericArg(args.offset) ?? 1
    const requestedLimit = numericArg(args.limit)
    const end =
      requestedLimit === undefined ? Infinity : start + requestedLimit - 1
    if (start < 1 || end > restored.restoredCoverageLines) return undefined
  }

  const fs = fsForContext(context)
  try {
    const stat = await fs.stat(filePath)
    const mtimeMs = stat.mtimeMs
    if (typeof mtimeMs !== 'number' || restored.mtimeMs !== mtimeMs) {
      return undefined
    }
  } catch {
    return undefined
  }

  context.nestedMemoryCues?.add(filePath)
  context.recentReadPaths?.add(filePath)
  return SAME_AS_BEFORE_NOTE
}

/**
 * Staleness caveat prepended to a direct Read of a memory file. '' for fresh files
 * (≤1 day), non-memory paths, and any resolve/stat failure (never breaks the read).
 */
export async function maybeMemoryFreshnessNote(
  context: ToolCallContext,
  filePath: string,
): Promise<string> {
  const runtimeConfig = context.options.runtimeConfig
  if (!runtimeConfig) return ''
  try {
    // Same resolution the filesystem-safety memory carve-out uses
    // (toolkit/run/executeToolCall.ts).
    const memoryDir = getMemoryDir(context.options.cwd, runtimeConfig, {
      projectRoot: context.options.projectRoot,
      homeDir: context.options.homeDir,
      memorySettings: context.options.memorySettings,
    })
    // Slash/drive-case-insensitive prefix match; `getMemoryDir` always ends
    // with a separator, so `startsWith` can't false-positive on siblings.
    const normalize = (v: string) => v.replace(/\\/g, '/').toLowerCase()
    if (!normalize(filePath).startsWith(normalize(memoryDir))) return ''
    const stat = await fsForContext(context).stat(filePath)
    if (!stat.isFile() || typeof stat.mtimeMs !== 'number') return ''
    return staleMemoryReminder(stat.mtimeMs)
  } catch {
    return ''
  }
}
