import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  read,
  rel,
  SRC,
  staticClosure,
  staticImportPath,
  stripComments,
} from './_helpers/staticImportGraph'

/**
 * What the boot keeps off its static graph. The entry chunk (`glic/main.tsx`)
 * runs before the host handshake, so the host tool definitions load through
 * `import()` from `nexusBoot.ts`.
 */

const ENTRY = join(SRC, 'glic', 'main.tsx')
const NEXUS_BOOT = join(SRC, 'browser', 'boot', 'nexusBoot.ts')
const HOST_TOOLS = join(SRC, 'toolkit', 'builtin', 'host', 'index.ts')
const HOST_BROWSER_TOOLS = join(SRC, 'toolkit', 'builtin', 'host', 'browser.ts')

describe('entry chunk', () => {
  const entryClosure = staticClosure([ENTRY])

  it('reaches nexusBoot statically', () => {
    // Without this edge the assertions below test nothing.
    expect(entryClosure.has(NEXUS_BOOT)).toBe(true)
  })

  it.each([HOST_TOOLS, HOST_BROWSER_TOOLS])('keeps %s off the static graph', file => {
    expect(
      entryClosure.has(file),
      `${rel(file)} is reachable from glic/main.tsx through STATIC imports, so the `
      + 'bundler puts the host tool definitions back into the entry chunk. Reach '
      + 'them through the import() in nexusBoot.ts instead. Chain: '
      + staticImportPath(ENTRY, file).join(' -> '),
    ).toBe(false)
  })

  it('loads the host tool definitions with import()', () => {
    expect(stripComments(read(NEXUS_BOOT))).toContain(
      "import('../../toolkit/builtin/host')",
    )
  })
})
