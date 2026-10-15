import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  installProcessFs,
  resetProcessFs,
} from '../utils/fs/runtimeFs'
import type { HostedToolDefinition } from '../browser/bridge/browserBridgeProtocol'
import { buildHostTools } from '../toolkit/builtin/host/hostTools'
import { maybeMemoryFreshnessNote } from '../toolkit/builtin/host/readState'

// Regression: a direct Read of a memory file must carry the same staleness
// caveat (`staleMemoryReminder`) that recalled memories get, so a stale memory
// is not asserted as fact. The helper once existed but was never wired: a
// direct Read of a 30-day-old topic file arrived caveat-free while
// recall-injected memories DID carry a freshness header. These tests pin the
// wiring in the hosted Read path.

const DAY = 86_400_000

function mockRuntimeConfig(): RuntimeConfig {
  return {
    getEnv: () => undefined,
    flagOn: () => false,
    now: () => Date.now(),
    createUUID: () => 'test-uuid',
    createTimestamp: () => new Date().toISOString(),
    getMaxStructuredOutputRetries: () => 5,
  } as unknown as RuntimeConfig
}

// cwd /test/cwd, no projectRoot/homeDir → default memory dir is the legacy
// `/test/cwd/.velloc/memory/` (same layout the extract-memories tests rely on).
const MEMORY_FILE = '/test/cwd/.velloc/memory/user_role.md'
const NON_MEMORY_FILE = '/test/cwd/src/index.ts'

function makeContext(
  optionOverrides: Record<string, unknown> = {},
): ToolCallContext {
  return {
    options: {
      cwd: '/test/cwd',
      runtimeConfig: mockRuntimeConfig(),
      ...optionOverrides,
    },
    readFileState: new Map(),
  } as unknown as ToolCallContext
}

function fsWithMtimes(mtimes: Record<string, number>): RuntimeFs {
  return {
    async stat(path: string) {
      // Key lookup tolerates either slash style (the dispatch path may hand
      // the host-normalized form to stat).
      const key = path.replace(/\\/g, '/')
      const mtimeMs = mtimes[key]
      if (mtimeMs === undefined) throw new Error(`ENOENT: ${path}`)
      return {
        mtimeMs,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      }
    },
  } as unknown as RuntimeFs
}

afterEach(() => {
  resetProcessFs()
})

describe('maybeMemoryFreshnessNote', () => {
  it('returns the staleness caveat for a memory file older than a day', async () => {
    installProcessFs(fsWithMtimes({ [MEMORY_FILE]: Date.now() - 30 * DAY }))
    const note = await maybeMemoryFreshnessNote(makeContext(), MEMORY_FILE)
    expect(note).toContain('<system-reminder>')
    expect(note).toContain('Saved 30 days ago')
  })

  it('returns "" for a fresh memory file (no noise for today/yesterday)', async () => {
    installProcessFs(fsWithMtimes({ [MEMORY_FILE]: Date.now() }))
    expect(await maybeMemoryFreshnessNote(makeContext(), MEMORY_FILE)).toBe('')
  })

  it('returns "" for a stale file OUTSIDE the memory dir', async () => {
    installProcessFs(
      fsWithMtimes({ [NON_MEMORY_FILE]: Date.now() - 30 * DAY }),
    )
    expect(await maybeMemoryFreshnessNote(makeContext(), NON_MEMORY_FILE)).toBe(
      '',
    )
  })

  it('matches the memory dir across slash style and drive case', async () => {
    const winPath = 'C:\\test\\cwd\\.velloc\\memory\\note.md'
    installProcessFs(
      fsWithMtimes({ 'C:/test/cwd/.velloc/memory/note.md': Date.now() - 5 * DAY }),
    )
    const note = await maybeMemoryFreshnessNote(
      makeContext({ cwd: 'c:/test/cwd' }),
      winPath,
    )
    expect(note).toContain('Saved 5 days ago')
  })

  it('returns "" when the context carries no runtimeConfig', async () => {
    installProcessFs(fsWithMtimes({ [MEMORY_FILE]: Date.now() - 30 * DAY }))
    const ctx = makeContext({ runtimeConfig: undefined })
    expect(await maybeMemoryFreshnessNote(ctx, MEMORY_FILE)).toBe('')
  })

  it('returns "" (never throws) when stat fails', async () => {
    installProcessFs(fsWithMtimes({}))
    expect(await maybeMemoryFreshnessNote(makeContext(), MEMORY_FILE)).toBe('')
  })
})

describe('hosted Read dispatch — memory staleness caveat', () => {
  function hostedReadTool() {
    const [tool] = buildHostTools([
      {
        name: 'Read',
        description: 'd',
        parameters: { type: 'object', properties: {} },
      } as unknown as HostedToolDefinition,
    ])
    return tool!
  }

  type CallFn = (
    input: unknown,
    context: ToolCallContext,
  ) => Promise<{ data?: unknown }>

  function dispatchCtx(callTool: (req: unknown) => Promise<unknown>): ToolCallContext {
    return {
      options: {
        cwd: '/test/cwd',
        projectRoot: '/test/cwd', // main agent → worktree isolation is a no-op
        sessionId: 's1',
        mainLoopModel: 'm',
        mainLoopProviderId: 'p',
        runtimeConfig: mockRuntimeConfig(),
      },
      readFileState: new Map(),
      platformCapabilities: { browser: { callTool } },
    } as unknown as ToolCallContext
  }

  it('prepends the note to a stale memory-file read result', async () => {
    // projectRoot /test/cwd + no homeDir → legacy `<projectRoot>/memory/`.
    const memFile = '/test/cwd/memory/user_role.md'
    installProcessFs(fsWithMtimes({ [memFile]: Date.now() - 12 * DAY }))
    const spy = vi.fn(async () => '1\tThe user is a Go engineer.')
    const result = await (hostedReadTool().call as CallFn)(
      { file_path: memFile },
      dispatchCtx(spy),
    )
    expect(result.data).toMatch(/^<system-reminder>Saved 12 days ago/)
    expect(result.data).toContain('The user is a Go engineer.')
  })

  it('leaves a non-memory read result untouched', async () => {
    installProcessFs(
      fsWithMtimes({ [NON_MEMORY_FILE]: Date.now() - 12 * DAY }),
    )
    const spy = vi.fn(async () => '1\tconst x = 1')
    const result = await (hostedReadTool().call as CallFn)(
      { file_path: NON_MEMORY_FILE },
      dispatchCtx(spy),
    )
    expect(result.data).toBe('1\tconst x = 1')
  })
})
