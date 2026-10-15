import { describe, expect, it } from 'vitest'
import { BridgeFsConversationStorageBackend } from '../browser/storage/BridgeFsSessionStorage'
import type { BrowserTranscriptWriteEntry } from '../sessions/sessionStore'

const BASE = '/home/.velloc/projects/proj'

/**
 * Session delete is final: a write arriving after `deleteSession`'s rm must not re-issue `mkdir` and resurrect
 * the session directory. Each test asserts on the fs calls the backend put on the wire.
 */

type SentCall = { op: string; path: string | undefined }

function makeBackend(opts: { holdRm?: boolean } = {}) {
  const calls: SentCall[] = []
  let releaseRm: (() => void) | undefined
  const rmGate = opts.holdRm
    ? new Promise<void>(resolve => {
        releaseRm = resolve
      })
    : undefined

  const transport = {
    request: async (request: {
      route: { capability: string; action: string }
      payload: unknown
    }) => {
      const op = `${request.route.capability}.${request.route.action}`
      calls.push({
        op,
        path: (request.payload as { path?: string } | undefined)?.path,
      })
      if (op === 'fs.rm' && rmGate) {
        await rmGate
      }
      return { ok: true, result: undefined } as never
    },
  }

  const backend = new BridgeFsConversationStorageBackend({
    transport: transport as never,
    basePath: BASE,
    createRequestId: () => 'req-test',
  })

  return {
    backend,
    calls,
    /**
     * fs ops that CREATE or MUTATE on-disk state (a resurrect is a mkdir),
     * excluding the one-time `mkdir` of the storage ROOT — that is shared by
     * every session and says nothing about the deleted one.
     */
    writeOps: () =>
      calls
        .filter(
          c =>
            (c.op === 'fs.mkdir' ||
              c.op === 'fs.appendFile' ||
              c.op === 'fs.writeFile') &&
            c.path !== BASE,
        )
        .map(c => c.op),
    releaseRm: () => releaseRm?.(),
  }
}

const ENTRY = { type: 'user', message: 'hi' } as unknown as BrowserTranscriptWriteEntry

describe('BridgeFsConversationStorageBackend — a deleted session stays deleted', () => {
  it('append after deleteSession writes nothing (no mkdir → no resurrected dir)', async () => {
    const { backend, calls, writeOps } = makeBackend()

    await backend.append('s1', ENTRY)
    expect(writeOps()).toEqual(['fs.mkdir', 'fs.appendFile'])

    await backend.deleteSession('s1')
    calls.length = 0

    // The late write: without the tombstone this re-mkdirs the session dir.
    await backend.append('s1', ENTRY)
    expect(writeOps()).toEqual([])
  })

  it('saveToolCallDetail after deleteSession writes nothing', async () => {
    const { backend, calls, writeOps } = makeBackend()

    await backend.deleteSession('s1')
    calls.length = 0

    await backend.saveToolCallDetail('s1', {
      toolCallId: 'tc-1',
    } as never)
    expect(writeOps()).toEqual([])
  })

  it('a write that RACES the in-flight rm is dropped too (tombstone precedes the rm)', async () => {
    const { backend, calls, writeOps, releaseRm } = makeBackend({ holdRm: true })

    // Delete is now parked inside its own `fs.rm` await — exactly where a
    // concurrent write used to slip through and re-create the directory.
    const deleting = backend.deleteSession('s1')
    await Promise.resolve()
    calls.length = 0

    const racing = backend.append('s1', ENTRY)
    await racing

    releaseRm()
    await deleting

    expect(writeOps()).toEqual([])
  })

  it('deleting one session does not stop another from writing', async () => {
    const { backend, calls, writeOps } = makeBackend()

    await backend.deleteSession('s1')
    calls.length = 0

    await backend.append('s2', ENTRY)
    expect(writeOps()).toEqual(['fs.mkdir', 'fs.appendFile'])
  })

  it('the tombstone set stays bounded (no unbounded growth in a long-lived worker)', async () => {
    const { backend, calls, writeOps } = makeBackend()

    // One past the cap, so the FIRST id is evicted.
    for (let i = 0; i < 1025; i += 1) {
      await backend.deleteSession(`s${i}`)
    }
    calls.length = 0

    // The most recent deletes are still remembered …
    await backend.append('s1024', ENTRY)
    expect(writeOps()).toEqual([])

    // … while the evicted oldest id is writable again. Safe: its delete is
    // 1024 deletes in the past, so no write for it can still be in flight.
    await backend.append('s0', ENTRY)
    expect(writeOps()).toEqual(['fs.mkdir', 'fs.appendFile'])
  })
})
