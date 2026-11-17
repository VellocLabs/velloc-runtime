/**
 * A hooks module's place in the mod slot (F-25), kept across the
 * generations of its worker.
 */

import type { ModModuleRef, ModWorkerHandle } from './modRuntimeContract'
import type { ModInstance } from './ModInstance'
import type { ModUses } from './modScan'
import type { ModLineMap } from './modLineMap'

export type Loaded = { instance: ModInstance; worker: ModWorkerHandle }

/** One module's place in the slot, across the generations of its worker. */
export type Seat = {
  /** Replaced when a reconcile brings the same path with other options. */
  ref: ModModuleRef
  /** The chain group's key: the plugin's name, `#n` for its nth module. */
  readonly key: string
  generation: number
  loaded?: Loaded
  /** The module's text as last read, before compiling — what a reload
   *  compares against ("changed modules only"). */
  source?: string
  /** What the compiler made of it, when it needed compiling — the whole
   *  graph's, so an edit to an imported file shows. */
  compiled?: string
  /** `compiled`'s lines back to source lines. */
  lines?: ModLineMap
  /** When each restart happened, for the limit. */
  restarts: number[]
  /** Hooks out of time in a row, this generation. */
  timeouts: number
  /** The last generation whose worker was lost: what its hooks still had
   *  running fails with the loss, which was reported already. */
  lostGeneration?: number
  timer?: ReturnType<typeof setTimeout>
  /** The files the loaded module was built from (the entry alone for a
   *  plain one), and their modification times as last read — what the dev
   *  loop compares at turn end. */
  files?: readonly string[]
  mtimes?: Map<string, number | undefined>
  /** The last load failed to compile: a reload compiles it again to see
   *  whether a fix (in the entry or a file it imports) landed. */
  compileFailed?: boolean
  /** What the module uses: the scan's calls / env / state, the
   *  registrations' events. */
  uses?: ModUses
  /** Hooks by name on a namespace no engine event is under (`voice.say`),
   *  admitted at the whole-set load on the chance a plugin's `engine.create`
   *  step adds the noun — held to the fold's table once it ran. */
  tentative?: string[]
}

/** `<root>/hooks/register.js` → `<root>`: the plugin directory a module's
 *  conventional place implies, for a ref that does not say. */
export function pluginRootOf(modulePath: string): string {
  const parts = modulePath.replace(/\\/g, '/').split('/')
  parts.pop()
  if (parts.length > 0 && parts[parts.length - 1] === 'hooks') parts.pop()
  return parts.join('/')
}
