/**
 * What an MCP server says about its sign-in before any is attempted (F-10):
 * an unauthenticated `initialize` and the `WWW-Authenticate` challenge of
 * its 401.
 */
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * The client ID metadata document a sign-in names as its `client_id` where
 * the authorization server accepts one; served from `public/oauth/client.json`.
 */
export const MCP_OAUTH_CLIENT_METADATA_URL = 'https://app.velloc.app/oauth/client.json'

/** The answer to an unauthenticated `initialize`. */
export type McpServerChallenge = {
  status: number
  /** From a `Bearer` challenge: where the protected-resource metadata is. */
  resourceMetadataUrl?: string
  /** From a `Bearer` challenge: the scope the server asks for. */
  scope?: string
}

const AUTH_PARAM = /([A-Za-z][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g

/** The parameters of the `Bearer` challenge in a `WWW-Authenticate` value. */
export function parseBearerChallenge(header: string | null | undefined): Record<string, string> | null {
  if (!header) return null
  const start = header.search(/(^|[\s,])Bearer(\s|,|$)/i)
  if (start < 0) return null
  let rest = header.slice(start).replace(/^[\s,]*Bearer/i, '')
  // Another scheme (`, Scheme param=`) ends this challenge.
  const next = rest.search(/,\s*[A-Za-z][\w-]*\s+[A-Za-z][\w-]*\s*=/)
  if (next >= 0) rest = rest.slice(0, next)
  const params: Record<string, string> = {}
  for (const match of rest.matchAll(AUTH_PARAM)) {
    const name = match[1]!.toLowerCase()
    if (!(name in params)) params[name] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!
  }
  return params
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Sends `initialize` with no credentials and reads the challenge. Throws when unreachable. */
export async function probeMcpServer(url: string, fetchFn: FetchLike): Promise<McpServerChallenge> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Velloc', version: '0' } },
    }),
  })
  void response.body?.cancel().catch(() => {})
  const challenge: McpServerChallenge = { status: response.status }
  if (response.status !== 401) return challenge
  const bearer = parseBearerChallenge(response.headers.get('www-authenticate'))
  const resourceMetadataUrl = httpUrl(bearer?.resource_metadata)
  if (resourceMetadataUrl) challenge.resourceMetadataUrl = resourceMetadataUrl
  if (bearer?.scope) challenge.scope = bearer.scope
  return challenge
}
