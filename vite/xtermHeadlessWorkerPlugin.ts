import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * Makes `@xterm/headless` load in the runtime's SharedWorker (F-31): its ES
 * build's `"requestIdleCallback" in window` is asked of `globalThis`, and the
 * ES build is resolved by path (the package's `module` field names a missing
 * file). Contract: throws at transform time unless the check occurs exactly
 * once, so an upgrade that changes it fails the build, not the worker.
 */
export const XTERM_HEADLESS_ESM = path.resolve(
  __dirname,
  '../node_modules/@xterm/headless/lib-headless/xterm-headless.mjs',
)

const WINDOW_CHECK = '"requestIdleCallback"in window'
const GLOBAL_CHECK = '"requestIdleCallback"in globalThis'

export function rewriteXtermHeadless(code: string): string {
  const parts = code.split(WINDOW_CHECK)
  if (parts.length !== 2) {
    throw new Error(
      `xtermHeadlessWorkerPlugin: expected the window check once in @xterm/headless, found it ${parts.length - 1} times`,
    )
  }
  return parts.join(GLOBAL_CHECK)
}

const isHeadlessEsm = (id: string): boolean =>
  path.normalize(id.split('?')[0]!).toLowerCase() === path.normalize(XTERM_HEADLESS_ESM).toLowerCase()

export function xtermHeadlessWorkerPlugin(): Plugin {
  return {
    name: 'velloc-xterm-headless-worker',
    enforce: 'pre',
    config: () => ({
      resolve: { alias: { '@xterm/headless': XTERM_HEADLESS_ESM } },
      // Served as-is in dev, so the rewrite below applies there too.
      optimizeDeps: { exclude: ['@xterm/headless'] },
    }),
    transform(code, id) {
      if (!isHeadlessEsm(id)) return null
      return { code: rewriteXtermHeadless(code), map: null }
    },
  }
}
