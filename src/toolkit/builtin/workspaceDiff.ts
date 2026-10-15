/**
 * WorkspaceDiff: a read-only git-style diff of what THIS session changed, from its
 * snapshot store. No permission prompt: it touches only snapshot blobs and files
 * this session already mutated through the write-gated pipeline. Registered only
 * when `templateWantsFileSnapshots(config)`.
 */

import type { Message } from '../../runtime/RuntimeTypes'
import type { PermissionDecider } from '../permissionVerdict'
import type { ToolContract } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import {
  computeSnapshotFileDiff,
  decodeSnapshotBytes,
  formatUnifiedDiffText,
  type SnapshotFileDiff,
  type SnapshotSideContent,
} from '../../sessions/fileSnapshots/snapshotDiff'
import type { SnapshotContentState } from '../../sessions/fileSnapshots/snapshotRecorder'
import { normalizePathKey } from '../../utils/paths'
import { resolveRuntimePath } from '../../utils/runtimePaths'

export const WORKSPACE_DIFF_TOOL_NAME = 'WorkspaceDiff'

export type WorkspaceDiffInput = {
  path?: string
}

export type WorkspaceDiffOutput = string

/** Body cap BELOW the tool-result cap, so the truncation tail note always
 *  survives instead of being cut off with the body. */
const MAX_DIFF_TEXT_CHARS = 80_000

function toSideContent(state: SnapshotContentState): SnapshotSideContent {
  if (state.skipped) return { kind: 'notCaptured' }
  if (!state.exists) return { kind: 'absent' }
  return decodeSnapshotBytes(state.bytes)
}

function statsLine(diffs: readonly SnapshotFileDiff[]): string {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    added += diff.plusLines
    removed += diff.minusLines
  }
  const files = diffs.length
  return `${files} file${files === 1 ? '' : 's'} changed, +${added} -${removed}`
}

async function call(
  input: WorkspaceDiffInput,
  context: ToolCallContext,
  _canUseTool: PermissionDecider,
  _parentMessage: Message,
): Promise<{ data: WorkspaceDiffOutput }> {
  const recorder = context.options.fileSnapshotRecorder
  if (!recorder) {
    return {
      data: 'WorkspaceDiff is unavailable: this session does not record file snapshots.',
    }
  }
  let changes
  try {
    changes = await recorder.getSessionDiff()
  } catch (err) {
    return {
      data: `WorkspaceDiff failed to read the snapshot store: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  const filterPath =
    typeof input.path === 'string' && input.path.trim().length > 0
      ? normalizePathKey(resolveRuntimePath(context.options.cwd, input.path.trim()))
      : null
  if (filterPath) {
    changes = changes.filter(change => change.path === filterPath)
  }
  const diffs = changes
    .map(change =>
      computeSnapshotFileDiff({
        displayPath: change.displayPath,
        before: toSideContent(change.original),
        after: toSideContent(change.current),
      }),
    )
    .filter(diff => diff.kind !== 'unchanged')
  if (diffs.length === 0) {
    return {
      data: filterPath
        ? `No changes recorded for ${input.path} in this session.`
        : 'No changes recorded in this session.',
    }
  }
  const header = statsLine(diffs)
  // Truncate at FILE boundaries so a cut never lands mid-hunk.
  const included: SnapshotFileDiff[] = []
  let chars = 0
  let truncated = false
  for (const diff of diffs) {
    const text = formatUnifiedDiffText([diff])
    if (included.length > 0 && chars + text.length > MAX_DIFF_TEXT_CHARS) {
      truncated = true
      break
    }
    included.push(diff)
    chars += text.length
  }
  const body = formatUnifiedDiffText(included)
  const tail = truncated
    ? `\n\n[diff truncated after ${included.length} of ${diffs.length} files — narrow with \`path\` to see a specific file]`
    : ''
  return { data: `${header}\n\n${body}${tail}` }
}

export const WORKSPACE_DIFF_TOOL_DESCRIPTION = [
  'Show everything this session has changed in the workspace, as a unified diff (session start → current file contents).',
  '',
  'Use it to review your own changes — before declaring work done, after a batch of run_js mutations, or when resuming a session. Covers file edits, creations, and deletions made through this session; binary files and files over the snapshot size limit are listed but not diffed.',
  '',
  'Pass `path` to diff a single file; omit it for all changed files.',
].join('\n')

export const WorkspaceDiffTool: ToolContract<WorkspaceDiffInput, WorkspaceDiffOutput> =
  declareTool({
    name: WORKSPACE_DIFF_TOOL_NAME,
    discoveryHint: 'review the changes this session has made as a unified diff',
    argsSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Diff only this file (workspace-relative or absolute). Omit for all changed files.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    readsOnly: () => true,
    parallelSafe: () => true,
    description: async () => WORKSPACE_DIFF_TOOL_DESCRIPTION,
    call,
  })
