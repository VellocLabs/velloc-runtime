/**
 * Read, admit, compile and scan one hooks module that runs outside a session
 * (a provider module, F-27; an app's background module, F-40) before its
 * worker is spawned. The uses check is the caller's admission.
 */

import { errorMessage } from './chainRules'
import { refuseModuleSource } from './modAdmission'
import type { ModBuildStore, ModCompileFn } from './modBuildStore'
import type { ModCompileGraph } from './modCompiler'
import type { ModModuleRef } from './ModRuntime'
import type { ModUses } from './modScan'

/** The module's text could not be read: environmental (a file lock, a plugin
 *  directory swapped by an update, a bridge not ready), so it is read again
 *  later — unlike a refusal, which is final. */
export class ModuleUnreadable extends Error {}

/** The module cannot load as it is: refused or failed, not retried. */
export class ModuleRefused extends Error {
  constructor(
    readonly state: 'refused' | 'failed',
    reason: string,
  ) {
    super(reason)
  }
}

export type ModulePrepareDeps = {
  readModule: (path: string) => Promise<string>
  compile?: ModCompileFn
  scan?: (ref: ModModuleRef, source: string) => Promise<ModUses>
  builds?: ModBuildStore
  report: (line: string) => void
}

/**
 * The module's text, admitted and compiled; unchanged files come from the
 * build store. Throws `ModuleUnreadable` or `ModuleRefused`. `uses` is what
 * the scan found, when it ran; `refuseUses` decides whether it is admitted.
 */
export async function prepareModule(
  ref: ModModuleRef,
  deps: ModulePrepareDeps,
  refuseUses: (uses: ModUses) => string | null,
): Promise<{ source: string; uses?: ModUses }> {
  const kept = await deps.builds?.lookup(ref).catch(() => null)
  if (kept) {
    if (kept.uses) {
      const refusedUses = refuseUses(kept.uses)
      if (refusedUses) throw new ModuleRefused('refused', refusedUses)
    }
    return { source: kept.source, ...(kept.uses ? { uses: kept.uses } : {}) }
  }
  let source: string
  try {
    source = await deps.readModule(ref.path)
  } catch (error) {
    throw new ModuleUnreadable(`${ref.path} could not be read (${errorMessage(error)})`)
  }
  const refused = refuseModuleSource(ref.path, source, deps.compile !== undefined)
  if (refused) throw new ModuleRefused('refused', refused)
  const original = source
  let uses: ModUses | undefined
  let graph: ModCompileGraph | undefined
  let files: readonly string[] = [ref.path]
  // Every module goes through the compiler when there is one: it compiles
  // what needs it and verifies the rest (`compileModModule`).
  if (deps.compile) {
    try {
      const previous = await deps.builds?.previous?.(ref).catch(() => null)
      const built = await deps.compile(ref, source, previous)
      source = typeof built === 'string' ? built : built.source
      if (typeof built !== 'string') ({ uses, files, graph } = built)
    } catch (error) {
      throw new ModuleRefused('refused', `it did not compile — ${errorMessage(error)}`)
    }
  }
  if (!uses && deps.scan) {
    try {
      uses = await deps.scan(ref, original)
    } catch (error) {
      deps.report(`${ref.plugin}: the scan failed (${errorMessage(error)}); what it calls is checked at the call`)
    }
  }
  if (deps.builds) {
    void deps.builds.remember(ref, {
      source,
      entrySource: original,
      compiled: source !== original,
      files,
      ...(uses ? { uses } : {}),
      ...(graph ? { graph } : {}),
    })
  }
  if (uses) {
    const refusedUses = refuseUses(uses)
    if (refusedUses) throw new ModuleRefused('refused', refusedUses)
  }
  return { source, ...(uses ? { uses } : {}) }
}
