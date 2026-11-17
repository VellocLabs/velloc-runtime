/**
 * Security: writes the mod API declaration into a dev mod's types folder
 * (`<plugin>/<manifest dir>/types/`) and the plugin's own `tsconfig.json`
 * (one `extends`) when it has none, never outside the dev mods folder (F-25).
 * Every directory from the folder down to `types/`, and every file
 * replaced, must resolve to itself (no symlink or junction on the way), and
 * only a file whose first line carries the generated marker is overwritten;
 * anything else is left as it is and reported. A host that cannot resolve
 * real paths gets nothing.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { isGeneratedFile, type ModApiFiles } from './modApiDeclaration'

export type ModTypesFs = Pick<RuntimeFs, 'readFile' | 'writeFile' | 'mkdir' | 'stat' | 'realpath'>

export type ModTypesTarget = {
  /** The dev mods folder: nothing is written outside it. */
  folder: string
  /** The plugin's directory, a child of `folder`. */
  pluginDir: string
  /** The plugin's manifest directory's name, under `pluginDir`. */
  manifestDir: string
  join(base: string, ...segments: string[]): string
}

export type ModTypesOutcome = {
  /** Files written this time (unchanged ones are not rewritten). */
  written: string[]
  /** Files left alone because someone else's file has the name. */
  conflicts: string[]
  /** Why nothing was written, when nothing could be. */
  refused?: string
}

/** The folder under the manifest directory the files go to. */
export const MOD_TYPES_DIR = 'types'

const canonical = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The relative path the plugin's own `tsconfig.json` extends. */
export function modTypesConfigPath(manifestDir: string): string {
  return `./${manifestDir}/${MOD_TYPES_DIR}/tsconfig.json`
}

export async function emitModTypes(fs: ModTypesFs, target: ModTypesTarget, files: ModApiFiles): Promise<ModTypesOutcome> {
  const outcome: ModTypesOutcome = { written: [], conflicts: [] }
  const refuse = (why: string): ModTypesOutcome => ({ ...outcome, refused: why })
  const realpath = fs.realpath
  if (!realpath) return refuse('this host cannot resolve real paths')
  const real = (path: string): Promise<string> => realpath.call(fs, path, { resolveLinks: true }).then(canonical)
  const exists = (path: string): Promise<boolean> => fs.stat(path).then(() => true, () => false)

  const folder = canonical(target.folder)
  const pluginDir = canonical(target.pluginDir)
  const name = pluginDir.slice(folder.length + 1)
  if (!pluginDir.startsWith(`${folder}/`) || name === '' || name.includes('/')) {
    return refuse(`${target.pluginDir} is not a plugin of the dev mods folder`)
  }

  // Each step down resolves to its parent's real path plus its own name.
  let parentReal: string
  try {
    parentReal = await real(target.folder)
  } catch {
    return refuse(`${target.folder} cannot be resolved`)
  }
  const steps: Array<[string, string]> = [
    [target.pluginDir, name],
    [target.join(target.pluginDir, target.manifestDir), target.manifestDir],
    [target.join(target.pluginDir, target.manifestDir, MOD_TYPES_DIR), MOD_TYPES_DIR],
  ]
  for (const [path, step] of steps) {
    if (!(await exists(path))) {
      try {
        await fs.mkdir(path)
      } catch (error) {
        return refuse(`${path} cannot be made: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let resolved: string
    try {
      resolved = await real(path)
    } catch {
      return refuse(`${path} cannot be resolved`)
    }
    if (resolved !== `${parentReal}/${step.toLowerCase()}`) return refuse(`${path} is a link`)
    parentReal = resolved
  }
  const typesDir = steps[2]![0]
  const typesReal = parentReal
  const pluginReal = `${await real(target.folder)}/${name}`
  /** Whether `path` (present or not) resolves to `dirReal/file`: no link,
   *  dangling or not, stands in its place. */
  const resolvesInPlace = (path: string, dirReal: string, file: string): Promise<boolean> =>
    real(path).then(resolved => resolved === `${dirReal}/${file.toLowerCase()}`, () => false)

  for (const file of Object.keys(files).sort()) {
    const path = target.join(typesDir, file)
    if (!(await resolvesInPlace(path, typesReal, file))) {
      outcome.conflicts.push(path)
      continue
    }
    if (await exists(path)) {
      let text: string
      try {
        text = await fs.readFile(path, { encoding: 'utf8' })
      } catch {
        outcome.conflicts.push(path)
        continue
      }
      if (!isGeneratedFile(text)) {
        outcome.conflicts.push(path)
        continue
      }
      if (text === files[file]) continue
    }
    await fs.writeFile(path, files[file]!, { encoding: 'utf8' })
    outcome.written.push(path)
  }

  const ownConfig = target.join(target.pluginDir, 'tsconfig.json')
  if (!(await exists(ownConfig)) && (await resolvesInPlace(ownConfig, pluginReal, 'tsconfig.json'))) {
    const text = `${JSON.stringify({ extends: modTypesConfigPath(target.manifestDir) }, null, 2)}\n`
    await fs.writeFile(ownConfig, text, { encoding: 'utf8' })
    outcome.written.push(ownConfig)
  }
  return outcome
}
