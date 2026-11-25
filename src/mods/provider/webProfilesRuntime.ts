/**
 * The realm's web profiles (`webProfiles.ts`) over the runtime's files
 * and its host port: the table is one JSON file in the runtime directory,
 * and a profile's session is deleted through `webWindow.deleteStoragePartition`.
 * Made at the first use; one per realm.
 */
import { createNativePrimitives } from '../../browser/bridge/nativePrimitives'
import { STORAGE_PARTITION_PRIMITIVE } from '../../browser/bridge/signInWindow'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { getMcpHost } from '../../mcp/mcpHost'
import { ensureDirRecursive } from '../../pluginHost/writeExtracted'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { WebProfiles } from './webProfiles'

export const WEB_PROFILES_FILE_NAME = 'web-profiles.json'

let instance: WebProfiles | undefined
let where: { homeDir: string; fs: RuntimeFs; report?: (line: string) => void } | undefined

const tablePath = (homeDir: string): string =>
  `${joinRuntimePath(homeDir, RUNTIME_DIR_NAME).replace(/\\/g, '/')}/${WEB_PROFILES_FILE_NAME}`

const hostKeepsProfiles = (): boolean => {
  const manifest = getMcpHost()?.manifest
  return (
    manifest?.capabilities?.includes('webWindow') === true
    && manifest.primitives?.includes(STORAGE_PARTITION_PRIMITIVE) === true
  )
}

export function runtimeWebProfiles(options: {
  homeDir: string
  fs: RuntimeFs
  report?: (line: string) => void
}): WebProfiles {
  where ??= options
  const { fs } = options
  const path = tablePath(options.homeDir)
  const dir = path.slice(0, path.lastIndexOf('/'))
  instance ??= new WebProfiles({
    load: async () => (fs.existsSync(path) ? fs.readFile(path, { encoding: 'utf8' }) : null),
    save: async text => {
      await ensureDirRecursive(fs, dir)
      await fs.writeFile(path, text, { encoding: 'utf8' })
    },
    hostKeepsProfiles,
    deletePartition: async id => {
      const host = getMcpHost()
      if (!host || !hostKeepsProfiles()) {
        const error = new Error('web profiles: this Velloc cannot keep web profiles')
        error.name = 'NotSupportedError'
        throw error
      }
      const primitives = createNativePrimitives({
        transport: host.transport,
        createRequestId: () => `web-profile-${crypto.randomUUID()}`,
        manifest: host.manifest,
      })
      await primitives.webWindow.deleteStoragePartition(id)
    },
    ...(options.report ? { report: options.report } : {}),
  })
  return instance
}

/**
 * A plugin was uninstalled: what it recorded in the web profiles goes, and a
 * profile left with nothing is deleted. Records are filed by plugin name, so
 * nothing goes while `stillInstalled` says a plugin of that name remains.
 * Never fails the uninstall; a table that was never written is left unwritten.
 */
export async function forgetPluginWebProfiles(
  options: {
    homeDir: string
    fs: RuntimeFs
    report?: (line: string) => void
    stillInstalled?: (plugin: string) => Promise<boolean>
  },
  plugin: string,
): Promise<void> {
  const path = tablePath(options.homeDir)
  try {
    if (!instance && !options.fs.existsSync(path)) return
    if (await options.stillInstalled?.(plugin)) return
    await runtimeWebProfiles(options).forgetPlugin(plugin)
  } catch (error) {
    options.report?.(`web profiles: could not clear what ${plugin} recorded: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The realm's profiles, made at the first use once the realm's provider
 *  runtime has said where they are kept; undefined before that. */
export function currentWebProfiles(): WebProfiles | undefined {
  return instance ?? (where ? runtimeWebProfiles(where) : undefined)
}

/** Where the realm keeps its profiles; the provider runtime says so when made. */
export function keepWebProfilesAt(options: { homeDir: string; fs: RuntimeFs; report?: (line: string) => void }): void {
  where = options
}

/** Test seam. */
export function setWebProfilesForTests(next: WebProfiles | undefined): void {
  instance = next
  where = undefined
}
