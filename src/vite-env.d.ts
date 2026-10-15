/// <reference types="vite/client" />

/* There is deliberately no `__NEXUS_BUILD_TIME__` global. The build time
 * travels in an index.html <meta> tag (`buildTimeMetaPlugin` in
 * `vite.config.ts`) and is read via `src/branding/buildInfo.ts`. A `define`
 * would be inlined into whichever chunk named it, and the resulting hash change
 * cascades to every importer — measured at 90 of 218 assets, 4.58 MB,
 * re-downloaded per deploy with no content change. Declaring the global again
 * is the first step back into that. */

/**
 * Bundled per-session template registry, pre-parsed at BUILD TIME by the
 * `bundled-template-registry` Vite plugin (see `vite.config.ts`) so the page
 * never imports `yaml` to read the bundled launchers/welcome. `createBundledRegistry`
 * returns a FRESH `RegistryData` (new Maps) on each call so overlay mutations and
 * test resets never bleed across callers.
 */
declare module 'virtual:bundled-template-registry' {
  import type { RegistryData } from '@/prompting/templateParsing'
  export function createBundledRegistry(): RegistryData
}

/**
 * The bundled launcher catalogs and welcome pages alone, from the same plugin,
 * fresh on each call — what the page renders, without the template bodies.
 */
declare module 'virtual:bundled-template-catalog' {
  import type { RegistryData } from '@/prompting/templateParsing'
  export function createBundledCatalog(): Pick<
    RegistryData,
    'launcherCatalog' | 'launcherByType' | 'betaLauncherCatalog' | 'welcomeByType'
  >
}

/**
 * The built-in mods (F-25), each plugin under `mods/builtin/` compiled at
 * build time by the `builtin-mods` Vite plugin (`vite/builtinModsPlugin.ts`).
 */
declare module 'virtual:builtin-mods' {
  import type { BuiltinModDefinition } from '@/mods/builtinMods'
  export const BUILTIN_MODS: BuiltinModDefinition[]
}

/**
 * The isolated-worker kernel's workers as TEXT, built by the
 * `isolated-worker-sources` Vite plugin (`vite/isolatedWorkerSourcesPlugin.ts`):
 * its workers run with an opaque origin and cannot load a chunk of the app's.
 */
declare module 'virtual:isolated-worker-sources' {
  /** The sandboxed spawner frame's whole document: CSP <meta> + inline script. */
  export const spawnerFrameSrcdoc: string
  /** That frame's Content-Security-Policy, which every worker it spawns inherits. */
  export const spawnerFrameCsp: string
  /** The frame mod workers are spawned from: the same document under a policy
   *  without `'unsafe-eval'` (F-25). */
  export const modSpawnerFrameSrcdoc: string
  export const modSpawnerFrameCsp: string
  /** run_js's worker, one self-contained module, as a `data:` URL. */
  export const runJsWorkerUrl: string
  /** A mod's worker (`mods/mod.worker`), one self-contained module, as a
   *  `data:` URL. */
  export const modWorkerUrl: string
}

interface ImportMetaEnv {
  /** Product brand, injected from the gn `branding_path_component` build arg
   *  (see `src/branding/runtimeDir.ts`). Absent in dev / unit tests. */
  readonly VITE_BRANDING_PATH_COMPONENT?: string
  /** Visible product name, injected at build time (see
   *  `src/branding/productName.ts`). Absent in dev / unit tests. */
  readonly VITE_PRODUCT_NAME?: string
}
