import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'

function detectSeparator(value: string): '/' | '\\' {
  return value.includes('\\') && !value.includes('/') ? '\\' : '/'
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function trimLeadingSeparators(value: string): string {
  return value.replace(/^[\\/]+/, '')
}

export function joinPath(base: string, ...parts: string[]): string {
  const separator = detectSeparator(base)
  let result = trimTrailingSeparators(base)
  for (const part of parts) {
    const normalizedPart = trimLeadingSeparators(trimTrailingSeparators(part))
    if (!normalizedPart) continue
    if (!result) {
      result = normalizedPart
      continue
    }
    result += separator + normalizedPart
  }
  return result
}

export function dirname(path: string): string {
  const trimmed = trimTrailingSeparators(path)
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx <= 0) return trimmed
  return trimmed.slice(0, idx)
}

const NEXUS_DIR = RUNTIME_DIR_NAME
const MCP_CONFIG_FILE = 'mcp.json'
const MCP_AUTH_FILE = 'mcp-auth.json'

export function getMcpConfigPath(cwd: string): string {
  return joinPath(cwd, NEXUS_DIR, MCP_CONFIG_FILE)
}

export function getMcpAuthPath(cwd: string): string {
  return joinPath(cwd, NEXUS_DIR, MCP_AUTH_FILE)
}

export function getNexusDir(cwd: string): string {
  return joinPath(cwd, NEXUS_DIR)
}
