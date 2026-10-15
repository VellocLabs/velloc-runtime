import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs, RuntimeFsStat } from '../utils/fs/runtimeFs'
import {
  installProcessFs,
  resetProcessFs,
} from '../utils/fs/runtimeFs'
import { joinPath } from '../memory/memoryPaths'
import { getConversationTranscriptPath } from '../utils/conversationStoragePaths'
import type { ConsolidationStamp } from '../memory/consolidate/runLock'
import * as forkedAgentModule from '../agents/forkedRun'
import {
  resetMemoryConsolidationForTests,
  runMemoryConsolidation,
  registerMemoryConsolidator,
  type MemoryConsolidationContext,
  type MemoryConsolidatorDeps,
} from '../memory/consolidate/consolidationRunner'

// ============================================================================
// The background periodic tidy CONSOLIDATION service. These tests drive the gate
// chain (sub-agent skip → memory enabled → memoryMaintenance → time → scan
// throttle → session count → lock) and prove the fork only fires when every
// gate passes — and that the stamp is committed on success / rewound on
// failure. `resolveMemoryDir` is mocked to a fixed dir; `launchFork` is
// spied; an in-memory fs backs the stamp file + per-session transcript mtimes.
// ============================================================================

const MEMORY_DIR = '/test/cwd/.velloc/memory'
const TRANSCRIPT_DIR = '/home/test/.velloc/projects/proj'
const LOCK_PATH = joinPath(MEMORY_DIR, '.consolidate-lock')

const NOW = 1_900_000_000_000
const HOUR = 3_600_000

// Keep `isMemoryEnabled` real (it's a pure runtimeConfig read); stub
// `resolveMemoryDir` so the test doesn't depend on the dir-resolution chain.
vi.mock('../memory/memoryPaths', async importOriginal => {
  const actual = await importOriginal<typeof import('../memory/memoryPaths')>()
  return { ...actual, resolveMemoryDir: vi.fn(async () => MEMORY_DIR) }
})

// ----------------------------------------------------------------------------
// In-memory fs
// ----------------------------------------------------------------------------

function statFor(mtimeMs: number | undefined): RuntimeFsStat {
  return {
    size: 0,
    mtimeMs,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isCharacterDevice: () => false,
    isBlockDevice: () => false,
  }
}

function makeFs(opts: {
  stamp?: ConsolidationStamp
  sessionMtimes?: Record<string, number>
}): { fs: RuntimeFs; files: Map<string, string> } {
  const files = new Map<string, string>()
  if (opts.stamp) files.set(LOCK_PATH, JSON.stringify(opts.stamp))
  const mtimes = new Map<string, number>(
    Object.entries(opts.sessionMtimes ?? {}),
  )
  const fs = {
    async readFile(path: string) {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT ${path}`)
      return v
    },
    async writeFile(path: string, data: string | Uint8Array) {
      files.set(path, String(data))
    },
    async unlink(path: string) {
      files.delete(path)
    },
    async mkdir() {
      /* no-op */
    },
    async stat(path: string) {
      if (mtimes.has(path)) return statFor(mtimes.get(path)!)
      if (files.has(path)) return statFor(NOW)
      throw new Error(`ENOENT ${path}`)
    },
  } as unknown as RuntimeFs
  return { fs, files }
}

function readStamp(files: Map<string, string>): ConsolidationStamp | null {
  const raw = files.get(LOCK_PATH)
  return raw ? (JSON.parse(raw) as ConsolidationStamp) : null
}

// ----------------------------------------------------------------------------
// Mock runtime + context + deps
// ----------------------------------------------------------------------------

function createMockRuntimeConfig(
  env: Record<string, string> = {},
): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => {
      const v = env[name]
      return v === '1' || v === 'true' || v === 'yes'
    },
    now: () => NOW,
    createUUID: () => 'periodic-tidy-uuid',
    createTimestamp: () => '2026-06-20T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  } as unknown as RuntimeConfig
}

function createContext(
  memorySettings: Record<string, unknown> | undefined,
  overrides: Partial<ToolCallContext['options']> = {},
): MemoryConsolidationContext {
  const toolUseContext = {
    options: {
      commands: [],
      cwd: '/test/cwd',
      sessionId: 'session-current',
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { enabledAgents: [], allAgents: [] },
      memorySettings,
      ...overrides,
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    platformCapabilities: {} as ToolCallContext['platformCapabilities'],
    getAppState: () => ({}) as ReturnType<ToolCallContext['readAppState']>,
    setAppState: () => {},
    markCallsInFlight: () => {},
    noteReplyLength: () => {},
    noteFileHistory: () => {},
    noteAttribution: () => {},
    messages: [],
  } as unknown as ToolCallContext
  return {
    messages: [],
    systemPrompt: 'sys' as unknown as MemoryConsolidationContext['systemPrompt'],
    userContext: {},
    systemContext: {},
    toolUseContext,
  }
}

/** 5 sessions, all touched after `since`, none the current session. */
function fiveFreshSessions(): { ids: string[]; mtimes: Record<string, number> } {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const mtimes: Record<string, number> = {}
  for (const id of ids) {
    mtimes[getConversationTranscriptPath(TRANSCRIPT_DIR, id)] = NOW
  }
  return { ids, mtimes }
}

function makeDeps(overrides: Partial<MemoryConsolidatorDeps> = {}): MemoryConsolidatorDeps {
  const { ids } = fiveFreshSessions()
  return {
    runtimeConfig: createMockRuntimeConfig(),
    listSessions: async () => ids,
    historyFolder: TRANSCRIPT_DIR,
    logEvent: vi.fn(),
    ...overrides,
  }
}

const ENABLED = { memoryMaintenance: 'periodic' } as const

// ----------------------------------------------------------------------------

let runForkedAgentSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  resetMemoryConsolidationForTests()
  runForkedAgentSpy = vi.spyOn(forkedAgentModule, 'launchFork')
  runForkedAgentSpy.mockReset()
  runForkedAgentSpy.mockResolvedValue({ messages: [], agentId: 'periodic_tidy_test' })
})

afterEach(() => {
  vi.useRealTimers()
  resetProcessFs()
})

describe('runMemoryConsolidation — gate chain', () => {
  it('no-ops until registerMemoryConsolidator has been called', async () => {
    installProcessFs(makeFs({}).fs)
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops from a sub-agent (agentId set)', async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps())
    await runMemoryConsolidation(
      createContext(ENABLED, { agentId: 'sub-agent' } as never),
    )
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when memoryMaintenance is unset (service is opt-in, default OFF)', async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps())
    await runMemoryConsolidation(createContext({}))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it("no-ops in 'off' mode", async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps())
    await runMemoryConsolidation(createContext({ memoryMaintenance: 'off' }))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it("no-ops in 'dailyLog' mode (consolidation moves to the nightly /tidy-memory cron)", async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps())
    await runMemoryConsolidation(createContext({ memoryMaintenance: 'dailyLog' }))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when auto-memory is disabled via env', async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(
      makeDeps({
        runtimeConfig: createMockRuntimeConfig({
          VELLOC_MEMORY: 'off',
        }),
      }),
    )
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when only autoExtractEnabled is set (gate split — extract ≠ tidy)', async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps())
    await runMemoryConsolidation(createContext({ autoExtractEnabled: true }))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('bails on the TIME gate (< 24h since last consolidation)', async () => {
    const { ids, mtimes } = fiveFreshSessions()
    const { fs } = makeFs({
      stamp: {
        lastConsolidatedAt: NOW - 1 * HOUR,
        holderId: '',
        expiresAt: 0,
      },
      sessionMtimes: mtimes,
    })
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('bails on the SESSION gate (fewer than 5 touched, current excluded)', async () => {
    // 4 other sessions + the current session → 4 after exclusion → below 5.
    const ids = ['s1', 's2', 's3', 's4', 'session-current']
    const mtimes: Record<string, number> = {}
    for (const id of ids) {
      mtimes[getConversationTranscriptPath(TRANSCRIPT_DIR, id)] = NOW
    }
    const { fs } = makeFs({ sessionMtimes: mtimes })
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('bails when the session-scan deps are absent (unbound / no base path)', async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: undefined, historyFolder: undefined }))
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('config.minSessions override fires with zero accumulated sessions (e2e path)', async () => {
    // Mirrors the e2e harness override: lowering minSessions to 0 lets the
    // fork fire in a single turn without seeding sessions.
    const { fs } = makeFs({})
    installProcessFs(fs)
    registerMemoryConsolidator(
      makeDeps({ listSessions: async () => [], config: { minSessions: 0 } }),
    )
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
  })

  // Regression (multi-tab realm): two BrowserRuntimes share ONE SharedWorker
  // realm. Runtime B initializes AFTER A — pre-fix B clobbered the module-global
  // runner, so A's end-of-turn forked against B's frozen deps (wrong project's
  // historyFolder / listSessions). The runner is now keyed by the runtime's
  // RuntimeConfig, so A's turn forks against A's deps. (minSessions:0 keeps the
  // gate trivial; listSessions is still invoked, so the spies prove which
  // runtime's deps were used.)
  it('isolates per-runtime deps: a turn forks against ITS runtime, not the last-initialized one', async () => {
    const { fs } = makeFs({})
    installProcessFs(fs)

    const rcA = createMockRuntimeConfig()
    const rcB = createMockRuntimeConfig()
    const listA = vi.fn(async () => [] as string[])
    const listB = vi.fn(async () => [] as string[])
    registerMemoryConsolidator(
      makeDeps({
        runtimeConfig: rcA,
        listSessions: listA,
        historyFolder: '/projA',
        config: { minSessions: 0 },
      }),
    )
    registerMemoryConsolidator(
      makeDeps({
        runtimeConfig: rcB,
        listSessions: listB,
        historyFolder: '/projB',
        config: { minSessions: 0 },
      }),
    )

    // Runtime A's turn (its RuntimeConfig rides the tool-use context).
    await runMemoryConsolidation(createContext(ENABLED, { runtimeConfig: rcA }))

    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    // A's session enumeration ran; B's did not — A's deps were used.
    expect(listA).toHaveBeenCalled()
    expect(listB).not.toHaveBeenCalled()
    // …and the fork prompt targeted A's transcript dir, not B's.
    const prompt = (
      runForkedAgentSpy.mock.calls[0]![0] as {
        openingRows: { message: { content: string } }[]
      }
    ).openingRows[0]!.message.content
    expect(prompt).toContain('/projA')
    expect(prompt).not.toContain('/projB')
  })

  it('bails when the lock is held by another live holder', async () => {
    const { ids, mtimes } = fiveFreshSessions()
    const { fs } = makeFs({
      stamp: {
        lastConsolidatedAt: 0,
        holderId: 'other-tab',
        expiresAt: NOW + 30 * 60 * 1000,
      },
      sessionMtimes: mtimes,
    })
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('reclaims a STALE lock and fires', async () => {
    const { ids, mtimes } = fiveFreshSessions()
    const { fs } = makeFs({
      stamp: {
        lastConsolidatedAt: 0,
        holderId: 'dead-tab',
        expiresAt: NOW - 60_000, // expired
      },
      sessionMtimes: mtimes,
    })
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
  })

  it('the scan throttle drops a second call within 10 minutes', async () => {
    // Session gate fails (so the stamp never advances) but the time gate keeps
    // passing — the throttle must prevent re-scanning every turn.
    const ids = ['s1'] // 1 session → session gate bails AFTER the scan stamp
    const mtimes: Record<string, number> = {
      [getConversationTranscriptPath(TRANSCRIPT_DIR, 's1')]: NOW,
    }
    const { fs } = makeFs({ sessionMtimes: mtimes })
    installProcessFs(fs)
    const listSessions = vi.fn(async () => ids)
    registerMemoryConsolidator(makeDeps({ listSessions }))

    await runMemoryConsolidation(createContext(ENABLED))
    await runMemoryConsolidation(createContext(ENABLED))
    // First call scanned; the second is throttled before it scans again.
    expect(listSessions).toHaveBeenCalledTimes(1)
  })
})

describe('runMemoryConsolidation — happy path + stamp lifecycle', () => {
  it('fires the fork with the periodic_tidy params when every gate passes', async () => {
    const { ids, mtimes } = fiveFreshSessions()
    const { fs, files } = makeFs({ sessionMtimes: mtimes })
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))

    await runMemoryConsolidation(createContext(ENABLED))

    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(arg.querySource).toBe('periodic_tidy')
    expect(arg.forkLabel).toBe('periodic_tidy')
    expect(arg.maxTurns).toBe(12)
    expect(arg.skipCacheWrite).toBe(true)
    expect(arg.useRealModelTransport).toBe(true)
    expect(typeof arg.canUseTool).toBe('function')

    // Success → stamp committed: lastConsolidatedAt advanced, holder cleared.
    const stamp = readStamp(files)
    expect(stamp?.lastConsolidatedAt).toBe(NOW)
    expect(stamp?.holderId).toBe('')
  })

  it('hands the prompt the session list + read-only-Bash constraint', async () => {
    const { ids, mtimes } = fiveFreshSessions()
    const { fs } = makeFs({ sessionMtimes: mtimes })
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))

    await runMemoryConsolidation(createContext(ENABLED))

    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      openingRows: Array<{ message: { content: string } }>
    }
    const prompt = arg.openingRows[0]!.message.content
    expect(prompt).toContain('Sessions since the last tidy (5)')
    expect(prompt).toContain('Shell in this run is read-only')
    expect(prompt).toContain('# Memory Tidy')
  })

  it('rewinds the stamp to its prior timestamp when the fork fails', async () => {
    const priorAt = NOW - 25 * HOUR
    const { ids, mtimes } = fiveFreshSessions()
    const { fs, files } = makeFs({
      stamp: { lastConsolidatedAt: priorAt, holderId: '', expiresAt: 0 },
      sessionMtimes: mtimes,
    })
    installProcessFs(fs)
    runForkedAgentSpy.mockRejectedValue(new Error('boom'))
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))

    await runMemoryConsolidation(createContext(ENABLED))

    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    const stamp = readStamp(files)
    // Rewound, holder cleared — the time gate would pass again next turn.
    expect(stamp?.lastConsolidatedAt).toBe(priorAt)
    expect(stamp?.holderId).toBe('')
  })

  it('reads the memoryMaintenance toggle LIVE between turns', async () => {
    const { ids, mtimes } = fiveFreshSessions()
    const { fs } = makeFs({ sessionMtimes: mtimes })
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))

    // Turn 1: disabled → no fork (bails before the scan throttle).
    await runMemoryConsolidation(createContext({}))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()

    // Turn 2: a live flip to enabled → fires.
    await runMemoryConsolidation(createContext(ENABLED))
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
  })

  // MEM-E2E-043 (unit): a corrupted `.consolidate-lock` (invalid JSON) must be
  // treated as "no lock" — `readStamp` swallows the parse error → null — so the
  // time gate sees lastConsolidatedAt=0, no holder blocks acquire, the fork
  // fires, and a fresh VALID stamp is written. Lock corruption must never wedge
  // consolidation or crash the turn.
  it('treats a corrupted .consolidate-lock as no lock and fires, writing a valid stamp', async () => {
    const { ids, mtimes } = fiveFreshSessions()
    const { fs, files } = makeFs({ sessionMtimes: mtimes })
    files.set(LOCK_PATH, '{ this is not valid json …') // corrupted stamp
    installProcessFs(fs)
    registerMemoryConsolidator(makeDeps({ listSessions: async () => ids }))

    await runMemoryConsolidation(createContext(ENABLED))

    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    // Success overwrote the corrupted file with a committed, parseable stamp.
    const stamp = readStamp(files)
    expect(stamp?.lastConsolidatedAt).toBe(NOW)
    expect(stamp?.holderId).toBe('')
  })
})
