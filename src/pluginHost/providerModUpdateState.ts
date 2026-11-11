/**
 * Contract: the one reader and writer of `~/.velloc/plugins/provider_mod_updates.json`.
 * A missing file reads as empty. For a write, an unreadable or malformed file
 * throws instead of being replaced; for a read it reads as empty.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { ensureDirRecursive } from './writeExtracted'
import { pluginsRoot, providerModUpdatesFilePath, type PluginInstallPathContext } from './pluginDirs'

export type UpdateStateFileOf<R> = { version: 1; plugins: Record<string, R> }

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function readUpdateStateFile<R>(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  forWrite: boolean,
): Promise<UpdateStateFileOf<R>> {
  let raw: string
  try {
    raw = String(await fs.readFile(providerModUpdatesFilePath(ctx), { encoding: 'utf-8' }))
  } catch (error) {
    if (/ENOENT|not found|no such file/i.test(failureText(error))) return { version: 1, plugins: {} }
    if (forWrite) throw new Error(`provider_mod_updates.json is unreadable (${failureText(error)}); refusing to overwrite it`)
    return { version: 1, plugins: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateStateFileOf<R>> | null
    if (parsed && parsed.version === 1 && parsed.plugins && typeof parsed.plugins === 'object') {
      return { version: 1, plugins: parsed.plugins as Record<string, R> }
    }
    throw new Error('not an update state file')
  } catch (error) {
    if (forWrite) throw new Error(`provider_mod_updates.json is malformed (${failureText(error)}); refusing to overwrite it. Fix or delete the file.`)
    return { version: 1, plugins: {} }
  }
}

export async function writeUpdateStateFile<R>(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  state: UpdateStateFileOf<R>,
): Promise<void> {
  await ensureDirRecursive(fs, pluginsRoot(ctx))
  await fs.writeFile(providerModUpdatesFilePath(ctx), `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8' })
}
