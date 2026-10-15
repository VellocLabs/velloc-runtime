import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MailboxPoller } from '../team/MailboxPoller'
import type {
  MailboxPollerHost,
  MailboxRecipient,
} from '../team/MailboxPoller'
import type { TeamMessageFrame } from '../team/teamTypes'

function frame(seq: number): TeamMessageFrame {
  return {
    v: 1,
    id: `f${seq}`,
    seq,
    ts: 0,
    from: { name: 'team-lead', role: 'lead' },
    to: { name: 'worker-a' },
    kind: 'message',
    trust: 'trusted',
    body: `body ${seq}`,
  }
}

/** A store stand-in that hands out frames once and records cursor writes. */
function makeStore(pending: TeamMessageFrame[]) {
  const cursors = new Map<string, number>()
  let readAfterCalls = 0
  const store = {
    readCursor: vi.fn(async (_dir: string, key: string) => ({
      v: 1 as const,
      deliveredSeq: cursors.get(key) ?? 0,
    })),
    readAfter: vi.fn(async (_dir: string, key: string, after: number) => {
      readAfterCalls += 1
      return pending.filter(f => f.seq > after)
    }),
    writeCursor: vi.fn(
      async (_dir: string, key: string, c: { deliveredSeq: number }) => {
        cursors.set(key, c.deliveredSeq)
      },
    ),
  }
  return { store, cursors, readAfterCalls: () => readAfterCalls }
}

function makeHost(
  recipients: MailboxRecipient[],
  opts: { hasTransport?: boolean } = {},
): MailboxPollerHost & { delivered: TeamMessageFrame[] } {
  const delivered: TeamMessageFrame[] = []
  return {
    delivered,
    hasTransport: () => opts.hasTransport ?? true,
    listRecipients: () => recipients,
    onFrames: (_recipient, frames) => {
      delivered.push(...frames)
    },
  }
}

const RECIPIENT: MailboxRecipient = {
  leadSessionDir: '/lead-1',
  headSessionId: 'lead-1',
  memberKey: 'worker-a',
  idle: true,
}

describe('MailboxPoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // The cursor is how far the recipient has CONSUMED, not how far this poller
  // has read. It used to advance the moment frames reached memory, so a
  // recipient that never took them — a teammate looping in one long turn, a
  // restart, a teardown — lost them while the file said "delivered": one
  // teammate's cursor read 15 with 3 frames in its transcript.
  it('hands frames over WITHOUT marking them read', async () => {
    const { store, cursors } = makeStore([frame(1), frame(2)])
    const host = makeHost([RECIPIENT])
    const poller = new MailboxPoller(store as never, host)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.delivered.map(f => f.seq)).toEqual([1, 2])
    expect(cursors.get('worker-a')).toBeUndefined()
    poller.stop()
  })

  it('advances the cursor only as far as the recipient acked', async () => {
    const { store, cursors } = makeStore([frame(1), frame(2), frame(3)])
    const host = makeHost([RECIPIENT])
    const poller = new MailboxPoller(store as never, host)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    await poller.ack(RECIPIENT, 2)
    expect(cursors.get('worker-a')).toBe(2)
    // Monotonic: a late ack of an earlier frame never moves it back.
    await poller.ack(RECIPIENT, 1)
    expect(cursors.get('worker-a')).toBe(2)
    poller.stop()
  })

  it('a FRESH poller (a restart) re-reads frames that were handed off but never acked', async () => {
    const { store, cursors } = makeStore([frame(1), frame(2)])
    const first = makeHost([RECIPIENT])
    const before = new MailboxPoller(store as never, first)
    before.start()
    await vi.advanceTimersByTimeAsync(0)
    await before.ack(RECIPIENT, 1)
    before.stop()
    expect(cursors.get('worker-a')).toBe(1)

    const second = makeHost([RECIPIENT])
    const after = new MailboxPoller(store as never, second)
    after.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(second.delivered.map(f => f.seq)).toEqual([2])
    after.stop()
  })

  it('writes acks in order even when an earlier cursor write is slow', async () => {
    const { store, cursors } = makeStore([frame(1), frame(2)])
    const writes: number[] = []
    let releaseFirst: (() => void) | null = null
    store.writeCursor = vi.fn(
      async (_dir: string, key: string, c: { deliveredSeq: number }) => {
        if (writes.length === 0) {
          await new Promise<void>(resolve => {
            releaseFirst = resolve
          })
        }
        writes.push(c.deliveredSeq)
        cursors.set(key, c.deliveredSeq)
      },
    ) as never
    const poller = new MailboxPoller(store as never, makeHost([RECIPIENT]))
    const one = poller.ack(RECIPIENT, 1)
    const two = poller.ack(RECIPIENT, 2)
    await vi.advanceTimersByTimeAsync(0)
    releaseFirst!()
    await Promise.all([one, two])
    expect(cursors.get('worker-a')).toBe(2)
    expect(writes.at(-1)).toBe(2)
  })

  it('does not deliver the same frame twice on the next pass', async () => {
    const { store } = makeStore([frame(1)])
    const host = makeHost([RECIPIENT])
    const poller = new MailboxPoller(store as never, host)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    // Idle recipient ⇒ 1s cadence; two more passes must find nothing new.
    await vi.advanceTimersByTimeAsync(2_100)
    expect(host.delivered).toHaveLength(1)
    poller.stop()
  })

  it('kick() during an in-flight pass does not start a second chain', async () => {
    let release: (() => void) | null = null
    const { store, readAfterCalls } = makeStore([frame(1)])
    store.readCursor = vi.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve({ v: 1, deliveredSeq: 0 })
        }),
    ) as never
    const host = makeHost([RECIPIENT])
    const poller = new MailboxPoller(store as never, host)
    poller.start()
    await vi.advanceTimersByTimeAsync(0) // pass parked inside readCursor
    poller.kick()
    poller.kick()
    await vi.advanceTimersByTimeAsync(0)
    // Nothing read yet — and crucially no parallel pass got that far either.
    expect(readAfterCalls()).toBe(0)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(readAfterCalls()).toBe(1)
    poller.stop()
  })

  it('reads nothing while the bridge transport is absent, and keeps polling', async () => {
    const { store } = makeStore([frame(1)])
    const host = makeHost([RECIPIENT], { hasTransport: false })
    const poller = new MailboxPoller(store as never, host)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.readAfter).not.toHaveBeenCalled()
    // The chain survives: once the transport appears, the next pass reads.
    host.hasTransport = () => true
    await vi.advanceTimersByTimeAsync(1_100)
    expect(store.readAfter).toHaveBeenCalled()
    poller.stop()
  })

  it('polls at 1s when a recipient is idle and 5s when all are busy', async () => {
    const { store } = makeStore([])
    const busy: MailboxRecipient = { ...RECIPIENT, idle: false }
    const host = makeHost([busy])
    const poller = new MailboxPoller(store as never, host)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    const afterFirst = store.readAfter.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_500)
    expect(store.readAfter.mock.calls.length).toBe(afterFirst)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(store.readAfter.mock.calls.length).toBeGreaterThan(afterFirst)
    poller.stop()
  })

  it('stop() ends the chain', async () => {
    const { store } = makeStore([])
    const poller = new MailboxPoller(store as never, makeHost([RECIPIENT]))
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    const calls = store.readAfter.mock.calls.length
    poller.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.readAfter.mock.calls.length).toBe(calls)
  })
})
