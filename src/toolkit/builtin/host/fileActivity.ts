/**
 * Contract: the usage log's rows for the hosted Read, Edit and Write tools
 * (F-27). Each `record*` returns at once and never throws; the row is
 * written after the file's identity is resolved, through the request log's
 * one writer. A row holds the file's identity, the tool, the amounts the tool
 * itself reported and the outcome, never file content, edit arguments or
 * tool output.
 */

import { HostToolError } from '../../../browser/bridge/hostToolError'
import { requestIdentityOf } from '../../../models/drivers/requestContext'
import type { FileOpRow } from '../../../models/usage/requestLogStore'
import { recordFileOps } from '../../../models/usage/requestLogWriter'
import { replyCallIdOf } from '../../../models/usage/modelCallIds'
import { sessionProjectOf } from '../../../models/usage/sessionProjects'
import { EDIT_TOOL_ID, READ_TOOL_ID } from '../../../prompting/fileToolNames'
import { createFileIdentityResolver, type FileIdentityResolver } from '../../../utils/fileIdentity'
import type { FileChangeDiff } from '../../../utils/fileChangeHunks'
import { fsForContext, type RuntimeFs } from '../../../utils/fs/runtimeFs'
import { utf8ByteLength } from '../../../utils/utf8ByteLength'
import type { ToolCallContext } from '../../toolCallContext'

/** What a file row says went wrong. */
export type FileFailureKind = 'not_found' | 'no_match' | 'denied' | 'conflict' | 'other'

const FAILURE_BY_CODE: Readonly<Record<string, FileFailureKind>> = {
  file_not_found: 'not_found',
  path_not_found: 'not_found',
  no_match: 'no_match',
  ambiguous_match: 'no_match',
  blocked_device_path: 'denied',
  file_not_read: 'conflict',
  file_modified_since_read: 'conflict',
  file_already_exists: 'conflict',
}

/** The failure kind of a host tool error code; any code it does not name is `other`. */
export function fileFailureKindOf(code: string | undefined): FileFailureKind {
  return (code !== undefined && Object.prototype.hasOwnProperty.call(FAILURE_BY_CODE, code) && FAILURE_BY_CODE[code]) || 'other'
}

/** What a row says beyond who asked and which file. */
export type FileRowFacts = Omit<FileOpRow, 'atMs' | 'sessionId' | 'agentId' | 'callId' | 'project' | 'repo' | 'worktree' | 'path' | 'fromPath'>

const resolvers = new WeakMap<RuntimeFs, Map<string, FileIdentityResolver>>()
const pending = new Set<Promise<void>>()

function resolverFor(context: ToolCallContext): FileIdentityResolver {
  const fs = fsForContext(context)
  const home = context.options.homeDir ?? ''
  let byHome = resolvers.get(fs)
  if (!byHome) resolvers.set(fs, (byHome = new Map()))
  let resolver = byHome.get(home)
  if (!resolver) byHome.set(home, (resolver = createFileIdentityResolver(fs, home ? { homeDir: home } : {})))
  return resolver
}

/**
 * One file of a batch: its absolute path, a move's absolute source, and the
 * row's facts. A source in the destination's working tree is recorded
 * relative to it, any other source as its absolute path.
 */
export type FileBatchItem = { filePath: string; fromPath?: string; facts: FileRowFacts }

function recordBatch(context: ToolCallContext, items: readonly FileBatchItem[], reply: unknown): void {
  if (items.length === 0) return
  const atMs = Date.now()
  const callId = replyCallIdOf(reply)
  const who = {
    ...requestIdentityOf({
      sessionId: context.options.sessionId,
      spawnerSessionId: context.options.spawnerSessionId,
      agentId: context.agentId,
    }),
    ...(callId !== undefined ? { callId } : {}),
  }
  const project = sessionProjectOf(who.sessionId)
  const job = (async () => {
    try {
      const resolve = resolverFor(context)
      const rows: FileOpRow[] = []
      for (const item of items) {
        const identity = await resolve(item.filePath)
        const source = item.fromPath !== undefined ? await resolve(item.fromPath) : undefined
        const from = source === undefined ? undefined
          : source.repo === identity.repo && source.worktree === identity.worktree ? source.path : item.fromPath
        rows.push({ atMs, ...who, ...(project ? { project } : {}), ...identity, ...(from !== undefined ? { fromPath: from } : {}), ...item.facts })
      }
      recordFileOps(rows)
    } catch {
      // A batch that cannot be built is dropped; the tool call is never affected.
    }
  })()
  pending.add(job)
  void job.finally(() => pending.delete(job))
}

function record(context: ToolCallContext, filePath: unknown, facts: FileRowFacts, reply: unknown): void {
  if (typeof filePath !== 'string' || filePath.length === 0) return
  recordBatch(context, [{ filePath, facts }], reply)
}

/**
 * Rows for several files written as one batch, in one transaction: a commit
 * that changes many files. Every `record*` takes the model reply row that
 * asked for the tool call; its model call's id becomes the rows' `callId`.
 */
export function recordFileBatch(context: ToolCallContext, items: readonly FileBatchItem[], reply?: unknown): void {
  recordBatch(context, items.filter(item => item.filePath.length > 0), reply)
}

function textLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++
  return text.endsWith('\n') ? lines - 1 : lines
}

const numberArg = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)

/**
 * A Read that returned. `host` is the host's own answer: one with a `notice`
 * returned no file text, so its amounts are zero. `data` is the text given to
 * the model, before any note is prepended; non-text results count their
 * reported image bytes only.
 */
export function recordFileRead(context: ToolCallContext, filePath: unknown, args: Record<string, unknown>, host: unknown, data: unknown, reply?: unknown): void {
  const notice = !!host && typeof host === 'object' && 'notice' in host
  let bytes = 0
  let lines = 0
  if (!notice && typeof data === 'string') {
    bytes = utf8ByteLength(data)
    lines = textLines(data)
  } else if (!notice && host && typeof host === 'object') {
    const media = (host as { media?: { bytes?: unknown } }).media
    if (media && typeof media.bytes === 'number') bytes = media.bytes
  }
  const partial = numberArg(args.offset) || numberArg(args.limit)
  record(context, filePath, { tool: READ_TOOL_ID, op: 'read', bytes, lines, ...(partial ? { partial } : {}), outcome: 'ok' }, reply)
}

const opOf = (tool: string): FileOpRow['op'] => (tool === READ_TOOL_ID ? 'read' : tool === EDIT_TOOL_ID ? 'edit' : 'write')

/** A Read, Edit or Write the untrusted read boundary refused before it reached the host. */
export function recordFileDenied(context: ToolCallContext, tool: string, filePath: unknown, reply?: unknown): void {
  record(context, filePath, { tool, op: opOf(tool), outcome: 'failed', failureKind: 'denied' }, reply)
}

/** An Edit or Write the host carried out; `receipt.bytes` is the file's size afterwards. */
export function recordFileChange(
  context: ToolCallContext,
  tool: string,
  receipt: Record<string, unknown>,
  diff: FileChangeDiff | undefined,
  reply?: unknown,
): void {
  record(context, receipt.path, {
    tool,
    op: opOf(tool),
    bytes: typeof receipt.bytes === 'number' ? receipt.bytes : 0,
    added: diff?.plusLines ?? 0,
    removed: diff?.minusLines ?? 0,
    ...(receipt.outcome === 'created' ? { created: true } : {}),
    outcome: 'ok',
  }, reply)
}

/** A Read, Edit or Write the host refused or failed: from a thrown host error, or a receipt that did not pass as a success. */
export function recordFileFailure(context: ToolCallContext, tool: string, filePath: unknown, failure: unknown, reply?: unknown): void {
  const code =
    failure instanceof HostToolError
      ? failure.code
      : failure && typeof failure === 'object' && typeof (failure as { code?: unknown }).code === 'string'
        ? (failure as { code: string }).code
        : undefined
  record(context, filePath, { tool, op: opOf(tool), outcome: 'failed', failureKind: fileFailureKindOf(code) }, reply)
}

/** Settles once every row asked for so far has been handed to the writer. */
export async function fileActivityIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}
