import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { loadMCPConfig } from './config'
import {
  invokeServerTool,
  connectMCPServer,
  disconnectMCPServer,
} from './client'
import {
  launchTransportKind,
  type McpBridgeOperations,
  type NexusMcpServerLaunchConfig,
} from './nativeBridge'
import type {
  LiveServerLink,
  McpResourceDescriptor,
  MCPServerConfig,
  MCPServerConfigWithName,
  MCPToolDescriptor,
} from './types'

/** JSON-RPC "Method not found" (-32601): the server doesn't implement the
 *  resources capability. The SDK surfaces it as an McpError with `.code`. */
function isMethodNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (code === -32601) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /-32601|method not found/i.test(msg)
}

/**
 * Equality of two `NexusMcpServerLaunchConfig` snapshots (pure data) via JSON
 * of sorted keys; drift means replace.
 */
function configsEqual(
  a: NexusMcpServerLaunchConfig | MCPServerConfig | undefined,
  b: NexusMcpServerLaunchConfig | MCPServerConfig | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  return stableJson(a) === stableJson(b)
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k]
      }
      return sorted
    }
    return val
  })
}

/**
 * Whether two launch configs describe the same server — browser-transport
 * (`MCPServerConfig`) or native (`NexusMcpServerLaunchConfig`). Exported for
 * `$.mcp.connect` (mods/modMcp.ts), which answers with the name the pool
 * already runs a plugin's server under.
 */
export function sameMCPServerConfig(
  a: NexusMcpServerLaunchConfig | MCPServerConfig | undefined,
  b: NexusMcpServerLaunchConfig | MCPServerConfig | undefined,
): boolean {
  return configsEqual(a, b)
}

export type MCPPoolOptions = {
  cwd: string
  /** The booting runtime's fs; omitted → the realm-global slot (tests). */
  fs?: RuntimeFs
  /** Additional servers (e.g. contributed by enabled plugins) merged after
   *  the project `.velloc/mcp.json`. On name collision the existing config
   *  wins and the plugin server is skipped. */
  extraServers?: MCPServerConfigWithName[]
  /**
   * How the settings-configured ("native") servers are driven — in the
   * worker, over the host's primitives (`createWorkerMcpOperations`,
   * workerServers.ts). Absent (mock host, browser mode) → the pool is
   * browser transports only.
   */
  nativeBridge?: McpBridgeOperations
  /**
   * The settings-configured servers (`mcp.servers` plus plugin stdio servers) with
   * full launch configs, re-read on every refresh. Required for any to connect.
   */
  loadNativeServers?: () => Promise<Array<{
    id: string
    config: NexusMcpServerLaunchConfig
  }>>
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('MCP tool call aborted.')
}

/** Resolve when `previous` settles, or reject as soon as `signal` aborts. */
function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

/** The host's in-band answer for a server its port service never connected. */
function isNativeServerNotConnected(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith('MCP server is not connected')
}

export class MCPPool {
  private readonly cwd: string
  private readonly fs?: RuntimeFs
  private readonly extraServers: MCPServerConfigWithName[]
  private readonly nativeBridge?: McpBridgeOperations
  private readonly loadNativeServers?: NonNullable<MCPPoolOptions['loadNativeServers']>
  private readonly servers = new Map<string, LiveServerLink>()
  /**
   * The one `init` run, memoised so a second concurrent caller awaits the
   * first instead of returning before any server is registered. Cleared
   * when the run throws, so the next `init` starts over.
   */
  private initRun: Promise<void> | null = null
  /** Per-name in-flight connects (browser and native) — never two at once. */
  private readonly connecting = new Map<string, Promise<void>>()
  /** When each server last connected or finished a call; absent once parked. */
  private readonly lastActiveAt = new Map<string, number>()
  /** Calls running per server; a server with one is never parked. */
  private readonly callsRunning = new Map<string, number>()
  /** Tail of each server's exclusive-call queue. Never rejects. */
  private readonly exclusiveTails = new Map<string, Promise<void>>()

  constructor(options: MCPPoolOptions) {
    this.cwd = options.cwd
    this.fs = options.fs
    this.extraServers = options.extraServers ?? []
    this.nativeBridge = options.nativeBridge
    this.loadNativeServers = options.loadNativeServers
  }

  init(): Promise<void> {
    if (!this.initRun) {
      this.initRun = this.runInit().catch(err => {
        this.initRun = null
        throw err
      })
    }
    return this.initRun
  }

  private async runInit(): Promise<void> {
    const configs = await loadMCPConfig(this.cwd, this.fs)
    const names = new Set(configs.map(entry => entry.name))
    const merged = [...configs]
    for (const extra of this.extraServers) {
      if (names.has(extra.name)) {
        console.warn(
          `[mcp] Plugin server "${extra.name}" skipped — a server with that name is already configured.`,
        )
        continue
      }
      names.add(extra.name)
      merged.push(extra)
    }
    await Promise.all([
      ...merged.map(entry => this.connect(entry)),
      this.connectNativeServers(names),
    ])
  }

  /** Run `work` as the only connect for `name`; a concurrent caller for the
   *  same name shares the run already in flight. */
  private connectOnce(name: string, work: () => Promise<void>): Promise<void> {
    const inFlight = this.connecting.get(name)
    if (inFlight) return inFlight
    const run = work().finally(() => {
      this.connecting.delete(name)
    })
    this.connecting.set(name, run)
    return run
  }

  private connect(entry: MCPServerConfigWithName): Promise<void> {
    const { name, ...config } = entry
    return this.connectOnce(name, async () => {
      const server = await connectMCPServer({
        cwd: this.cwd,
        name,
        config,
        fs: this.fs,
      })
      this.servers.set(name, server)
    })
  }

  /**
   * Retry every server left in `status: 'failed'` — once per call. A failed
   * entry keeps its `error` until a retry replaces it (a new failure reason
   * or a connected server). Browser/plugin servers reconnect with their
   * stored config; settings-configured ones are retried inside
   * `refreshNativeServers`. Then reconcile the settings-configured list.
   * Never rejects.
   */
  async refresh(): Promise<void> {
    const failedBrowser = Array.from(this.servers.values()).filter(
      server =>
        server.nativeServerId === undefined
        && server.status === 'failed'
        && server.config !== undefined,
    )
    await Promise.all([
      ...failedBrowser.map(server =>
        this.addServer({ name: server.name, ...server.config! }).catch(err =>
          console.warn(`[mcp] Server "${server.name}" retry failed:`, err),
        ),
      ),
      this.refreshNativeServers().catch(err =>
        console.warn('[mcp] Native pool refresh failed:', err),
      ),
    ])
  }

  /**
   * Connect the settings-configured servers; best-effort (failures become
   * `status: 'failed'`). A name already taken by a browser/plugin server wins.
   */
  private async connectNativeServers(taken: Set<string>): Promise<void> {
    const bridge = this.nativeBridge
    if (!bridge || !this.loadNativeServers) return
    let entries: Array<{ id: string; config: NexusMcpServerLaunchConfig }>
    try {
      entries = await this.loadNativeServers()
    } catch (err) {
      console.warn('[mcp] loadNativeServers failed:', err)
      return
    }
    await this.addNativeServers(bridge, entries, taken)
  }

  /**
   * Connect each summary not already in `taken`, recording the outcome
   * (connected / failed) in the pool. `taken` is mutated as servers are
   * claimed so concurrent additions don't double-register a name. Shared
   * by initial discovery (`connectNativeServers`) and the per-new-session
   * `refreshNativeServers` add path.
   */
  private async addNativeServers(
    bridge: McpBridgeOperations,
    entries: Array<{ id: string; config: NexusMcpServerLaunchConfig }>,
    taken: Set<string>,
  ): Promise<void> {
    await Promise.all(
      entries.map(async entry => {
        const name = entry.id
        if (taken.has(name)) {
          console.warn(
            `[mcp] Native server "${name}" skipped — a server with that name is already configured.`,
          )
          return
        }
        taken.add(name)
        await this.connectNative(bridge, name, entry.config)
      }),
    )
  }

  /**
   * Connect one settings-configured server and record the outcome. Name-level
   * single-flight via `connectOnce`. A failed entry already in the pool stays
   * as it is (with its reason) until this attempt settles.
   */
  private connectNative(
    bridge: McpBridgeOperations,
    name: string,
    config: NexusMcpServerLaunchConfig,
  ): Promise<void> {
    return this.connectOnce(name, async () => {
      const server: LiveServerLink = {
        name,
        nativeServerId: name,
        nativeConfig: config,
        status: 'connecting',
        tools: [],
      }
      try {
        const result = await bridge.connect(name, config)
        if (result.ok) {
          server.status = 'connected'
          server.tools = result.tools
          this.lastActiveAt.set(name, Date.now())
        } else {
          server.status = 'failed'
          server.error = result.error ?? 'connect failed'
          console.warn(
            `[mcp] Native server "${name}" connect failed:`,
            server.error,
          )
        }
      } catch (err) {
        server.status = 'failed'
        server.error = err instanceof Error ? err.message : String(err)
        console.warn(`[mcp] Native server "${name}" connect threw:`, err)
      }
      this.servers.set(name, server)
    })
  }

  /**
   * In-flight refresh: concurrent `refreshNativeServers` calls share it, so diff
   * passes never interleave.
   */
  private refreshInFlight: Promise<void> | null = null

  /**
   * Reconcile native servers against settings.json: add new, remove missing,
   * replace drifted configs. Browser-transport servers are never touched.
   * settings.json is authoritative: a call in flight on a removed server gets a
   * tool error. Serialised via `refreshInFlight`.
   */
  async refreshNativeServers(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }
    const bridge = this.nativeBridge
    const load = this.loadNativeServers
    if (!bridge || !load) return
    this.refreshInFlight = this.doRefreshNativeServers(bridge, load).finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private async doRefreshNativeServers(
    bridge: McpBridgeOperations,
    load: NonNullable<MCPPoolOptions['loadNativeServers']>,
  ): Promise<void> {
    let entries: Array<{ id: string; config: NexusMcpServerLaunchConfig }>
    try {
      entries = await load()
    } catch (err) {
      console.warn('[mcp] loadNativeServers (refresh) failed:', err)
      return
    }

    // Build the "what should be live" set keyed by id, plus the
    // "what IS live and native" set. The native-only filter is
    // critical: we never touch browser-transport / plugin-extra
    // servers from this code path.
    const desired = new Map(entries.map(e => [e.id, e]))
    const liveNative = new Map<string, LiveServerLink>()
    for (const [name, server] of this.servers) {
      if (server.nativeServerId !== undefined) {
        liveNative.set(name, server)
      }
    }

    // Compute three buckets. `replaces` collapses to "disconnect then
    // re-add" so we run each id through a single connect path
    // (`addNativeServers`).
    const additions: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = []
    const removals: LiveServerLink[] = []
    const replaces: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = []
    // Same config, left failed by an earlier connect: retried once here.
    const retries: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = []

    for (const [id, entry] of desired) {
      const existing = liveNative.get(id)
      if (!existing) {
        additions.push(entry)
        continue
      }
      if (
        existing.nativeConfig !== undefined
        && !configsEqual(existing.nativeConfig, entry.config)
      ) {
        replaces.push(entry)
      } else if (existing.status === 'failed') {
        retries.push(entry)
      }
    }
    for (const [id, server] of liveNative) {
      if (!desired.has(id)) {
        removals.push(server)
      }
    }

    if (
      additions.length === 0
      && removals.length === 0
      && replaces.length === 0
      && retries.length === 0
    ) {
      return
    }

    // Replaces and removes both disconnect first. Run them in
    // parallel so a slow disconnect on one server doesn't block the
    // reconnect of another. After the disconnects settle we run the
    // adds (which include the freshly-removed replaces) in one
    // batch so id collisions can't happen mid-reconnect.
    await Promise.all([
      ...removals.map(server => this.disconnectAndEvict(bridge, server)),
      ...replaces.map(entry => {
        const existing = liveNative.get(entry.id)
        return existing
          ? this.disconnectAndEvict(bridge, existing)
          : Promise.resolve()
      }),
    ])

    // Carry the just-evicted replaces into the add bucket; this is
    // the "reconnect with new config" step.
    const adds = [...additions, ...replaces]
    await Promise.all([
      // `taken` is built from the post-eviction `this.servers` so the
      // re-adds don't trip the collision warn-and-skip in
      // `addNativeServers`.
      adds.length > 0
        ? this.addNativeServers(bridge, adds, new Set(this.servers.keys()))
        : Promise.resolve(),
      ...retries.map(entry => this.connectNative(bridge, entry.id, entry.config)),
    ])
  }

  /**
   * Disconnect a native server via the bridge and drop it from
   * `this.servers`. Best-effort: a disconnect failure is logged but
   * still proceeds with eviction — leaving the entry around after a
   * removed-in-settings event would be worse than a leaked C++
   * connection (which the host process will reap on next browser
   * restart anyway). Mirrors `shutdown` for the disconnect call.
   */
  private async disconnectAndEvict(
    bridge: McpBridgeOperations,
    server: LiveServerLink,
  ): Promise<void> {
    if (server.nativeServerId === undefined) return
    try {
      await bridge.disconnect(server.nativeServerId)
    } catch (err) {
      console.warn(
        `[mcp] Native server "${server.name}" disconnect (refresh) failed:`,
        err instanceof Error ? err.message : err,
      )
    }
    server.status = 'closed'
    this.servers.delete(server.name)
  }

  /** In-flight `addServer` connects, by name — see `addServer`. */
  private readonly adding = new Map<string, Promise<LiveServerLink>>()

  /**
   * Connect one browser-transport server after `init` (`$.mcp.connect`). A
   * registered name wins unless it is a failed or closed server with the same
   * config. Concurrent calls share one connect. Never rejects.
   */
  addServer(entry: MCPServerConfigWithName): Promise<LiveServerLink> {
    const inFlight = this.adding.get(entry.name)
    if (inFlight) return inFlight
    const { name, ...config } = entry
    const existing = this.servers.get(name)
    const retry =
      existing !== undefined
      && existing.nativeServerId === undefined
      && (existing.status === 'failed' || existing.status === 'closed')
      && configsEqual(existing.config, config as MCPServerConfig)
    if (existing && !retry) return Promise.resolve(existing)
    const run = (async () => {
      if (existing) await disconnectMCPServer(existing)
      await this.connect(entry)
      return this.servers.get(name)!
    })().finally(() => {
      this.adding.delete(name)
    })
    this.adding.set(name, run)
    return run
  }

  /** Whether a server is registered under `name`, in any status. */
  hasServer(name: string): boolean {
    return this.servers.has(name)
  }

  listServers(): LiveServerLink[] {
    return Array.from(this.servers.values())
  }

  getServer(name: string): LiveServerLink | undefined {
    return this.servers.get(name)
  }

  listAllTools(): Array<{ server: string; tool: MCPToolDescriptor }> {
    const result: Array<{ server: string; tool: MCPToolDescriptor }> = []
    for (const server of this.servers.values()) {
      if (server.status !== 'connected') continue
      for (const tool of server.tools) {
        result.push({ server: server.name, tool })
      }
    }
    return result
  }

  /**
   * Invoke one tool. A tool its server does not mark `readOnlyHint` starts
   * only after every earlier such call on the same server has settled (the
   * pool is shared by a session's agents, and one server holds one state); an
   * abort while waiting rejects without calling. Read-only calls never wait.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const readOnly = this.servers
      .get(serverName)
      ?.tools.find(tool => tool.name === toolName)?.readOnlyHint === true
    if (readOnly) {
      return this.trackCall(serverName, () =>
        this.dispatchCall(serverName, toolName, args, signal),
      )
    }
    const previous = this.exclusiveTails.get(serverName) ?? Promise.resolve()
    let finish!: () => void
    const own = new Promise<void>(resolve => {
      finish = resolve
    })
    const tail = previous.then(() => own)
    this.exclusiveTails.set(serverName, tail)
    try {
      await waitForTurn(previous, signal)
      return await this.trackCall(serverName, () =>
        this.dispatchCall(serverName, toolName, args, signal),
      )
    } finally {
      finish()
      if (this.exclusiveTails.get(serverName) === tail) {
        this.exclusiveTails.delete(serverName)
      }
    }
  }

  private async trackCall<T>(serverName: string, run: () => Promise<T>): Promise<T> {
    this.callsRunning.set(serverName, (this.callsRunning.get(serverName) ?? 0) + 1)
    try {
      return await run()
    } finally {
      const left = (this.callsRunning.get(serverName) ?? 1) - 1
      if (left > 0) this.callsRunning.set(serverName, left)
      else this.callsRunning.delete(serverName)
      this.lastActiveAt.set(serverName, Date.now())
    }
  }

  /**
   * Stop each connected stdio server that has run no call for `idleMs`. Its
   * entry keeps `status: 'connected'` and its tools, so the session's tool
   * list is unchanged; the next call meets "not connected" and reconnects in
   * `dispatchCall`. A parked server is not parked again until it is used.
   * Returns the names stopped.
   */
  async parkIdleStdioServers(idleMs: number, now: number = Date.now()): Promise<string[]> {
    const bridge = this.nativeBridge
    if (!bridge) return []
    const idle = Array.from(this.servers.values()).filter(server => {
      if (server.nativeServerId === undefined || server.status !== 'connected') return false
      if (!server.nativeConfig || launchTransportKind(server.nativeConfig) !== 'stdio') return false
      if (this.callsRunning.has(server.name) || this.connecting.has(server.name)) return false
      const since = this.lastActiveAt.get(server.name)
      return since !== undefined && now - since >= idleMs
    })
    await Promise.all(
      idle.map(async server => {
        this.lastActiveAt.delete(server.name)
        try {
          await bridge.disconnect(server.nativeServerId!)
        } catch (err) {
          console.warn(
            `[mcp] Native server "${server.name}" idle stop failed:`,
            err instanceof Error ? err.message : err,
          )
        }
      }),
    )
    return idle.map(server => server.name)
  }

  private async dispatchCall(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const server = this.servers.get(serverName)
    if (!server) {
      throw new Error(`MCP server "${serverName}" is not registered.`)
    }
    if (server.nativeServerId !== undefined) {
      if (!this.nativeBridge) {
        throw new Error(
          `MCP server "${serverName}" is native but no native bridge is available.`,
        )
      }
      if (server.status !== 'connected') {
        throw new Error(
          `MCP server "${serverName}" is not connected (status: ${server.status}).`,
        )
      }
      const nativeBridge = this.nativeBridge
      const nativeServerId = server.nativeServerId
      let out = await nativeBridge.callTool(nativeServerId, toolName, args, signal)
      // "Not connected" means the frame never reached a server: its stdio
      // child exited or was parked idle, or the runtime's host port was
      // replaced under a live pool (a newer window hands the SharedWorker its
      // own) and the child died with the old connection. Connect it again on
      // the current port and retry once.
      if (!out.ok && isNativeServerNotConnected(out.error)) {
        const reconnected = server.nativeConfig !== undefined
          ? await nativeBridge.connect(nativeServerId, server.nativeConfig)
          : { ok: false, tools: [], error: `MCP server "${nativeServerId}" has no launch config.` }
        if (reconnected.ok) {
          server.tools = reconnected.tools
          out = await nativeBridge.callTool(nativeServerId, toolName, args, signal)
        }
      }
      if (!out.ok) {
        throw new Error(out.error ?? `MCP tool "${toolName}" failed.`)
      }
      return out.result
    }
    return invokeServerTool(server, toolName, args, signal)
  }

  /**
   * List the resources advertised by a connected MCP server
   * (`resources/list`). Browser-transport servers go through the SDK
   * `client.listResources()`. Native (stdio) servers are not supported yet
   * (the native bridge has no resources route) and throw. A server that
   * doesn't implement resources (method-not-found) yields an empty list.
   */
  async listResources(serverName: string): Promise<McpResourceDescriptor[]> {
    const server = this.servers.get(serverName)
    if (!server) {
      throw new Error(`MCP server "${serverName}" is not registered.`)
    }
    if (server.nativeServerId !== undefined) {
      throw new Error(
        `MCP server "${serverName}" is native; resource access is not supported yet.`,
      )
    }
    if (!server.client) {
      throw new Error(
        `MCP server "${serverName}" has no client (status: ${server.status}).`,
      )
    }
    let result: { resources?: unknown[] }
    try {
      result = await server.client.listResources()
    } catch (err) {
      if (isMethodNotFound(err)) return []
      throw err
    }
    const resources = Array.isArray(result.resources) ? result.resources : []
    return resources.map(raw => {
      const r = (raw ?? {}) as Record<string, unknown>
      return {
        uri: String(r.uri ?? ''),
        name: typeof r.name === 'string' ? r.name : undefined,
        description:
          typeof r.description === 'string' ? r.description : undefined,
        mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
        server: serverName,
      }
    })
  }

  /**
   * Read a specific resource by URI from a connected MCP server
   * (`resources/read`). Returns the SDK result (`{ contents: [...] }`).
   */
  async readResource(serverName: string, uri: string): Promise<unknown> {
    const server = this.servers.get(serverName)
    if (!server) {
      throw new Error(`MCP server "${serverName}" is not registered.`)
    }
    if (server.nativeServerId !== undefined) {
      throw new Error(
        `MCP server "${serverName}" is native; resource access is not supported yet.`,
      )
    }
    if (!server.client) {
      throw new Error(
        `MCP server "${serverName}" has no client (status: ${server.status}).`,
      )
    }
    return server.client.readResource({ uri })
  }

  async shutdown(): Promise<void> {
    const servers = Array.from(this.servers.values())
    this.servers.clear()
    this.lastActiveAt.clear()
    await Promise.all(
      servers.map(async server => {
        if (server.nativeServerId !== undefined) {
          if (!this.nativeBridge) return
          try {
            await this.nativeBridge.disconnect(server.nativeServerId)
          } catch (err) {
            console.warn(
              `[mcp] Native server "${server.name}" disconnect failed:`,
              err,
            )
          }
          server.status = 'closed'
          return
        }
        await disconnectMCPServer(server)
      }),
    )
  }
}
