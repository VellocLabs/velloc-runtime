import type { Plugin } from 'vite'

export type ModuleGraph = {
  getModuleIds(): IterableIterator<string>
  getModuleInfo(id: string): {
    isEntry: boolean
    importers: readonly string[]
    dynamicImporters: readonly string[]
    importedIds: readonly string[]
    dynamicallyImportedIds: readonly string[]
  } | null
}

// The studio catalog's engine (F-1): packages only it reaches stay out of the
// shared vendor chunks the chat and the runtime load.
const STUDIO_SOURCE_DIRS = ['/src/browser/webview/a2ui/studio/', '/src/toolkit/builtin/a2ui/express/studio']

export function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, '/')
}

function isStudioSource(id: string): boolean {
  const normalized = normalizeModuleId(id)
  return STUDIO_SOURCE_DIRS.some(dir => normalized.includes(dir))
}

/**
 * The modules reachable from an entry (or any module nothing imports) without
 * passing through the studio's own sources. One walk over the graph.
 */
export function modulesReachedOutsideStudio(graph: ModuleGraph): Set<string> {
  const reached = new Set<string>()
  const queue: string[] = []
  for (const id of graph.getModuleIds()) {
    const info = graph.getModuleInfo(id)
    if (!info || isStudioSource(id)) continue
    if (info.isEntry || (info.importers.length === 0 && info.dynamicImporters.length === 0)) {
      reached.add(id)
      queue.push(id)
    }
  }
  while (queue.length > 0) {
    const info = graph.getModuleInfo(queue.pop()!)
    if (!info) continue
    for (const next of [...info.importedIds, ...info.dynamicallyImportedIds]) {
      if (reached.has(next) || isStudioSource(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  return reached
}

/** Answers "is this module reached only through the studio?" for the current build; reset at each build start. */
export function studioReach(): { plugin: Plugin; reachedOnlyByStudio(id: string, graph: ModuleGraph): boolean } {
  let shared: Set<string> | null = null
  return {
    plugin: { name: 'velloc-studio-reach', buildStart() { shared = null } },
    reachedOnlyByStudio(id, graph) {
      shared ??= modulesReachedOutsideStudio(graph)
      return !shared.has(id)
    },
  }
}
