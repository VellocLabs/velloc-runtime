import { createHash } from 'node:crypto'
import path from 'node:path'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

// Security: the kernel's DedicatedWorkers run with an opaque origin, spawned
// from `data:` URLs by a sandboxed `srcdoc` iframe whose CSP they inherit
// (SandboxedWorkerHost.ts). An app-origin chunk would need CORS, or a CSP that
// reopens egress, so each is bundled here into self-contained text:
//   spawnerFrameSrcdoc / spawnerFrameCsp        the frame document and its policy
//   modSpawnerFrameSrcdoc / modSpawnerFrameCsp  the same without 'unsafe-eval'
//                                               (the frame mod workers come from)
//   runJsWorkerUrl / modWorkerUrl               the workers, as data: URLs
// The inline script is admitted by its SHA-256 (no 'unsafe-inline'), hashed
// over the exact text placed between the tags. Dev and build share this path;
// registered in `vite.config.ts` and `vitest.config.mjs`.

export const ISOLATED_WORKER_SOURCES_VIRTUAL_ID = 'virtual:isolated-worker-sources'
const RESOLVED_ID = `\0${ISOLATED_WORKER_SOURCES_VIRTUAL_ID}`

const SPAWNER_FRAME_ENTRY = 'src/browser/workerKernel/spawnerFrame.entry.ts'
const RUN_JS_WORKER_ENTRY = 'src/browser/runJs/runJs.worker.ts'
const MOD_WORKER_ENTRY = 'src/mods/mod.worker.ts'

/**
 * Security: the spawner frame's Content-Security-Policy, which every worker it
 * spawns inherits (Blink applies the owner's CSP to a worker on a local scheme).
 *
 *   default-src 'none'      no fetch / XHR / WebSocket / EventSource (the
 *                           connect-src fallback), no image, no frame — the
 *                           request-shaped egress realm hardening cannot close
 *   script-src <hash>       the one inline spawner script, by hash
 *              'unsafe-eval' run_js evaluates the model's script with
 *                           `new AsyncFunction(code)`
 *              data:        `import('data:…')` of a bundle handed in as text;
 *                           an `import('https://…')` is refused HERE
 *   worker-src data:        the workers themselves
 */
export function spawnerFrameCsp(
  frameScriptHash: string,
  /** `allowEval: false` is the mod frame's policy (F-25): a
   *  hooks module is imported as `data:`, so nothing in that frame needs
   *  `eval`, `new Function` or a string timer — and a mod gets none. */
  options: { allowEval: boolean } = { allowEval: true },
): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${frameScriptHash}'${options.allowEval ? " 'unsafe-eval'" : ''} data:`,
    'worker-src data:',
  ].join('; ')
}

/** The frame's whole document. `script` goes between the tags verbatim — the
 *  CSP hash is over exactly these bytes. */
export function spawnerFrameSrcdoc(
  script: string,
  options: { allowEval: boolean } = { allowEval: true },
): string {
  if (/<\/script/i.test(script)) {
    // Would end the inline script early (and change what the hash covers).
    throw new Error(
      'isolated-worker-sources: the spawner frame bundle contains "</script"',
    )
  }
  const hash = createHash('sha256').update(script, 'utf8').digest('base64')
  return (
    '<!doctype html><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${spawnerFrameCsp(hash, options)}">` +
    `<script>${script}</script>`
  )
}

/** A module-worker `data:` URL for a self-contained ESM text. */
export function moduleDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
}

type Bundled = { text: string; inputs: string[] }

async function bundle(
  root: string,
  entry: string,
  format: 'iife' | 'esm',
  minify: boolean,
): Promise<Bundled> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [path.resolve(root, entry)],
    bundle: true,
    write: false,
    format,
    platform: 'browser',
    target: 'es2022',
    minify,
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
  })
  const [file] = result.outputFiles
  if (!file) throw new Error(`isolated-worker-sources: no output for ${entry}`)
  return {
    text: file.text,
    inputs: Object.keys(result.metafile.inputs).map(input => path.resolve(root, input)),
  }
}

export type IsolatedWorkerSources = {
  spawnerFrameSrcdoc: string
  spawnerFrameCsp: string
  modSpawnerFrameSrcdoc: string
  modSpawnerFrameCsp: string
  runJsWorkerUrl: string
  modWorkerUrl: string
  /** Every source file the strings were built from. */
  inputs: string[]
}

export async function buildIsolatedWorkerSources(
  root: string,
  options: { minify: boolean },
): Promise<IsolatedWorkerSources> {
  const [frame, runJs, mod] = await Promise.all([
    bundle(root, SPAWNER_FRAME_ENTRY, 'iife', options.minify),
    bundle(root, RUN_JS_WORKER_ENTRY, 'esm', options.minify),
    bundle(root, MOD_WORKER_ENTRY, 'esm', options.minify),
  ])
  // A worker bundle must be self-contained: nothing left for the opaque-origin
  // worker to import (its CSP would refuse it anyway — fail the build instead
  // of the first run). The mod worker's one DYNAMIC `import()` — of the hooks
  // module's text as a `data:` URL — is not a static import and is the point.
  for (const [entry, bundled] of [
    [RUN_JS_WORKER_ENTRY, runJs],
    [MOD_WORKER_ENTRY, mod],
  ] as const) {
    if (/^\s*(import|export)\s[^;]*\sfrom\s/m.test(bundled.text)) {
      throw new Error(
        `isolated-worker-sources: ${entry} did not bundle to one module`,
      )
    }
  }
  const script = frame.text.trim()
  const hash = createHash('sha256').update(script, 'utf8').digest('base64')
  return {
    spawnerFrameSrcdoc: spawnerFrameSrcdoc(script),
    spawnerFrameCsp: spawnerFrameCsp(hash),
    modSpawnerFrameSrcdoc: spawnerFrameSrcdoc(script, { allowEval: false }),
    modSpawnerFrameCsp: spawnerFrameCsp(hash, { allowEval: false }),
    runJsWorkerUrl: moduleDataUrl(runJs.text),
    modWorkerUrl: moduleDataUrl(mod.text),
    inputs: [...new Set([...frame.inputs, ...runJs.inputs, ...mod.inputs])],
  }
}

export function isolatedWorkerSourcesPlugin(): Plugin {
  let minify = false
  return {
    name: 'isolated-worker-sources',
    configResolved(config) {
      minify = config.command === 'build'
    },
    resolveId(id) {
      return id === ISOLATED_WORKER_SOURCES_VIRTUAL_ID ? RESOLVED_ID : null
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null
      // cwd, not `import.meta.url`: correct whether this module is imported
      // natively (vite.config.ts) or bundled (vitest.config.mjs) — the same
      // reason as bundledTemplateRegistryPlugin.
      const sources = await buildIsolatedWorkerSources(process.cwd(), { minify })
      for (const input of sources.inputs) this.addWatchFile(input)
      return [
        `export const spawnerFrameSrcdoc = ${JSON.stringify(sources.spawnerFrameSrcdoc)}`,
        `export const spawnerFrameCsp = ${JSON.stringify(sources.spawnerFrameCsp)}`,
        `export const modSpawnerFrameSrcdoc = ${JSON.stringify(sources.modSpawnerFrameSrcdoc)}`,
        `export const modSpawnerFrameCsp = ${JSON.stringify(sources.modSpawnerFrameCsp)}`,
        `export const runJsWorkerUrl = ${JSON.stringify(sources.runJsWorkerUrl)}`,
        `export const modWorkerUrl = ${JSON.stringify(sources.modWorkerUrl)}`,
        '',
      ].join('\n')
    },
  }
}
