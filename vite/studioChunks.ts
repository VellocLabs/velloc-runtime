function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, '/')
}

export type ModuleGraph = { getModuleInfo(id: string): { importers: readonly string[]; dynamicImporters: readonly string[] } | null }

// The studio catalog's engine (F-1): packages only it reaches stay out of the
// shared vendor chunks the chat and the runtime load.
const STUDIO_SOURCE_DIRS = ['/src/browser/webview/a2ui/studio/', '/src/toolkit/builtin/a2ui/express/studio']

/**
 * Whether every path to `id` runs through the studio's own sources, so the
 * package stays out of shared vendor chunks. `memo` keeps settled answers;
 * a module met again on the current path counts as reached by the studio,
 * so only a `false` found on the way is final before the walk ends.
 */
export function reachedOnlyByStudio(id: string, graph: ModuleGraph, memo: Map<string, boolean>, path = new Set<string>()): boolean {
  const known = memo.get(id)
  if (known !== undefined) return known
  if (path.has(id)) return true
  const normalized = normalizeModuleId(id)
  if (STUDIO_SOURCE_DIRS.some(dir => normalized.includes(dir))) return true
  const info = graph.getModuleInfo(id)
  const importers = info ? [...info.importers, ...info.dynamicImporters] : []
  path.add(id)
  const result = importers.length > 0 && importers.every(importer => reachedOnlyByStudio(importer, graph, memo, path))
  path.delete(id)
  if (!result || path.size === 0) memo.set(id, result)
  return result
}
