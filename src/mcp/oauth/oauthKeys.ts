/**
 * Identity of a remote MCP server for sign-in (F-10): the same URL from a
 * plugin and from settings.json shares one sign-in. The key is a short hash
 * of the normalized URL so it fits the host's secret-name alphabet.
 */
import type { BridgeSecretName } from '../../browser/bridge/protocol/secrets'

/**
 * Origin + path, lower-case host, no trailing slash, no query or fragment.
 * Null for a URL that is not http(s).
 */
export function normalizeMcpServerUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host.toLowerCase()}${path}`
}

/** FNV-1a 64-bit of `text`, as 16 hex characters. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const bytes = new TextEncoder().encode(text)
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/** The sign-in key of a server URL, or null when the URL is not http(s). */
export function mcpOAuthKey(rawUrl: string): string | null {
  const normalized = normalizeMcpServerUrl(rawUrl)
  return normalized ? fnv1a64(normalized) : null
}

/** Host secret names of one sign-in. Security: values never return to the runtime. */
export function mcpOAuthSecretNames(key: string): {
  access: BridgeSecretName
  refresh: BridgeSecretName
  clientSecret: BridgeSecretName
} {
  return {
    access: `mcp:oauth/${key}/access`,
    refresh: `mcp:oauth/${key}/refresh`,
    clientSecret: `mcp:oauth/${key}/client`,
  }
}

/** A request header value that the host fills with a stored secret. */
export function secretPlaceholder(name: BridgeSecretName): string {
  return `{{secret:${name}}}`
}
