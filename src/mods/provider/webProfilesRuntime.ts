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
import type { NexusProviderConfig, ProviderWebProfileRef } from '../../settings/settingsTypes'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { isFsNotFoundError } from '../../utils/fsTransportFailure'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { WebProfiles } from './webProfiles'

export const WEB_PROFILES_FILE_NAME = 'web-profiles.json'

let instance: WebProfiles | undefined
let where: { homeDir: string; fs: RuntimeFs; report?: (line: string) => void } | undefined

const tablePath = (homeDir: string): string =>
  `${joinRuntimePath(homeDir, RUNTIME_DIR_NAME).replace(/\\/g, '/')}/${WEB_PROFILES_FILE_NAME}`

/**
 * The table's text, or null when there is no file. Read, never probed with
 * `existsSync`: the browser's fs answers that with false for every path, and
 * a table taken for absent is overwritten by the next change.
 */
async function readTable(fs: RuntimeFs, path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, { encoding: 'utf8' })
  } catch (error) {
    if (isFsNotFoundError(error)) return null
    throw error
  }
}

const hostKeepsProfiles = (): boolean => {
  const manifest = getMcpHost()?.manifest
  return (
    manifest?.capabilities?.includes('webWindow') === true
    && manifest.primitives?.includes(STORAGE_PARTITION_PRIMITIVE) === true
  )
}

/** A table text already read from `fs` at `path`, served as the first load
 *  of the instance made over that same file. */
type ReadTable = { fs: RuntimeFs; path: string; text: string }

export function runtimeWebProfiles(
  options: {
    homeDir: string
    fs: RuntimeFs
    report?: (line: string) => void
  },
  alreadyRead?: ReadTable,
): WebProfiles {
  where ??= options
  const { fs } = options
  const path = tablePath(options.homeDir)
  const dir = path.slice(0, path.lastIndexOf('/'))
  let first = alreadyRead?.fs === fs && alreadyRead.path === path ? alreadyRead.text : undefined
  instance ??= new WebProfiles({
    load: () => {
      if (first === undefined) return readTable(fs, path)
      const text = first
      first = undefined
      return Promise.resolve(text)
    },
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

/** The table as read while no instance is made yet; undefined once one is;
 *  null: it was never written, so there is nothing to change. */
async function readUnlessMade(at: { homeDir: string; fs: RuntimeFs }): Promise<ReadTable | undefined | null> {
  if (instance) return undefined
  const path = tablePath(at.homeDir)
  const text = await readTable(at.fs, path)
  return text === null ? null : { fs: at.fs, path, text }
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
  try {
    const read = await readUnlessMade(options)
    if (read === null) return
    if (await options.stillInstalled?.(plugin)) return
    await runtimeWebProfiles(options, read).forgetPlugin(plugin)
  } catch (error) {
    options.report?.(`web profiles: could not clear what ${plugin} recorded: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * A provider's entry stopped being signed in through `through` (it signed
 * out, signed in elsewhere, or was removed). The site's account record goes
 * unless an entry of `configs`, the table as that write left it, is still
 * signed in through it. Never fails the write that reports it; a table that
 * was never written is left unwritten.
 */
export async function releaseWebProfileAccount(
  options: { homeDir: string; fs: RuntimeFs; report?: (line: string) => void },
  through: ProviderWebProfileRef,
  configs: Readonly<Record<string, NexusProviderConfig>>,
): Promise<void> {
  const report = options.report ?? where?.report
  try {
    if (Object.values(configs).some(config => config.webProfile?.id === through.id && config.webProfile.site === through.site)) return
    const at = where ?? options
    const read = await readUnlessMade(at)
    if (read === null) return
    await (instance ?? runtimeWebProfiles(at, read)).dropAccount(through.id, through.site)
  } catch (error) {
    report?.(
      `web profiles: could not drop the account of ${through.site} in ${through.id}: ${error instanceof Error ? error.message : String(error)}`,
    )
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
