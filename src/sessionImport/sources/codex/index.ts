/**
 * The Codex import provider — a binding of the pure `parseLite` (lite/list
 * pass) and `convert` (full transcript) onto the shared `ImportSourceAdapter`
 * interface. All translation reuse lives in `sessionImport/core/`; only the
 * Codex-specific rollout map is here.
 */

import type { ImportSourceAdapter } from '../../protocol'
import { convert } from './convert'
import { parseLite } from './parseLite'

export const codexImportSource: ImportSourceAdapter = {
  source: 'codex',
  parseLite,
  convert,
}
