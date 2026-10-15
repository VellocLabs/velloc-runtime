import fs from 'node:fs'
import path from 'node:path'
import { normalizePath, type AnymatchPattern, type Logger, type Plugin } from 'vite'

// `server.watch.ignored` for the dev server, plus the plugin that anchors it at
// the root Vite actually serves. Ignored: the served public/'s
// managed-binaries.json and its `.e2e-bak` (an e2e spec rewrites them and Vite
// would reload every client; the first hit is logged) and nested `.velloc/`
// worktrees. Anchors are the served root's spellings (as given and realpath,
// case-folded on Windows), matched by function rather than glob so a glob
// character in the checkout path is harmless. Pinned in devServerWatch.test.ts.

/** The names an e2e spec writes under the served public/ (file + its backup). */
export const E2E_REGISTRY_FILES = ['managed-binaries.json', 'managed-binaries.json.e2e-bak']

export interface DevServerWatch {
  /** For `server.watch.ignored`. */
  ignored: AnymatchPattern[]
  /** Re-anchors `ignored` at the served root; must be in `plugins`. */
  plugin: Plugin
}

const caseFold = process.platform === 'win32'
  ? (p: string) => p.toLowerCase()
  : (p: string) => p

/** Forward-slash, case-folded spellings of `dir`: as given and its realpath. */
function spellings(dir: string): string[] {
  const out = new Set([caseFold(normalizePath(path.resolve(dir)))])
  try {
    out.add(caseFold(normalizePath(fs.realpathSync.native(dir))))
  } catch {
    // Not there (yet) — the given spelling is all there is.
  }
  return [...out]
}

const within = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`)

/**
 * `configDir` is the fallback anchor (vite.config.ts passes `__dirname`) until
 * the plugin's configResolved replaces it with the served root and public dir.
 */
export function devServerWatch(configDir: string): DevServerWatch {
  let nestedTrees = spellings(configDir).map((root) => `${root}/.velloc`)
  let publicDirs = spellings(configDir).map((root) => `${root}/public`)
  let logger: Pick<Logger, 'info'> = { info: (msg) => console.info(msg) }
  let loggedRegistry = false

  const isNestedTree = (file: string) => {
    const f = caseFold(normalizePath(file))
    return nestedTrees.some((dir) => within(f, dir))
  }
  const isE2eRegistry = (file: string) => {
    const f = caseFold(normalizePath(file))
    const hit = publicDirs.some((dir) =>
      E2E_REGISTRY_FILES.some((name) => f === `${dir}/${caseFold(name)}`))
    if (hit && !loggedRegistry) {
      loggedRegistry = true
      logger.info(
        `[nexus] not watching public/managed-binaries.json: an e2e spec ` +
        'rewrites it mid-run. Edits are still served on the next request, but ' +
        'will not reload open pages — reload by hand (vite/devServerWatch.ts).')
    }
    return hit
  }

  return {
    ignored: [isE2eRegistry, isNestedTree],
    plugin: {
      name: 'nexus:dev-server-watch',
      apply: 'serve',
      configResolved(config) {
        nestedTrees = spellings(config.root).map((root) => `${root}/.velloc`)
        publicDirs = config.publicDir ? spellings(config.publicDir) : []
        logger = config.logger
      },
    },
  }
}
