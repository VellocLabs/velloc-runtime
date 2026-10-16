import type {
  McpBridgeOperations,
  NexusMcpServerLaunchConfig,
} from './nativeBridge'
import { MCPPool } from './pool'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { MCPServerConfigWithName } from './types'

/**
 * MCP pools, one per top-level session (F-10); a sub-agent, fork or teammate
 * runtime shares the pool of the session it descends from.
 *
 * Contract: pair every `acquireSessionMCPPool` with one `release`. A pool with
 * no holder closes after `MCP_POOL_RELEASE_GRACE_MS`; `closeSessionMCPPool`
 * closes at once. Idle stdio servers are parked while any pool exists.
 */

/** Longest a runtime build waits for its pool's connects; slower servers
 *  keep connecting and serve the session's later builds. */
export const MCP_BOOT_WAIT_MS = 10_000
export const MCP_POOL_RELEASE_GRACE_MS = 30_000
export const MCP_STDIO_IDLE_MS = 10 * 60_000
const IDLE_SWEEP_INTERVAL_MS = 60_000
/** Bound on a parent chain walk; agent nesting is far shallower. */
const MAX_PARENT_DEPTH = 32

type PoolEntry = {
  pool: MCPPool
  holders: number
  initialized: boolean
  closeTimer: ReturnType<typeof setTimeout> | null
}

const pools = new Map<string, PoolEntry>()
const parentOf = new Map<string, string>()
let idleSweep: ReturnType<typeof setInterval> | null = null

/** The session whose pool `sessionId` uses: its root ancestor. */
export function topLevelSessionId(sessionId: string): string {
  let current = sessionId
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const parent = parentOf.get(current)
    if (parent === undefined || parent === current) return current
    current = parent
  }
  return current
}

export type AcquireSessionMCPPoolOptions = {
  sessionId: string
  /** The spawning session, for a sub-agent, fork or teammate runtime. */
  parentSessionId?: string
  /** Project directory for `.nexus/mcp.json`; used when the pool is created. */
  cwd: string
  fs?: RuntimeFs
  extraServers?: MCPServerConfigWithName[]
  nativeBridge?: McpBridgeOperations
  loadNativeServers?: () => Promise<Array<{
    id: string
    config: NexusMcpServerLaunchConfig
  }>>
  /** Defaults to `MCP_BOOT_WAIT_MS`. */
  bootWaitMs?: number
}

export type SessionMCPPoolLease = {
  pool: MCPPool
  /** The pool's key. */
  topLevelSessionId: string
  /** Idempotent. */
  release: () => void
}

/**
 * Hold the pool of `sessionId`'s top-level session, creating and connecting
 * it on first use; a later holder retries the pool's failed servers and picks
 * up settings changes. Resolves once the connects settle or `bootWaitMs`
 * passes, whichever is first. Never rejects for a server failure.
 */
export async function acquireSessionMCPPool(
  options: AcquireSessionMCPPoolOptions,
): Promise<SessionMCPPoolLease> {
  const { sessionId, parentSessionId } = options
  const linked = parentSessionId !== undefined && parentSessionId !== sessionId
  if (linked) parentOf.set(sessionId, parentSessionId)
  const key = topLevelSessionId(sessionId)

  let entry = pools.get(key)
  if (!entry) {
    entry = {
      pool: new MCPPool({
        cwd: options.cwd,
        fs: options.fs,
        extraServers: options.extraServers,
        nativeBridge: options.nativeBridge,
        loadNativeServers: options.loadNativeServers,
      }),
      holders: 0,
      initialized: false,
      closeTimer: null,
    }
    pools.set(key, entry)
    startIdleSweep()
  }
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer)
    entry.closeTimer = null
  }
  entry.holders++
  const held = entry

  const settle = held.initialized
    ? held.pool.refresh()
    : held.pool.init().then(() => {
        held.initialized = true
      })
  await waitAtMost(
    settle.catch(err => {
      console.warn('[mcp] Session pool connect failed:', err)
    }),
    options.bootWaitMs ?? MCP_BOOT_WAIT_MS,
  )

  let released = false
  return {
    pool: held.pool,
    topLevelSessionId: key,
    release: () => {
      if (released) return
      released = true
      if (linked && parentOf.get(sessionId) === parentSessionId) parentOf.delete(sessionId)
      releaseHolder(key, held)
    },
  }
}

function releaseHolder(key: string, entry: PoolEntry): void {
  entry.holders = Math.max(0, entry.holders - 1)
  if (entry.holders > 0 || pools.get(key) !== entry) return
  entry.closeTimer = setTimeout(() => {
    entry.closeTimer = null
    if (entry.holders === 0 && pools.get(key) === entry) void closeEntry(key, entry)
  }, MCP_POOL_RELEASE_GRACE_MS)
}

/** Close `sessionId`'s top-level pool now (the session was deleted). */
export async function closeSessionMCPPool(sessionId: string): Promise<void> {
  const key = topLevelSessionId(sessionId)
  const entry = pools.get(key)
  if (entry) await closeEntry(key, entry)
}

async function closeEntry(key: string, entry: PoolEntry): Promise<void> {
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer)
    entry.closeTimer = null
  }
  pools.delete(key)
  if (pools.size === 0) stopIdleSweep()
  try {
    await entry.pool.shutdown()
  } catch (err) {
    console.warn(`[mcp] Session pool "${key}" shutdown failed:`, err)
  }
}

/** Every open pool, for realm-wide events (a settings change). */
export function listSessionMCPPools(): MCPPool[] {
  return Array.from(pools.values(), entry => entry.pool)
}

/** Park the idle stdio servers of every open pool. */
export async function parkIdleMCPServers(now: number = Date.now()): Promise<void> {
  await Promise.all(
    listSessionMCPPools().map(pool =>
      pool.parkIdleStdioServers(MCP_STDIO_IDLE_MS, now).catch(err => {
        console.warn('[mcp] Idle park failed:', err)
      }),
    ),
  )
}

/** Close every pool and forget every parent link. */
export async function closeAllSessionMCPPools(): Promise<void> {
  const entries = Array.from(pools.entries())
  parentOf.clear()
  await Promise.all(entries.map(([key, entry]) => closeEntry(key, entry)))
}

function startIdleSweep(): void {
  if (idleSweep) return
  idleSweep = setInterval(() => {
    void parkIdleMCPServers()
  }, IDLE_SWEEP_INTERVAL_MS)
}

function stopIdleSweep(): void {
  if (!idleSweep) return
  clearInterval(idleSweep)
  idleSweep = null
}

function waitAtMost(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
