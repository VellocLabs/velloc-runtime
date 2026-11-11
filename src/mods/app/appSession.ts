/**
 * An app session's folder (F-40): `shared-workspace/app-<appId>`, created and
 * seeded before the session reads its project instructions, so the seed's
 * `AGENTS.md` is the app's own. A seed that fails refuses the session with
 * `plugin_app_seed`; the engine is not built.
 */

import { getNexusAppDir } from '../../utils/conversationStoragePaths'
import type { AppTemplate } from '../ui/contributionsHost'
import { PluginTemplateUnavailableError } from '../ui/pluginTemplateSession'
import type { PluginAppDecl } from '../ui/uiManifest'
import { seedAppFolder, type AppSeedFs, type AppSeedResult } from './appSeed'

/** What an app session knows about its app. */
export type AppSessionInfo = {
  appId: string
  plugin: string
  /** The app's folder, the session's project root. */
  folder: string
  decl: PluginAppDecl
  seed: AppSeedResult
  /** The plugin's directory, absolute: where its language files are. */
  root?: string
}

export async function openAppFolder(args: {
  fs: AppSeedFs
  homeDir: string | undefined
  app: AppTemplate
}): Promise<AppSessionInfo> {
  const { fs, homeDir, app } = args
  if (!homeDir) {
    throw new PluginTemplateUnavailableError('plugin_app_seed', `The app ${app.appId} has no home folder to live in.`)
  }
  const folder = getNexusAppDir(homeDir, app.appId)
  try {
    await fs.mkdir(folder)
    const seed = await seedAppFolder({
      fs,
      seedDir: app.seedDir,
      appDir: folder,
      appId: app.appId,
      plugin: app.plugin,
      seedVersion: app.decl.seedVersion,
    })
    return { appId: app.appId, plugin: app.plugin, folder, decl: app.decl, seed, ...(app.root !== undefined ? { root: app.root } : {}) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new PluginTemplateUnavailableError('plugin_app_seed', `The app ${app.appId} could not set up its folder: ${reason}`)
  }
}
