import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * Worker builds resolve with the `browser` condition, which picks entries that
 * need `document`. These packages list a DOM-free entry under `worker`; this
 * plugin resolves to it in worker builds only (F-9, the Markdown parse Worker).
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
    enforce: 'pre',
    resolveId(source) {
      return DOM_FREE_WORKER_ENTRIES[source] ?? null
    },
  }
}
