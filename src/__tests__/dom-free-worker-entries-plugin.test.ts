import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DOM_FREE_WORKER_ENTRIES } from '../../vite/domFreeWorkerEntriesPlugin'

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
})
