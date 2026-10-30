import { defineConfig, type Plugin, type Rollup } from 'vite'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'
import { builtinModsPlugin } from './vite/builtinModsPlugin'
import { bundledTemplateRegistryPlugin } from './vite/bundledTemplateRegistryPlugin'
import { isolatedWorkerSourcesPlugin } from './vite/isolatedWorkerSourcesPlugin'
import {
  BACKGROUND_CACHE_UPDATE_ENTRY,
  BACKGROUND_CACHE_UPDATE_SOURCE,
  injectBackgroundCacheUpdatePlugin,
} from './vite/backgroundCacheUpdatePlugin'
import { localeAssetsPlugin } from './vite/localeAssetsPlugin'
import { devCatalogSnapshotPlugin } from './vite/devCatalogSnapshotPlugin'
import { devServerWatch } from './vite/devServerWatch'
import { xtermHeadlessWorkerPlugin } from './vite/xtermHeadlessWorkerPlugin'
import { thirdPartyNotices } from './vite/thirdPartyNoticesPlugin'
import { NEXUS_INTERFACE_VERSION } from './src/browser/bridge/protocol/interfaceVersion'
import { BUILD_TIME_META_NAME, buildTimeFromCommit } from './src/branding/buildInfo'

function normalizeBasePath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeadingSlash.endsWith('/')
    ? withLeadingSlash
    : `${withLeadingSlash}/`
}

function resolvePagesBasePath(): string {
  const explicit = process.env.PAGES_BASE_PATH
  if (explicit) {
    return normalizeBasePath(explicit)
  }

  // Version-pinned production deploy (`npm run build:versioned`): the bundle
  // is served under /v<N>/ where <N> is the bridge interface version baked
  // into this build — the path the binary derives from its own constant.
  // The base is derived from the SAME TS constant the runtime check uses,
  // so bundle content and serving path can never disagree by construction.
  // See G-3.
  if (process.env.VERSIONED_DEPLOY === '1') {
    return `/v${NEXUS_INTERFACE_VERSION}/`
  }

  const repository = process.env.GITHUB_REPOSITORY
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  if (!repository) {
    return '/'
  }

  const [, repoName] = repository.split('/')
  if (!repoName) {
    return '/'
  }

  if (owner && repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return '/'
  }

  return normalizeBasePath(repoName)
}

function processPolyfillPlugin(mode: string): Plugin {
  return {
    name: 'process-env-polyfill',
    transformIndexHtml() {
      return [{
        tag: 'script',
        children: `globalThis.process={env:{NODE_ENV:${JSON.stringify(mode)}}};`,
        injectTo: 'head-prepend',
      }]
    },
  }
}

// Inject the SharedWorker warm-up as its OWN early <script> in <head>, kept
// separate from the main index entry. Vite folds every <script type="module">
// it finds in index.html into a single entry chunk, which would delay the
// warm-up behind the main bundle (and its static deps). Building it as its own
// `warmSharedWorker` input and injecting the tag here keeps it a tiny chunk
// that fetches and runs first. Dev serves the source module; build points at
// the content-hashed entry chunk. `head-prepend` makes it the first script so
// it runs before main.tsx's bootstrap and the nexus-init/bridge handshake.
function injectWarmSharedWorkerPlugin(): Plugin {
  let base = '/'
  return {
    name: 'inject-warm-shared-worker',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        let src = `${base}src/glic/warmSharedWorker.ts`
        if (ctx.bundle) {
          const entry = Object.values(ctx.bundle).find(
            (chunk): chunk is Rollup.OutputChunk =>
              chunk.type === 'chunk' &&
              chunk.isEntry &&
              chunk.name === 'warmSharedWorker',
          )
          if (entry) {
            src = `${base}${entry.fileName}`
          }
        }
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src },
            injectTo: 'head-prepend',
          },
        ]
      },
    },
  }
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, '/')
}

function resolveManualChunk(id: string): string | undefined {
  const normalized = normalizeModuleId(id)

  if (!normalized.includes('/node_modules/')) {
    return undefined
  }

  if (
    normalized.includes('/node_modules/@assistant-ui/react-markdown/') ||
    normalized.includes('/node_modules/react-markdown/') ||
    normalized.includes('/node_modules/remark-') ||
    normalized.includes('/node_modules/rehype-') ||
    normalized.includes('/node_modules/micromark') ||
    normalized.includes('/node_modules/mdast-') ||
    normalized.includes('/node_modules/hast-') ||
    normalized.includes('/node_modules/unist-') ||
    normalized.includes('/node_modules/unified/') ||
    normalized.includes('/node_modules/trough/') ||
    normalized.includes('/node_modules/bail/') ||
    normalized.includes('/node_modules/vfile') ||
    normalized.includes('/node_modules/property-information/') ||
    normalized.includes('/node_modules/space-separated-tokens/') ||
    normalized.includes('/node_modules/comma-separated-tokens/') ||
    normalized.includes('/node_modules/character-entities') ||
    normalized.includes('/node_modules/decode-named-character-reference/') ||
    normalized.includes('/node_modules/style-to-js/') ||
    normalized.includes('/node_modules/style-to-object/') ||
    normalized.includes('/node_modules/inline-style-parser/') ||
    normalized.includes('/node_modules/html-url-attributes/') ||
    normalized.includes('/node_modules/devlop/') ||
    normalized.includes('/node_modules/zwitch/')
  ) {
    return 'vendor-markdown'
  }

  if (normalized.includes('/node_modules/@assistant-ui/react/')) {
    return 'vendor-assistant-ui'
  }

  if (
    normalized.includes('/node_modules/react-dom/') ||
    normalized.includes('/node_modules/react/')
  ) {
    return 'vendor-react'
  }

  // yaml and zod are heavy and reachable from several lazy paths (the shell's
  // templateRegistry, the tracer-flags settings read, the A2UI renderer).
  // Naming them keeps each a single stable, separately-cached chunk instead of
  // being folded into (or split across) whichever app chunk references them
  // first. Both are loaded only via dynamic-import chains, never by the entry.
  if (normalized.includes('/node_modules/yaml/')) {
    return 'vendor-yaml'
  }
  if (normalized.includes('/node_modules/zod/')) {
    return 'vendor-zod'
  }

  return undefined
}

// Build-time asset manifest — emits assets-manifest.json listing every
// output JS/CSS/font chunk under /assets/ sorted by byte size (largest
// first) plus a buildId timestamp. Used by backgroundCacheUpdate.js to
// pre-warm the browser HTTP cache for the largest lazy-loaded content-hashed
// chunks via fetch() with cache: "force-cache".
function assetManifestPlugin(): Plugin {
  return {
    name: 'asset-manifest',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets: Array<{ url: string; size: number; type: string }> = []
      for (const [fileName, info] of Object.entries(bundle)) {
        if (info.type !== 'chunk' && info.type !== 'asset') continue
        if (!/^assets\//.test(fileName)) continue
        const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
        let type = 'other'
        if (ext === 'js' || ext === 'mjs') type = 'js'
        else if (ext === 'css') type = 'css'
        else if (ext === 'woff2' || ext === 'woff' || ext === 'ttf') type = 'font'
        // Locale catalogs are content-hashed JSON under assets/locales/ (see
        // vite/localeAssetsPlugin.ts). Tagged distinctly so the background
        // updater can warm just the ACTIVE locale — warming all seven would
        // re-create "every user downloads every language", only over the
        // network instead of in the bundle.
        else if (/^assets\/locales\//.test(fileName)) type = 'locale'
        assets.push({
          url: fileName,
          size: info.type === 'chunk'
            ? Buffer.byteLength((info as { code?: string }).code ?? '', 'utf8')
            : (info as { source?: Uint8Array }).source?.length ?? 0,
          type,
        })
      }
      assets.sort((a, b) => b.size - a.size)
      this.emitFile({
        type: 'asset',
        fileName: 'assets-manifest.json',
        source: JSON.stringify({
          // Same commit-derived value as the <meta> tag, not a wall clock, so
          // this file is byte-identical across rebuilds of the same commit.
          // scripts/pack_artifact.mjs copies it into the release manifest as
          // `buildId`, and a timestamp there would make two packs of one
          // commit look like different sources.
          buildId: resolveBuildTime(),
          assets,
        }, null, 2) + '\n',
      })
    },
  }
}

// Publishes the build time as a <meta> tag in index.html instead of a `define`:
// a define inlined into a chunk changes its hash, which cascades to every
// importer and re-downloads immutable assets on each deploy. index.html is
// unhashed and read synchronously at boot.
function buildTimeMetaPlugin(): Plugin {
  return {
    name: 'build-time-meta',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { name: BUILD_TIME_META_NAME, content: resolveBuildTime() },
        injectTo: 'head-prepend',
      }]
    },
  }
}

// The committer date of HEAD, as a fixed-length ISO string, so rebuilds of one
// commit keep their content hashes (a wall clock would churn immutable assets).
// Milliseconds come from the commit hash (`buildTimeFromCommit`) so two commits
// in one second get distinct build keys. Falls back to the wall clock without git.
function resolveBuildTime(): string {
  try {
    const [iso = '', hash = ''] = execFileSync('git', ['log', '-1', '--format=%cI%n%H'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/)
    // UTC with milliseconds, fixed length, so `new Date(...)` parses it.
    const time = buildTimeFromCommit(iso, hash)
    if (time) return time
  } catch {
    // no git, not a repo, or an empty history — fall through
  }
  return new Date().toISOString()
}

// What the dev server's watcher skips, and why, is in vite/devServerWatch.ts.
// `__dirname` is only the fallback anchor: the plugin re-anchors the ignore at
// the root Vite actually serves, whose spelling (junction, drive-letter case,
// 8.3) is the one the watcher reports — __dirname is the config's real path.
const devWatch = devServerWatch(__dirname)

// One collector per worker build feeds the page build's plugin, which emits
// third-party-licenses.txt once every graph is known.
const notices = thirdPartyNotices(__dirname)

export default defineConfig(({ mode }) => ({
  base: resolvePagesBasePath(),
  plugins: [
    devWatch.plugin,
    xtermHeadlessWorkerPlugin(),
    processPolyfillPlugin(mode),
    injectWarmSharedWorkerPlugin(),
    injectBackgroundCacheUpdatePlugin(),
    bundledTemplateRegistryPlugin(),
    builtinModsPlugin(),
    isolatedWorkerSourcesPlugin(),
    localeAssetsPlugin(),
    devCatalogSnapshotPlugin(__dirname),
    assetManifestPlugin(),
    buildTimeMetaPlugin(),
    notices.plugin,
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    // Deliberately no __NEXUS_BUILD_TIME__ define: the build time travels in an
    // index.html <meta> tag (buildTimeMetaPlugin), and a define here would churn
    // ~4.6 MB of immutable assets on every deploy.
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  worker: {
    format: 'es',
    // The SharedWorker is a SEPARATE Rollup build with its own plugin set, so
    // the virtual `virtual:bundled-template-registry` module must be registered
    // here too — the worker imports `templateRegistry` (via createBrowserRuntime).
    // So must `virtual:builtin-mods`: the session boot registers the built-in
    // mods there.
    plugins: () => [
      bundledTemplateRegistryPlugin(),
      builtinModsPlugin(),
      xtermHeadlessWorkerPlugin(),
      notices.collector(),
    ],
  },
  server: {
    watch: {
      // Anchored at the SERVED root (see devWatch above): a bare `**/.velloc/**`
      // would blind every env-script worktree server, whose own root sits inside
      // nexus_web/.velloc/worktrees/.
      ignored: devWatch.ignored,
    },
  },
  optimizeDeps: {
    // Dependencies reached only through lazy imports or worker modules (e.g.
    // the A2UI renderer via a2ui/A2uiProviderHost.tsx): the dev-server startup
    // scan never sees them, so each one found later re-optimizes the deps,
    // reloads every open page, and can fail an in-flight dynamic import
    // ("Failed to fetch dynamically imported module"). Dev only; production
    // (rollup) is unaffected.
    include: [
      '@copilotkit/a2ui-renderer',
      '@leeoniya/ufuzzy',
      '@mixmark-io/domino',
      '@modelcontextprotocol/sdk/client/index.js',
      '@modelcontextprotocol/sdk/client/sse.js',
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
      '@modelcontextprotocol/sdk/client/websocket.js',
      '@modelcontextprotocol/sdk/types.js',
      '@xterm/addon-serialize',
      'cron-parser',
      'lru-cache',
      'react/jsx-dev-runtime',
      'turndown',
      'typescript',
      'yaml',
    ],
  },
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        // Separate entry so the SharedWorker warm-up loads as its own tiny
        // early <script> (injected by injectWarmSharedWorkerPlugin) instead of
        // being folded into the main index entry chunk.
        warmSharedWorker: fileURLToPath(
          new URL('./src/glic/warmSharedWorker.ts', import.meta.url),
        ),
        // Separate entry so the background cache updater is its own
        // content-hashed chunk (injected by injectBackgroundCacheUpdatePlugin,
        // which finds it under this same key).
        [BACKGROUND_CACHE_UPDATE_ENTRY]: fileURLToPath(
          new URL(`./${BACKGROUND_CACHE_UPDATE_SOURCE}`, import.meta.url),
        ),
      },
      output: {
        manualChunks(id) {
          return resolveManualChunk(id)
        },
      },
    },
  },
}))
