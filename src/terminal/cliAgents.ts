/**
 * The coding-agent CLIs a CLI session runs (F-34): how each starts or
 * continues a conversation, and whether the host has it.
 *
 * Security: started from this table by CLI id only (the host resolves it
 * against its allowlist); the one varying argument, a conversation id, is
 * runtime-minted or read from session metadata and must be a UUID.
 */
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import { createNativePrimitives } from '../browser/bridge/nativePrimitives'
import type { TerminalHost } from './TerminalService'

export const CLI_AGENT_IDS = ['claude', 'codex'] as const
export type CliAgentId = (typeof CLI_AGENT_IDS)[number]

export function isCliAgentId(value: unknown): value is CliAgentId {
  return typeof value === 'string' && (CLI_AGENT_IDS as readonly string[]).includes(value)
}

/** Digits per hyphen-separated group of a canonical UUID, the shape `crypto.randomUUID` returns. */
const UUID_GROUP_DIGITS = [8, 4, 4, 4, 12] as const
const HEX_DIGITS = /^[0-9a-fA-F]+$/

/** A conversation id is a canonical UUID: five hex groups of 8, 4, 4, 4 and 12 digits. */
export function isConversationId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const groups = value.split('-')
  return (
    groups.length === UUID_GROUP_DIGITS.length &&
    groups.every((group, index) => group.length === UUID_GROUP_DIGITS[index] && HEX_DIGITS.test(group))
  )
}

/** True when the runtime picks the conversation id at start; false when the CLI picks it and it is found later. */
export const CLI_ASSIGNS_CONVERSATION_ID: Record<CliAgentId, boolean> = {
  claude: true,
  codex: false,
}

/** The conversation a start names: a fresh one with a known id, or one to resume. */
export type CliConversation = { id: string; resume: boolean }

/** What `shell.spawn` runs for a CLI: the tool id, plus the conversation to start or resume. */
export function cliAgentArgv(
  cli: CliAgentId,
  conversation: CliConversation | null,
): { file: string; args: string[] } {
  if (conversation && !isConversationId(conversation.id)) {
    throw new Error(`cli: '${conversation.id}' is not a conversation id`)
  }
  switch (cli) {
    case 'claude':
      if (!conversation) return { file: 'claude', args: [] }
      return {
        file: 'claude',
        args: conversation.resume ? ['--resume', conversation.id] : ['--session-id', conversation.id],
      }
    case 'codex':
      return {
        file: 'codex',
        args: conversation?.resume ? ['resume', conversation.id] : [],
      }
  }
}

/** The environment a probe reads: the host's platform and three variables. */
export type CliProbeEnv = {
  platform: string
  path: string | null
  home: string | null
  appData: string | null
}

const WINDOWS_EXTENSIONS = ['.exe', '.cmd'] as const

function joinPath(dir: string, name: string, windows: boolean): string {
  const sep = windows ? '\\' : '/'
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}${sep}${name}`
}

/**
 * Where the host resolver would find `cli`: every `PATH` directory, then the
 * installers' default directories (`~/.local/bin`; `%APPDATA%\npm` on Windows).
 */
export function cliCandidatePaths(cli: CliAgentId, env: CliProbeEnv): string[] {
  const windows = env.platform === 'win32'
  const dirs = (env.path ?? '')
    .split(windows ? ';' : ':')
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(dir => dir.length > 0)
  if (env.home) dirs.push(joinPath(joinPath(env.home, '.local', windows), 'bin', windows))
  if (windows && env.appData) dirs.push(joinPath(env.appData, 'npm', windows))
  const names = windows ? WINDOWS_EXTENSIONS.map(ext => `${cli}${ext}`) : [cli]
  return dirs.flatMap(dir => names.map(name => joinPath(dir, name, windows)))
}

/** The CLIs with at least one candidate that `isFile` accepts, in table order. */
export function cliAgentsFound(env: CliProbeEnv, isFile: (path: string) => boolean): CliAgentId[] {
  return CLI_AGENT_IDS.filter(cli => cliCandidatePaths(cli, env).some(isFile))
}

const STAT_BATCH_LIMIT = 2000

/**
 * Which CLIs the host has, by file lookups only (`shell.env`, `fs.systemInfo`,
 * one `fs.statBatch`) — nothing is launched. An older host without
 * `shell.env` reports none.
 */
export async function probeCliAgents(
  host: TerminalHost,
  createRequestId: () => string,
): Promise<CliAgentId[]> {
  const transport = host.transport
  if (!transport || !(host.manifest?.primitives?.includes('shell.env') ?? false)) return []
  const primitives = createNativePrimitives({
    transport,
    createRequestId,
    manifest: host.manifest ?? undefined,
  })
  const [values, info] = await Promise.all([
    primitives.shell.env(['PATH', 'USERPROFILE', 'HOME', 'APPDATA']),
    transport.request({ id: createRequestId(), route: createBridgeRoute('fs', 'systemInfo'), payload: {} }),
  ])
  const platform = info.ok && typeof info.result.platform === 'string' ? info.result.platform : ''
  const env: CliProbeEnv = {
    platform,
    path: values.PATH ?? null,
    home: (platform === 'win32' ? values.USERPROFILE : values.HOME) ?? null,
    appData: values.APPDATA ?? null,
  }
  const paths = [...new Set(CLI_AGENT_IDS.flatMap(cli => cliCandidatePaths(cli, env)))].slice(
    0,
    STAT_BATCH_LIMIT,
  )
  if (paths.length === 0) return []
  const stats = await transport.request({
    id: createRequestId(),
    route: createBridgeRoute('fs', 'statBatch'),
    payload: { paths },
  })
  if (!stats.ok) return []
  const files = new Set(
    stats.result.filter(row => row.stat?.isFile === true).map(row => row.path),
  )
  return cliAgentsFound(env, path => files.has(path))
}

/** A stored `cliConversation` metadata value, or undefined when it is not one. */
export function parseCliConversation(
  value: unknown,
): { cli: CliAgentId; id: string | null } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { cli, id } = value as { cli?: unknown; id?: unknown }
  if (!isCliAgentId(cli)) return undefined
  if (id !== null && !isConversationId(id)) return undefined
  return { cli, id }
}
