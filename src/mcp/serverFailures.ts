/**
 * The MCP servers that failed to connect, as the prompt reports them (F-10):
 * each server's name and one bounded line of its error. Read from the pool at
 * every prompt render, so a server that reconnects drops out.
 * Security: an error can echo a launch command, URL or header. Credential-like
 * text is masked before the line is cut, so a cut cannot leave half a secret
 * that no longer matches a pattern.
 */
import type { MCPPool } from './pool'

export type McpServerFailure = { name: string; reason: string }

/** Longest reason line the prompt carries for one server, in characters. */
export const MCP_FAILURE_REASON_MAX_CHARS = 200

/** How much of a raw error is scanned at all; the rest is dropped unread. */
const SCAN_MAX_CHARS = 4000

const MASK = '[redacted]'

const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|credentials?|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*`

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // `key=value`, `key: value`, `"key": "value"`; an auth scheme before the value goes with it.
  [
    new RegExp(String.raw`(${SECRET_KEY}["']?\s*[=:]\s*)(["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"'&,;)]+\2`, 'gi'),
    `$1$2${MASK}$2`,
  ],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // `scheme://user:password@host`
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // JWTs, then long opaque runs (keys, hashes) that mix letters and digits.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, MASK],
]

/** `text` with credential-like substrings replaced by a mask. */
export function redactCredentialText(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** One masked line of a server's error, at most `MCP_FAILURE_REASON_MAX_CHARS`. */
export function summarizeMcpServerError(error: string | undefined): string {
  const scanned = (error ?? '').slice(0, SCAN_MAX_CHARS)
  const line = redactCredentialText(scanned.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim())
  if (line.length === 0) return 'connect failed'
  if (line.length <= MCP_FAILURE_REASON_MAX_CHARS) return line
  return `${line.slice(0, MCP_FAILURE_REASON_MAX_CHARS - 1).trimEnd()}…`
}

/** Every server in `status: 'failed'`, by name, with its summarized error. */
export function mcpServerFailuresFromPool(pool: Pick<MCPPool, 'listServers'>): McpServerFailure[] {
  const out: McpServerFailure[] = []
  for (const server of pool.listServers()) {
    if (server.status !== 'failed') continue
    out.push({ name: server.name, reason: summarizeMcpServerError(server.error) })
  }
  return out
}
