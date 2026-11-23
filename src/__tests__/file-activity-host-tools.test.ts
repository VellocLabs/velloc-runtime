import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedToolDefinition } from '../browser/bridge/browserBridgeProtocol'
import { HostToolError } from '../browser/bridge/hostToolError'
import type { FileOpRow } from '../models/usage/requestLogStore'
import { projectKeyOf, registerSessionProject } from '../models/usage/sessionProjects'
import { fileActivityIdle, fileFailureKindOf } from '../toolkit/builtin/host/fileActivity'
import { buildHostEditDiff } from '../toolkit/builtin/host/editDiff'
import { buildHostTools } from '../toolkit/builtin/host/hostTools'
import { renderHostResult } from '../toolkit/builtin/host/resultText'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const written = vi.hoisted(() => [] as FileOpRow[])
vi.mock('../models/usage/requestLogWriter', () => ({
  recordFileOps: (rows: readonly FileOpRow[]) => {
    written.push(...rows)
  },
}))

const ROOT = '/ws/app'

/** A file system whose only `.git` is the repository at ROOT. */
const fs = {
  stat: async (path: string) => {
    if (path.replace(/\\/g, '/') === `${ROOT}/.git`) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
  readFile: async () => {
    throw new Error('ENOENT')
  },
} as unknown as RuntimeFs

function hostedTool(name: string) {
  const [tool] = buildHostTools([{ name, description: 'd', parameters: { type: 'object', properties: {} } } as unknown as HostedToolDefinition])
  return tool!
}

function context(callTool: (request: unknown) => Promise<unknown>, options: Record<string, unknown> = {}, agentId?: string): ToolCallContext {
  return {
    options: {
      cwd: ROOT,
      projectRoot: ROOT,
      sessionId: 's1',
      homeDir: '/home/me',
      mainLoopModel: 'm',
      mainLoopProviderId: 'p',
      fsOperations: fs,
      ...options,
    },
    ...(agentId ? { agentId } : {}),
    readFileState: new Map(),
    platformCapabilities: { browser: { callTool } },
  } as unknown as ToolCallContext
}

type CallFn = (input: unknown, context: ToolCallContext) => Promise<{ data?: unknown }>

async function call(name: string, input: unknown, callTool: (request: unknown) => Promise<unknown>, ctx = context(callTool)) {
  const result = await (hostedTool(name).call as CallFn)(input, ctx)
  await fileActivityIdle()
  return result
}

let dropProject: () => void

beforeEach(() => {
  written.length = 0
  dropProject = registerSessionProject('s1', 'D:\\ws\\app\\')
})

afterEach(() => {
  dropProject()
})

describe('file rows from the hosted file tools', () => {
  it('records a whole read with the bytes and lines given to the model, under its repository and project', async () => {
    const text = '     1\tconst é = 1\n     2\tx()'
    await call('Read', { file_path: `${ROOT}/src/a.ts` }, async () => text)
    expect(written).toEqual([
      {
        atMs: expect.any(Number),
        sessionId: 's1',
        project: projectKeyOf('D:\\ws\\app\\'),
        repo: ROOT,
        path: 'src/a.ts',
        tool: 'Read',
        op: 'read',
        bytes: new TextEncoder().encode(text).length,
        lines: 2,
        outcome: 'ok',
      },
    ])
  })

  it('marks a read with an offset or a limit as partial', async () => {
    await call('Read', { file_path: `${ROOT}/a.ts`, offset: 10 }, async () => '    10\tx\n')
    await call('Read', { file_path: `${ROOT}/a.ts`, limit: 5 }, async () => '     1\ty\n')
    expect(written.map(row => [row.partial, row.lines])).toEqual([[true, 1], [true, 1]])
  })

  it('records a read answered with the unchanged note as a row with zero amounts', async () => {
    await call('Read', { file_path: `${ROOT}/a.ts` }, async () => ({ notice: { kind: 'unchanged' } }))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ op: 'read', bytes: 0, lines: 0, outcome: 'ok' })
  })

  it('measures a memory file read before the freshness note is prepended', async () => {
    const memory = '/test/cwd/memory/user_role.md'
    const text = '     1\tnote'
    const stale = {
      ...fs,
      stat: async (path: string) => {
        if (path.replace(/\\/g, '/') === memory) return { isFile: () => true, isDirectory: () => false, mtimeMs: Date.now() - 30 * 86_400_000 }
        return fs.stat(path)
      },
    } as unknown as RuntimeFs
    const callTool = async () => text
    const runtimeConfig = { now: () => Date.now(), getEnv: () => undefined, flagOn: () => false }
    const result = await call(
      'Read',
      { file_path: memory },
      callTool,
      context(callTool, { cwd: '/test/cwd', projectRoot: '/test/cwd', homeDir: undefined, runtimeConfig, fsOperations: stale }),
    )
    expect(String(result.data).length).toBeGreaterThan(text.length)
    expect(written[0]).toMatchObject({ path: memory, bytes: text.length, lines: 1 })
    expect(written[0]).not.toHaveProperty('repo')
  })

  it('records a created file with its size and the lines the diff counted', async () => {
    const args = { file_path: `${ROOT}/new.ts`, content: 'a\nb\n' }
    const receipt = { outcome: 'created', path: `${ROOT}/new.ts`, bytes: 4 }
    await call('Write', args, async () => receipt)
    const diff = buildHostEditDiff('Write', args, renderHostResult('Write', receipt))!.editDiff
    expect(diff.plusLines).toBeGreaterThan(0)
    expect(written).toEqual([
      expect.objectContaining({ tool: 'Write', op: 'write', path: 'new.ts', bytes: 4, added: diff.plusLines, removed: 0, created: true, outcome: 'ok' }),
    ])
  })

  it('never marks a write the host reported as an update as created, even without the earlier content', async () => {
    const path = `${ROOT}/a.ts`
    await call('Write', { file_path: path, content: 'a\n' }, async () => ({ outcome: 'updated', path, bytes: 2 }))
    expect(written).toEqual([expect.objectContaining({ op: 'write', outcome: 'ok' })])
    expect(written[0]).not.toHaveProperty('created')
  })

  it('records an edit with the lines it added and removed', async () => {
    const path = `${ROOT}/a.ts`
    await call('Edit', { file_path: path, old_string: 'x', new_string: 'y\nz' }, async () => ({
      outcome: 'updated',
      path,
      bytes: 9,
      original_file: 'one\nx\n',
    }))
    expect(written).toEqual([expect.objectContaining({ tool: 'Edit', op: 'edit', path: 'a.ts', bytes: 9, added: 2, removed: 1, outcome: 'ok' })])
    expect(written[0]).not.toHaveProperty('created')
  })

  it('records a failed edit with the kind of its failure, and still throws', async () => {
    const callTool = async () => {
      throw new HostToolError('no_match', 'no match', { path: `${ROOT}/a.ts` })
    }
    await expect(call('Edit', { file_path: `${ROOT}/a.ts`, old_string: 'q', new_string: 'r' }, callTool)).rejects.toThrow('no_match')
    await fileActivityIdle()
    expect(written).toEqual([expect.objectContaining({ tool: 'Edit', op: 'edit', path: 'a.ts', outcome: 'failed', failureKind: 'no_match' })])
  })

  it('records a read the untrusted boundary refused as denied, without reaching the host', async () => {
    const callTool = vi.fn(async () => 'secret')
    await call('Read', { file_path: '/home/me/.ssh/id_rsa' }, callTool, context(callTool, { untrustedReadRoot: ROOT }))
    expect(callTool).not.toHaveBeenCalled()
    expect(written).toEqual([expect.objectContaining({ tool: 'Read', path: '/home/me/.ssh/id_rsa', outcome: 'failed', failureKind: 'denied' })])
  })

  it('records an edit or a write the untrusted boundary refused as denied, without reaching the host', async () => {
    const callTool = vi.fn(async () => ({ outcome: 'updated', path: '/home/me/.bashrc', bytes: 1 }))
    const ctx = context(callTool, { untrustedReadRoot: ROOT })
    await call('Edit', { file_path: '/home/me/.bashrc', old_string: 'a', new_string: 'b' }, callTool, ctx)
    await call('Write', { file_path: '/home/me/.bashrc', content: 'b' }, callTool, ctx)
    expect(callTool).not.toHaveBeenCalled()
    expect(written.map(row => [row.op, row.outcome, row.failureKind])).toEqual([
      ['edit', 'failed', 'denied'],
      ['write', 'failed', 'denied'],
    ])
  })

  it('records a change receipt that did not pass as a success as a failed row, with or without a code', async () => {
    const path = `${ROOT}/a.ts`
    await call('Edit', { file_path: path, old_string: 'x', new_string: 'y' }, async () => ({ code: 'file_modified_since_read', path }))
    await call('Edit', { file_path: path, old_string: 'x', new_string: 'y' }, async () => ({ ok: false, error: 'write failed' }))
    await call('Write', { file_path: path, content: 'y' }, async () => ({ outcome: 'updated', path: `${ROOT}/other.ts`, bytes: 1 }))
    expect(written.map(row => [row.op, row.path, row.outcome, row.failureKind])).toEqual([
      ['edit', 'a.ts', 'failed', 'conflict'],
      ['edit', 'a.ts', 'failed', 'other'],
      ['write', 'a.ts', 'failed', 'other'],
    ])
    expect(written.every(row => row.bytes === undefined && row.added === undefined)).toBe(true)
  })

  it('counts an image read by the bytes the host reported', async () => {
    await call('Read', { file_path: `${ROOT}/logo.png` }, async () => ({
      media: { kind: 'image', path: `${ROOT}/logo.png`, bytes: 2048 },
      content_parts: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    }))
    expect(written).toEqual([expect.objectContaining({ op: 'read', path: 'logo.png', bytes: 2048, lines: 0, outcome: 'ok' })])
  })

  it("keeps a sub-agent's row under its session, with the agent", async () => {
    const callTool = async () => 'x'
    await call('Read', { file_path: `${ROOT}/a.ts` }, callTool, context(callTool, {}, 'agent-7'))
    expect(written[0]).toMatchObject({ sessionId: 's1', agentId: 'agent-7', project: projectKeyOf('D:\\ws\\app') })
  })

  it('writes no row for other tools, and nothing beyond the columns', async () => {
    await call('Glob', { pattern: '*' }, async () => ({ files: [] }))
    expect(written).toEqual([])
    await call('Write', { file_path: `${ROOT}/s.ts`, content: 'secret text' }, async () => ({ outcome: 'updated', path: `${ROOT}/s.ts`, bytes: 11, original_file: 'old' }))
    expect(Object.keys(written[0]!).sort()).toEqual(['added', 'atMs', 'bytes', 'op', 'outcome', 'path', 'project', 'removed', 'repo', 'sessionId', 'tool'])
    expect(JSON.stringify(written)).not.toMatch(/secret|old/)
  })

  it('maps host error codes to failure kinds', () => {
    expect(['file_not_found', 'path_not_found', 'ambiguous_match', 'blocked_device_path', 'file_modified_since_read', 'file_not_read', 'file_already_exists', 'write_failed', 'constructor', undefined].map(fileFailureKindOf)).toEqual([
      'not_found',
      'not_found',
      'no_match',
      'denied',
      'conflict',
      'conflict',
      'conflict',
      'other',
      'other',
      'other',
    ])
  })
})
