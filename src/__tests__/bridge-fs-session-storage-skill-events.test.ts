import { describe, expect, it } from 'vitest'
import { BridgeFsConversationStorageBackend } from '../browser/storage/BridgeFsSessionStorage'
import type { SkillInvocationEvent } from '../skillLibrary/skillInvocationLog'

/**
 * The `skill-events.json` sidecar persists the Skills-tab invocation log across restarts. Pins the write path,
 * the lenient parse validator and the tombstone guard on the real backend over a virtual-fs fake transport.
 */

const BASE = '/home/.velloc/projects/proj'
const DEC = new TextDecoder()
const ENC = new TextEncoder()

function makeBackend() {
  const files = new Map<string, Uint8Array>()
  /** Paths whose `fs.readFile` FAILS (the file may be there) — not ENOENT. */
  const unreadable = new Set<string>()
  const transport = {
    request: async (request: {
      route: { capability: string; action: string }
      payload: { path?: string; content?: Uint8Array }
    }) => {
      const op = `${request.route.capability}.${request.route.action}`
      const path = request.payload?.path
      if (op === 'fs.writeFile') {
        files.set(path!, request.payload.content as Uint8Array)
        return { ok: true, result: undefined } as never
      }
      if (op === 'fs.readFile') {
        if (unreadable.has(path!)) {
          return {
            ok: false,
            error: { code: 'FS_ERROR', message: 'sharing violation' },
          } as never
        }
        const bytes = files.get(path!)
        if (!bytes) {
          return {
            ok: false,
            error: { code: 'ENOENT', message: 'no such file' },
          } as never
        }
        return { ok: true, result: bytes } as never
      }
      // mkdir / rm / anything else the backend calls: succeed.
      return { ok: true, result: undefined } as never
    },
  }
  const backend = new BridgeFsConversationStorageBackend({
    transport: transport as never,
    basePath: BASE,
    createRequestId: () => 'req-test',
  })
  return { backend, files, unreadable }
}

const evt = (over: Partial<SkillInvocationEvent> = {}): SkillInvocationEvent => ({
  id: 'e1',
  skillName: 'pdf',
  skillPath: '/s/pdf/SKILL.md',
  invokedAt: 1000,
  status: 'loaded',
  agentId: null,
  ...over,
})

const eventsPath = (sessionId: string): string =>
  `${BASE}/${sessionId}/skill-events.json`

describe('BridgeFsConversationStorageBackend — skill-events sidecar', () => {
  it('round-trips the full event log through skill-events.json', async () => {
    const { backend, files } = makeBackend()
    const events: SkillInvocationEvent[] = [
      evt({ id: 'a', status: 'loaded', size: 100, detailId: 'skill:a' }),
      evt({ id: 'b', status: 'loaded', size: 120, detailId: 'skill:b' }),
      evt({ id: 'c', status: 'failed', error: 'boom' }),
    ]
    await backend.saveSkillEvents('s1', events)

    // Written to the session's sidecar, wrapped with a schema tag.
    expect(files.has(eventsPath('s1'))).toBe(true)
    const parsed = JSON.parse(DEC.decode(files.get(eventsPath('s1'))!))
    expect(parsed.v).toBe(1)
    expect(Array.isArray(parsed.events)).toBe(true)

    expect(await backend.loadSkillEvents('s1')).toEqual(events)
  })

  it('returns null when the sidecar is missing (a session that never used skills)', async () => {
    const { backend } = makeBackend()
    expect(await backend.loadSkillEvents('nope')).toBeNull()
  })

  it('returns null — never throws — on a torn / non-JSON sidecar', async () => {
    const { backend, files } = makeBackend()
    files.set(eventsPath('s1'), ENC.encode('{ not json'))
    expect(await backend.loadSkillEvents('s1')).toBeNull()
  })

  it('drops individually malformed events and defaults missing fields', async () => {
    const { backend, files } = makeBackend()
    files.set(
      eventsPath('s1'),
      ENC.encode(
        JSON.stringify({
          v: 1,
          events: [
            { id: 'ok', skillName: 'pdf', invokedAt: 1, status: 'loaded' },
            { id: 'bad-status', skillName: 'pdf', invokedAt: 2, status: 'nope' },
            { skillName: 'pdf', invokedAt: 3, status: 'loaded' }, // no id
            'garbage',
          ],
        }),
      ),
    )
    const loaded = await backend.loadSkillEvents('s1')
    expect(loaded?.map(e => e.id)).toEqual(['ok'])
    expect(loaded?.[0]).toMatchObject({
      id: 'ok',
      skillName: 'pdf',
      agentId: null,
      skillPath: '', // defaulted — the persisted row carried none
    })
  })

  it('reads a legacy `duplicated` event back as `loaded` instead of dropping it', async () => {
    const { backend, files } = makeBackend()
    files.set(
      eventsPath('s1'),
      ENC.encode(
        JSON.stringify({
          v: 1,
          events: [
            { id: 'a', skillName: 'pdf', invokedAt: 1, status: 'loaded', size: 9, detailId: 'skill:a' },
            { id: 'b', skillName: 'pdf', invokedAt: 2, status: 'duplicated', size: 9, detailId: 'skill:a' },
          ],
        }),
      ),
    )
    const loaded = await backend.loadSkillEvents('s1')
    expect(loaded?.map(e => [e.id, e.status])).toEqual([
      ['a', 'loaded'],
      ['b', 'loaded'],
    ])
    expect(loaded?.[1]).toMatchObject({ size: 9, detailId: 'skill:a' })
  })

  it('returns null when the top-level shape has no events array', async () => {
    const { backend, files } = makeBackend()
    files.set(eventsPath('s1'), ENC.encode(JSON.stringify({ v: 1 })))
    expect(await backend.loadSkillEvents('s1')).toBeNull()
  })

  it('does not write for a deleted session (tombstone guard)', async () => {
    const { backend, files } = makeBackend()
    await backend.deleteSession('s1')
    await backend.saveSkillEvents('s1', [evt()])
    expect(files.has(eventsPath('s1'))).toBe(false)
  })

  it('a read that FAILED rethrows instead of reading as "nothing there", and the sidecar is not overwritten until a load succeeds', async () => {
    // A sharing violation / bridge error used to resolve null like a missing
    // file: the caller cached "recovered, nothing there" and its next flush
    // rewrote skill-events.json with only this lifetime's events — the
    // history in the file it could not read was erased.
    const { backend, files, unreadable } = makeBackend()
    const history = [evt({ id: 'old', status: 'failed', error: 'boom' })]
    await backend.saveSkillEvents('s1', history)
    const onDisk = files.get(eventsPath('s1'))!

    unreadable.add(eventsPath('s1'))
    await expect(backend.loadSkillEvents('s1')).rejects.toThrow('sharing violation')
    await expect(backend.saveSkillEvents('s1', [evt({ id: 'new' })])).rejects.toThrow(/not readable/)
    expect(files.get(eventsPath('s1'))).toBe(onDisk)

    // Readable again: the load merges the history back, and writes resume.
    unreadable.delete(eventsPath('s1'))
    expect(await backend.loadSkillEvents('s1')).toEqual(history)
    await backend.saveSkillEvents('s1', [...history, evt({ id: 'new' })])
    expect((await backend.loadSkillEvents('s1'))?.map(e => e.id)).toEqual(['old', 'new'])
  })

  it('a missing sidecar still reads as null and does not block the first write', async () => {
    const { backend, files } = makeBackend()
    expect(await backend.loadSkillEvents('s1')).toBeNull()
    await backend.saveSkillEvents('s1', [evt()])
    expect(files.has(eventsPath('s1'))).toBe(true)
  })
})
