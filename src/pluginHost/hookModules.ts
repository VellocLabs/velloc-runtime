/**
 * A plugin's hooks modules: the `modules` key of `hooks/hooks.json`, paths
 * relative to that file. Resolution only.
 *
 * Security: refuses loudly an absolute path or one that climbs out with `..`.
 */

import { dirnameRuntimePath, joinRuntimePath } from '../utils/runtimePaths'

/**
 * Resolve `hooks.json`'s `modules` value to absolute paths inside the plugin.
 * Returns `[]` when the key is absent. Throws, naming the entry, when the
 * value is not a list of relative paths that stay inside `pluginPath`.
 */
export function resolveHookModulePaths(
  modules: unknown,
  hooksFilePath: string,
  pluginPath: string,
): string[] {
  if (modules === undefined) return []
  if (!Array.isArray(modules)) {
    throw new Error('"modules" must be a list of paths')
  }
  const base = segmentsOf(dirnameRuntimePath(hooksFilePath))
  const root = segmentsOf(pluginPath)
  return modules.map(entry => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('"modules" entries must be non-empty paths')
    }
    const spelled = entry.replace(/\\/g, '/')
    if (spelled.startsWith('/') || /^[A-Za-z]:/.test(spelled)) {
      throw new Error(`module path "${entry}" must be relative to hooks.json`)
    }
    const resolved = [...base]
    for (const segment of spelled.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        resolved.pop()
        continue
      }
      resolved.push(segment)
    }
    const inside =
      resolved.length > root.length &&
      root.every((segment, index) => sameSegment(segment, resolved[index]!))
    if (!inside) {
      throw new Error(`module path "${entry}" is outside the plugin`)
    }
    return joinRuntimePath(pluginPath, ...resolved.slice(root.length))
  })
}

function segmentsOf(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.')
}

/** Windows paths compare case-insensitively; a drive letter always does. */
function sameSegment(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase()
}
