/**
 * Erases a deleted CLI session's conversation from its CLI's own logs (F-34),
 * so the CLI no longer offers it to resume.
 *
 * Security: paths come from the host's home, the session's folder and a
 * validated conversation UUID; nothing a client sends names a file. Only that
 * conversation's log and its same-named folder are removed.
 */
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import type { BridgeFsTreeEntry } from '../browser/bridge/protocol/fs'
import { sourceRoot } from '../browser/bridge/adapter/sessionImportBridgeAdapter'
import { projectFolderKey } from '../utils/conversationStoragePaths'
import { joinRuntimePath } from '../utils/runtimePaths'
import { isConversationId, readCliProbeEnv, type CliAgentId } from './cliAgents'
import { cliLogSource } from './cliLogs'
import type { TerminalHost } from './TerminalService'

/** How deep a dated log tree is searched for a conversation's log. */
const DATED_LOG_DEPTH = 4

/** A failed removal is tried once more after this, for a CLI that was still closing its log. */
export const CLI_LOG_ERASE_RETRY_MS = 1_000

export type CliLogEraser = {
  /** Removes conversation `id`'s log, started in `cwd`. Never throws; resolves to the paths removed. */
  erase(cli: CliAgentId, where: { cwd: string; id: string }): Promise<string[]>
}

/** Whether `name` is the log file of conversation `id` in a dated log tree. */
export function isDatedLogOf(name: string, id: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? ''
  return base === `${id}.jsonl` || base.endsWith(`-${id}.jsonl`)
}

export function createBridgeCliLogEraser(
  host: () => TerminalHost,
  createRequestId: () => string,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): CliLogEraser {
  const request = async <T>(
    transport: BrowserBridgeTransport,
    action: 'readdirTree' | 'rm',
    payload: Record<string, unknown>,
  ): Promise<T | null> => {
    const response = await transport.request({
      id: createRequestId(),
      route: createBridgeRoute('fs', action),
      payload: payload as never,
    })
    return response.ok ? (response.result as T) ?? ({} as T) : null
  }
  const remove = async (transport: BrowserBridgeTransport, path: string, recursive: boolean): Promise<boolean> => {
    const once = () => request(transport, 'rm', { path, recursive, force: true }).catch(() => null)
    if ((await once()) !== null) return true
    await wait(CLI_LOG_ERASE_RETRY_MS)
    return (await once()) !== null
  }
  const present = async (transport: BrowserBridgeTransport, dir: string): Promise<BridgeFsTreeEntry[]> =>
    (await request<{ entries?: BridgeFsTreeEntry[] }>(transport, 'readdirTree', { path: dir, maxDepth: 1 }).catch(
      () => null,
    ))?.entries ?? []

  return {
    async erase(cli, where) {
      if (!isConversationId(where.id)) return []
      const transport = host().transport
      if (!transport) return []
      const env = await readCliProbeEnv(host(), createRequestId).catch(() => null)
      if (!env?.home) return []
      const root = sourceRoot(env.home, cliLogSource(cli))
      const targets: Array<{ path: string; recursive: boolean }> = []
      if (cli === 'codex') {
        const listed = await request<{ entries?: BridgeFsTreeEntry[] }>(transport, 'readdirTree', {
          path: root,
          maxDepth: DATED_LOG_DEPTH,
        }).catch(() => null)
        for (const entry of listed?.entries ?? []) {
          if (!entry.isDirectory && isDatedLogOf(entry.path, where.id)) {
            targets.push({ path: joinRuntimePath(root, ...entry.path.split(/[\\/]/)), recursive: false })
          }
        }
      } else {
        const dir = joinRuntimePath(root, projectFolderKey(where.cwd.replace(/[\\/]+$/, '')))
        for (const entry of await present(transport, dir)) {
          if (entry.path === `${where.id}.jsonl` && !entry.isDirectory) {
            targets.push({ path: joinRuntimePath(dir, entry.path), recursive: false })
          } else if (entry.path === where.id && entry.isDirectory) {
            targets.push({ path: joinRuntimePath(dir, entry.path), recursive: true })
          }
        }
      }
      const removed: string[] = []
      for (const target of targets) {
        if (await remove(transport, target.path, target.recursive)) removed.push(target.path)
      }
      return removed
    },
  }
}
