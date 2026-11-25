import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * The `browser` resolve condition picks package entries that need `document`,
 * which a Worker has not. These packages also ship a DOM-free entry (listed
 * under `worker`). Registered in both plugin lists: in a Worker build every
 * import takes it; on the page (build or dev server) only imports reached
 * from a `*.worker.ts` module do, so the page keeps its own entry (F-9, the
 * Markdown parse Worker).
 */
export const DOM_FREE_WORKER_ENTRIES: Record<string, string> = {
  'decode-named-character-reference': path.resolve(
    __dirname,
    '../node_modules/decode-named-character-reference/index.js',
  ),
}

export function domFreeWorkerEntriesPlugin(): Plugin {
  let workerBuild = false
  const workerGraph = new Set<string>()
  const inWorkerGraph = (importer: string | undefined): boolean =>
    importer !== undefined && (/\.worker\.ts(\?|$)/.test(importer) || workerGraph.has(importer))
  return {
    name: 'velloc-dom-free-worker-entries',
    enforce: 'pre',
    configResolved(config) {
      workerBuild = config.isWorker
    },
    async resolveId(source, importer, options) {
      const entry = DOM_FREE_WORKER_ENTRIES[source]
      if (entry && (workerBuild || inWorkerGraph(importer))) return entry
      if (workerBuild || !inWorkerGraph(importer)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved && !resolved.external) workerGraph.add(resolved.id)
      return resolved
    },
  }
}
