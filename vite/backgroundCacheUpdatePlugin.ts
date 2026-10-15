import type { HtmlTagDescriptor, Plugin, Rollup } from 'vite'

/**
 * Injects the background cache updater (`src/glic/backgroundCacheUpdate.ts`)
 * as its own content-hashed, immutable chunk at the end of <body>; a changed
 * updater reaches clients with the next index.html. Build: a classic
 * `<script defer>`, so the chunk must be self-contained with no `import` or
 * `export`; `backgroundCacheUpdateTag` fails the build otherwise. Dev: a
 * `type="module"` tag, since Vite serves the source module with its imports.
 */

/** The Rollup input key in vite.config.ts; the chunk is found by this name. */
export const BACKGROUND_CACHE_UPDATE_ENTRY = 'backgroundCacheUpdate'

/** The entry's source, relative to the project root. */
export const BACKGROUND_CACHE_UPDATE_SOURCE = 'src/glic/backgroundCacheUpdate.ts'

/**
 * The updater's <script> tag: the source module on a dev server (no bundle),
 * the emitted chunk as a classic deferred script in a build. Throws when the
 * build has no such chunk, or when the chunk would not parse as a classic
 * script.
 */
export function backgroundCacheUpdateTag(
  base: string,
  bundle: Rollup.OutputBundle | undefined,
): HtmlTagDescriptor {
  if (!bundle) {
    return {
      tag: 'script',
      attrs: { type: 'module', src: `${base}${BACKGROUND_CACHE_UPDATE_SOURCE}` },
      injectTo: 'body',
    }
  }
  const entry = Object.values(bundle).find(
    (chunk): chunk is Rollup.OutputChunk =>
      chunk.type === 'chunk' &&
      chunk.isEntry &&
      chunk.name === BACKGROUND_CACHE_UPDATE_ENTRY,
  )
  if (!entry) {
    throw new Error(
      `inject-background-cache-update: the bundle has no '${BACKGROUND_CACHE_UPDATE_ENTRY}' ` +
        `entry chunk — vite.config.ts must keep ${BACKGROUND_CACHE_UPDATE_SOURCE} as a ` +
        `rollupOptions.input under that key.`,
    )
  }
  const imports = [...entry.imports, ...entry.dynamicImports]
  if (imports.length > 0 || entry.exports.length > 0) {
    throw new Error(
      `inject-background-cache-update: ${entry.fileName} is injected as a classic ` +
        `<script defer>, so it must be import- and export-free, but it imports ` +
        `[${imports.join(', ')}] and exports [${entry.exports.join(', ')}]. Every module ` +
        `${BACKGROUND_CACHE_UPDATE_SOURCE} imports must be reachable from no other ` +
        `entry — see src/glic/manifestAssetBase.ts.`,
    )
  }
  return {
    tag: 'script',
    attrs: { defer: true, src: `${base}${entry.fileName}` },
    injectTo: 'body',
  }
}

export function injectBackgroundCacheUpdatePlugin(): Plugin {
  let base = '/'
  return {
    name: 'inject-background-cache-update',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        return [backgroundCacheUpdateTag(base, ctx.bundle)]
      },
    },
  }
}
