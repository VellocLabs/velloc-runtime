import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as client from '../browser/webview/BrowserRuntimeClient'
import { createSharedWorkerTransport } from '../browser/webview/sharedWorkerTransport'
import { setModelUploadHandler } from '../browser/webview/workerDebugLog'

/**
 * Guards for the modules beside `BrowserRuntimeClient.ts`: none imports the
 * client (the graph stays a DAG), the detail requests stay behind `import()`,
 * and the client still exports the names it re-exports. Behaviour is pinned by
 * the suites that drive the client.
 */

const WEBVIEW = join(__dirname, '..', 'browser', 'webview')
const read = (file: string): string => readFileSync(join(WEBVIEW, file), 'utf8')

const HELPERS = [
  'sharedWorkerTransport.ts',
  'browserRuntimeClientState.ts',
  'RuntimeClientParkedInput.ts',
  'RuntimeClientDetailRequests.ts',
  'RuntimeClientFileRequests.ts',
  'workerDebugLog.ts',
]

describe('BrowserRuntimeClient modules', () => {
  it.each(HELPERS)('%s does not import the client', file => {
    expect(read(file)).not.toMatch(/from\s+'\.\/BrowserRuntimeClient'/)
  })

  it('reaches the detail requests only through import()', () => {
    const source = read('BrowserRuntimeClient.ts')
    expect(source).toContain("import('./RuntimeClientDetailRequests')")
    const staticImports = source.match(/^import\s+(?!type\b)[^']*?from\s+'\.\/RuntimeClientDetailRequests'/gm)
    expect(staticImports).toBeNull()
  })

  it('re-exports the moved runtime names from the client', () => {
    expect(client.createSharedWorkerTransport).toBe(createSharedWorkerTransport)
    expect(client.setModelUploadHandler).toBe(setModelUploadHandler)
    expect(typeof client.createBrowserRuntimeSharedWorker).toBe('function')
    expect(typeof client.BrowserRuntimeClient).toBe('function')
  })
})
