import { afterEach, describe, it, expect, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { HostedToolDefinition } from '../browser/bridge/browserBridgeProtocol'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import { applyReadContextWindow, applyWorktreeIsolation, normalizeCwdArgForHost, normalizeFsPathArgsForHost, stripNonPdfReadPagesArg, coerceReadRangeArgsForHost } from '../toolkit/builtin/host/pathArgs'
import { maybeBuildPostCompactReadStub } from '../toolkit/builtin/host/readState'
import { SHELL_NO_TIMEOUT_CAP_SENTINEL_MS } from '../toolkit/builtin/host/shellArgs'
import { buildHostTools } from '../toolkit/builtin/host/hostTools'
import {
  setSubAgentController,
  type SubAgentController,
} from '../team/subAgentController'
import {
  HOST_DISPLAY_COMMAND,
  HOST_RESULT_ACKNOWLEDGED,
  HOST_SUPER_SHELL_TASK_ID,
  setBackgroundShellSink,
  setBackgroundShellSpawner,
  type BackgroundShellLaunch,
  type BackgroundShellSpawnRequest,
} from '../toolkit/run/backgroundShellSink'
import {
  heldShellMutationProbeCount,
  releaseHeldShellMutationProbes,
  resetHeldShellMutationProbes,
} from '../sessions/fileSnapshots/shellMutationProbe'

function ctx(
  cwd: string,
  projectRoot: string,
  options: Record<string, unknown> = {},
): ToolCallContext {
  return {
    options: { cwd, projectRoot, ...options },
  } as unknown as ToolCallContext
}

const WT = '/repo/.velloc/worktrees/idX'
const REPO = '/repo'

afterEach(() => {
  resetProcessFs()
  // The foreground-middle-layer tests register a fake controller; clear it so
  // the legacy-path dispatch tests (no controller) aren't affected by leakage.
  setSubAgentController(null)
})

describe('worktree isolation — applyWorktreeIsolation', () => {
  it('is a no-op for the main agent / non-worktree forks (cwd === projectRoot)', () => {
    const c = ctx(REPO, REPO)
    expect(applyWorktreeIsolation('Bash', { command: 'ls' }, c)).toEqual({
      command: 'ls',
    })
    expect(applyWorktreeIsolation('Edit', { file_path: 'a.ts' }, c)).toEqual({
      file_path: 'a.ts',
    })
  })

  it('stamps the per-call cwd on shell tools (Bash + PowerShell)', () => {
    const c = ctx(WT, REPO)
    expect(applyWorktreeIsolation('Bash', { command: 'make' }, c)).toEqual({
      command: 'make',
      cwd: WT,
    })
    expect(applyWorktreeIsolation('PowerShell', { command: 'dir' }, c)).toEqual({
      command: 'dir',
      cwd: WT,
    })
  })

  it('resolves relative fs paths against the worktree; leaves absolute paths', () => {
    const c = ctx(WT, REPO)
    expect(applyWorktreeIsolation('Edit', { file_path: 'src/a.ts' }, c)).toEqual(
      { file_path: `${WT}/src/a.ts` },
    )
    expect(
      applyWorktreeIsolation('Read', { file_path: '/elsewhere/b.ts' }, c),
    ).toEqual({ file_path: '/elsewhere/b.ts' })
    expect(applyWorktreeIsolation('Write', { file_path: 'out.txt' }, c)).toEqual(
      { file_path: `${WT}/out.txt` },
    )
  })

  it('defaults an omitted Glob/Grep search dir to the worktree', () => {
    const c = ctx(WT, REPO)
    expect(
      applyWorktreeIsolation('Glob', { pattern: '**/*.ts', path: null }, c),
    ).toEqual({ pattern: '**/*.ts', path: WT })
    expect(
      applyWorktreeIsolation('Grep', { pattern: 'foo', path: 'src' }, c),
    ).toEqual({ pattern: 'foo', path: `${WT}/src` })
  })

  it('does not touch unrelated (browser) tools', () => {
    const c = ctx(WT, REPO)
    expect(applyWorktreeIsolation('BrowserClick', { x: 1, y: 2 }, c)).toEqual({
      x: 1,
      y: 2,
    })
  })
})

describe('hosted tool cwd normalization — normalizeCwdArgForHost', () => {
  const WIN_HOST = 'C:\\Users\\me\\project'

  it('converts a git-bash POSIX cwd to native on a Windows host (the D:\\shift bug)', () => {
    // The model set the command correctly (`git -C "C:/shift"`) but passed the
    // cwd arg as `/c/shift`, which the C++ chdir rejected as non-absolute.
    expect(
      normalizeCwdArgForHost(
        { command: 'git -C "C:/shift" status', cwd: '/c/shift' },
        WIN_HOST,
      ),
    ).toEqual({ command: 'git -C "C:/shift" status', cwd: 'C:\\shift' })
  })

  it('converts a /cygdrive/ cwd to native on a Windows host', () => {
    expect(normalizeCwdArgForHost({ cwd: '/cygdrive/d/proj' }, WIN_HOST)).toEqual(
      { cwd: 'D:\\proj' },
    )
  })

  it('leaves an already-native cwd unchanged on a Windows host', () => {
    expect(normalizeCwdArgForHost({ cwd: 'C:/shift' }, WIN_HOST)).toEqual({
      cwd: 'C:/shift',
    })
    expect(normalizeCwdArgForHost({ cwd: 'D:\\a\\b' }, WIN_HOST)).toEqual({
      cwd: 'D:\\a\\b',
    })
  })

  it('leaves a POSIX cwd untouched on a POSIX host', () => {
    expect(
      normalizeCwdArgForHost({ cwd: '/c/shift' }, '/home/me/project'),
    ).toEqual({ cwd: '/c/shift' })
  })

  it('is a no-op when there is no cwd arg', () => {
    const args = { command: 'ls' }
    expect(normalizeCwdArgForHost(args, WIN_HOST)).toBe(args)
    expect(normalizeCwdArgForHost({ cwd: '' }, WIN_HOST)).toEqual({ cwd: '' })
  })
})

describe('hosted fs path-arg normalization — normalizeFsPathArgsForHost', () => {
  const WIN_HOST = 'C:\\Users\\me\\project'

  it('converts a POSIX file_path to native on a Windows host (Read/Write/Edit)', () => {
    // Same bug class as the cwd seam: an unconverted /c/... file_path is
    // rejected by the C++ FileTool ("file_path must be an absolute path").
    expect(
      normalizeFsPathArgsForHost('Read', { file_path: '/c/shift/x.ts' }, WIN_HOST),
    ).toEqual({ file_path: 'C:\\shift\\x.ts' })
    expect(
      normalizeFsPathArgsForHost('Write', { file_path: '/d/out.txt' }, WIN_HOST),
    ).toEqual({ file_path: 'D:\\out.txt' })
  })

  it('converts a POSIX Glob/Grep search path to native', () => {
    // Pre-fix the C++ Append()s /c/shift onto the session cwd → garbage path.
    expect(
      normalizeFsPathArgsForHost('Grep', { pattern: 'foo', path: '/c/shift' }, WIN_HOST),
    ).toEqual({ pattern: 'foo', path: 'C:\\shift' })
  })

  it('leaves native / relative / absent path args untouched (same ref)', () => {
    const native = { file_path: 'C:/already/native.ts' }
    expect(normalizeFsPathArgsForHost('Read', native, WIN_HOST)).toBe(native)
    const rel = { file_path: 'src/rel.ts' }
    expect(normalizeFsPathArgsForHost('Edit', rel, WIN_HOST)).toBe(rel)
    const omitted = { pattern: 'x', path: null }
    expect(normalizeFsPathArgsForHost('Glob', omitted, WIN_HOST)).toBe(omitted)
  })

  it('is a no-op on a POSIX host and for non-fs tools', () => {
    expect(
      normalizeFsPathArgsForHost('Read', { file_path: '/c/shift/x' }, '/home/me'),
    ).toEqual({ file_path: '/c/shift/x' })
    const ps = { command: 'ls', cwd: '/c/x' }
    expect(normalizeFsPathArgsForHost('PowerShell', ps, WIN_HOST)).toBe(ps)
  })
})

describe('hosted Read pages normalization — stripNonPdfReadPagesArg', () => {
  it('strips pages from non-PDF Read calls', () => {
    expect(
      stripNonPdfReadPagesArg('Read', {
        file_path: '/repo/src/app.ts',
        pages: '1-2',
      }),
    ).toEqual({ file_path: '/repo/src/app.ts' })
  })

  it('preserves pages for PDF Read calls', () => {
    const args = { file_path: '/repo/docs/report.PDF', pages: '1-2' }
    expect(stripNonPdfReadPagesArg('Read', args)).toBe(args)
  })

  it('is a no-op for other tools or Read calls without pages', () => {
    const edit = { file_path: '/repo/src/app.ts', pages: '1-2' }
    expect(stripNonPdfReadPagesArg('Edit', edit)).toBe(edit)
    const read = { file_path: '/repo/src/app.ts' }
    expect(stripNonPdfReadPagesArg('Read', read)).toBe(read)
  })
})

// A string `offset`/`limit` does not fail loudly on the native side — the
// typed deserializer just drops it, so the model silently gets the WHOLE file
// instead of the slice it asked for (and a large file then trips the read
// token cap). See coerceReadRangeArgsForHost.
describe('hosted Read range coercion — coerceReadRangeArgsForHost', () => {
  it('converts string-encoded offset/limit to integers', () => {
    expect(
      coerceReadRangeArgsForHost('Read', {
        file_path: '/repo/big.txt',
        offset: '100',
        limit: '5',
      }),
    ).toEqual({ file_path: '/repo/big.txt', offset: 100, limit: 5 })
  })

  it('converts a mixed string/int pair', () => {
    expect(
      coerceReadRangeArgsForHost('Read', {
        file_path: '/repo/big.txt',
        offset: ' 200 ',
        limit: 3,
      }),
    ).toEqual({ file_path: '/repo/big.txt', offset: 200, limit: 3 })
  })

  it('leaves non-integer strings for the native validator to reject', () => {
    const args = {
      file_path: '/repo/big.txt',
      offset: '1.5',
      limit: 'abc',
    }
    expect(coerceReadRangeArgsForHost('Read', args)).toBe(args)
  })

  it('is a no-op for integer args, other tools, and absent range args', () => {
    const ints = { file_path: '/repo/big.txt', offset: 100, limit: 5 }
    expect(coerceReadRangeArgsForHost('Read', ints)).toBe(ints)
    const other = { file_path: '/repo/big.txt', offset: '100' }
    expect(coerceReadRangeArgsForHost('Edit', other)).toBe(other)
    const bare = { file_path: '/repo/big.txt' }
    expect(coerceReadRangeArgsForHost('Read', bare)).toBe(bare)
  })
})

describe('hosted Read budget — applyReadContextWindow', () => {
  it('stamps the active model context window for Read calls', () => {
    const c = ctx(REPO, REPO, { mainLoopModel: 'example [1m]' })
    expect(applyReadContextWindow('Read', { file_path: '/a.ts' }, c)).toEqual({
      file_path: '/a.ts',
      context_window: 1_000_000,
    })
  })

  it('does not touch non-Read tools', () => {
    const args = { file_path: '/a.ts' }
    expect(applyReadContextWindow('Edit', args, ctx(REPO, REPO))).toBe(args)
  })
})

describe('hosted Read post-compact restore stub', () => {
  it('returns a stub for restored exact ranges whose mtime is unchanged', async () => {
    installProcessFs({
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 42 }),
    } as never)
    const context = ctx('/workspace', '/workspace')
    ;(context as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
      [
        '/workspace/a.txt',
        {
          content: '1\thello',
          timestamp: 1,
          mtimeMs: 42,
          offset: undefined,
          limit: 1,
          partialRead: true,
          postCompactRestored: true,
        },
      ],
    ])
    ;(context as { nestedMemoryCues?: Set<string> }).nestedMemoryCues = new Set()
    ;(context as { recentReadPaths?: Set<string> }).recentReadPaths = new Set()

    const stub = await maybeBuildPostCompactReadStub(context, {
      file_path: '/workspace/a.txt',
      limit: 1,
    })

    expect(stub).toContain('This file has not changed since you last read it')
    expect([...(context.nestedMemoryCues ?? [])]).toEqual([
      '/workspace/a.txt',
    ])
    expect([...(context.recentReadPaths ?? [])]).toEqual(['/workspace/a.txt'])
  })

  it("stats through the SESSION's fs, not the realm-global slot", async () => {
    // The global slot belongs to whichever runtime scope wrote it last; once
    // that scope is disposed every call through it throws. The stub must come
    // from this session's own fs, or a restored file is silently re-sent.
    installProcessFs({
      stat: async () => {
        throw new Error('Runtime scope was disposed.')
      },
    } as never)
    const context = ctx('/workspace', '/workspace', {
      fsOperations: {
        stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 42 }),
      },
    })
    ;(context as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
      [
        '/workspace/restored.txt',
        {
          content: '1	post-compact-content',
          timestamp: 1,
          mtimeMs: 42,
          offset: undefined,
          limit: undefined,
          partialRead: false,
          postCompactRestored: true,
        },
      ],
    ])

    const stub = await maybeBuildPostCompactReadStub(context, {
      file_path: '/workspace/restored.txt',
    })

    expect(stub).toContain('This file has not changed since you last read it')
  })

  it('stubs restored full reads with no offset or limit', async () => {
    installProcessFs({
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 42 }),
    } as never)
    const context = ctx('/workspace', '/workspace')
    ;(context as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
      [
        '/workspace/full.txt',
        {
          content: '1\thello',
          timestamp: 1,
          mtimeMs: 42,
          offset: undefined,
          limit: undefined,
          partialRead: false,
          postCompactRestored: true,
        },
      ],
    ])

    await expect(
      maybeBuildPostCompactReadStub(context, {
        file_path: '/workspace/full.txt',
      }),
    ).resolves.toContain('This file has not changed since you last read it')
  })
  it('stubs any sub-range of a full-file restore (range containment)', async () => {
    // Regression: a multi-file survey re-reads files at shifting overlapping
    // ranges after compaction. When the WHOLE file was restored (partialRead
    // false), a re-read of any offset/limit is already covered by the restore
    // block, so it must stub regardless of the requested range — the old code
    // demanded an exact offset+limit match and re-sent the full content.
    installProcessFs({
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 42 }),
    } as never)
    const context = ctx('/workspace', '/workspace')
    ;(context as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
      [
        '/workspace/whole.txt',
        {
          content: '1\tline one\n2\tline two\n3\tline three',
          timestamp: 1,
          mtimeMs: 42,
          offset: undefined,
          limit: undefined,
          partialRead: false,
          postCompactRestored: true,
        },
      ],
    ])

    await expect(
      maybeBuildPostCompactReadStub(context, {
        file_path: '/workspace/whole.txt',
        offset: 2,
        limit: 1,
      }),
    ).resolves.toContain('This file has not changed since you last read it')
  })
  it('does not stub a deep re-read past a truncated full-file restore', async () => {
    // Regression: a large full-file read (partialRead false) can be truncated
    // to the per-file token cap when re-injected after compaction. Only the
    // leading lines actually reach the model, so a re-read past the delivered
    // prefix must fall through to a real read instead of a false "unchanged"
    // stub — otherwise the model silently loses the never-delivered lines.
    installProcessFs({
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 42 }),
    } as never)
    const makeContext = () => {
      const context = ctx('/workspace', '/workspace')
      ;(context as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
        [
          '/workspace/big.txt',
          {
            content: '1\tline one\n2\tline two\n3\tline three\n4\tline four',
            timestamp: 1,
            mtimeMs: 42,
            offset: undefined,
            limit: undefined,
            partialRead: false,
            postCompactRestored: true,
            // Only the first two lines survived the restore token cap.
            restoredCoverageLines: 2,
          },
        ],
      ])
      return context
    }

    // Deep re-read starting past the delivered prefix → real read.
    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/big.txt',
        offset: 3,
        limit: 1,
      }),
    ).resolves.toBeUndefined()
    // Open-ended full re-read → the tail was never delivered → real read.
    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/big.txt',
      }),
    ).resolves.toBeUndefined()
    // A range that spills past the delivered prefix → real read.
    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/big.txt',
        offset: 1,
        limit: 4,
      }),
    ).resolves.toBeUndefined()
    // A range fully inside the delivered prefix → still safe to stub.
    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/big.txt',
        offset: 1,
        limit: 2,
      }),
    ).resolves.toContain('This file has not changed since you last read it')
  })
  it('requires restored offset and limit to match exactly', async () => {
    installProcessFs({
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 42 }),
    } as never)
    const makeContext = () => {
      const context = ctx('/workspace', '/workspace')
      ;(context as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
        [
          '/workspace/slice.txt',
          {
            content: '10\tten\n11\televen',
            timestamp: 1,
            mtimeMs: 42,
            offset: 10,
            limit: 2,
            partialRead: true,
            postCompactRestored: true,
          },
        ],
      ])
      return context
    }

    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/slice.txt',
        offset: 10,
        limit: 2,
      }),
    ).resolves.toContain('This file has not changed since you last read it')
    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/slice.txt',
        offset: 10,
        limit: 1,
      }),
    ).resolves.toBeUndefined()
    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/slice.txt',
        offset: 11,
        limit: 2,
      }),
    ).resolves.toBeUndefined()
    await expect(
      maybeBuildPostCompactReadStub(makeContext(), {
        file_path: '/workspace/slice.txt',
        limit: 2,
      }),
    ).resolves.toBeUndefined()
  })
  it('does not stub restored ranges after an mtime change', async () => {
    installProcessFs({
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 43 }),
    } as never)
    const context = ctx('/workspace', '/workspace')
    ;(context as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
      [
        '/workspace/a.txt',
        {
          content: '1\thello',
          timestamp: 1,
          mtimeMs: 42,
          offset: undefined,
          limit: 1,
          postCompactRestored: true,
        },
      ],
    ])

    await expect(
      maybeBuildPostCompactReadStub(context, {
        file_path: '/workspace/a.txt',
        limit: 1,
      }),
    ).resolves.toBeUndefined()
  })
})
describe('hosted-tool dispatch wiring — converts cwd + fs paths before browser.callTool', () => {
  function hostedTool(
    name: string,
    extra: Partial<HostedToolDefinition> = {},
  ) {
    const [tool] = buildHostTools([
      {
        name,
        description: 'd',
        parameters: { type: 'object', properties: {} },
        ...extra,
      } as unknown as HostedToolDefinition,
    ])
    return tool!
  }

  function dispatchCtx(
    cwd: string,
    callTool: (req: unknown) => Promise<unknown>,
    sessionId = 's1',
  ): ToolCallContext {
    return {
      options: {
        cwd,
        projectRoot: cwd, // main agent → applyWorktreeIsolation is a no-op
        sessionId,
        mainLoopModel: 'm',
        mainLoopProviderId: 'p',
      },
      readFileState: new Map(),
      platformCapabilities: { browser: { callTool } },
    } as unknown as ToolCallContext
  }

  type CallFn = (input: unknown, context: ToolCallContext) => Promise<unknown>

  it('maps hosted manifest concurrencySafe to isConcurrencySafe explicitly', () => {
    expect(hostedTool('Read', { concurrencySafe: true }).parallelSafe({}))
      .toBe(true)
    expect(hostedTool('BrowserReadPage', { readOnly: true }).parallelSafe({}))
      .toBe(false)
  })

  it('short-circuits hosted Read after compaction restored the exact range', async () => {
    installProcessFs({
      stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 42 }),
    } as never)
    const spy = vi.fn(async () => ({ output: 'should not be called' }))
    const tool = hostedTool('Read')
    const c = dispatchCtx('/workspace', spy)
    ;(c as { postCompactReadFileState?: ToolCallContext['fileReadLedger'] }).postCompactReadFileState = new Map([
      [
        '/workspace/a.txt',
        {
          content: '1\thello',
          timestamp: 1,
          mtimeMs: 42,
          offset: undefined,
          limit: 1,
          postCompactRestored: true,
        },
      ],
    ])

    const result = await (tool.call as CallFn)(
      { file_path: '/workspace/a.txt', limit: 1 },
      c,
    )

    expect(spy).not.toHaveBeenCalled()
    expect((result as { data?: unknown }).data).toContain(
      'This file has not changed since you last read it',
    )
  })
  it('normalizes a per-call POSIX cwd to native at the dispatch site (the D:\\shift bug)', async () => {
    // Guards the call-site WIRING end-to-end, not just the helper: removing
    // normalizeCwdArgForHost from buildHostedTool.call fails this test.
    const spy = vi.fn(async () => ({ output: 'ok', exit_code: 0 }))
    const tool = hostedTool('PowerShell')
    await (tool.call as CallFn)(
      { command: 'git -C "C:/shift" status', cwd: '/c/shift' },
      dispatchCtx('C:\\Users\\me\\project', spy),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'PowerShell',
        args: expect.objectContaining({ cwd: 'C:\\shift' }),
      }),
    )
  })

  it('normalizes a POSIX fs file_path to native at the dispatch site', async () => {
    // Guards the normalizeFsPathArgsForHost wiring.
    const spy = vi.fn(async () => ({ output: '' }))
    const tool = hostedTool('Read')
    await (tool.call as CallFn)(
      { file_path: '/c/shift/notes.md' },
      dispatchCtx('C:\\Users\\me\\project', spy),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Read',
        args: expect.objectContaining({ file_path: 'C:\\shift\\notes.md' }),
      }),
    )
  })

  it('strips accidental pages from non-PDF Read dispatch args', async () => {
    const spy = vi.fn(async () => ({ output: '' }))
    const tool = hostedTool('Read')
    await (tool.call as CallFn)(
      { file_path: '/home/me/project/src/app.ts', pages: '1-2' },
      dispatchCtx('/home/me/project', spy),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Read',
        args: expect.not.objectContaining({ pages: expect.anything() }),
      }),
    )
  })

  it('preserves pages for PDF Read dispatch args', async () => {
    const spy = vi.fn(async () => ({ output: '' }))
    const tool = hostedTool('Read')
    await (tool.call as CallFn)(
      { file_path: '/home/me/project/docs/spec.pdf', pages: '1-2' },
      dispatchCtx('/home/me/project', spy),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Read',
        args: expect.objectContaining({ pages: '1-2' }),
      }),
    )
  })

  it('leaves args untouched on a POSIX host', async () => {
    const spy = vi.fn(async () => ({ output: '' }))
    const tool = hostedTool('Read')
    await (tool.call as CallFn)(
      { file_path: '/home/me/notes.md' },
      dispatchCtx('/home/me/project', spy),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ file_path: '/home/me/notes.md' }),
      }),
    )
  })

  it('dispatches hosted Read with the current session id so subagents do not share parent dedup state', async () => {
    const spy = vi.fn(async () => ({ output: '' }))
    const tool = hostedTool('Read')
    await (tool.call as CallFn)(
      { file_path: '/home/me/project/src/a.ts' },
      dispatchCtx('/home/me/project', spy, 'subagent-123'),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        executionContext: expect.objectContaining({ sessionId: 'subagent-123' }),
      }),
    )
  })

  it('records the read file_path into nestedMemoryAttachmentTriggers (conditional-rules trigger)', async () => {
    const spy = vi.fn(async () => ({ output: '' }))
    const tool = hostedTool('Read')
    const ctx = dispatchCtx('/home/me/project', spy)
    const triggers = new Set<string>()
    const recent = new Set<string>()
    ;(ctx as { nestedMemoryCues?: Set<string> }).nestedMemoryCues =
      triggers
    ;(ctx as { recentReadPaths?: Set<string> }).recentReadPaths = recent
    await (tool.call as CallFn)(
      { file_path: '/home/me/project/src/a.ts' },
      ctx,
    )
    expect([...triggers]).toEqual(['/home/me/project/src/a.ts'])
    expect([...recent]).toEqual(['/home/me/project/src/a.ts'])
  })

  it('does not record a trigger for non-Read tools', async () => {
    const spy = vi.fn(async () => ({ output: 'ok', exit_code: 0 }))
    const tool = hostedTool('PowerShell')
    const ctx = dispatchCtx('/home/me/project', spy)
    const triggers = new Set<string>()
    ;(ctx as { nestedMemoryCues?: Set<string> }).nestedMemoryCues =
      triggers
    await (tool.call as CallFn)(
      { command: 'ls', cwd: '/home/me/project' },
      ctx,
    )
    expect(triggers.size).toBe(0)
  })

  // --- Bash/PowerShell foreground middle layer (always-background + budget) ---
  // Every model shell is launched as a background local_bash task
  // (forced run_in_background) and the tool call blocks up to the budget to look
  // foreground. Reuses the kind-agnostic SubAgentController (shell ids resolve
  // there). No controller (mock-host / non-manager runtime) → legacy Exec
  // passthrough. afterEach clears the controller so these don't leak.
  function fakeController(
    overrides: Partial<SubAgentController>,
  ): SubAgentController {
    return {
      getSnapshot: () => null,
      waitForCompletion: async () => null,
      stop: () => ({ status: 'not_found' }),
      resume: () => ({ ok: false, reason: 'not_found' }),
      list: () => [],
      acknowledgeResult: () => {},
      ...overrides,
    }
  }

  it('foreground middle layer: forces background + returns inline when it finishes within budget', async () => {
    const ack = vi.fn()
    const waitForCompletion = vi.fn(
      async (_id: string, _budget: number, _signal?: AbortSignal) => ({
        sessionId: 'shell-a',
        status: 'success' as const,
        description: 'echo hi',
        taskType: 'local_bash' as const,
        output: 'hello world',
        exitCode: 0,
        startedAt: 0,
      }),
    )
    setSubAgentController(fakeController({ waitForCompletion, acknowledgeResult: ack }))
    const spy = vi.fn(async () => ({ shell_id: 'shell-a', status: 'running' }))
    const tool = hostedTool('Bash')
    const result = await (tool.call as CallFn)({ command: 'echo hi' }, dispatchCtx('/ws', spy))
    // C++ was asked to Spawn (forced background) even though the model didn't ask.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ run_in_background: true }),
      }),
    )
    // The tool waits + acknowledges on the minted public taskId (`b…`), NOT
    // the native shell_id, and both are the SAME minted id.
    expect(waitForCompletion).toHaveBeenCalledWith(
      expect.stringMatching(/^b/),
      expect.any(Number),
      undefined,
    )
    const mintedTaskId = waitForCompletion.mock.calls[0]![0]
    expect(ack).toHaveBeenCalledWith(mintedTaskId) // suppress the duplicate delivery
    // Raw Exec shape: { output, exit_code } — no task_id/status wrapper.
    const data = (result as { data: { output?: string; exit_code?: number } }).data
    expect(data.output).toContain('hello world')
    expect(data.exit_code).toBe(0)
  })

  it('foreground middle layer: hands off to background when still running after budget', async () => {
    const ack = vi.fn()
    const waitForCompletion = vi.fn(async () => ({
      sessionId: 'shell-b',
      status: 'running' as const,
      description: 'sleep 99',
      taskType: 'local_bash' as const,
      output: '',
      startedAt: 0,
    }))
    setSubAgentController(fakeController({ waitForCompletion, acknowledgeResult: ack }))
    const spy = vi.fn(async () => ({ shell_id: 'shell-b', status: 'running' }))
    const tool = hostedTool('Bash')
    const result = await (tool.call as CallFn)({ command: 'sleep 99' }, dispatchCtx('/ws', spy))
    const data = (result as { data: { status?: string; message?: string } }).data
    expect(data.status).toBe('running')
    expect(data.message).toContain('moved to the background')
    // Not acknowledged → the manager delivers it exactly once later (no dup).
    expect(ack).not.toHaveBeenCalled()
  })

  describe('shell write capture across the middle layer', () => {
    function probedCtx(spy: (req: unknown) => Promise<unknown>) {
      installProcessFs({
        stat: async () => ({ isDirectory: () => false, isFile: () => true, size: 1 }),
      } as never)
      const recorder = {
        probeBeforeMutation: vi.fn(async () => true),
        trackBeforeDirectoryRemoval: vi.fn(async () => {}),
        discardUnchangedProbe: vi.fn(async () => true),
      }
      const c = dispatchCtx('/ws', spy)
      ;(c.options as unknown as Record<string, unknown>).fileSnapshotRecorder = recorder
      return { c, recorder }
    }

    it('settles the probe when the wait for the command throws', async () => {
      resetHeldShellMutationProbes()
      const waitForCompletion = vi.fn(async () => {
        throw new Error('controller gone')
      })
      setSubAgentController(fakeController({ waitForCompletion }))
      const spy = vi.fn(async () => ({ shell_id: 'shell-t', status: 'running' }))
      const { c, recorder } = probedCtx(spy)
      await expect((hostedTool('Bash').call as CallFn)({ command: 'echo x > out.txt' }, c)).rejects.toThrow('controller gone')
      expect(recorder.probeBeforeMutation).toHaveBeenCalled()
      expect(recorder.discardUnchangedProbe).toHaveBeenCalledTimes(1)
      expect(heldShellMutationProbeCount()).toBe(0)
    })

    it('holds the probe of a command handed to the background under its session', async () => {
      resetHeldShellMutationProbes()
      const waitForCompletion = vi.fn(async () => ({
        sessionId: 'shell-h',
        status: 'running' as const,
        description: 'x',
        taskType: 'local_bash' as const,
        output: '',
        startedAt: 0,
      }))
      setSubAgentController(fakeController({ waitForCompletion }))
      const spy = vi.fn(async () => ({ shell_id: 'shell-h', status: 'running' }))
      const { c, recorder } = probedCtx(spy)
      await (hostedTool('Bash').call as CallFn)({ command: 'echo x > out.txt' }, c)
      expect(recorder.discardUnchangedProbe).not.toHaveBeenCalled()
      expect(heldShellMutationProbeCount()).toBe(1)
      releaseHeldShellMutationProbes('s1')
      expect(heldShellMutationProbeCount()).toBe(0)
    })
  })

  it('the in-process display-command Symbol labels the drawer task and never reaches the host (SuperShell)', async () => {
    const launches: Array<{
      command: string
      resultAcknowledged?: boolean
      superShellTaskId?: string
    }> = []
    setBackgroundShellSink(launch => launches.push(launch))
    try {
      setSubAgentController(fakeController({}))
      const spy = vi.fn(async () => ({ shell_id: 'shell-ss', status: 'running' }))
      const tool = hostedTool('Bash')
      await (tool.call as CallFn)(
        {
          command: "__ss_d='/x'\neval 'npm test'",
          run_in_background: true,
          [HOST_DISPLAY_COMMAND]: 'npm test',
          [HOST_RESULT_ACKNOWLEDGED]: true,
          [HOST_SUPER_SHELL_TASK_ID]: 'h1abc',
        },
        dispatchCtx('/ws', spy),
      )
      const sent = (spy.mock.calls[0] as unknown as [{ args: Record<string, unknown> }])[0].args
      expect(sent.command).toBe("__ss_d='/x'\neval 'npm test'")
      expect(Object.getOwnPropertySymbols(sent)).toHaveLength(0)
      expect(launches).toHaveLength(1)
      expect(launches[0]!.command).toBe('npm test')
      // The nested caller consumes the result: the task registers acknowledged.
      expect(launches[0]!.resultAcknowledged).toBe(true)
      // …and names the SuperShell invocation the step belongs to (drawer filing).
      expect(launches[0]!.superShellTaskId).toBe('h1abc')
      // A plain string key — all a model's JSON input could carry — is ignored.
      launches.length = 0
      await (tool.call as CallFn)(
        {
          command: 'rm -rf x',
          run_in_background: true,
          display_command: 'harmless',
          superShellTaskId: 'h-spoofed',
        },
        dispatchCtx('/ws', spy),
      )
      expect(launches[0]!.command).toBe('rm -rf x')
      expect(launches[0]!.resultAcknowledged).toBeUndefined()
      expect(launches[0]!.superShellTaskId).toBeUndefined()
    } finally {
      setBackgroundShellSink(null)
    }
  })

  it('detach branch sends the no-timeout-cap sentinel (uncapped run-to-completion, not a finite kill)', async () => {
    // C++ semantics make a FINITE timeout wrong for a detached command:
    //   - keeping the model's `timeout` → background Spawn hard-KILLS at it;
    //   - stripping it → C++ substitutes kDefaultBashTimeoutMs (120s) and
    //     hard-kills there, losing any command longer than 2 minutes;
    //   - pinning kMaxBashTimeoutMs (600s) → hard-kills a long build at 10 min.
    // The detach branch must send the no-timeout-cap SENTINEL so the child runs
    // to completion with no kill timer; C++ recognises
    // the sentinel and does not clamp it. An old binary clamps it to 600s (safe).
    setSubAgentController(fakeController({ waitForCompletion: async () => null }))
    const spy = vi.fn(async () => ({ shell_id: 'shell-t', status: 'running' }))
    const tool = hostedTool('Bash')

    // With a model timeout (a long build the model bounded at 5 min):
    await (tool.call as CallFn)(
      { command: 'npm run build', timeout: 300_000 },
      dispatchCtx('/ws', spy),
    )
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          run_in_background: true,
          timeout: SHELL_NO_TIMEOUT_CAP_SENTINEL_MS,
        }),
      }),
    )

    // And with NO model timeout (the common case — C++'s 120s default would
    // otherwise kill any forced-background command past 2 minutes):
    await (tool.call as CallFn)({ command: 'npm run build' }, dispatchCtx('/ws', spy))
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          run_in_background: true,
          timeout: SHELL_NO_TIMEOUT_CAP_SENTINEL_MS,
        }),
      }),
    )
  })

  it('kill-at-timeout branch (short-timeout sleep) keeps the model timeout as the kill', async () => {
    // A leading `sleep` with a timeout shorter than the detach budget is the
    // non-auto-backgroundable case: C++ must KILL it at the model's timeout, so
    // that timeout passes through unchanged (not pinned to the max).
    setSubAgentController(fakeController({ waitForCompletion: async () => null }))
    const spy = vi.fn(async () => ({ shell_id: 'shell-s', status: 'running' }))
    const tool = hostedTool('Bash')
    await (tool.call as CallFn)(
      { command: 'sleep 99', timeout: 500 },
      dispatchCtx('/ws', spy),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          run_in_background: true,
          timeout: 500,
        }),
      }),
    )
  })

  it('explicit run_in_background is UNCAPPED even with a model timeout', async () => {
    // An explicit background drops the kill timer UNCONDITIONALLY — an
    // explicit `timeout` on a background command is NOT a kill. Before the uncapping fix this asserted the old
    // behaviour (timeout: 30_000 passed through as a kill-after-N); now the
    // timeout is replaced by the no-timeout-cap sentinel.
    setSubAgentController(fakeController({ waitForCompletion: async () => null }))
    const spy = vi.fn(async () => ({ shell_id: 'shell-e', status: 'running' }))
    const tool = hostedTool('Bash')
    await (tool.call as CallFn)(
      { command: 'sleep 99', run_in_background: true, timeout: 30_000 },
      dispatchCtx('/ws', spy),
    )
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          run_in_background: true,
          timeout: SHELL_NO_TIMEOUT_CAP_SENTINEL_MS,
        }),
      }),
    )
  })

  it('explicit run_in_background returns immediately without a foreground wait', async () => {
    const waitForCompletion = vi.fn(async () => null)
    setSubAgentController(fakeController({ waitForCompletion }))
    const spy = vi.fn(async () => ({ shell_id: 'shell-c', status: 'running' }))
    const tool = hostedTool('Bash')
    const result = await (tool.call as CallFn)(
      { command: 'sleep 99', run_in_background: true },
      dispatchCtx('/ws', spy),
    )
    expect(waitForCompletion).not.toHaveBeenCalled()
    expect((result as { data: { status?: string } }).data.status).toBe('running')
  })

  it('with no manager (controller unregistered), does not force background — legacy Exec passthrough', async () => {
    setSubAgentController(null)
    const spy = vi.fn(async () => ({ output: 'legacy out', exit_code: 0 }))
    const tool = hostedTool('Bash')
    const result = await (tool.call as CallFn)({ command: 'echo hi' }, dispatchCtx('/ws', spy))
    // No forced run_in_background — the model's args pass through to legacy Exec.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.not.objectContaining({ run_in_background: expect.anything() }),
      }),
    )
    expect((result as { data: { output?: string } }).data.output).toBe('legacy out')
  })

  describe('the worker owns the background start (B3: shell.spawn + persist)', () => {
    type Launch = BackgroundShellLaunch
    function withSpawner(canSpawn = true) {
      const spawn = vi.fn(async (_req: BackgroundShellSpawnRequest) => ({ shellId: 'persist-1' }))
      setBackgroundShellSpawner({ canSpawn: () => canSpawn, spawn })
      const launches: Launch[] = []
      setBackgroundShellSink(launch => launches.push(launch))
      return { spawn, launches }
    }
    afterEach(() => {
      setBackgroundShellSpawner(null)
      setBackgroundShellSink(null)
    })

    it('spawns through the worker, not the host Bash tool; the log is <taskId>.output', async () => {
      const { spawn, launches } = withSpawner()
      setSubAgentController(fakeController({ waitForCompletion: async () => null }))
      const callTool = vi.fn(async () => ({ output: 'host must not run it' }))
      const tool = hostedTool('Bash')
      const result = await (tool.call as CallFn)(
        { command: 'npm run build', run_in_background: true },
        dispatchCtx('/ws', callTool),
      )
      expect(callTool).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledTimes(1)
      const req = spawn.mock.calls[0]![0]
      expect(req).toMatchObject({ tool: 'Bash', command: 'npm run build', cwd: '/ws' })
      expect(launches).toHaveLength(1)
      const launch = launches[0]!
      // The persistent child's id is the native handle; the public task id
      // names the log, which is the output file the model is pointed at.
      expect(launch.shellId).toBe('persist-1')
      expect(launch.taskId).toMatch(/^b/)
      expect(req.logPath).toMatch(new RegExp(`[\\\\/]s1[\\\\/]tasks[\\\\/]${launch.taskId}\\.output$`))
      expect(launch.spoolPath).toBe(req.logPath)
      expect(launch.killAfterMs).toBeUndefined()
      // The model-facing ack is unchanged: task id, running, the output file.
      const data = (result as { data: Record<string, unknown> }).data
      expect(data).toMatchObject({
        task_id: launch.taskId,
        status: 'running',
        output_file: req.logPath,
      })
      expect(String(data.message)).toContain(
        `Started in the background as shell id ${launch.taskId}.`,
      )
    })

    it('a host not known yet (reload, port swap) is waited for: run_in_background still backgrounds', async () => {
      let known = false
      const spawn = vi.fn(async (_req: BackgroundShellSpawnRequest) => ({ shellId: 'persist-1' }))
      setBackgroundShellSpawner({ canSpawn: () => known, isKnown: () => known, spawn })
      setBackgroundShellSink(() => {})
      setSubAgentController(fakeController({ waitForCompletion: async () => null }))
      setTimeout(() => { known = true }, 120)
      const callTool = vi.fn(async () => ({ output: 'host ran it in the foreground' }))
      const result = await (hostedTool('Bash').call as CallFn)(
        { command: 'npm run dev', run_in_background: true },
        dispatchCtx('/ws', callTool),
      )
      expect(callTool).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledTimes(1)
      expect((result as { data: Record<string, unknown> }).data).toMatchObject({ status: 'running' })
    })

    it('a known host without the persistent shells runs it in the foreground at once', async () => {
      const spawn = vi.fn(async (_req: BackgroundShellSpawnRequest) => ({ shellId: 'persist-1' }))
      setBackgroundShellSpawner({ canSpawn: () => false, isKnown: () => true, spawn })
      setSubAgentController(fakeController({ waitForCompletion: async () => null }))
      const callTool = vi.fn(async () => ({ output: 'fg' }))
      const started = Date.now()
      await (hostedTool('Bash').call as CallFn)(
        { command: 'npm run dev', run_in_background: true },
        dispatchCtx('/ws', callTool),
      )
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(spawn).not.toHaveBeenCalled()
      expect(callTool).toHaveBeenCalledTimes(1)
    })

    it('a PowerShell command spawns as the PowerShell tool', async () => {
      const { spawn } = withSpawner()
      setSubAgentController(fakeController({ waitForCompletion: async () => null }))
      await (hostedTool('PowerShell').call as CallFn)(
        { command: 'Get-ChildItem', run_in_background: true },
        dispatchCtx('C:\\ws', vi.fn()),
      )
      expect(spawn.mock.calls[0]![0]).toMatchObject({
        tool: 'PowerShell',
        command: 'Get-ChildItem',
        cwd: 'C:\\ws',
      })
    })

    it('a forced leading sleep keeps its timeout as a registry kill; a detached command has none', async () => {
      const { launches } = withSpawner()
      setSubAgentController(fakeController({ waitForCompletion: async () => null }))
      const tool = hostedTool('Bash')
      await (tool.call as CallFn)({ command: 'sleep 99', timeout: 500 }, dispatchCtx('/ws', vi.fn()))
      expect(launches[0]!.killAfterMs).toBe(500)
      await (tool.call as CallFn)({ command: 'make', timeout: 500 }, dispatchCtx('/ws', vi.fn()))
      expect(launches[1]!.killAfterMs).toBeUndefined()
      expect(launches[1]!.params?.unbounded).toBe(true)
    })

    it('a refused start surfaces as the tool error, and registers nothing', async () => {
      const { spawn, launches } = withSpawner()
      spawn.mockRejectedValueOnce(new Error('INVALID_CWD: no such directory'))
      setSubAgentController(fakeController({ waitForCompletion: async () => null }))
      await expect(
        (hostedTool('Bash').call as CallFn)(
          { command: 'ls', run_in_background: true },
          dispatchCtx('/ws', vi.fn()),
        ),
      ).rejects.toThrow('INVALID_CWD')
      expect(launches).toHaveLength(0)
    })

    it('a host without the persistent shells runs the command in the foreground and reports no task', async () => {
      const { spawn, launches } = withSpawner(false)
      const waitForCompletion = vi.fn(async () => null)
      setSubAgentController(fakeController({ waitForCompletion }))
      const callTool = vi.fn(async () => ({ shell_id: 'bg_host', status: 'running' }))
      await (hostedTool('Bash').call as CallFn)(
        { command: 'npm test', run_in_background: true },
        dispatchCtx('/ws', callTool),
      )
      expect(spawn).not.toHaveBeenCalled()
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.not.objectContaining({ run_in_background: expect.anything() }),
        }),
      )
      // Nothing in the worker could watch a host-side child: never a task.
      expect(launches).toHaveLength(0)
      expect(waitForCompletion).not.toHaveBeenCalled()
    })
  })
})
