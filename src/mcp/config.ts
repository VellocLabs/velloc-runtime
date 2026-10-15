import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { dirname, getMcpConfigPath } from './paths'
import type { NexusMcpServerLaunchConfig } from './nativeBridge'
import type {
  MCPServerConfig,
  MCPServerConfigWithName,
  MCPServersConfigFile,
} from './types'

const REMOTE_TRANSPORT_KINDS = new Set(['http', 'sse', 'websocket', 'ws'])

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length > 0 ? items : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeNativeCommand(command: string): string {
  switch (command) {
    case '/bin/sh':
    case '/usr/bin/sh':
      return 'sh'
    case '/bin/bash':
    case '/usr/bin/bash':
      return 'bash'
    default:
      return command
  }
}

export function isStdioMCPServerConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const candidate = raw as Record<string, unknown>
  const transport = candidate.transport ?? candidate.type
  return transport === 'stdio' || (transport == null && typeof candidate.command === 'string')
}

/**
 * Validate one native MCP launch entry. These run through the host `mcp`
 * bridge (not the browser JS SDK), so command-based stdio configs are valid.
 */
export function parseNativeMCPServerConfig(
  name: string,
  raw: unknown,
): NexusMcpServerLaunchConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  const transport = candidate.transport ?? candidate.type
  const command = candidate.command
  const url = candidate.url
  const isStdio = transport === 'stdio' || (transport == null && typeof command === 'string')
  const isHttp = transport === 'http' || (transport == null && typeof url === 'string')

  if (isStdio) {
    if (typeof command !== 'string' || command.length === 0) {
      console.warn(`[mcp] Native server "${name}" missing command.`)
      return null
    }
    const config: NexusMcpServerLaunchConfig = {
      transport: 'stdio',
      command: normalizeNativeCommand(command),
    }
    const args = stringArray(candidate.args)
    const env = stringRecord(candidate.env)
    if (args) config.args = args
    if (env) config.env = env
    if (typeof candidate.cwd === 'string' && candidate.cwd.length > 0) {
      config.cwd = candidate.cwd
    }
    return config
  }

  if (isHttp) {
    if (typeof url !== 'string' || url.length === 0) {
      console.warn(`[mcp] Native server "${name}" missing url.`)
      return null
    }
    const config: NexusMcpServerLaunchConfig = {
      transport: 'http',
      url,
    }
    const headers = stringRecord(candidate.headers)
    if (headers) config.headers = headers
    if (typeof candidate.cwd === 'string' && candidate.cwd.length > 0) {
      config.cwd = candidate.cwd
    }
    return config
  }

  console.warn(
    `[mcp] Native server "${name}" has unsupported transport type: ${String(transport)}. Only stdio and http are supported by the native MCP bridge.`,
  )
  return null
}

/**
 * Validate one MCP server entry. Returns the narrowed config or null
 * (logging a warning) for unsupported transports / missing url. Exported so
 * the plugin loader can validate inline `mcpServers` from a plugin manifest
 * with the same browser-transport rules.
 */
export function parseMCPServerConfig(
  name: string,
  raw: unknown,
): MCPServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  const url = candidate.url
  let type = candidate.type
  // An untyped url-bearing entry is remote (stdio is native-bridge only):
  // `websocket` for ws(s):// URLs, else `http`; sse must be explicit.
  if (type == null && typeof url === 'string' && url.length > 0) {
    type = /^wss?:\/\//i.test(url) ? 'websocket' : 'http'
  }
  if (typeof type !== 'string' || !REMOTE_TRANSPORT_KINDS.has(type)) {
    // A `command`-bearing entry is a stdio server — the cryptic
    // "transport type: undefined" hid the real reason it's dropped. Browsers
    // can't spawn subprocesses, so stdio servers can't run through this path;
    // point the user at a remote (url-based) server instead.
    if (typeof candidate.command === 'string' && candidate.command.length > 0) {
      console.warn(
        `[mcp] Server "${name}" is a command/stdio server, but this browser ` +
          `transport config path only supports url-based remote servers. ` +
          `Configure it as a native MCP server in Settings, or use a remote ` +
          `server with a "url" (http/sse/websocket), e.g. GitHub's remote MCP ` +
          `at https://api.githubcopilot.com/mcp/.`,
      )
    } else {
      console.warn(
        `[mcp] Server "${name}" has unsupported transport type: ${String(type)}. Only http, sse, ws/websocket are supported in the browser runtime.`,
      )
    }
    return null
  }
  // Normalize the config file's WebSocket literal ('ws') to nexus's internal
  // 'websocket' so the transport/type pipeline (which switches on
  // 'websocket') stays unchanged.
  const normalizedType = type === 'ws' ? 'websocket' : type
  if (typeof url !== 'string' || url.length === 0) {
    console.warn(`[mcp] Server "${name}" missing url.`)
    return null
  }
  const headers =
    candidate.headers && typeof candidate.headers === 'object'
      ? (candidate.headers as Record<string, string>)
      : undefined
  return { type: normalizedType as MCPServerConfig['type'], url, headers }
}

export async function loadMCPConfig(
  cwd: string,
  fs: RuntimeFs = processFs(),
): Promise<MCPServerConfigWithName[]> {
  const path = getMcpConfigPath(cwd)
  let raw: string
  try {
    raw = await fs.readFile(path, { encoding: 'utf-8' })
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[mcp] Failed to parse ${path}:`, err)
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const servers = (parsed as MCPServersConfigFile).mcpServers
  if (!servers || typeof servers !== 'object') return []
  const result: MCPServerConfigWithName[] = []
  for (const [name, value] of Object.entries(servers)) {
    const validated = parseMCPServerConfig(name, value)
    if (validated) result.push({ name, ...validated })
  }
  return result
}

export async function saveMCPConfig(
  cwd: string,
  servers: Record<string, MCPServerConfig>,
  fs: RuntimeFs = processFs(),
): Promise<void> {
  const path = getMcpConfigPath(cwd)
  try {
    await fs.mkdir(dirname(path))
  } catch {
    // directory may already exist
  }
  const content: MCPServersConfigFile = { mcpServers: servers }
  await fs.writeFile(path, JSON.stringify(content, null, 2), {
    encoding: 'utf-8',
  })
}
