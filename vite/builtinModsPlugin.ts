import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { compileModModule } from '../src/mods/modCompiler'

// Build-time built-in mods (F-25): each plugin directory under
// `mods/builtin/<name>/` compiled by the same compiler installed plugins use
// (`src/mods/modCompiler.ts`), under the root `builtin:<name>` so the output is
// machine-independent. `virtual:builtin-mods` exports `BUILTIN_MODS` for
// `src/mods/bundledBuiltinMods.ts`. Registered in `vite.config.ts` (incl. the
// worker build) and `vitest.config.mjs`.

export const BUILTIN_MODS_VIRTUAL_ID = 'virtual:builtin-mods'
const RESOLVED_ID = `\0${BUILTIN_MODS_VIRTUAL_ID}`

/** `mods/builtin`, from the process cwd (the `nexus_web` root for every
 *  `npm run` script), as `bundledTemplateRegistryPlugin` finds its root. */
function builtinDir(): string {
  return path.resolve(process.cwd(), 'mods/builtin')
}

type BuiltinMod = { name: string; version?: string; description?: string; source: string; files: string[] }

async function compileBuiltin(dir: string): Promise<BuiltinMod> {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
    description?: unknown
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${dir}: .claude-plugin/plugin.json names no plugin`)
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks/hooks.json'), 'utf8')) as { modules?: unknown }
  const modules = Array.isArray(hooks.modules) ? hooks.modules : []
  if (modules.length !== 1 || typeof modules[0] !== 'string') {
    throw new Error(`${dir}: a built-in is one hooks module; hooks/hooks.json lists ${modules.length}`)
  }
  const root = `builtin:${manifest.name}`
  const toDisk = (virtual: string): string => path.join(dir, virtual.slice(root.length + 1))
  const compiled = await compileModModule({
    root,
    entry: `${root}/hooks/${modules[0].replace(/^\.\//, '')}`,
    fs: { readFile: async (file: string) => fs.readFileSync(toDisk(file), 'utf8') },
  })
  return {
    name: manifest.name,
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
    source: compiled.source,
    files: compiled.files.map(toDisk),
  }
}

/** Every built-in under `mods/builtin`, compiled; in directory-name order. */
export async function compileBuiltinMods(root = builtinDir()): Promise<BuiltinMod[]> {
  if (!fs.existsSync(root)) return []
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry: { isDirectory(): boolean; name: string }) => entry.isDirectory())
    .map((entry: { isDirectory(): boolean; name: string }) => entry.name)
    .sort()
  return Promise.all(dirs.map((name: string) => compileBuiltin(path.join(root, name))))
}

export function builtinModsPlugin(): Plugin {
  return {
    name: 'builtin-mods',
    resolveId(id) {
      if (id === BUILTIN_MODS_VIRTUAL_ID) return RESOLVED_ID
      return undefined
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined
      const mods = await compileBuiltinMods()
      for (const mod of mods) for (const file of mod.files) this.addWatchFile(file)
      const definitions = mods.map(({ name, version, description, source }) => ({
        name,
        ...(version ? { version } : {}),
        ...(description ? { description } : {}),
        source,
      }))
      // No source map: a map of generated text is the text again (~3 MB in dev).
      return { code: `export const BUILTIN_MODS = ${JSON.stringify(definitions)}\n`, map: { mappings: '' } }
    },
    handleHotUpdate(ctx) {
      if (!ctx.file.replace(/\\/g, '/').includes('/mods/builtin/')) return
      const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_ID)
      if (mod) return [...ctx.modules, mod]
      return undefined
    },
  }
}
