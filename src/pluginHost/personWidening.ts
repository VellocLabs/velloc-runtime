/**
 * Security: hosts a PERSON added to a provider mod's boundary (F-27), by
 * pointing its base URL outside the manifest's `domains` and confirming it.
 * They live in the plugin's update record beside the consent baseline and are
 * never part of it: an update is still compared with what the manifest
 * declares, and a switch of version leaves them in place.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { PluginInstallPathContext } from './pluginDirs'
import { isPlainHostName } from '../mods/provider/providerBaseUrlRule'
import { readUpdateStateFile, writeUpdateStateFile } from './providerModUpdateState'

/** What the person added, by provider key. */
export type PersonAdded = {
  providers: Record<string, { domains: string[] }>
}

type RecordWithPersonAdded = { personAdded?: PersonAdded }
function normalizedHost(host: string): string {
  const name = host.trim().toLowerCase()
  if (!isPlainHostName(name)) throw new Error(`"${host}" is not a plain host name`)
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

/** The hosts on file that the person added for one provider of `pluginId`. */
export async function readPersonHosts(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  pluginId: string,
  providerKey: string,
): Promise<string[]> {
  const state = await readUpdateStateFile<RecordWithPersonAdded>(ctx, fs, false)
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
  const state = await readUpdateStateFile<RecordWithPersonAdded>(ctx, fs, true)
  const record = (state.plugins[pluginId] ??= {})
  if (addPersonHost(record, providerKey, host)) await writeUpdateStateFile(ctx, fs, state)
}
