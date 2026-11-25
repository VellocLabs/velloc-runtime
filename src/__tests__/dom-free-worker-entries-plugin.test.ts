import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DOM_FREE_WORKER_ENTRIES, domFreeWorkerEntriesPlugin } from '../../vite/domFreeWorkerEntriesPlugin'

describe('domFreeWorkerEntriesPlugin', () => {
  it.each(Object.entries(DOM_FREE_WORKER_ENTRIES))(
    '%s resolves to the entry its package lists for workers, which reads no document',
    (name, entry) => {
      const pkg = JSON.parse(
        readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'),
      ) as { exports: Record<string, string> }
      expect(entry.replaceAll('\\', '/')).toMatch(new RegExp(`${pkg.exports.worker.slice(1)}$`))
      expect(readFileSync(entry, 'utf8')).not.toMatch(/\bdocument\b/)
    },
  )

  it('takes the DOM-free entry in a Worker build, and on the page only under a Worker module', async () => {
    const [name, entry] = Object.entries(DOM_FREE_WORKER_ENTRIES)[0]!
    const resolveIn = async (isWorker: boolean, chain: string[]) => {
      const plugin = domFreeWorkerEntriesPlugin()
      ;(plugin.configResolved as (c: { isWorker: boolean }) => void)({ isWorker })
      const resolveId = plugin.resolveId as (
        this: unknown, source: string, importer: string | undefined, options: object,
      ) => Promise<unknown>
      const ctx = { resolve: async (source: string) => ({ id: `/nm/${source}.js`, external: false }) }
      for (let k = 0; k + 1 < chain.length; k++) await resolveId.call(ctx, chain[k + 1]!, chain[k], {})
      return resolveId.call(ctx, name, chain.at(-1), {})
    }
    expect(await resolveIn(true, ['/src/any.ts'])).toBe(entry)
    expect(await resolveIn(false, ['/src/page.tsx'])).toBeNull()
    expect(await resolveIn(false, ['/src/a/markdown-parse.worker.ts'])).toBe(entry)
    expect(await resolveIn(false, ['/src/a/markdown-parse.worker.ts', 'micromark', '/nm/micromark.js'])).toBe(entry)
  })
})
