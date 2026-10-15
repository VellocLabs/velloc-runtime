/**
 * Security: provider plugin consent. A plugin declaring `providers` installs
 * DISABLED; its providers register only when the consent baseline on file
 * covers the grant its manifest declares now, whatever its enabled flag says.
 * A version that asks for more is unapproved until the person consents again.
 * Hand-placed directory plugins are exempt.
 */
import type { ProviderManifest } from '../mods/provider/providerManifest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { setPluginEnabled } from './enabledPlugins'
import { grantOf, widened, type Grant } from './providerGrant'
import { providerModUpdatesFilePath, type PluginInstallPathContext } from './pluginDirs'

/** Whether a parsed plugin.json declares at least one provider. */
export function manifestDeclaresProviders(manifest: unknown): boolean {
  const providers = (manifest as { providers?: unknown } | null)?.providers
  return !!providers && typeof providers === 'object' && !Array.isArray(providers) && Object.keys(providers).length > 0
}

/** Install-time hold: disable `identifier` when its manifest declares providers. */
export async function holdProviderPluginForConsent(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  identifier: string,
  manifest: unknown,
): Promise<boolean> {
  if (!manifestDeclaresProviders(manifest)) return false
  // Installing again a plugin the person already approved keeps it as it is,
  // unless this version asks for more than they approved.
  if (await consentCovers(ctx, fs, identifier, manifest)) return false
  await setPluginEnabled({ homeDir: ctx.homeDir }, fs, identifier, false)
  return true
}

/** The plugin ids (`<name>@<catalog>`) that have a consent baseline on file. */
export async function readConsentedPluginIds(ctx: PluginInstallPathContext, fs: RuntimeFs): Promise<Set<string>> {
  return new Set((await readConsentedGrants(ctx, fs)).keys())
}

/** The grant each plugin id with a consent baseline on file was approved for. */
export async function readConsentedGrants(ctx: PluginInstallPathContext, fs: RuntimeFs): Promise<Map<string, Grant>> {
  try {
    const raw = String(await fs.readFile(providerModUpdatesFilePath(ctx), { encoding: 'utf-8' }))
    const plugins = (JSON.parse(raw) as { plugins?: Record<string, { consent?: { grant?: Grant } }> } | null)?.plugins ?? {}
    const out = new Map<string, Grant>()
    for (const [id, record] of Object.entries(plugins)) {
      if (record?.consent === undefined) continue
      out.set(id, record.consent.grant ?? { providers: {} })
    }
    return out
  } catch {
    return new Map()
  }
}

/**
 * Security: whether the consent on file for `identifier` covers what
 * `manifest` declares now. No baseline, a manifest whose grant cannot be
 * read, or a grant wider than the one approved: not covered.
 */
export async function consentCovers(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  identifier: string,
  manifest: unknown,
): Promise<boolean> {
  const approved = (await readConsentedGrants(ctx, fs)).get(identifier)
  if (approved === undefined) return false
  const providers = (manifest as { providers?: Record<string, ProviderManifest> } | null)?.providers ?? {}
  try {
    return !widened(approved, grantOf(providers)).widened
  } catch {
    return false
  }
}
