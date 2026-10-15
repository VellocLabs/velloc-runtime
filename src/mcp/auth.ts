import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { dirname, getMcpAuthPath } from './paths'
import type { MCPAuthStore, MCPOAuthTokens } from './types'

async function readAuthStore(
  cwd: string,
  fs: RuntimeFs,
): Promise<MCPAuthStore> {
  const path = getMcpAuthPath(cwd)
  let raw: string
  try {
    raw = await fs.readFile(path, { encoding: 'utf-8' })
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as MCPAuthStore
  } catch (err) {
    console.warn(`[mcp] Failed to parse auth store ${path}:`, err)
  }
  return {}
}

async function writeAuthStore(
  cwd: string,
  store: MCPAuthStore,
  fs: RuntimeFs,
): Promise<void> {
  const path = getMcpAuthPath(cwd)
  try {
    await fs.mkdir(dirname(path))
  } catch {
    // directory may already exist
  }
  await fs.writeFile(path, JSON.stringify(store, null, 2), {
    encoding: 'utf-8',
  })
}

export async function getStoredTokens(
  cwd: string,
  serverName: string,
  fs: RuntimeFs = processFs(),
): Promise<MCPOAuthTokens | undefined> {
  const store = await readAuthStore(cwd, fs)
  return store[serverName]
}

export async function setStoredTokens(
  cwd: string,
  serverName: string,
  tokens: MCPOAuthTokens,
  fs: RuntimeFs = processFs(),
): Promise<void> {
  const store = await readAuthStore(cwd, fs)
  store[serverName] = tokens
  await writeAuthStore(cwd, store, fs)
}

export async function clearStoredTokens(
  cwd: string,
  serverName: string,
  fs: RuntimeFs = processFs(),
): Promise<void> {
  const store = await readAuthStore(cwd, fs)
  if (!(serverName in store)) return
  delete store[serverName]
  await writeAuthStore(cwd, store, fs)
}

export function isTokenExpired(
  tokens: MCPOAuthTokens,
  skewSeconds = 30,
): boolean {
  if (!tokens.expires_at) return false
  return Date.now() >= tokens.expires_at - skewSeconds * 1000
}

export function buildAuthHeaders(
  tokens: MCPOAuthTokens | undefined,
): Record<string, string> {
  if (!tokens) return {}
  const scheme = tokens.token_type ?? 'Bearer'
  return { Authorization: `${scheme} ${tokens.access_token}` }
}
