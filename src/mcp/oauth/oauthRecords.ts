/**
 * What the runtime remembers about MCP server sign-ins (F-10), in
 * `~/.velloc/mcp-oauth.json`, keyed by `mcpOAuthKey`. Security: no token or
 * client secret is ever written here — those live in the host secret store
 * (`mcpOAuthSecretNames`); this file holds only where they apply.
 */
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { NEXUS_DIR_NAME } from '../../settings/settingSources'
import { dirname, joinPath } from '../paths'

export type McpOAuthClientRecord = {
  /** The authorization server the client id belongs to. */
  authServer: string
  clientId: string
  /** A client secret is stored under `mcpOAuthSecretNames(key).clientSecret`. */
  hasSecret?: boolean
  /** Registered by the runtime (dynamic registration), not typed by the person. */
  registered?: boolean
  /** The client id is the client ID metadata document's URL. */
  metadataDocument?: boolean
}

export type McpOAuthTokenRecord = {
  tokenEndpoint: string
  /** The server origin the access token secret is bound to. */
  accessOrigin: string
  resource?: string
  scope?: string
  /** Epoch ms; absent when the server gave no lifetime. */
  expiresAt?: number
  hasRefresh: boolean
  signedInAt: number
}

export type McpOAuthRecord = {
  /** The normalized server URL. */
  url: string
  /** The server asked for a sign-in (401, or OAuth resource metadata). */
  required?: boolean
  client?: McpOAuthClientRecord
  tokens?: McpOAuthTokenRecord
}

export type McpOAuthRecords = Record<string, McpOAuthRecord>

const FILE_NAME = 'mcp-oauth.json'

export function mcpOAuthRecordsPath(homeDir: string): string {
  return joinPath(homeDir, NEXUS_DIR_NAME, FILE_NAME)
}

function isRecord(value: unknown): value is McpOAuthRecord {
  return !!value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string'
}

/** The stored records; an absent or unreadable file is none. */
export async function readMcpOAuthRecords(homeDir: string, fs: RuntimeFs): Promise<McpOAuthRecords> {
  let raw: string
  try {
    raw = await fs.readFile(mcpOAuthRecordsPath(homeDir), { encoding: 'utf-8' })
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as { servers?: unknown }
    const out: McpOAuthRecords = {}
    if (parsed && typeof parsed.servers === 'object' && parsed.servers) {
      for (const [key, value] of Object.entries(parsed.servers as Record<string, unknown>)) {
        if (isRecord(value)) out[key] = value
      }
    }
    return out
  } catch (err) {
    console.warn('[mcp] unreadable sign-in records:', err instanceof Error ? err.message : err)
    return {}
  }
}

export async function writeMcpOAuthRecords(
  homeDir: string,
  fs: RuntimeFs,
  records: McpOAuthRecords,
): Promise<void> {
  const path = mcpOAuthRecordsPath(homeDir)
  try {
    await fs.mkdir(dirname(path))
  } catch {
    // directory may already exist
  }
  await fs.writeFile(path, JSON.stringify({ version: 1, servers: records }, null, 2), { encoding: 'utf-8' })
}
