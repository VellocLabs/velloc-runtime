// The "run main() only when executed, not when imported by a test" guard for
// the scripts in this directory. It compares real paths: the loader realpaths
// import.meta.url, but argv[1] keeps a junction or symlink path as typed.
// Plain .mjs with no src/ imports: it runs under plain Node.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * True when the module at `moduleUrl` (pass `import.meta.url`) is the file
 * `node` was asked to run; false when imported, with no entry file (`node -e`,
 * the REPL) or for a non-`file:` URL. A failed realpath falls back to
 * comparing the normalised absolute paths.
 */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  let selfPath
  try {
    selfPath = fileURLToPath(moduleUrl)
  } catch {
    return false
  }
  const entryPath = path.resolve(argv1)
  return samePath(realpathOr(selfPath), realpathOr(entryPath))
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.normalize(p)
  }
}

// Windows paths are case-insensitive, and realpathSync keeps whatever case it
// was handed for components that are not links (and the fallback keeps it for
// all of them).
function samePath(a, b) {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}
