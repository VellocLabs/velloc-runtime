/**
 * What `$.app.reseed()` leaves in an app's folder (F-40): the person's
 * `config.json`, the `data/` folder, and the manifest's data file.
 */

import type { PluginAppDecl } from '../ui/uiManifest'

export const RESEED_ALWAYS_KEPT: readonly string[] = Object.freeze(['config.json', 'data/'])

/** The app-relative paths a reseed never writes; a path ending in `/` is a folder. */
export function appReseedKeep(decl: Pick<PluginAppDecl, 'data'>): string[] {
  const keep = [...RESEED_ALWAYS_KEPT]
  if (decl.data) keep.push(decl.data.replaceAll('\\', '/').replace(/^\.\//, ''))
  return keep
}

export function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}
