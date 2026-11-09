/**
 * Security: plugin consent. A plugin declaring `providers`, or folders or
 * agent runs for an app's background module, installs DISABLED; its providers
 * register and its modules reach those folders or run the agent only when the
 * consent baseline on file covers the grant its manifest declares now,
 * whatever its enabled flag says. A version that asks for more is unapproved
 * until the person consents again.
 * Hand-placed directory plugins are exempt.
 */
import { manifestAsksAgent } from '../mods/app/appAgentRun'
import { folderScopesOf } from '../mods/app/appFolderScopes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { UpdateChannel } from '../branding/updateChannels'
import { setPluginEnabled } from './enabledPlugins'
import { checkPluginDescriptor } from './manifestValidator'
import { pluginGrantOf, widened, type Grant } from './providerGrant'
import { providerModUpdatesFilePath, type PluginInstallPathContext } from './pluginDirs'

/** Whether a parsed plugin.json declares at least one provider. */
export function manifestDeclaresProviders(manifest: unknown): boolean {
  const providers = (manifest as { providers?: unknown } | null)?.providers
  return !!providers && typeof providers === 'object' && !Array.isArray(providers) && Object.keys(providers).length > 0
}

/**
 * A parsed plugin.json with its `templates` as this channel's manifest check
 * keeps them: an app the channel leaves out declares no folders or agent runs.
 */
function withChannelTemplates(manifest: unknown, channel?: UpdateChannel): unknown {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest
  const checked = checkPluginDescriptor(manifest, channel).manifest
  return { ...(manifest as Record<string, unknown>), templates: checked?.templates }
}

/** Whether a parsed plugin.json declares anything the person consents to: providers, or folders or agent runs of an app this channel runs. */
export function manifestNeedsConsent(manifest: unknown, channel?: UpdateChannel): boolean {
  if (manifestDeclaresProviders(manifest)) return true
  const apps = withChannelTemplates(manifest, channel)
  return folderScopesOf(apps) !== undefined || manifestAsksAgent(apps)
}

/** Install-time hold: disable `identifier` when its manifest declares providers, folders or agent runs. */
export async function holdProviderPluginForConsent(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  identifier: string,
  manifest: unknown,
): Promise<boolean> {
  if (!manifestNeedsConsent(manifest)) return false
  // Installing again a plugin the person already approved keeps it as it is,
  // unless this version asks for more than they approved.
  if (await consentCovers(ctx, fs, identifier, withChannelTemplates(manifest))) return false
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
  try {
    return !widened(approved, pluginGrantOf(manifest)).widened
  } catch {
    return false
  }
}
