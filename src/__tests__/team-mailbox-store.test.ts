import { describe, expect, it, vi } from 'vitest'
import { TeamMailboxStore } from '../team/TeamMailboxStore'
import type { TeamMessageFrame } from '../team/teamTypes'

/**
 * In-memory stand-in for the `fs` bridge: a path → string map plus a log of
 * every call, so a test can assert both the CONTENT written and the ACTION
 * used (append vs write — the append-only contract is the reason two senders
 * can share an inbox without a lock).
 */
function makeFakeFs(
  seed: Record<string, string> = {},
  opts: {
    /** Delay the Nth (0-based) appendFile by a macrotask, so a later append
     *  can overtake it — what a real async bridge is free to do. */
    stallAppendIndex?: number
  } = {},
) {
  let appendCount = 0
  const files = new Map<string, string>(Object.entries(seed))
  const calls: Array<{ action: string; path: string }> = []
  const encoder = new TextEncoder()
  const transport = {
    request: vi.fn(
      async (req: {
        route: { capability: string; action: string }
        payload: { path: string; data?: Uint8Array; content?: Uint8Array }
      }) => {
        const { capability, action } = req.route
        const path = req.payload.path
        calls.push({ action, path })
        if (capability !== 'fs') {
          return { ok: false as const, error: { code: 'E', message: 'E' } }
        }
        if (action === 'mkdir') return { ok: true as const, result: { ok: true } }
        if (action === 'appendFile') {
          const text = new TextDecoder().decode(req.payload.data!)
          const index = appendCount++
          if (index === opts.stallAppendIndex) {
            await new Promise(resolve => setTimeout(resolve, 5))
          }
          files.set(path, (files.get(path) ?? '') + text)
          return { ok: true as const, result: { ok: true } }
        }
        if (action === 'writeFile') {
          files.set(path, new TextDecoder().decode(req.payload.content!))
          return { ok: true as const, result: { ok: true } }
        }
        if (action === 'readFile') {
          const text = files.get(path)
          if (text === undefined) {
            return { ok: false as const, error: { code: 'ENOENT', message: 'missing' } }
          }
          return { ok: true as const, result: encoder.encode(text) }
        }
        return { ok: false as const, error: { code: 'UNKNOWN', message: 'x' } }
      },
    ),
  }
  return { transport, files, calls }
}

function makeStore(
  seed?: Record<string, string>,
  opts?: Parameters<typeof makeFakeFs>[1],
) {
  const fake = makeFakeFs(seed, opts)
  const store = new TeamMailboxStore({
    transport: fake.transport as never,
    createRequestId: () => 'req',
  })
  return { store, fake }
}

const LEAD_DIR = '/home/u/.velloc/projects/p/lead-1'
const INBOX = `${LEAD_DIR}/team/mailbox/worker-a/inbox.jsonl`
const CURSOR = `${LEAD_DIR}/team/mailbox/worker-a/cursor.json`

function body(text: string, to = 'worker-a') {
  return {
    from: { name: 'team-lead', role: 'lead' as const },
    to: { name: to },
    kind: 'message' as const,
    trust: 'trusted' as const,
    body: text,
  }
}

describe('TeamMailboxStore', () => {
  it('appends frames with monotonic seq starting at 1', async () => {
    const { store, fake } = makeStore()
    const first = await store.append(LEAD_DIR, body('one'))
    const second = await store.append(LEAD_DIR, body('two'))
    expect([first.seq, second.seq]).toEqual([1, 2])
    // Append-only: two lines, and the write action is `appendFile` — a
    // read-modify-write would let a concurrent sender lose a frame.
    expect(fake.files.get(INBOX)!.trimEnd().split('\n')).toHaveLength(2)
    expect(fake.calls.filter(c => c.path === INBOX).map(c => c.action)).toEqual([
      'readFile',
      'appendFile',
      'appendFile',
    ])
  })

  it('readAfter returns only frames past the cursor', async () => {
    const { store } = makeStore()
    await store.append(LEAD_DIR, body('one'))
    await store.append(LEAD_DIR, body('two'))
    const after = await store.readAfter(LEAD_DIR, 'worker-a', 1)
    expect(after.map(f => f.body)).toEqual(['two'])
    expect(await store.readAfter(LEAD_DIR, 'worker-a', 0)).toHaveLength(2)
    expect(await store.readAfter(LEAD_DIR, 'worker-a', 2)).toHaveLength(0)
  })

  it('skips a torn or foreign line instead of failing the whole read', async () => {
    const good: TeamMessageFrame = {
      v: 1,
      id: 'a',
      seq: 2,
      ts: 1,
      from: { name: 'worker-a', role: 'member' },
      to: { name: 'team-lead' },
      kind: 'turn_end',
      trust: 'untrusted',
      body: 'done',
    }
    const { store } = makeStore({
      [`${LEAD_DIR}/team/mailbox/team-lead/inbox.jsonl`]:
        '{"v":1,"seq":1,"bo\n' + JSON.stringify(good) + '\n\n',
    })
    const frames = await store.readAfter(LEAD_DIR, 'team-lead', 0)
    expect(frames.map(f => f.body)).toEqual(['done'])
  })

  it('a missing inbox reads as empty, not an error', async () => {
    const { store } = makeStore()
    expect(await store.readAfter(LEAD_DIR, 'nobody', 0)).toEqual([])
  })

  it('a FAILED inbox read (not a missing file) fails the append instead of restarting seq at 1', async () => {
    // The first append of a process seeds `seq` from the file. A transient
    // read failure (a transport swap during page boot) read as an EMPTY inbox:
    // the frame was written as seq 1 under fifteen older ones and `nextSeq`
    // cached 2 for the rest of the realm, so a cursor at 15 filtered every
    // later frame out — the teammate's reports silently lost.
    const existing = [1, 2, 3]
      .map(seq =>
        JSON.stringify({
          v: 1,
          id: `f${seq}`,
          seq,
          ts: 0,
          from: { name: 'worker-a', role: 'member' },
          to: { name: 'team-lead' },
          kind: 'turn_end',
          trust: 'trusted',
          body: `report ${seq}`,
        }),
      )
      .join('\n')
    const leadInbox = `${LEAD_DIR}/team/mailbox/team-lead/inbox.jsonl`
    const { store, fake } = makeStore({ [leadInbox]: `${existing}\n` })
    let failReads = 1
    const real = fake.transport.request.getMockImplementation()!
    fake.transport.request.mockImplementation(async req => {
      if (req.route.action === 'readFile' && failReads > 0) {
        failReads -= 1
        return { ok: false as const, error: { code: 'EBUSY', message: 'sharing violation' } }
      }
      return real(req)
    })

    await expect(store.append(LEAD_DIR, body('late report', 'team-lead'))).rejects.toThrow(/EBUSY/)
    // Nothing was written, and nothing was cached for the inbox.
    expect(fake.files.get(leadInbox)).toBe(`${existing}\n`)

    // The next append re-reads and continues from the real high-water mark.
    const next = await store.append(LEAD_DIR, body('late report', 'team-lead'))
    expect(next.seq).toBe(4)
    expect((await store.readAfter(LEAD_DIR, 'team-lead', 3)).map(f => f.seq)).toEqual([4])
  })

  it('continues the seq sequence across a restart', async () => {
    // A fresh store (new process) over an inbox that already has frames must
    // not restart at 1 — that would make old frames look undelivered.
    const { store: first, fake } = makeStore()
    await first.append(LEAD_DIR, body('one'))
    await first.append(LEAD_DIR, body('two'))
    const restarted = new TeamMailboxStore({
      transport: fake.transport as never,
      createRequestId: () => 'req',
    })
    const third = await restarted.append(LEAD_DIR, body('three'))
    expect(third.seq).toBe(3)
  })

  it('serializes concurrent appends so seq order matches file order', async () => {
    // Red without the per-inbox chain: `seq` is allocated before an awaited
    // write, so if the first write is slower the file reads 2 then 1. A
    // poller that sees only the seq-2 line advances its cursor past 1, and
    // the first message is skipped for good — two `SendMessage` calls in one
    // turn were enough to lose one silently.
    const { store, fake } = makeStore(undefined, { stallAppendIndex: 0 })
    const [first, second] = await Promise.all([
      store.append(LEAD_DIR, body('one')),
      store.append(LEAD_DIR, body('two')),
    ])
    expect([first!.seq, second!.seq]).toEqual([1, 2])

    const lines = fake.files
      .get(INBOX)!
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as {seq: number; body: string})
    // On-disk order must match seq order, and nothing may be lost.
    expect(lines.map(l => l.seq)).toEqual([1, 2])
    expect(lines.map(l => l.body)).toEqual(['one', 'two'])

    // And the reader sees both, in order, from a fresh cursor.
    const frames = await store.readAfter(LEAD_DIR, 'worker-a', 0)
    expect(frames.map(f => f.body)).toEqual(['one', 'two'])
  })

  it('cursor defaults to 0 and round-trips atomically', async () => {
    const { store, fake } = makeStore()
    expect(await store.readCursor(LEAD_DIR, 'worker-a')).toEqual({
      v: 1,
      deliveredSeq: 0,
    })
    await store.writeCursor(LEAD_DIR, 'worker-a', { v: 1, deliveredSeq: 7 })
    expect(await store.readCursor(LEAD_DIR, 'worker-a')).toEqual({
      v: 1,
      deliveredSeq: 7,
    })
    expect(fake.calls.some(c => c.path === CURSOR && c.action === 'writeFile')).toBe(
      true,
    )
  })

  it('a corrupt cursor reads as 0 rather than swallowing mail', async () => {
    const { store } = makeStore({ [CURSOR]: 'not json' })
    expect(await store.readCursor(LEAD_DIR, 'worker-a')).toEqual({
      v: 1,
      deliveredSeq: 0,
    })
  })
})
