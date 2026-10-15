/**
 * Re-list the provider mods that read changed catalog keys (F-28): one pass per
 * update burst (`debounceMs`), never overlapping; a failed listing changes nothing;
 * a provider that read none of the changed keys is not touched.
 */
export type CatalogRelistingDeps = {
  /** Subscribe to `catalog.updated`; returns the unsubscribe. */
  onCatalogUpdated: (listener: (event: { providerKeys: string[] }) => void) => () => void
  /** The registered provider mods' provider ids. */
  providerIds: () => string[]
  /** The catalog provider keys one provider's module has read. */
  readKeysOf: (providerId: string) => string[]
  /** List one provider again (forced). True when new rows landed. Never rejects. */
  relist: (providerId: string) => Promise<boolean>
  /** Tell every open surface which providers' rows were replaced. */
  publish: (providerIds: string[]) => Promise<void>
  report: (line: string) => void
  /** Default 750 ms. */
  debounceMs?: number
  timers?: {
    set: (fn: () => void, ms: number) => unknown
    clear: (handle: unknown) => void
  }
}

export type CatalogRelisting = {
  /** The pass in progress, or a settled promise. For tests and shutdown. */
  idle(): Promise<void>
  dispose(): void
}

export function startCatalogRelisting(deps: CatalogRelistingDeps): CatalogRelisting {
  const set = deps.timers?.set ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = deps.timers?.clear ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  const wait = deps.debounceMs ?? 750
  const pending = new Set<string>()
  const running = new Set<string>()
  let timer: unknown
  let pass: Promise<void> = Promise.resolve()

  const runPass = async (): Promise<void> => {
    const changed = new Set(pending)
    pending.clear()
    const targets = deps
      .providerIds()
      .filter(id => deps.readKeysOf(id).some(key => changed.has(key)))
    const landed: string[] = []
    for (const id of targets) {
      if (running.has(id)) continue
      running.add(id)
      try {
        if (await deps.relist(id)) landed.push(id)
      } catch (error) {
        deps.report(`${id}: its models could not be listed again after the catalog changed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        running.delete(id)
      }
    }
    if (landed.length === 0) return
    try {
      await deps.publish(landed)
    } catch (error) {
      deps.report(`the refreshed model lists could not be published: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const unsubscribe = deps.onCatalogUpdated(event => {
    for (const key of event.providerKeys) pending.add(key)
    if (timer !== undefined) clear(timer)
    timer = set(() => {
      timer = undefined
      // Passes run one after another: a burst that straddles a pass queues one more.
      pass = pass.then(runPass, runPass)
    }, wait)
  })

  return {
    idle: async () => {
      await pass
    },
    dispose() {
      unsubscribe()
      if (timer !== undefined) clear(timer)
      timer = undefined
      pending.clear()
    },
  }
}
