/**
 * How a provider module is read, compiled and scanned: ONE definition shared by the
 * runtime and the update admission, so they cannot disagree.
 */

import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { compileModModule, loadTypeScript } from '../modCompiler'
import { scanModuleUses } from '../modScan'
import type { ProviderModulePrepareDeps } from './ProviderModRuntime'

export type ProviderModuleLoaderDeps = {
  homeDir: string
  fs: RuntimeFs
  report: (line: string) => void
}

/** `~/.velloc/mods`: the module builds (`.builds/`) and the `$.store` files live under it. */
export function providerModsDir(homeDir: string): string {
  return joinRuntimePath(homeDir, RUNTIME_DIR_NAME, 'mods')
}

/** The read / compile / scan the runtime loads a provider module with. */
export function providerModuleLoaders(deps: ProviderModuleLoaderDeps): ProviderModulePrepareDeps {
  const { fs, report } = deps
  return {
    readModule: async path => String(await fs.readFile(path, { encoding: 'utf-8' })),
    compile: ref =>
      compileModModule({
        entry: ref.path,
        root: ref.root ?? ref.path.replace(/[\\/][^\\/]*[\\/][^\\/]*$/, ''),
        fs: { readFile: (path, o) => fs.readFile(path, o).then(String) },
      }).then(result => ({ source: result.source, files: result.files, uses: result.uses })),
    scan: (ref, source) => loadTypeScript().then(ts => scanModuleUses(ts, [{ path: ref.path, text: source }])),
    report,
  }
}
