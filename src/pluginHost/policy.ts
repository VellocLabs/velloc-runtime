import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { readLayer } from '../settings/settingsStore'
import type { SettingsPathContext } from '../settings/settingsStore'

/**
 * True when managed settings set this plugin to `false` in `enabledPlugins`.
 * Such a plugin may not be installed or enabled at any scope.
 */
export async function policyForbidsPlugin(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  pluginId: string,
): Promise<boolean> {
  const { settings } = await readLayer('policySettings', ctx, fs)
  const policyEnabled = settings.enabledPlugins
  return policyEnabled?.[pluginId] === false
}
