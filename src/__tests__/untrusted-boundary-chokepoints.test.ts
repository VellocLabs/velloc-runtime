import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { HostedToolDefinition } from '../browser/bridge/browserBridgeProtocol'
import {
  installProcessFs,
  resetProcessFs,
} from '../utils/fs/runtimeFs'
import { buildHostTools } from '../toolkit/builtin/host/hostTools'
import { handleScriptFsOp } from '../toolkit/builtin/superEdit'

/**
 * The read boundary AT THE TWO CHOKEPOINTS. `untrusted-read-boundary.test.ts`
 * covers the predicate; these cover that the predicate is actually consulted
 * on the paths that reach the host — which is the part a refactor breaks.
 */

const ROOT = '/repo/.velloc/worktrees/team-worker-a'

afterEach(() => resetProcessFs())

function hostedTool(name: string) {
  const [tool] = buildHostTools([
    {
      name,
      description: 'd',
      parameters: { type: 'object', properties: {} },
    } as unknown as HostedToolDefinition,
  ])
  return tool!
}

function dispatchCtx(
  callTool: (req: unknown) => Promise<unknown>,
  opts: { untrustedReadRoot?: string } = {},
): ToolCallContext {
  return {
    options: {
      cwd: ROOT,
      projectRoot: ROOT,
      sessionId: 'teammate-1',
      mainLoopModel: 'm',
      mainLoopProviderId: 'p',
      ...opts,
    },
    readFileState: new Map(),
    platformCapabilities: { browser: { callTool } },
  } as unknown as ToolCallContext
}

type CallFn = (input: unknown, context: ToolCallContext) => Promise<unknown>

describe('chokepoint 1 — hosted-tool dispatch', () => {
  it('denies a Read outside the root, and never reaches the host', async () => {
    const callTool = vi.fn(async () => ({ output: 'secret' }))
    const result = (await (hostedTool('Read').call as CallFn)(
      { file_path: '/home/u/.ssh/id_rsa' },
      dispatchCtx(callTool, { untrustedReadRoot: ROOT }),
    )) as { data?: string }
    expect(result.data).toContain('Denied')
    // The point of checking BEFORE dispatch: a denial after the host read the
    // file would have already produced the bytes.
    expect(callTool).not.toHaveBeenCalled()
  })

  it('allows a Read inside the root', async () => {
    const callTool = vi.fn(async () => ({ output: 'ok' }))
    await (hostedTool('Read').call as CallFn)(
      { file_path: `${ROOT}/src/app.ts` },
      dispatchCtx(callTool, { untrustedReadRoot: ROOT }),
    )
    expect(callTool).toHaveBeenCalled()
  })

  it('checks Glob and Grep paths too', async () => {
    const callTool = vi.fn(async () => ({ output: 'ok' }))
    for (const name of ['Glob', 'Grep']) {
      const result = (await (hostedTool(name).call as CallFn)(
        { pattern: '*', path: '/etc' },
        dispatchCtx(callTool, { untrustedReadRoot: ROOT }),
      )) as { data?: string }
      expect(result.data, name).toContain('Denied')
    }
    expect(callTool).not.toHaveBeenCalled()
  })

  it('checks an ABSOLUTE Glob pattern — the host searches from its base, not `path`', async () => {
    // file_tool.cc derives the search root from an absolute pattern and
    // ignores `path`, so with no `path` the pattern IS the path argument.
    const callTool = vi.fn(async () => ({ output: 'ok' }))
    for (const pattern of [
      '/home/u/**/*',
      'C:/Users/u/**/*',
      'C:\\Users\\u\\*.txt',
      `${ROOT}/../other-repo/**/*.ts`,
      '/home/u/.ssh/id_rsa',
    ]) {
      const result = (await (hostedTool('Glob').call as CallFn)(
        { pattern },
        dispatchCtx(callTool, { untrustedReadRoot: ROOT }),
      )) as { data?: string }
      expect(result.data, pattern).toContain('Denied')
    }
    expect(callTool).not.toHaveBeenCalled()

    // An absolute pattern under the root, and any relative one, still run.
    for (const pattern of [`${ROOT}/src/**/*.ts`, 'src/**/*.ts']) {
      await (hostedTool('Glob').call as CallFn)(
        { pattern },
        dispatchCtx(callTool, { untrustedReadRoot: ROOT }),
      )
    }
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it('lets an ordinary session (no boundary) read anywhere, unchanged', async () => {
    const callTool = vi.fn(async () => ({ output: 'ok' }))
    await (hostedTool('Read').call as CallFn)(
      { file_path: '/home/u/.ssh/id_rsa' },
      dispatchCtx(callTool),
    )
    expect(callTool).toHaveBeenCalled()
  })
})

describe('chokepoint 2 — SuperEdit path resolution', () => {
  const overlay = {
    readFileForScript: vi.fn(async () => new Uint8Array()),
    statForScript: vi.fn(async () => ({})),
    readdirForScript: vi.fn(async () => []),
  }
  const PARENT = {
    type: 'assistant',
    uuid: 'a-1',
    message: { role: 'assistant', content: [] },
  } as never

  function superEditCtx(opts: { untrustedReadRoot?: string } = {}) {
    return {
      options: { cwd: ROOT, projectRoot: ROOT, ...opts },
    } as unknown as ToolCallContext
  }

  it('throws NotAllowedError for a path outside the root', async () => {
    // A refusal, not an ask: there is no user-approval path for a session on
    // a relay, because the untrusted model writes the text the prompt shows.
    await expect(
      handleScriptFsOp(
        overlay as never,
        'readFile',
        { path: '/etc/passwd', root: '/' },
        superEditCtx({ untrustedReadRoot: ROOT }),
        PARENT,
      ),
    ).rejects.toThrow(/only access files under/)
    expect(overlay.readFileForScript).not.toHaveBeenCalled()
  })

  it('allows a path inside the root', async () => {
    await handleScriptFsOp(
      overlay as never,
      'readFile',
      { path: 'src/app.ts', root: ROOT },
      superEditCtx({ untrustedReadRoot: ROOT }),
      PARENT,
    )
    expect(overlay.readFileForScript).toHaveBeenCalled()
  })

  it('is a no-op without a boundary', async () => {
    overlay.readFileForScript.mockClear()
    await handleScriptFsOp(
      overlay as never,
      'readFile',
      { path: '/etc/passwd', root: '/' },
      superEditCtx(),
      PARENT,
    )
    expect(overlay.readFileForScript).toHaveBeenCalled()
  })
})
