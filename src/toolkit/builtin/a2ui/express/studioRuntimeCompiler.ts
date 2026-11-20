// The runtime's Express compiler for the studio catalog (F-1): built from the
// generated description, so it needs no renderer and no DOM. Loaded lazily.

import type { StudioExpressCompiler } from './studioExpress'

let pending: Promise<StudioExpressCompiler> | null = null

export function getRuntimeStudioCompiler(): Promise<StudioExpressCompiler> {
  pending ??= (async () => {
    const [{ default: description }, { createStudioExpressCompiler }] = await Promise.all([
      import('./studio-catalog.json'),
      import('./studioExpress'),
    ])
    return createStudioExpressCompiler(description as unknown as Record<string, unknown>)
  })()
  pending.catch(() => { pending = null })
  return pending
}
