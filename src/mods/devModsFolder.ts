/**
 * The session's dev mods folder (F-25): `<home>/.velloc/dev-mods/<sessionId>/`,
 * one plugin per child folder, loaded into this session alone once the person
 * turns it on. Scanned at each main-loop turn end; module edits inside a
 * loaded plugin are the runtime's dev loop, not this folder's.
 * Contract: `afterTurn` never rejects and never waits on the person — the
 * question runs beside the turns, and its answer loads the folder.
 */

import type { ActivePlugin } from '../pluginHost/pluginModel'
import type { RuntimeFsEntry } from '../utils/fs/runtimeFs'
import { getPluginManifestPath } from '../pluginHost/pluginPaths'

/** Where the folder stands for this session. */
export type DevModsState = 'unasked' | 'asking' | 'on' | 'declined' | 'off'

/** The person's answer; `dismissed` asks again at the next turn end. */
export type DevModsAnswer = 'on' | 'declined' | 'dismissed'

export type DevModsFolderOptions = {
  folder: string
  readdir(path: string): Promise<RuntimeFsEntry[]>
  /** A file's modification time, or undefined when it is not there. */
  mtime(path: string): Promise<number | undefined>
  join(base: string, ...segments: string[]): string
  /** The plugin in `dir`, or undefined when it does not assemble. */
  assemble(dir: string, folderName: string): Promise<ActivePlugin | undefined>
  /** Whether an installed plugin already has `name`: the installed one wins. */
  isInstalled?(name: string): boolean
  /** The session's permission mode as the engine reads it now. */
  permissionMode(): string
  /** Whether a page can be asked (an interactive session). */
  canAsk: boolean
  ask(pluginNames: readonly string[]): Promise<DevModsAnswer>
  /** The folder turned on without asking and loaded `pluginNames`: tell the
   *  person. Called again for each plugin it loads later, never twice for one. */
  notifyOn?(pluginNames: readonly string[]): void
  /** The folder's plugin set changed while on: reconcile the session's mods. */
  onPluginsChanged(): Promise<void>
  /** The folder's plugins were (re)loaded: write what sits beside them. */
  onLoaded?(plugins: readonly ActivePlugin[]): Promise<void>
  onStateChanged?(state: DevModsState): void
  report(line: string): void
}

/** The install id a dev-folder plugin is known by (`$.plugin`, settings). */
export const DEV_MODS_MARKETPLACE = 'dev'

/** Modes in which the folder turns on without asking (and says so). */
const UNASKED_ON_MODES: ReadonlySet<string> = new Set(['bypassPermissions'])
/** Modes in which nobody is asked and nothing loads. */
const NEVER_ASK_MODES: ReadonlySet<string> = new Set(['dontAsk'])

export type DevModsFolder = {
  readonly state: () => DevModsState
  /** The folder's plugins while on; empty otherwise. */
  plugins(): readonly ActivePlugin[]
  afterTurn(): Promise<void>
}

export function createDevModsFolder(options: DevModsFolderOptions): DevModsFolder {
  let state: DevModsState = 'unasked'
  let loaded: ActivePlugin[] = []
  let loadedKey = ''
  /** Turned on without asking: each newly loaded plugin is announced. */
  let onUnasked = false
  const announced = new Set<string>()

  const setState = (next: DevModsState): void => {
    if (state === next) return
    state = next
    options.onStateChanged?.(next)
  }

  /** Each child folder holding a manifest, with the times of its manifest
   *  and its `hooks/hooks.json` (which names the plugin's modules). */
  const scan = async (): Promise<Array<{ name: string; dir: string; mtime: string }>> => {
    let entries: RuntimeFsEntry[]
    try {
      entries = await options.readdir(options.folder)
    } catch {
      return []
    }
    const found = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const dir = options.join(options.folder, entry.name)
          const manifest = await options.mtime(getPluginManifestPath(dir)).catch(() => undefined)
          if (manifest === undefined) return undefined
          const hooks = await options.mtime(options.join(dir, 'hooks', 'hooks.json')).catch(() => undefined)
          return { name: entry.name, dir, mtime: `${manifest}/${hooks ?? '-'}` }
        }),
    )
    return found
      .filter((item): item is { name: string; dir: string; mtime: string } => item !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const load = async (folders: Awaited<ReturnType<typeof scan>>): Promise<void> => {
    const key = folders.map(f => `${f.name}:${f.mtime}`).join('|')
    if (key === loadedKey) return
    const plugins: ActivePlugin[] = []
    for (const folder of folders) {
      const plugin = await options.assemble(folder.dir, folder.name).catch(() => undefined)
      if (!plugin) {
        options.report(`dev mods: ${folder.dir} is not a plugin`)
        continue
      }
      if (plugins.some(other => other.name === plugin.name)) {
        options.report(`dev mods: ${folder.dir} repeats the plugin name ${plugin.name}; left out`)
        continue
      }
      if (options.isInstalled?.(plugin.name)) {
        options.report(`dev mods: ${folder.dir} is named ${plugin.name}, which an installed plugin already is; left out`)
        continue
      }
      plugins.push({ ...plugin, enabled: true, installIdentifier: `${plugin.name}@${DEV_MODS_MARKETPLACE}` })
    }
    loaded = plugins
    loadedKey = key
    await options.onPluginsChanged()
    await options.onLoaded?.(plugins).catch(error => {
      options.report(`dev mods: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (!onUnasked) return
    const fresh = plugins.map(plugin => plugin.name).filter(name => !announced.has(name))
    if (fresh.length === 0) return
    for (const name of fresh) announced.add(name)
    options.notifyOn?.(fresh)
  }

  const askNow = (names: readonly string[]): void => {
    setState('asking')
    void options.ask(names).then(
      async answer => {
        if (answer === 'on') {
          setState('on')
          try {
            await load(await scan())
          } catch (error) {
            options.report(`dev mods: ${error instanceof Error ? error.message : String(error)}`)
          }
        } else if (answer === 'declined') {
          setState('declined')
        } else {
          setState('unasked')
        }
      },
      error => {
        options.report(`dev mods: the question failed: ${error instanceof Error ? error.message : String(error)}`)
        setState('unasked')
      },
    )
  }

  return {
    state: () => state,
    plugins: () => (state === 'on' ? loaded : []),
    async afterTurn() {
      try {
        if (state === 'asking' || state === 'declined') return
        const folders = await scan()
        if (state === 'on') {
          await load(folders)
          return
        }
        if (folders.length === 0) return
        const mode = options.permissionMode()
        // Off is where nobody could be asked: a later mode that can ask, asks.
        if (state === 'off' && (NEVER_ASK_MODES.has(mode) || !options.canAsk)) return
        if (UNASKED_ON_MODES.has(mode)) {
          onUnasked = true
          setState('on')
          await load(folders)
          return
        }
        if (NEVER_ASK_MODES.has(mode) || !options.canAsk) {
          setState('off')
          options.report(`dev mods: ${options.folder} is not loaded: nobody can be asked to turn it on`)
          return
        }
        const names = await Promise.all(folders.map(f => options.assemble(f.dir, f.name).then(p => p?.name ?? f.name, () => f.name)))
        askNow(names)
      } catch (error) {
        options.report(`dev mods: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
