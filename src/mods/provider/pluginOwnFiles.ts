/**
 * Security: `$.fs.read` confined to the module's own plugin directory. A `..` or a
 * link that leads out is refused (`NotAllowedError`); reads are bounded by
 * `MOD_FS_READ_LIMIT`; a missing file rejects `ENOENT`. `read` is the one method.
 */

import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { isAbsoluteRuntimePath, normalizeRuntimePath, relativeRuntimePath, resolveRuntimePath } from '../../utils/runtimePaths'
import { fileModFs } from '../modFs'

export type PluginFileRead = (root: string, path: unknown, as: 'text' | 'bytes') => Promise<string | { base64: string }>

function notAllowed(message: string): Error {
  const error = new Error(message)
  error.name = 'NotAllowedError'
  return error
}

/** Whether `target` is `root` or below it (both absolute, normalized). */
function isUnder(root: string, target: string): boolean {
  const rel = relativeRuntimePath(root, target)
  if (rel === '' || rel === '.') return true
  if (isAbsoluteRuntimePath(rel)) return false
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}

/** The reader a provider runtime serves `$.fs.read` with. */
export function pluginOwnFileReader(fs: RuntimeFs, options: { readLimit?: number } = {}): PluginFileRead {
  return async (root, path, as) => {
    if (typeof path !== 'string' || path === '') throw new TypeError('$.fs.read: path must be a non-empty string')
    if (!root) throw notAllowed('$.fs.read: this module has no plugin directory to read from')
    const base = normalizeRuntimePath(root)
    const abs = resolveRuntimePath(base, path)
    const refuse = () => notAllowed(`$.fs.read: ${path} is outside the plugin's own directory; a provider module reads only its own files`)
    if (!isUnder(base, abs)) throw refuse()
    // A link inside the directory must not lead out of it. A host with no
    // realpath, or a path that does not resolve, falls to the read below.
    if (fs.realpath) {
      const real = await Promise.all([fs.realpath(base), fs.realpath(abs)]).catch(() => null)
      if (real && !isUnder(normalizeRuntimePath(real[0]), normalizeRuntimePath(real[1]))) throw refuse()
    }
    return fileModFs(fs, { cwd: base, ...(options.readLimit ? { readLimit: options.readLimit } : {}) }).read(abs, as)
  }
}
