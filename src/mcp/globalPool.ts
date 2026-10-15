import type {
  McpBridgeOperations,
  NexusMcpServerLaunchConfig,
} from './nativeBridge'
import { MCPPool } from './pool'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { MCPServerConfigWithName } from './types'

let singleton: MCPPool | null = null
let initPromise: Promise<MCPPool> | null = null
/** Bumped by every init start and by shutdown: a run only writes the module
 *  state while it is still the current one. */
let generation = 0

export type EnsureMCPPoolOptions = {
  /** The booting runtime's fs; omitted → the realm-global slot (tests). */
  fs?: RuntimeFs
  extraServers?: MCPServerConfigWithName[]
  /** Native (stdio) MCP bridge; omitted on hosts without the `mcp`
   *  capability. See `MCPPoolOptions.nativeBridge`. */
  nativeBridge?: McpBridgeOperations
  /** Settings.json-backed loader. When supplied, the pool reads its
   *  native server list from this callback and forwards inline
   *  configs through `bridge.connect()`. See
   *  `MCPPoolOptions.loadNativeServers`. */
  loadNativeServers?: () => Promise<Array<{
    id: string
    config: NexusMcpServerLaunchConfig
  }>>
}

export async function ensureMCPPool(
  cwd: string,
  options: EnsureMCPPoolOptions = {},
): Promise<MCPPool> {
  if (singleton) {
    // The pool is a process-wide singleton built on the first session. A
    // later session (new chat / restored tab) reuses it — without this the
    // pool would still reflect the server list from first boot, so a server
    // the user just added in host settings wouldn't appear until a full
    // browser restart. Re-discover native servers and retry failed ones so
    // the new session sees them. Best-effort: never blocks or fails boot.
    const pool = singleton
    await pool.refresh()
    return pool
  }
  if (initPromise) return initPromise
  // Single-flight while one init is in flight. A thrown init clears the
  // memo and stores no singleton, so the next call builds and inits again.
  const gen = ++generation
  const run = (async () => {
    const pool = new MCPPool({
      cwd,
      fs: options.fs,
      extraServers: options.extraServers,
      nativeBridge: options.nativeBridge,
      loadNativeServers: options.loadNativeServers,
    })
    try {
      await pool.init()
    } catch (err) {
      console.warn('[mcp] Global pool init failed:', err)
      // This boot proceeds with the pool as it stands (never fails session
      // boot), but it is not kept: the next call starts a fresh init.
      if (gen === generation) initPromise = null
      return pool
    }
    if (gen === generation) singleton = pool
    return pool
  })()
  initPromise = run
  return run
}

export function getMCPPool(): MCPPool | null {
  return singleton
}

export async function shutdownMCPPool(): Promise<void> {
  const pool = singleton
  singleton = null
  initPromise = null
  generation++
  if (pool) await pool.shutdown()
}
