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
 * `import()` from `nexusBoot.ts`. The shell (`MultiSessionShell`) renders the
 * launchers and welcome pages from `templateCatalog.ts` and must not pull in
 * `templateRegistry`, whose bundled data carries every template body.
 */

const ENTRY = join(SRC, 'glic', 'main.tsx')
const NEXUS_BOOT = join(SRC, 'browser', 'boot', 'nexusBoot.ts')
const SHELL = join(SRC, 'browser', 'webview', 'MultiSessionShell.tsx')
const HOST_TOOLS = join(SRC, 'toolkit', 'builtin', 'host', 'index.ts')
const HOST_BROWSER_TOOLS = join(SRC, 'toolkit', 'builtin', 'host', 'browser.ts')
const TEMPLATE_REGISTRY = join(SRC, 'prompting', 'templateRegistry.ts')
const TEMPLATE_CATALOG = join(SRC, 'prompting', 'templateCatalog.ts')

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

describe('shell chunk', () => {
  const shellClosure = staticClosure([SHELL])

  it('renders launchers and welcome pages from the template catalog', () => {
    expect(shellClosure.has(TEMPLATE_CATALOG)).toBe(true)
  })

  it('keeps the template registry off the static graph', () => {
    expect(
      shellClosure.has(TEMPLATE_REGISTRY),
      `${rel(TEMPLATE_REGISTRY)} is reachable from MultiSessionShell through STATIC `
      + 'imports, so every bundled template body ships in the shell chunk. Read '
      + 'launchers and welcome pages from prompting/templateCatalog.ts instead. Chain: '
      + staticImportPath(SHELL, TEMPLATE_REGISTRY).join(' -> '),
    ).toBe(false)
  })

  it('reads the template catalog without the template registry data', () => {
    const source = stripComments(read(TEMPLATE_CATALOG))
    expect(source).toContain("from 'virtual:bundled-template-catalog'")
    expect(source).not.toContain('virtual:bundled-template-registry')
  })
})
