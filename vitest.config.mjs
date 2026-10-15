import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { builtinModsPlugin } from './vite/builtinModsPlugin.ts'
import { bundledTemplateRegistryPlugin } from './vite/bundledTemplateRegistryPlugin.ts'
import { isolatedWorkerSourcesPlugin } from './vite/isolatedWorkerSourcesPlugin.ts'

const chromeResourcesStub = fileURLToPath(
  new URL('./src/__tests__/stubs/chromeResources.ts', import.meta.url),
)

// Mirror the `@/` → `./src` alias from vite.config.ts so component modules
// imported from tests resolve correctly. Vitest does not auto-inherit Vite
// aliases when a separate vitest config exists.
const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// patch_webui modules import Chromium WebUI helpers via `chrome://` URLs that
// only resolve when the page is served from a chrome:// origin. Vitest 4's
// module-evaluator runs in plain Node and treats `chrome://...` as a relative
// path, so a `resolve.alias` entry never gets a chance to match. A custom
// resolver plugin intercepts the import before that mis-normalization happens.
const chromeResourcesStubPlugin = {
  name: 'stub-chrome-resources',
  enforce: 'pre',
  resolveId(source) {
    if (source === 'chrome://resources/js/load_time_data.js') {
      return chromeResourcesStub
    }
    return null
  },
  transform(code, id) {
    // Vitest 4's module-evaluator hands `chrome://...` imports straight to
    // Node's ESM resolver, which mangles them into `<cwd>/chrome:/...` paths.
    // Vite's resolveId hook never gets a chance to intercept. Rewriting the
    // import statement at the source level is the only reliable fix.
    if (!code.includes('chrome://resources/js/load_time_data.js')) {
      return null
    }
    void id
    return {
      code: code.replace(
        /['"]chrome:\/\/resources\/js\/load_time_data\.js['"]/g,
        JSON.stringify(chromeResourcesStub),
      ),
      map: null,
    }
  },
}

export default defineConfig({
  // No __NEXUS_BUILD_TIME__ mirror: the build time is no longer a `define`. It
  // reaches the bundle through an index.html <meta> tag, so tests that need a
  // value inject it with `setBuildTime()` (see src/__tests__/buildInfo.test.ts).
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@': path.resolve(projectRoot, 'src'),
    },
  },
  plugins: [
    chromeResourcesStubPlugin,
    bundledTemplateRegistryPlugin(),
    builtinModsPlugin(),
    // RunJsWindowHost imports the kernel's worker sources as text.
    isolatedWorkerSourcesPlugin(),
  ],
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ['src/__tests__/setup.ts'],
    server: {
      deps: {
        // Force patch_webui modules through Vite's transform pipeline so the
        // chrome:// resolver plugin above gets a chance to intercept their
        // imports. Without this they go through Node's native ESM loader.
        inline: [/[\\/]custom_browser[\\/]resources[\\/]patch_webui[\\/]/],
      },
    },
  },
})
