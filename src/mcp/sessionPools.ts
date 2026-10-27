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

/** One lease's fs and settings loader; the pool reads through a root
 *  session's newest lease, else the newest lease. */
type PoolHold = {
  root: boolean
  fs?: RuntimeFs
  loadNativeServers?: AcquireSessionMCPPoolOptions['loadNativeServers']
}

type PoolEntry = {
  pool: MCPPool
  /** The project folder the pool read `.nexus/mcp.json` from. */
  cwd: string
  /** One per live lease, oldest first. */
  holds: PoolHold[]
  initialized: boolean
  closeTimer: ReturnType<typeof setTimeout> | null
}

const pools = new Map<string, PoolEntry>()
/** Pools replaced under their key, open until their last holder leaves. */
const detached = new Set<PoolEntry>()
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
  /** Security: `false` keeps the project's server file out of the pool
   *  (`MCPPoolOptions.projectServers`); read when the pool is created. */
  projectServers?: boolean
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
  // A link lives as long as its root's pool: a descendant spawned after an
  // intermediate agent ended still resolves to the same root.
  if (parentSessionId !== undefined && parentSessionId !== sessionId) parentOf.set(sessionId, parentSessionId)
  const key = topLevelSessionId(sessionId)
  const root = key === sessionId

  let entry = pools.get(key)
  // The session itself back with another project folder (a rebind) gets a
  // fresh pool; descendants holding the old one keep it until they release.
  if (entry && root && entry.cwd !== options.cwd) {
    detachEntry(key, entry)
    entry = undefined
  }
  if (!entry) {
    entry = {
      cwd: options.cwd,
      pool: new MCPPool({
        cwd: options.cwd,
        fs: options.fs,
        extraServers: options.extraServers,
        projectServers: options.projectServers,
        nativeBridge: options.nativeBridge,
        loadNativeServers: options.loadNativeServers,
      }),
      holds: [],
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
  const held = entry
  const hold: PoolHold = { root, fs: options.fs, loadNativeServers: options.loadNativeServers }
  held.holds.push(hold)
  applySources(held)

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
      const at = held.holds.indexOf(hold)
      if (at !== -1) held.holds.splice(at, 1)
      if (held.holds.length > 0) applySources(held)
      releaseHolder(key, held)
    },
  }
}

/** Read through a live holder's sources: a disposed runtime's fs and loader
 *  fail every read, which a refresh would take for "no servers". */
function applySources(entry: PoolEntry): void {
  const hold = entry.holds.findLast(candidate => candidate.root) ?? entry.holds.at(-1)
  if (hold) entry.pool.setSources({ fs: hold.fs, loadNativeServers: hold.loadNativeServers })
}

function releaseHolder(key: string, entry: PoolEntry): void {
  if (entry.holds.length > 0) return
  if (detached.has(entry)) {
    void shutdownPool(key, entry)
    return
  }
  if (pools.get(key) !== entry) return
  entry.closeTimer = setTimeout(() => {
    entry.closeTimer = null
    if (entry.holds.length === 0 && pools.get(key) === entry) void closeEntry(key, entry)
  }, MCP_POOL_RELEASE_GRACE_MS)
}

function detachEntry(key: string, entry: PoolEntry): void {
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer)
    entry.closeTimer = null
  }
  pools.delete(key)
  detached.add(entry)
  if (entry.holds.length === 0) void shutdownPool(key, entry)
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
  if (pools.get(key) === entry) {
    pools.delete(key)
    forgetLinks(key)
  }
  if (pools.size === 0) stopIdleSweep()
  await shutdownPool(key, entry)
}

async function shutdownPool(key: string, entry: PoolEntry): Promise<void> {
  detached.delete(entry)
  try {
    await entry.pool.shutdown()
  } catch (err) {
    console.warn(`[mcp] Session pool "${key}" shutdown failed:`, err)
  }
}

/** Drop the parent links that resolve to `key`. */
function forgetLinks(key: string): void {
  const children = Array.from(parentOf.keys()).filter(child => topLevelSessionId(child) === key)
  for (const child of children) parentOf.delete(child)
}

/** Every open pool, for realm-wide events (a settings change). */
export function listSessionMCPPools(): MCPPool[] {
  return [...Array.from(pools.values(), entry => entry.pool), ...Array.from(detached, entry => entry.pool)]
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
  const replaced = Array.from(detached)
  parentOf.clear()
  await Promise.all([
    ...entries.map(([key, entry]) => closeEntry(key, entry)),
    ...replaced.map(entry => shutdownPool('replaced', entry)),
  ])
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
