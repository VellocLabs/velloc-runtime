import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  WorkspaceDiffTool,
  WORKSPACE_DIFF_TOOL_NAME,
  WORKSPACE_DIFF_TOOL_DESCRIPTION,
} from '../toolkit/builtin/workspaceDiff'
import type { SessionFileChange } from '../sessions/fileSnapshots/snapshotRecorder'

const enc = (s: string) => new TextEncoder().encode(s)

function change(
  path: string,
  original: string | null,
  current: string | null,
  opts?: { skipped?: 'original' | 'current' },
): SessionFileChange {
  return {
    path,
    displayPath: path,
    original: {
      exists: original !== null || opts?.skipped === 'original',
      skipped: opts?.skipped === 'original',
      bytes: original !== null ? enc(original) : null,
    },
    current: {
      exists: current !== null || opts?.skipped === 'current',
      skipped: opts?.skipped === 'current',
      bytes: current !== null ? enc(current) : null,
    },
  }
}

function makeContext(
  changes: SessionFileChange[] | (() => Promise<SessionFileChange[]>) | null,
): ToolCallContext {
  const recorder =
    changes === null
      ? undefined
      : {
          getSessionDiff:
            typeof changes === 'function' ? changes : async () => changes,
        }
  return {
    options: { cwd: '/ws', fileSnapshotRecorder: recorder },
    abortController: new AbortController(),
  } as unknown as ToolCallContext
}

const canUseTool = (() => {}) as unknown as PermissionDecider
const invokingRow = {} as unknown as Message

async function run(
  input: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<string> {
  const { data } = await WorkspaceDiffTool.call(
    input as never,
    ctx,
    canUseTool,
    invokingRow,
  )
  return data
}

describe('WorkspaceDiff tool', () => {
  it('is read-only, concurrency-safe, permissionless, and carries the static contract', async () => {
    expect(WorkspaceDiffTool.name).toBe(WORKSPACE_DIFF_TOOL_NAME)
    expect(WorkspaceDiffTool.readsOnly({})).toBe(true)
    expect(WorkspaceDiffTool.parallelSafe({})).toBe(true)
    await expect(
      WorkspaceDiffTool.selfVerdict({}, makeContext([])),
    ).resolves.toMatchObject({ behavior: 'allow' })
    expect(WORKSPACE_DIFF_TOOL_DESCRIPTION).toContain('unified diff')
  })

  it('reports unavailability when the session has no recorder (non-snapshot session types)', async () => {
    expect(await run({}, makeContext(null))).toContain(
      'does not record file snapshots',
    )
  })

  it('renders edits, creates, and deletes as one git-style unified diff with a stats header', async () => {
    const data = await run(
      {},
      makeContext([
        change('/ws/edit.txt', 'old line\n', 'new line\n'),
        change('/ws/new.txt', null, 'created\n'),
        change('/ws/gone.txt', 'deleted\n', null),
      ]),
    )
    expect(data).toMatch(/^3 files changed, \+\d+ -\d+/)
    expect(data).toContain('diff --git a//ws/edit.txt b//ws/edit.txt')
    expect(data).toContain('-old line')
    expect(data).toContain('+new line')
    expect(data).toContain('--- /dev/null')
    expect(data).toContain('+created')
    expect(data).toContain('+++ /dev/null')
    expect(data).toContain('-deleted')
  })

  it('marks not-captured (over-cap) files instead of diffing them', async () => {
    const data = await run(
      {},
      makeContext([change('/ws/big.bin', null, 'x', { skipped: 'original' })]),
    )
    expect(data).toContain('changes not captured')
  })

  it('narrows to one file via `path`, resolving workspace-relative against cwd', async () => {
    const changes = [
      change('/ws/a.txt', 'a1\n', 'a2\n'),
      change('/ws/b.txt', 'b1\n', 'b2\n'),
    ]
    const data = await run({ path: 'a.txt' }, makeContext(changes))
    expect(data).toContain('a/a.txt'.replace('a/', 'a//ws/')) // a//ws/a.txt header
    expect(data).not.toContain('b.txt')
  })

  it('says so when nothing changed (all-files and path-narrowed forms)', async () => {
    expect(await run({}, makeContext([]))).toBe(
      'No changes recorded in this session.',
    )
    expect(await run({ path: 'missing.txt' }, makeContext([]))).toContain(
      'missing.txt',
    )
  })

  it('surfaces a store read failure as prose, never a throw', async () => {
    const data = await run(
      {},
      makeContext(async () => {
        throw new Error('SQLITE_BUSY: locked')
      }),
    )
    expect(data).toContain('failed to read the snapshot store')
    expect(data).toContain('SQLITE_BUSY')
  })

  it('truncates at file boundaries with a narrow-with-path tail note', async () => {
    const bigBody = (marker: string) =>
      Array.from({ length: 3000 }, (_, i) => `${marker} line ${i}`).join('\n') + '\n'
    const data = await run(
      {},
      makeContext([
        change('/ws/one.txt', null, bigBody('one')),
        change('/ws/two.txt', null, bigBody('two')),
        change('/ws/three.txt', null, bigBody('three')),
      ]),
    )
    expect(data).toMatch(/\[diff truncated after \d+ of 3 files/)
    expect(data).toContain('narrow with `path`')
  })

  it('a filtered file that is unchanged reports no-changes rather than an empty diff', async () => {
    const data = await run(
      { path: '/ws/same.txt' },
      makeContext([change('/ws/same.txt', 'same', 'same')]),
    )
    expect(data).toContain('No changes recorded for /ws/same.txt')
  })
})
