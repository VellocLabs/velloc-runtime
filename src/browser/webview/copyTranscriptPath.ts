import { transcriptPathForSession } from './searchTargets'
import type { SessionListItem } from './SessionRows'

/**
 * Contract: returns a handler that writes the absolute transcript path of a
 * listed session to the clipboard. An unknown session, a home-dir failure or
 * a failed write is swallowed — the gesture is a hidden convenience with no
 * UI of its own. Resolves to the copied path, or null.
 *
 * The home directory is resolved once and kept, so every copy after the first
 * calls `writeText` synchronously inside the click that asked for it.
 */
export function createCopyTranscriptPath(
  resolveHomeDir: () => Promise<string>,
  getSessions: () => readonly SessionListItem[],
  writeText: (text: string) => Promise<boolean>,
): (sessionId: string) => Promise<string | null> {
  let homeDir: string | null = null
  return async sessionId => {
    const session = getSessions().find(item => item.sessionId === sessionId)
    if (!session) return null
    try {
      homeDir ??= await resolveHomeDir()
      const path = transcriptPathForSession(homeDir, session)
      return (await writeText(path)) ? path : null
    } catch {
      return null
    }
  }
}
