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

  it('aliases each package for the page and its Workers, in build and dev alike', () => {
    const config = (domFreeWorkerEntriesPlugin().config as () => { resolve: { alias: Array<{ find: RegExp; replacement: string }> } })()
    for (const [name, entry] of Object.entries(DOM_FREE_WORKER_ENTRIES)) {
      const alias = config.resolve.alias.find((a) => a.find.test(name))!
      expect(alias.replacement).toBe(entry)
      expect(alias.find.test(`${name}/index.dom.js`)).toBe(false)
    }
  })
})
