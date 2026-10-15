import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { buildRegistry, type RegistryData } from '../src/prompting/templateParsing'

// Build-time template registry: pre-parses `src/template/**/*.md` in Node so
// the page never ships `yaml`. `virtual:bundled-template-registry` exports
// `createBundledRegistry()`, a fresh RegistryData from the same `buildRegistry`
// the local-overlay path uses; consumed by `src/prompting/templateRegistry.ts`.
// Registered in `vite.config.ts` and `vitest.config.mjs`.

export const BUNDLED_TEMPLATE_VIRTUAL_ID = 'virtual:bundled-template-registry'
const RESOLVED_ID = `\0${BUNDLED_TEMPLATE_VIRTUAL_ID}`

// The template root, resolved from the process cwd (the `nexus_web` project
// root for every `npm run` script — dev, build, and vitest alike). Using cwd
// rather than `import.meta.url`/`__dirname` keeps it correct whether this
// module is imported natively (vite.config.ts) or bundled (vitest.config.mjs).
function templateDir(): string {
  return path.resolve(process.cwd(), 'src/template')
}

/** Recursively collect `[relPath, rawContent]` for every `.md` under
 *  `src/template`. `relPath` is forward-slashed and relative to that root
 *  (e.g. `index.md`, `agent/includes/agent_intro.md`) — exactly the shape
 *  `buildRegistry` expects. Non-template files (e.g. `README.md`) are read too
 *  but ignored by `buildRegistry`. */
function readTemplateEntries(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        walk(full)
      } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
        const rel = path.relative(root, full).replace(/\\/g, '/')
        out.push([rel, fs.readFileSync(full, 'utf8')])
      }
    }
  }
  walk(root)
  return out
}

/** Serialize a built RegistryData to a JS module source that reconstructs it
 *  with fresh Maps on each `createBundledRegistry()` call. `JSON.stringify`
 *  makes every string/object a safe literal; Maps are rebuilt from entries. */
function serializeBundledRegistry(reg: RegistryData): string {
  const j = (v: unknown): string => JSON.stringify(v)
  const mapEntries = (m: Map<string, unknown>): string =>
    `[${[...m.entries()].map(([k, v]) => `[${j(k)},${j(v)}]`).join(',')}]`
  const welcomeEntries = `[${[...reg.welcomeByType.entries()]
    .map(([k, inner]) => `[${j(k)},new Map(${mapEntries(inner)})]`)
    .join(',')}]`
  return `export function createBundledRegistry() {
  return {
    sharedHolders: ${j(reg.sharedHolders)},
    typeHolders: new Map(${mapEntries(reg.typeHolders)}),
    templates: new Map(${mapEntries(reg.templates)}),
    betaTemplates: new Map(${mapEntries(reg.betaTemplates)}),
    launcherCatalog: ${j(reg.launcherCatalog)},
    launcherByType: new Map(${mapEntries(reg.launcherByType)}),
    betaLauncherCatalog: ${j(reg.betaLauncherCatalog)},
    welcomeByType: new Map(${welcomeEntries}),
  }
}
`
}

export function bundledTemplateRegistryPlugin(): Plugin {
  return {
    name: 'bundled-template-registry',
    resolveId(id) {
      if (id === BUNDLED_TEMPLATE_VIRTUAL_ID) return RESOLVED_ID
      return undefined
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined
      const root = templateDir()
      const entries = readTemplateEntries(root)
      // Watch every source so edits re-trigger the build in dev/watch mode.
      for (const [rel] of entries) {
        this.addWatchFile(path.join(root, rel))
      }
      return serializeBundledRegistry(buildRegistry(entries))
    },
    handleHotUpdate(ctx) {
      // A template `.md` edit invalidates the generated virtual module so the
      // next request re-parses it (dev only; production builds once).
      if (!ctx.file.replace(/\\/g, '/').includes('/src/template/')) return
      const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_ID)
      if (mod) return [...ctx.modules, mod]
      return undefined
    },
  }
}
