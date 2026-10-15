/**
 * The Claude Code import source. Location/detection of its files
 * (`~/.claude/projects/<slug>/<uuid>.jsonl`) is the adapter's concern
 * (`browser/bridge/adapter/sessionImportBridgeAdapter.ts`); this module is
 * the pure parse + convert half that runs in the import Worker.
 */

import type { ImportSourceAdapter } from '../../protocol'
import { convert } from './convert'
import { listSessionRows } from './parseLite'
import { TERMINAL_AGENT_SOURCE_ID } from './sourceIdentity'

export const terminalAgentImportSource: ImportSourceAdapter = {
  source: TERMINAL_AGENT_SOURCE_ID,
  parseLite: listSessionRows,
  convert,
}
