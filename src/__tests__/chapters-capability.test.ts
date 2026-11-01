import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  type ConnectionInfo,
  type RuntimeContext,
} from '../browser/runtimeHub'
import { connectRuntime, type RuntimeConnection } from '../browser/runtimeClient'
import { registerChaptersCapability } from '../browser/runtimeHub/chaptersCapability'
import {
  CHAPTERS_ACTION_SCOPES,
  chaptersTopic,
  isChaptersMarkPayload,
  isChaptersUnmarkPayload,
  sessionOfChaptersTopic,
} from '../sessions/chapterProtocol'
import { CHAPTER_MARKS_MAX } from '../sessions/chapterMarks'
import { ChapterBook } from '../sessions/chapterBook'
import { chaptersOfPayload, holdChaptersView } from '../browser/webview/chaptersView'

// The chapters capability (F-37): the declared scopes, an observe connection refused, the topic visible
// only for a session the connection may see, the actions answering from the runtime's book, and the
// page's view sharing one subscription per session.

function makeRig(entries: unknown[] = [
  { uuid: 'u1', message: { content: 'First question' } },
  { uuid: 'a1', message: { content: 'The reply' } },
]) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const listeners = new Set<(sessionId: string) => void>()
  const stored = new Map<string, unknown>()
  const book = new ChapterBook({
    storage: {
      read: async sessionId => stored.get(sessionId),
      write: async (sessionId, marks) => {
        stored.set(sessionId, marks)
      },
      entries: async () => entries,
    },
    onChange: sessionId => listeners.forEach(listener => listener(sessionId)),
  })
  const capability = registerChaptersCapability(registry, broker, {
    book: () => book,
    onChanged: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'pp', bootstrap: () => undefined })
  return { registry, broker, book, capability, hub, stored }
}

async function connect(rig: ReturnType<typeof makeRig>, scopeCeiling?: 'control' | 'observe' | 'manager'): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  rig.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'c', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

const narrow: ConnectionInfo = {
  connectionId: 'n',
  clientId: 'n',
  kind: 'mobile',
  scope: { mode: 'observe', sessions: ['s1'] },
  transport: 'websocket',
  connectedAt: 0,
}

describe('chapters protocol', () => {
  it('declares both actions control, each bound to the session it names', () => {
    expect(CHAPTERS_ACTION_SCOPES).toEqual({ mark: 'control', unmark: 'control' })
    const { registry } = makeRig()
    for (const act of ['mark', 'unmark']) {
      const entry = registry.resolve('chapters', act)!
      expect(entry.spec.scope).toBe('control')
      expect(entry.spec.sessionOf?.({ sessionId: 's2', entryKey: 'u1' })).toBe('s2')
    }
    expect(registry.advertise({ mode: 'observe', sessions: 'all' }).find(c => c.cap === 'chapters')).toBeUndefined()
    expect(registry.advertise({ mode: 'control', sessions: 'all' }).find(c => c.cap === 'chapters')?.acts).toEqual(['mark', 'unmark'])
  })

  it('a payload names a session and keys and nothing else; no title is accepted', () => {
    expect(isChaptersMarkPayload({ sessionId: 's1', entryKey: 'u1' })).toBe(true)
    expect(isChaptersMarkPayload({ sessionId: 's1', entryKey: 'u1', segmentKey: 'a2' })).toBe(true)
    expect(isChaptersMarkPayload({ sessionId: 's1', entryKey: 'u1', title: 'mine' })).toBe(false)
    expect(isChaptersMarkPayload({ sessionId: 's1/x', entryKey: 'u1' })).toBe(false)
    expect(isChaptersMarkPayload({ sessionId: 's1', entryKey: '' })).toBe(false)
    expect(isChaptersMarkPayload({ sessionId: 's1', entryKey: 'x'.repeat(201) })).toBe(false)
    expect(isChaptersUnmarkPayload({ sessionId: 's1', markId: 'c1' })).toBe(true)
    expect(isChaptersUnmarkPayload({ sessionId: 's1', markId: 'c1', entryKey: 'u1' })).toBe(false)
    expect(sessionOfChaptersTopic(chaptersTopic('s1'))).toBe('s1')
    expect(sessionOfChaptersTopic('chapters/a/b')).toBeNull()
    expect(sessionOfChaptersTopic('proposals/s1')).toBeNull()
  })

  it('an observe connection is refused every action', async () => {
    const rig = makeRig()
    const observer = await connect(rig, 'observe')
    await expect(observer.request('chapters.mark', { sessionId: 's1', entryKey: 'u1' })).rejects.toMatchObject({ code: 'forbidden_scope' })
    await expect(observer.request('chapters.unmark', { sessionId: 's1', markId: 'c1' })).rejects.toMatchObject({ code: 'forbidden_scope' })
    expect(rig.stored.get('s1')).toBeUndefined()
    observer.close()
  })

  it('the topic is readable only for a session the connection may see', () => {
    const rig = makeRig()
    expect(rig.broker.authorize(chaptersTopic('s1'), narrow)).not.toBe('forbidden')
    expect(rig.broker.authorize(chaptersTopic('s2'), narrow)).toBe('forbidden')
  })

  it('a control connection marks and unmarks; the topic carries every change', async () => {
    const rig = makeRig()
    const control = await connect(rig, 'control')
    const seen: unknown[] = []
    control.subscribe(chaptersTopic('s1'), event => {
      seen.push(event.payload)
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ sessionId: 's1', marks: [] })

    const { mark } = (await control.request('chapters.mark', { sessionId: 's1', entryKey: 'a1' })) as {
      mark: { id: string; title: string }
    }
    expect(mark).toMatchObject({ entryKey: 'a1', title: 'The reply' })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(chaptersOfPayload(seen[1], 's1')).toEqual([mark])

    await expect(control.request('chapters.mark', { sessionId: 's1', entryKey: 'gone' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await control.request('chapters.unmark', { sessionId: 's1', markId: mark.id })).toEqual({ markId: mark.id })
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(chaptersOfPayload(seen[2], 's1')).toEqual([])
    await expect(control.request('chapters.unmark', { sessionId: 's1', markId: mark.id })).rejects.toMatchObject({ code: 'not_found' })
    control.close()
  })

  it('a full list answers conflict with the reason', async () => {
    const entries = Array.from({ length: CHAPTER_MARKS_MAX + 1 }, (_, i) => ({ uuid: `e${i}`, message: { content: `e${i}` } }))
    const rig = makeRig(entries)
    for (let i = 0; i < CHAPTER_MARKS_MAX; i++) await rig.book.mark('s1', `e${i}`)
    const control = await connect(rig, 'control')
    await expect(control.request('chapters.mark', { sessionId: 's1', entryKey: `e${CHAPTER_MARKS_MAX}` })).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'limit' },
    })
    control.close()
  })
})

describe('chapters view', () => {
  it('readers of one session share one subscription, and a later one gets the latest list at once', () => {
    let deliver: ((event: { payload: unknown }) => void) | null = null
    const unsubscribe = vi.fn()
    const connection = {
      subscribe: vi.fn((_topic: string, listener: (event: { payload: unknown }) => void) => {
        deliver = listener
        return unsubscribe
      }),
    } as unknown as Parameters<typeof holdChaptersView>[0]
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = holdChaptersView(connection, 's1', first)
    const marks = [{ id: 'c1', entryKey: 'u1', title: 'T', createdAt: 1 }]
    deliver!({ payload: { sessionId: 's1', marks } })
    deliver!({ payload: { sessionId: 'other', marks: [] } })
    const releaseSecond = holdChaptersView(connection, 's1', second)

    expect(connection.subscribe).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith(marks)
    releaseFirst()
    expect(unsubscribe).not.toHaveBeenCalled()
    releaseSecond()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
