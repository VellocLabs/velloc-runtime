import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { buildRegistry, type RegistryData } from '../src/prompting/templateParsing'

// Build-time template registry: pre-parses `src/template/**/*.md` in Node so
// the page never ships `yaml`. Two modules, from the same `buildRegistry` the
// local-overlay path uses:
// - `virtual:bundled-template-catalog` exports `createBundledCatalog()`, the
//   launcher catalogs and welcome pages alone (`src/prompting/templateCatalog.ts`),
//   so the page can render them without the template bodies;
// - `virtual:bundled-template-registry` exports `createBundledRegistry()`, a fresh
//   RegistryData built on the former. Registered in vite and vitest configs.

export const BUNDLED_TEMPLATE_VIRTUAL_ID = 'virtual:bundled-template-registry'
export const BUNDLED_CATALOG_VIRTUAL_ID = 'virtual:bundled-template-catalog'
const RESOLVED_ID = `\0${BUNDLED_TEMPLATE_VIRTUAL_ID}`
const RESOLVED_CATALOG_ID = `\0${BUNDLED_CATALOG_VIRTUAL_ID}`

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

const j = (v: unknown): string => JSON.stringify(v)
const mapEntries = (m: Map<string, unknown>): string =>
  `[${[...m.entries()].map(([k, v]) => `[${j(k)},${j(v)}]`).join(',')}]`

/** Serialize the launcher catalogs and welcome pages to a module whose
 *  `createBundledCatalog()` returns fresh arrays and Maps on each call.
 *  `launcherByType` is the catalog keyed by type, as `buildRegistry` builds it. */
function serializeBundledCatalog(reg: RegistryData): string {
  const welcomeEntries = `[${[...reg.welcomeByType.entries()]
    .map(([k, inner]) => `[${j(k)},new Map(${mapEntries(inner)})]`)
    .join(',')}]`
  return `export function createBundledCatalog() {
  const launcherCatalog = ${j(reg.launcherCatalog)}
  return {
    launcherCatalog,
    launcherByType: new Map(launcherCatalog.map(meta => [meta.type, meta])),
    betaLauncherCatalog: ${j(reg.betaLauncherCatalog)},
    welcomeByType: new Map(${welcomeEntries}),
  }
}
`
}

/** Serialize a built RegistryData to a JS module source that reconstructs it
 *  with fresh Maps on each `createBundledRegistry()` call, taking the launcher
 *  and welcome fields from the catalog module. `JSON.stringify` makes every
 *  string/object a safe literal; Maps are rebuilt from entries. */
function serializeBundledRegistry(reg: RegistryData): string {
  return `import { createBundledCatalog } from ${j(BUNDLED_CATALOG_VIRTUAL_ID)}
export function createBundledRegistry() {
  return {
    sharedHolders: ${j(reg.sharedHolders)},
    typeHolders: new Map(${mapEntries(reg.typeHolders)}),
    templates: new Map(${mapEntries(reg.templates)}),
    betaTemplates: new Map(${mapEntries(reg.betaTemplates)}),
    ...createBundledCatalog(),
  }
}
`
}

export function bundledTemplateRegistryPlugin(): Plugin {
  return {
    name: 'bundled-template-registry',
    resolveId(id) {
      if (id === BUNDLED_TEMPLATE_VIRTUAL_ID) return RESOLVED_ID
      if (id === BUNDLED_CATALOG_VIRTUAL_ID) return RESOLVED_CATALOG_ID
      return undefined
    },
    load(id) {
      if (id !== RESOLVED_ID && id !== RESOLVED_CATALOG_ID) return undefined
      const root = templateDir()
      const entries = readTemplateEntries(root)
      // Watch every source so edits re-trigger the build in dev/watch mode.
      for (const [rel] of entries) {
        this.addWatchFile(path.join(root, rel))
      }
      const registry = buildRegistry(entries)
      return id === RESOLVED_ID
        ? serializeBundledRegistry(registry)
        : serializeBundledCatalog(registry)
    },
    handleHotUpdate(ctx) {
      // A template `.md` edit invalidates the generated virtual module so the
      // next request re-parses it (dev only; production builds once).
      if (!ctx.file.replace(/\\/g, '/').includes('/src/template/')) return
      const mods = [RESOLVED_ID, RESOLVED_CATALOG_ID]
        .map(id => ctx.server.moduleGraph.getModuleById(id))
        .filter(mod => mod !== undefined)
      if (mods.length > 0) return [...ctx.modules, ...mods]
      return undefined
    },
  }
}
