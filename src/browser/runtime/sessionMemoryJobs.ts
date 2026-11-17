import type { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import { registerMemoryConsolidator } from '../../memory/consolidate/consolidationRunner'
import { registerMemoryExtractor } from '../../memory/extract/extractionRunner'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import type { SidechainTranscriptStore } from '../../utils/sidechainTranscripts'

export type SessionMemoryJobsInput = {
  runtimeConfig: BrowserRuntimeConfig
  installedSidechainStore: SidechainTranscriptStore | null
  backend: BrowserConversationStorageBackend | undefined
  sidechainBasePath: string | undefined
}

/** Registers this runtime's end-of-turn memory extraction and its background memory consolidation. */
export function registerSessionMemoryJobs({
  runtimeConfig,
  installedSidechainStore,
  backend,
  sidechainBasePath,
}: SessionMemoryJobsInput): void {
  // Memory extraction (fire-and-forget at end of turn), with the same sidechain store. Off under
  // `e2eTrace` unless `e2eEnableExtractMemories`; production sets neither.
  if (
    !runtimeConfig.flagOn('e2eTrace') ||
    runtimeConfig.flagOn('e2eEnableExtractMemories')
  ) {
    registerMemoryExtractor({
      runtimeConfig,
      sidechainStore: installedSidechainStore ?? undefined,
    })
  }

  // Background memory consolidation, gated by time + session count + lock; the same e2e suppression
  // (re-enabled by `e2eEnablePeriodicTidy`). No base path → the session-count gate makes it inert.
  if (
    !runtimeConfig.flagOn('e2eTrace') ||
    runtimeConfig.flagOn('e2eEnablePeriodicTidy')
  ) {
    // e2e-only threshold overrides so the dedicated periodic-tidy spec can fire the
    // consolidation fork in a single turn without seeding 24h + 5 sessions.
    // Production guest URLs never set these query params → config is undefined →
    // the hardcoded MIN_HOURS/MIN_SESSIONS defaults apply.
    const numEnv = (name: string): number | undefined => {
      const v = runtimeConfig.getEnv(name)
      if (v === undefined) return undefined
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    const minSessionsOverride = numEnv('e2ePeriodicTidyMinSessions')
    const minHoursOverride = numEnv('e2ePeriodicTidyMinHours')
    const periodicTidyConfig =
      minSessionsOverride !== undefined || minHoursOverride !== undefined
        ? {
            ...(minSessionsOverride !== undefined
              ? { minSessions: minSessionsOverride }
              : {}),
            ...(minHoursOverride !== undefined
              ? { minHours: minHoursOverride }
              : {}),
          }
        : undefined
    registerMemoryConsolidator({
      runtimeConfig,
      sidechainStore: installedSidechainStore ?? undefined,
      listSessions: backend?.listSessions
        ? () => backend.listSessions!()
        : undefined,
      historyFolder: sidechainBasePath,
      config: periodicTidyConfig,
    })
  }
}
