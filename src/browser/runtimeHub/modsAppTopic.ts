/**
 * `mods/app/<sessionId>` (F-40): an app session's board. The snapshot and
 * every `state` delta carry the whole board, or null for a session with no
 * open app. Security: session-bound and `observe`; a connection bound to a
 * list of sessions sees the boards of those alone.
 */

import { appSurfaceState, onAppSurfaceChanged } from '../../mods/app/appSurfaceRegistry'
import {
  MODS_APP_STATE_EVENT,
  modsAppTopic,
  modsAppTopicSession,
  type AppSurfaceState,
} from '../runtimeProtocol/modApps'
import type { TopicId } from '../runtimeProtocol/frames'
import { scopeAllows } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export function modsAppTopicProvider(
  getState: (sessionId: string) => AppSurfaceState | null = appSurfaceState,
): TopicProvider {
  return {
    matches: (id: TopicId) => modsAppTopicSession(id) !== undefined,
    authorize: (id, conn) => {
      if (!scopeAllows(conn.scope.mode, 'observe')) return false
      const sessionId = modsAppTopicSession(id)
      return sessionId !== undefined && (conn.scope.sessions === 'all' || conn.scope.sessions.includes(sessionId))
    },
    async *snapshot(id): AsyncIterable<SnapshotPage> {
      const sessionId = modsAppTopicSession(id)
      yield { type: MODS_APP_STATE_EVENT, payload: sessionId ? getState(sessionId) : null }
    },
  }
}

/** Serves the topic and publishes each board change; the result stops publishing. */
export function registerModsAppTopic(
  broker: Pick<TopicBroker, 'registerProvider' | 'publish'>,
  onChanged: typeof onAppSurfaceChanged = onAppSurfaceChanged,
): () => void {
  broker.registerProvider(modsAppTopicProvider())
  return onChanged((sessionId, state) => broker.publish(modsAppTopic(sessionId), state, { type: MODS_APP_STATE_EVENT }))
}
