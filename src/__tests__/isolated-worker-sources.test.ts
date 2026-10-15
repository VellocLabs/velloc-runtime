/**
 * What the `isolated-worker-sources` plugin hands the page: the spawner
 * frame's document and run_js's worker, as text. The policy in that document
 * is the engine-enforced half of the sandbox, so its exact shape is pinned.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  modSpawnerFrameCsp,
  modSpawnerFrameSrcdoc,
  modWorkerUrl,
  runJsWorkerUrl,
  spawnerFrameCsp,
  spawnerFrameSrcdoc,
} from 'virtual:isolated-worker-sources'
import {
  moduleDataUrl,
  spawnerFrameCsp as buildCsp,
  spawnerFrameSrcdoc as buildSrcdoc,
} from '../../vite/isolatedWorkerSourcesPlugin'

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
}

function decodeDataUrl(url: string): string {
  const prefix = 'data:text/javascript;base64,'
  expect(url.startsWith(prefix)).toBe(true)
  return Buffer.from(url.slice(prefix.length), 'base64').toString('utf8')
}

describe('the spawner frame document', () => {
  it('carries exactly one inline script, admitted by its hash', () => {
    const scripts = inlineScripts(spawnerFrameSrcdoc)
    expect(scripts).toHaveLength(1)
    const hash = createHash('sha256').update(scripts[0]!, 'utf8').digest('base64')
    expect(spawnerFrameCsp).toContain(`'sha256-${hash}'`)
    expect(spawnerFrameSrcdoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${spawnerFrameCsp}">`,
    )
    // The policy precedes the script it has to admit.
    expect(spawnerFrameSrcdoc.indexOf('Content-Security-Policy')).toBeLessThan(
      spawnerFrameSrcdoc.indexOf('<script>'),
    )
  })

  it('states the policy every worker inherits', () => {
    const directives = Object.fromEntries(
      spawnerFrameCsp.split('; ').map(d => {
        const [name, ...values] = d.split(' ')
        return [name, values]
      }),
    )
    expect(Object.keys(directives).sort()).toEqual(['default-src', 'script-src', 'worker-src'])
    // No connect-src of its own: fetch / XHR / WebSocket fall back to this.
    expect(directives['default-src']).toEqual(["'none'"])
    expect(directives['worker-src']).toEqual(['data:'])
    const script = directives['script-src']!
    expect(script).toHaveLength(3)
    expect(script[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/)
    // run_js's AsyncFunction eval, and `import('data:…')` of a text bundle.
    expect(script.slice(1)).toEqual(["'unsafe-eval'", 'data:'])
    // Never these: an inline allowance wider than the one script, or any
    // network origin a worker could then import from.
    expect(spawnerFrameCsp).not.toContain("'unsafe-inline'")
    expect(spawnerFrameCsp).not.toMatch(/https?:|\*|'self'|blob:/)
  })

  it('is the kernel host: it announces itself and installs on frameInit', () => {
    const [script] = inlineScripts(spawnerFrameSrcdoc)
    expect(script).toContain('workerHost.frameReady')
    expect(script).toContain('workerHost.frameInit')
    expect(script).toContain('worker.spawned')
  })

  it('refuses a script that would close its own tag', () => {
    expect(() => buildSrcdoc('var a = "</script>"')).toThrow(/<\/script/)
    expect(() => buildSrcdoc('var a = "</SCRIPT >"')).toThrow()
    expect(buildSrcdoc('var a = 1')).toContain('<script>var a = 1</script>')
  })

  it('builds the policy around the hash it is given', () => {
    expect(buildCsp('HASH')).toBe(
      "default-src 'none'; script-src 'sha256-HASH' 'unsafe-eval' data:; worker-src data:",
    )
    expect(buildCsp('HASH', { allowEval: false })).toBe(
      "default-src 'none'; script-src 'sha256-HASH' data:; worker-src data:",
    )
  })
})

describe("the mod frame document (F-25)", () => {
  it('is the same spawner script under a policy without unsafe-eval', () => {
    expect(inlineScripts(modSpawnerFrameSrcdoc)).toEqual(inlineScripts(spawnerFrameSrcdoc))
    expect(modSpawnerFrameSrcdoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${modSpawnerFrameCsp}">`,
    )
    expect(modSpawnerFrameCsp).not.toContain("'unsafe-eval'")
    expect(modSpawnerFrameCsp).toBe(spawnerFrameCsp.replace(" 'unsafe-eval'", ''))
    // The one hash admits the one script in both documents.
    const [script] = inlineScripts(modSpawnerFrameSrcdoc)
    const hash = createHash('sha256').update(script!, 'utf8').digest('base64')
    expect(modSpawnerFrameCsp).toContain(`'sha256-${hash}'`)
    expect(buildSrcdoc('var a = 1', { allowEval: false })).not.toContain('unsafe-eval')
  })
})

describe('the run_js worker bundle', () => {
  it('is one self-contained module on a data: URL', () => {
    const source = decodeDataUrl(runJsWorkerUrl)
    // Nothing left to import: an opaque-origin worker could not, and its CSP
    // would refuse it.
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\sfrom\s+["']\.{0,2}\//)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })

  it('is the run_js worker: it hardens the realm and waits for worker.init', () => {
    const source = decodeDataUrl(runJsWorkerUrl)
    expect(source).toContain('worker.init')
    expect(source).toContain('importScripts')
    expect(source).toContain('k.started')
  })

  it('round-trips non-ASCII source through the data: URL', () => {
    const text = 'export const s = "— ⇄ 你好"'
    expect(decodeDataUrl(moduleDataUrl(text))).toBe(text)
  })
})

describe('the mod worker bundle', () => {
  it('is one self-contained module on a data: URL', () => {
    const source = decodeDataUrl(modWorkerUrl)
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\sfrom\s+["']\.{0,2}\//)
  })

  it('is the mod worker: it hardens the realm, waits for worker.init, and speaks mod.*', () => {
    const source = decodeDataUrl(modWorkerUrl)
    expect(source).toContain('worker.init')
    expect(source).toContain('importScripts')
    expect(source).toContain('mod.loaded')
    expect(source).toContain('mod.invoke')
  })

  it('keeps exactly one dynamic import: the hooks module, as a data: URL', () => {
    // The worker's CSP admits `data:` scripts and nothing else, so this one
    // import can only ever load text the runtime handed it.
    const source = decodeDataUrl(modWorkerUrl)
    expect(source.match(/\bimport\s*\(/g)).toHaveLength(1)
    expect(source).toContain('data:text/javascript;base64,')
  })
})
