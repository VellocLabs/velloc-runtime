import { describe, expect, it } from 'vitest'
import { reachedOnlyByStudio, type ModuleGraph } from '../../vite/studioChunks'

const STUDIO = 'C:\\w\\nexus_web\\src\\browser\\webview\\a2ui\\studio\\StudioAppSurface.tsx'
const CHAT = '/w/nexus_web/src/browser/webview/chat/Markdown.tsx'

function graphOf(edges: Record<string, string[]>, dynamic: Record<string, string[]> = {}): ModuleGraph {
  return {
    getModuleInfo: id => ({ importers: edges[id] ?? [], dynamicImporters: dynamic[id] ?? [] }),
  }
}

describe('reachedOnlyByStudio', () => {
  it('claims a package that only the studio sources import, through other packages', () => {
    const graph = graphOf({
      '/nm/react-markdown/index.js': [STUDIO],
      '/nm/remark-gfm/index.js': ['/nm/react-markdown/index.js'],
    })
    expect(reachedOnlyByStudio('/nm/remark-gfm/index.js', graph, new Map())).toBe(true)
  })

  it('leaves a package that the chat also imports in the shared chunk', () => {
    const graph = graphOf({
      '/nm/react-markdown/index.js': [STUDIO, CHAT],
      '/nm/remark-gfm/index.js': ['/nm/react-markdown/index.js'],
      [CHAT]: ['/w/nexus_web/src/main.tsx'],
    })
    const memo = new Map<string, boolean>()
    expect(reachedOnlyByStudio('/nm/remark-gfm/index.js', graph, memo)).toBe(false)
    expect(reachedOnlyByStudio('/nm/react-markdown/index.js', graph, memo)).toBe(false)
  })

  it('counts dynamic importers, and a module nobody imports is not the studio\'s', () => {
    const graph = graphOf({ '/nm/zod/v3/index.js': [] }, { '/nm/zod/v3/index.js': [CHAT] })
    expect(reachedOnlyByStudio('/nm/zod/v3/index.js', graph, new Map())).toBe(false)
    expect(reachedOnlyByStudio('/nm/orphan/index.js', graphOf({}), new Map())).toBe(false)
  })

  it('settles a cycle by the importers outside it', () => {
    const cycle = graphOf({
      '/nm/a/index.js': ['/nm/b/index.js', STUDIO],
      '/nm/b/index.js': ['/nm/a/index.js'],
    })
    expect(reachedOnlyByStudio('/nm/b/index.js', cycle, new Map())).toBe(true)
    const shared = graphOf({
      '/nm/a/index.js': ['/nm/b/index.js', STUDIO],
      '/nm/b/index.js': ['/nm/a/index.js', CHAT],
      [CHAT]: ['/w/nexus_web/src/main.tsx'],
    })
    const memo = new Map<string, boolean>()
    expect(reachedOnlyByStudio('/nm/a/index.js', shared, memo)).toBe(false)
    expect(reachedOnlyByStudio('/nm/b/index.js', shared, memo)).toBe(false)
  })
})
