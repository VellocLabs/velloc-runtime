import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/AgentRuntimeWorkerHandle'
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStoragePayload,
  BrowserSessionMetadata,
  BrowserTranscriptEntry,
  SessionMetaFile,
} from '../sessions/sessionStore'
import { setTemplateChannelForTest } from '../prompting/templateCatalog'
import { resolveLineage } from '../sessions/sessionLineage'

// A fork a person makes of a child-capable session records where it came
// from as the person's (F-36, R04): its turn ends report to the source, and
// the lineage still reads as the person's fork, so they never wake it alone.

function makeWorker(): AgentRuntimeWorkerHandle {
  return {
    async receiveFrame() {},
    getSnapshot: () => ({ initialized: true }),
    enqueueSubmit() {},
    consumePendingAsNextSubmit() {},
    pumpSubmits() {},
    isBusy: () => false,
    isStopping: () => false,
    getPhase: () => ({ kind: 'idle' }),
  } as unknown as AgentRuntimeWorkerHandle
}

function mockPort() {
  const listeners: Array<(event: MessageEvent) => void> = []
  const posted: unknown[] = []
  return {
    posted,
    simulate(data: unknown) {
      for (const handler of listeners) handler({ data, ports: [] } as unknown as MessageEvent)
    },
    port: {
      addEventListener: (_type: string, handler: (event: MessageEvent) => void) => listeners.push(handler),
      removeEventListener() {},
      postMessage: (message: unknown) => posted.push(message),
      start() {},
      close() {},
    } as unknown as MessagePort,
  }
}

async function forkOf(templateType: string, message: Record<string, unknown> = {}): Promise<BrowserSessionMetadata> {
  const manager = new SharedWorkerSessionManager({ createWorker: makeWorker })
  const metaWrites: SessionMetaFile[] = []
  const storage = {
    append: vi.fn(async () => {}),
    readSessionMeta: vi.fn(async () => null),
    writeSessionMeta: vi.fn(async (_sessionId: string, meta: SessionMetaFile) => {
      metaWrites.push(meta)
    }),
    load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'source-session',
        parentUuid: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      } as unknown as BrowserTranscriptEntry,
    ]),
    flush: vi.fn(async () => {}),
    loadSessionMetadata: vi.fn(async (): Promise<BrowserSessionMetadata> => ({ templateType })),
    loadSessionSummary: vi.fn(async (sessionId: string) => ({ sessionId, updatedAt: 1, messageCount: 1 })),
    projectRouteOf: vi.fn(() => undefined),
    setSessionProjectDir: vi.fn(),
    loadToolCallDetail: vi.fn(async () => null),
    saveToolCallDetail: vi.fn(async () => {}),
  }
  const coordinator = (
    manager as unknown as {
      storageCoordinator: { storage: BrowserConversationStorageBackend; groupedStorage: unknown; homeDir: string }
    }
  ).storageCoordinator
  coordinator.storage = storage as unknown as BrowserConversationStorageBackend
  coordinator.groupedStorage = storage
  coordinator.homeDir = '/home/me'
  const { port, simulate, posted } = mockPort()
  manager.handleConnect(port)
  simulate({ type: 'session.fork', fromSessionId: 'source-session', cutUuid: 'u1', requestId: 'f1', ...message })
  await vi.waitFor(() => expect(posted.some(m => (m as { type?: string }).type === 'session.forked')).toBe(true))
  expect(metaWrites).toHaveLength(1)
  return metaWrites[0]!.metadata
}

afterEach(() => {
  setTemplateChannelForTest(null)
})

describe('a person\'s fork and its origin', () => {
  it('on the beta channel a fork of a code session records the person as its origin and still reads as their fork', async () => {
    setTemplateChannelForTest('beta')
    const metadata = await forkOf('code')
    expect(metadata.spawnedFrom).toEqual({
      sessionId: 'source-session',
      taskId: '',
      kind: 'side_session',
      initiator: 'user',
      userFork: true,
    })
    expect(metadata.forkedFromSessionId).toBe('source-session')
    expect(resolveLineage(metadata)).toMatchObject({ sessionId: 'source-session', kind: 'fork', initiator: 'user' })
  })

  it('records none off the beta channel, for a type that has no child sessions, for a rewind, or for a side chat', async () => {
    setTemplateChannelForTest('stable')
    expect((await forkOf('code')).spawnedFrom).toBeUndefined()
    setTemplateChannelForTest('beta')
    expect((await forkOf('chat')).spawnedFrom).toBeUndefined()
    expect((await forkOf('code', { replacesSource: true })).spawnedFrom).toBeUndefined()
    const sideChat = await forkOf('code', { sideChat: true })
    expect(sideChat.sideChat).toBe(true)
    expect(sideChat.spawnedFrom).toBeUndefined()
  })
})
