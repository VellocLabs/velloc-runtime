import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * The `browser` resolve condition picks package entries that need `document`,
 * which a Worker has not. These packages also ship a DOM-free entry (listed
 * under `worker`). A Worker build takes it for every import; the page build
 * keeps its own. The dev server serves one module graph to the page and its
 * Workers, so there every import takes it (F-9, the Markdown parse Worker).
 */
export const DOM_FREE_WORKER_ENTRIES: Record<string, string> = {
  'decode-named-character-reference': path.resolve(
    __dirname,
    '../node_modules/decode-named-character-reference/index.js',
  ),
}

function aliases() {
  return Object.entries(DOM_FREE_WORKER_ENTRIES).map(([name, replacement]) => ({
    find: new RegExp(`^${name}$`),
    replacement,
  }))
}

/** For the page's plugin list: the dev server only. */
export function domFreeWorkerEntriesPlugin(): Plugin {
  return {
    name: 'velloc-dom-free-worker-entries',
    apply: 'serve',
    config: () => ({ resolve: { alias: aliases() } }),
  }
}

/** For `worker.plugins`: every import of a Worker build. */
export function domFreeWorkerEntriesWorkerPlugin(): Plugin {
  return {
    name: 'velloc-dom-free-worker-entries-worker',
    enforce: 'pre',
    resolveId: (source) => DOM_FREE_WORKER_ENTRIES[source] ?? null,
  }
}
