/**
 * Security: hosts a PERSON added to a provider mod's boundary (F-27), by
 * pointing its base URL outside the manifest's `domains` and confirming it.
 * They live in the plugin's update record beside the consent baseline and are
 * never part of it: an update is still compared with what the manifest
 * declares, and a switch of version leaves them in place.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { ensureDirRecursive } from './writeExtracted'
import { pluginsRoot, providerModUpdatesFilePath, type PluginInstallPathContext } from './pluginDirs'

/** What the person added, by provider key. */
export type PersonAdded = {
  providers: Record<string, { domains: string[] }>
}

type RecordWithPersonAdded = { personAdded?: PersonAdded }
type StateFile = { version: 1; plugins: Record<string, RecordWithPersonAdded> }

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

function normalizedHost(host: string): string {
  const name = host.trim().toLowerCase()
  if (!HOST.test(name) || name.length > 253) throw new Error(`"${host}" is not a plain host name`)
  return name
}

/** The hosts the person added for one provider (lower case, sorted). */
export function personHostsOf(record: RecordWithPersonAdded | undefined, providerKey: string): string[] {
  const domains = record?.personAdded?.providers?.[providerKey]?.domains
  return Array.isArray(domains) ? domains.filter(entry => typeof entry === 'string') : []
}

/** Add `host` to what the person added for `providerKey`. True when it was new. */
export function addPersonHost(record: RecordWithPersonAdded, providerKey: string, host: string): boolean {
  const name = normalizedHost(host)
  const current = personHostsOf(record, providerKey)
  if (current.includes(name)) return false
  const providers = { ...(record.personAdded?.providers ?? {}) }
  providers[providerKey] = { domains: [...current, name].sort() }
  record.personAdded = { providers }
  return true
}

async function readStateFile(ctx: PluginInstallPathContext, fs: RuntimeFs, forWrite: boolean): Promise<StateFile> {
  let raw: string
  try {
    raw = String(await fs.readFile(providerModUpdatesFilePath(ctx), { encoding: 'utf-8' }))
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!forWrite || /ENOENT|not found|no such file/i.test(text)) return { version: 1, plugins: {} }
    throw new Error(`provider_mod_updates.json is unreadable (${text}); refusing to overwrite it`)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateFile> | null
    if (parsed && parsed.version === 1 && parsed.plugins && typeof parsed.plugins === 'object') {
      return { version: 1, plugins: parsed.plugins }
    }
  } catch {
    // Falls through to the refusal below.
  }
  if (forWrite) throw new Error('provider_mod_updates.json is malformed; refusing to overwrite it. Fix or delete the file.')
  return { version: 1, plugins: {} }
}

/** The hosts on file that the person added for one provider of `pluginId`. */
export async function readPersonHosts(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  pluginId: string,
  providerKey: string,
): Promise<string[]> {
  const state = await readStateFile(ctx, fs, false)
  return personHostsOf(state.plugins[pluginId], providerKey)
}

/**
 * Record a host with no update service running (no plugin has a grant to
 * follow, so nothing else writes the file). With a service, use its
 * `addPersonHost`, which is serialized with its other writes.
 */
export async function storePersonHost(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  pluginId: string,
  providerKey: string,
  host: string,
): Promise<void> {
  const state = await readStateFile(ctx, fs, true)
  const record = (state.plugins[pluginId] ??= {})
  if (!addPersonHost(record, providerKey, host)) return
  await ensureDirRecursive(fs, pluginsRoot(ctx))
  await fs.writeFile(providerModUpdatesFilePath(ctx), `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8' })
}
