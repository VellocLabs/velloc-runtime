/**
 * The table `$` is built from at `engine.create` (F-25): interface descriptors
 * between hooks and across the port. Shared by both ends.
 */

export type EngineTable = {
  /** Each noun on `$` and its methods — the engine's as `modNouns`
   *  implements them (`$.plugin`'s two values count as none), a plugin's as
   *  its step returned them. */
  nouns: Record<string, string[]>
  /** Who added each noun: `engine`, or the plugin's name. */
  owners: Record<string, string>
  /** The nouns a step withheld (left out of what it returned), by the plugin
   *  that did. */
  withheld: Record<string, string>
  /** A step returned without calling `next`: everything beneath it is
   *  withheld, by this plugin. */
  withheldAll?: string
}

export function isEngineTable(value: unknown): value is EngineTable {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const table = value as Record<string, unknown>
  const isStringRecord = (record: unknown): boolean =>
    record !== null &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    Object.values(record as Record<string, unknown>).every(entry => typeof entry === 'string')
  return (
    table.nouns !== null &&
    typeof table.nouns === 'object' &&
    !Array.isArray(table.nouns) &&
    Object.values(table.nouns as Record<string, unknown>).every(
      methods => Array.isArray(methods) && methods.every(method => typeof method === 'string'),
    ) &&
    isStringRecord(table.owners) &&
    isStringRecord(table.withheld) &&
    (table.withheldAll === undefined || typeof table.withheldAll === 'string')
  )
}
