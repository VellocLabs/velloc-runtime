/**
 * Import-source registry. Adding a provider: drop `sources/<source>/`
 * exporting an `ImportSourceAdapter`, add the id to `ImportSource` in
 * `../protocol.ts`, and list it here. Nothing else in the app changes.
 */

import type { ImportSource, ImportSourceAdapter } from '../protocol'
import { terminalAgentImportSource } from './claude-code'
import { TERMINAL_AGENT_SOURCE_ID } from './claude-code/sourceIdentity'
import { codexImportSource } from './codex'

export { TERMINAL_AGENT_SOURCE_ID }

const SOURCES: Record<ImportSource, ImportSourceAdapter> = {
  [TERMINAL_AGENT_SOURCE_ID]: terminalAgentImportSource,
  codex: codexImportSource,
}

export function getImportSource(source: ImportSource): ImportSourceAdapter {
  const adapter = SOURCES[source]
  if (!adapter) {
    throw new Error(`Unknown import source: ${String(source)}`)
  }
  return adapter
}
