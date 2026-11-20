import { describe, expect, it } from 'vitest'
import { modulesReachedOutsideStudio, studioReach, type ModuleGraph } from '../../vite/studioChunks'

const STUDIO = 'C:\\w\\nexus_web\\src\\browser\\webview\\a2ui\\studio\\StudioAppSurface.tsx'
const ENTRY = '/w/nexus_web/src/main.tsx'
const CHAT = '/w/nexus_web/src/browser/webview/chat/Markdown.tsx'

/** A graph from static and dynamic import edges, importer → imported. */
function graphOf(entries: string[], edges: Array<[string, string]>, dynamic: Array<[string, string]> = []): ModuleGraph {
  const ids = new Set<string>(entries)
  for (const [a, b] of [...edges, ...dynamic]) { ids.add(a); ids.add(b) }
  const pick = (list: Array<[string, string]>, side: 0 | 1, id: string) =>
    list.filter(edge => edge[side] === id).map(edge => edge[side === 0 ? 1 : 0])
  return {
    getModuleIds: () => ids.values(),
    getModuleInfo: id => ids.has(id)
      ? {
          isEntry: entries.includes(id),
          importedIds: pick(edges, 0, id),
          dynamicallyImportedIds: pick(dynamic, 0, id),
          importers: pick(edges, 1, id),
          dynamicImporters: pick(dynamic, 1, id),
        }
      : null,
  }
}

describe('studio chunk reach', () => {
  it('claims a package that only the studio sources import, through other packages and a lazy import', () => {
    const graph = graphOf(
      [ENTRY],
      [[STUDIO, '/nm/react-markdown/index.js'], ['/nm/react-markdown/index.js', '/nm/remark-gfm/index.js']],
      [[ENTRY, STUDIO]],
    )
    const reach = studioReach()
    expect(reach.reachedOnlyByStudio('/nm/remark-gfm/index.js', graph)).toBe(true)
    expect(reach.reachedOnlyByStudio(ENTRY, graph)).toBe(false)
  })

  it('leaves a package that the chat also imports in the shared chunk', () => {
    const graph = graphOf(
      [ENTRY],
      [[ENTRY, CHAT], [CHAT, '/nm/react-markdown/index.js'], [STUDIO, '/nm/react-markdown/index.js'],
        ['/nm/react-markdown/index.js', '/nm/remark-gfm/index.js']],
      [[ENTRY, STUDIO]],
    )
    const shared = modulesReachedOutsideStudio(graph)
    expect(shared.has('/nm/remark-gfm/index.js')).toBe(true)
    expect(shared.has(STUDIO)).toBe(false)
  })

  it('treats a module nothing imports as a root, and walks through cycles', () => {
    const graph = graphOf(
      [ENTRY],
      [[STUDIO, '/nm/a/index.js'], ['/nm/a/index.js', '/nm/b/index.js'], ['/nm/b/index.js', '/nm/a/index.js'],
        ['/nm/emitted/worker.js', '/nm/b/index.js']],
    )
    const shared = modulesReachedOutsideStudio(graph)
    expect(shared.has('/nm/a/index.js')).toBe(true)
    expect(shared.has('/nm/b/index.js')).toBe(true)
  })

  it('answers from the build it is in: a build start forgets the last graph', () => {
    const reach = studioReach()
    const before = graphOf([ENTRY], [[STUDIO, '/nm/x/index.js']], [[ENTRY, STUDIO]])
    expect(reach.reachedOnlyByStudio('/nm/x/index.js', before)).toBe(true)
    const after = graphOf([ENTRY], [[STUDIO, '/nm/x/index.js'], [ENTRY, '/nm/x/index.js']], [[ENTRY, STUDIO]])
    expect(reach.reachedOnlyByStudio('/nm/x/index.js', after)).toBe(true)
    ;(reach.plugin.buildStart as () => void)()
    expect(reach.reachedOnlyByStudio('/nm/x/index.js', after)).toBe(false)
  })
})
