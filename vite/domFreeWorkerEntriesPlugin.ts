import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * The `browser` resolve condition picks package entries that need `document`,
 * which a Worker has not. These packages also ship a DOM-free entry (listed
 * under `worker`); this plugin aliases each to it for the page and its
 * Workers alike, in the build and the dev server (F-9, the Markdown parse
 * Worker).
 */
export const DOM_FREE_WORKER_ENTRIES: Record<string, string> = {
  'decode-named-character-reference': path.resolve(
    __dirname,
    '../node_modules/decode-named-character-reference/index.js',
  ),
}

export function domFreeWorkerEntriesPlugin(): Plugin {
  return {
    name: 'velloc-dom-free-worker-entries',
    config: () => ({
      resolve: {
        alias: Object.entries(DOM_FREE_WORKER_ENTRIES).map(([find, replacement]) => ({
          find: new RegExp(`^${find}$`),
          replacement,
        })),
      },
    }),
  }
}
