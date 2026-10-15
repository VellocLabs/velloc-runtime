import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')
const ENTRY = join(SRC, 'browser', 'webview', 'e2eTestModules.ts')

/** The handles the e2e suite calls through `__NEXUS_E2E__.loadTestModules()`. */
const HANDLES = [
  'connectRuntime',
  'connectRuntimeOverSharedWorker',
  'createRuntimeFileAccess',
  'createWebSocketTransport',
  'createBrowserRuntimeSharedWorker',
  'getWorkspaceStore',
  'warmColdUi',
]

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })

describe('e2e test modules', () => {
  it('exports every handle the e2e suite drives', async () => {
    const mod: Record<string, unknown> = await import('../browser/webview/e2eTestModules')
    for (const name of HANDLES) expect(typeof mod[name], name).toBe('function')
  })

  it('is reached only through a dynamic import, never a static one', () => {
    const importers: string[] = []
    for (const file of walk(SRC)) {
      if (file === ENTRY) continue
      const source = readFileSync(file, 'utf8')
      if (/from\s+['"][^'"]*e2eTestModules['"]/.test(source)) {
        importers.push(relative(SRC, file).split(sep).join('/'))
      }
    }
    expect(importers).toEqual([])
  })
})
