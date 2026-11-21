/**
 * `mods/app/<sessionId>` (F-40): an app session's board. The snapshot and a
 * `state` event carry the whole board, or null for a session with no open
 * app; a `delta` event carries what changed since the event before; a `resync`
 * event carries nothing: the board is to be had from the snapshot again. Security: session-bound and `observe`; a connection bound to a
 * list of sessions sees the boards of those alone.
 */

import { appSurfaceBoard, onAppSurfaceChanged } from '../../mods/app/appSurfaceRegistry'
import {
  MODS_APP_DELTA_EVENT,
  MODS_APP_RESYNC_EVENT,
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
  getState: (sessionId: string) => AppSurfaceState | null | Promise<AppSurfaceState | null> = appSurfaceBoard,
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
      yield { type: MODS_APP_STATE_EVENT, payload: sessionId ? await getState(sessionId) : null }
    },
  }
}

/** Serves the topic and publishes each board change; the result stops publishing. */
export function registerModsAppTopic(
  broker: Pick<TopicBroker, 'registerProvider' | 'publish'>,
  onChanged: typeof onAppSurfaceChanged = onAppSurfaceChanged,
): () => void {
  broker.registerProvider(modsAppTopicProvider())
  return onChanged((sessionId, state, delta, live) =>
    delta
      ? broker.publish(modsAppTopic(sessionId), delta, { type: MODS_APP_DELTA_EVENT })
      : live
        ? broker.publish(modsAppTopic(sessionId), null, { type: MODS_APP_RESYNC_EVENT })
        : broker.publish(modsAppTopic(sessionId), state, { type: MODS_APP_STATE_EVENT }),
  )
}
