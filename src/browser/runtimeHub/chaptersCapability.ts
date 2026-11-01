/**
 * Chapter marks on the runtime protocol (F-37); shapes and scopes in `sessions/chapterProtocol.ts`. The
 * runtime's chapter book does the work; a client names a session and a place and reads the result off
 * the topic.
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  CHAPTERS_ACTION_SCOPES,
  CHAPTERS_CAPABILITY,
  CHAPTERS_EVENT,
  CHAPTERS_TOPIC_SCOPE,
  chaptersTopic,
  isChaptersMarkPayload,
  isChaptersUnmarkPayload,
  sessionOfChaptersPayload,
  sessionOfChaptersTopic,
  type ChaptersMarkPayload,
  type ChaptersMarkResult,
  type ChaptersState,
  type ChaptersUnmarkPayload,
  type ChaptersUnmarkResult,
} from '../../sessions/chapterProtocol'
import { getChapterBook, onChaptersChanged, type ChapterBook } from '../../sessions/chapterBook'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { ConnectionInfo, SnapshotPage, TopicProvider } from './types'

export type ChaptersCapabilityOptions = {
  /** Default: the realm's book (`setChapterBook`). */
  book?: () => ChapterBook | null
  /** Default: the book's change feed. */
  onChanged?: (listener: (sessionId: string) => void) => () => void
}

/** Whether `conn` may see `sessionId`: the session-topic rule. */
const seesSession = (conn: ConnectionInfo, sessionId: string): boolean =>
  conn.scope.sessions === 'all' || conn.scope.sessions.includes(sessionId)

export function registerChaptersCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: ChaptersCapabilityOptions = {},
): { publish(sessionId: string): Promise<void>; dispose(): void } {
  const bookOf = options.book ?? getChapterBook

  const state = async (sessionId: string): Promise<ChaptersState> => {
    const book = bookOf()
    return { sessionId, marks: book ? await book.marks(sessionId) : [] }
  }
  const book = (): ChapterBook => {
    const found = bookOf()
    if (!found) throw wireError('host_unavailable', 'chapters: the runtime has no session manager yet')
    return found
  }

  const provider: TopicProvider = {
    matches: (id: TopicId) => sessionOfChaptersTopic(id) !== null,
    authorize: (id, conn) => {
      const sessionId = sessionOfChaptersTopic(id)
      return sessionId !== null && scopeAllows(conn.scope.mode, CHAPTERS_TOPIC_SCOPE) && seesSession(conn, sessionId)
    },
    async *snapshot(id: TopicId): AsyncIterable<SnapshotPage> {
      const sessionId = sessionOfChaptersTopic(id)
      if (sessionId) yield { type: CHAPTERS_EVENT, payload: await state(sessionId) }
    },
  }
  broker.registerProvider(provider)

  registry.registerCapability({
    cap: CHAPTERS_CAPABILITY,
    actions: {
      mark: { scope: CHAPTERS_ACTION_SCOPES.mark, sessionOf: sessionOfChaptersPayload, guard: isChaptersMarkPayload },
      unmark: { scope: CHAPTERS_ACTION_SCOPES.unmark, sessionOf: sessionOfChaptersPayload, guard: isChaptersUnmarkPayload },
    },
    handle: async request => {
      const act = request.route.act
      switch (act) {
        case 'mark': {
          const { sessionId, entryKey, segmentKey } = request.payload as ChaptersMarkPayload
          const result = await book().mark(sessionId, entryKey, segmentKey)
          if (result.ok) return { mark: result.mark } satisfies ChaptersMarkResult
          if (result.reason === 'limit') {
            throw wireError('conflict', 'chapters: the session has as many marks as it may keep', { reason: 'limit' })
          }
          throw wireError('not_found', 'chapters: no such entry in this session')
        }
        case 'unmark': {
          const { sessionId, markId } = request.payload as ChaptersUnmarkPayload
          if (!(await book().unmark(sessionId, markId))) {
            throw wireError('not_found', `chapters: no mark ${markId} in this session`)
          }
          return { markId } satisfies ChaptersUnmarkResult
        }
        default:
          throw wireError('unknown_route', `chapters has no action '${act}'`)
      }
    },
  })

  const publish = async (sessionId: string): Promise<void> => {
    let id: TopicId
    try {
      id = chaptersTopic(sessionId)
    } catch {
      return
    }
    // Nobody is reading: a later subscriber's snapshot reads afresh.
    if (broker.subscribersOf(id).length === 0) return
    broker.publish(id, await state(sessionId), { type: CHAPTERS_EVENT })
  }
  const unsubscribe = (options.onChanged ?? onChaptersChanged)(sessionId => {
    void publish(sessionId)
  })
  return { publish, dispose: unsubscribe }
}
