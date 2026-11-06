import { transcriptPathForSession } from './searchTargets'
import type { SessionListItem } from './SessionRows'

/**
 * Contract: returns a handler that writes the absolute transcript path of a
 * listed session to the clipboard. An unknown session, a home-dir failure or
 * a clipboard rejection is swallowed — the gesture is a hidden convenience
 * with no UI of its own. Resolves to the copied path, or null.
 */
export function createCopyTranscriptPath(
  resolveHomeDir: () => Promise<string>,
  getSessions: () => readonly SessionListItem[],
  writeText: (text: string) => Promise<void>,
): (sessionId: string) => Promise<string | null> {
  return async sessionId => {
    const session = getSessions().find(item => item.sessionId === sessionId)
    if (!session) return null
    try {
      const path = transcriptPathForSession(await resolveHomeDir(), session)
      await writeText(path)
      return path
    } catch {
      return null
    }
  }
}
