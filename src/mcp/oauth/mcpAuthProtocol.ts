/**
 * MCP server sign-in on the runtime protocol (F-10). Clients read topic
 * `mcpAuth/status` (`manager`: it names the person's servers) and ask:
 * - `mcpAuth.signIn` at `full`: it opens a sign-in window on the host desktop
 *   and may carry a client secret;
 * - `mcpAuth.cancel` / `mcpAuth.signOut` at `manager`.
 * The flow itself, every host call and every token stay in the runtime.
 */
import type { ScopeMode } from '../../browser/runtimeProtocol'

export const MCP_AUTH_CAPABILITY = 'mcpAuth'
export const MCP_AUTH_STATUS_TOPIC = 'mcpAuth/status'
/** The `type` of the snapshot and of every delta. */
export const MCP_AUTH_STATUS_EVENT = 'state'

export const MCP_AUTH_ACTION_SCOPES = {
  signIn: 'full',
  cancel: 'manager',
  signOut: 'manager',
} as const satisfies Record<string, ScopeMode>
export type McpAuthAction = keyof typeof MCP_AUTH_ACTION_SCOPES

export const MCP_AUTH_PHASES = ['needs-sign-in', 'signing-in', 'signed-in'] as const
export type McpAuthPhase = (typeof MCP_AUTH_PHASES)[number]

/** One server that asked for, is going through, or holds a sign-in. */
export type McpAuthServerState = {
  /** The normalized server URL (`normalizeMcpServerUrl`). */
  url: string
  phase: McpAuthPhase
  /** Its authorization server registers no clients: sign-in needs a client
   *  id the person registered, with `redirectUri` as its redirect. */
  needsClient?: boolean
  redirectUri?: string
  /** Why the last sign-in did not finish, one line. */
  lastError?: string
}

/**
 * The whole state, published on every change. `available` is false while the
 * runtime cannot run a sign-in (no service, or a host without the window
 * redirect capture, form secrets or the secret store).
 */
export type McpAuthState = {
  available: boolean
  servers: McpAuthServerState[]
}

export type McpAuthSignInPayload = { url: string; clientId?: string; clientSecret?: string }
export type McpAuthServerPayload = { url: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

const MAX_URL_CHARS = 2000
const MAX_CLIENT_FIELD_CHARS = 4096

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isMcpAuthSignInPayload(value: unknown): value is McpAuthSignInPayload {
  if (!isPlainObject(value) || !onlyKeys(value, ['url', 'clientId', 'clientSecret'])) return false
  if (!isBoundedString(value.url, MAX_URL_CHARS)) return false
  if (value.clientId !== undefined && !isBoundedString(value.clientId, MAX_CLIENT_FIELD_CHARS)) return false
  if (value.clientSecret !== undefined) {
    if (!isBoundedString(value.clientSecret, MAX_CLIENT_FIELD_CHARS)) return false
    if (value.clientId === undefined) return false
  }
  return true
}

export function isMcpAuthServerPayload(value: unknown): value is McpAuthServerPayload {
  return isPlainObject(value) && onlyKeys(value, ['url']) && isBoundedString(value.url, MAX_URL_CHARS)
}

/** A payload from the topic that is the shape a page reads, or null. */
export function readMcpAuthState(value: unknown): McpAuthState | null {
  if (!isPlainObject(value) || typeof value.available !== 'boolean' || !Array.isArray(value.servers)) return null
  const servers: McpAuthServerState[] = []
  for (const raw of value.servers) {
    if (!isPlainObject(raw) || typeof raw.url !== 'string') return null
    if (typeof raw.phase !== 'string' || !(MCP_AUTH_PHASES as readonly string[]).includes(raw.phase)) return null
    const server: McpAuthServerState = { url: raw.url, phase: raw.phase as McpAuthPhase }
    if (raw.needsClient === true) server.needsClient = true
    if (typeof raw.redirectUri === 'string') server.redirectUri = raw.redirectUri
    if (typeof raw.lastError === 'string') server.lastError = raw.lastError
    servers.push(server)
  }
  return { available: value.available, servers }
}
