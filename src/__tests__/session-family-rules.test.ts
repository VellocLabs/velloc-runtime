import { describe, expect, it } from 'vitest'
import {
  appendPeerInbox,
  archiveDecision,
  checkFamilyToolCaller,
  clampLimit,
  controlDecision,
  detachDecision,
  pageTranscript,
  receiptTail,
  resolveRecipient,
  PEER_INBOX_MAX,
} from '../sessions/sessionFamilyRules'
import {
  FAMILY_DEPTH_LIMIT,
  lineageInputFromRelationFields,
  type SessionLineageInput,
  type SessionOrigin,
} from '../sessions/sessionLineage'
import { buildSessionSummaryFromMetadata } from '../sessions/sessionStore'

// The session-family rules (F-36): who a recipient name means, who controls
// whom, who may detach whom, what may be archived, how a transcript pages,
// and the caller gate.

function child(parent: string, extra: Partial<SessionOrigin> = {}): SessionLineageInput {
  return { spawnedFrom: { sessionId: parent, taskId: 't', kind: 'side_session', initiator: 'model', ...extra } }
}

function indexOf(entries: Record<string, SessionLineageInput>): Map<string, SessionLineageInput> {
  return new Map(Object.entries(entries))
}

describe('checkFamilyToolCaller', () => {
  const ok = { channel: 'beta', templateType: 'code', nested: false, sessionId: 's' }
  it('passes a beta code or agent session', () => {
    expect(checkFamilyToolCaller(ok)).toEqual({ ok: true, sessionId: 's' })
    expect(checkFamilyToolCaller({ ...ok, templateType: 'agent' }).ok).toBe(true)
  })
  it('refuses the stable channel, other types, nested callers and no session', () => {
    expect(checkFamilyToolCaller({ ...ok, channel: 'stable' })).toMatchObject({ ok: false, reason: /release channel/ })
    expect(checkFamilyToolCaller({ ...ok, templateType: 'chat' })).toMatchObject({ ok: false, reason: /"chat"/ })
    expect(checkFamilyToolCaller({ ...ok, nested: true })).toMatchObject({ ok: false, reason: /sub-agent or teammate/ })
    expect(checkFamilyToolCaller({ ...ok, sessionId: undefined })).toMatchObject({ ok: false, reason: /session id/ })
  })
})

describe('resolveRecipient', () => {
  const names = new Map([
    ['p', 'planner'],
    ['c1', 'parser'],
    ['c2', 'parser-2'],
    ['f', 'copy'],
  ])
  const index = indexOf({
    p: {},
    c1: child('p', { name: 'parser' }),
    c2: child('p', { name: 'parser-2' }),
    // A person's fork of c1: a family boundary, whatever name it carries.
    f: { forkedFromSessionId: 'c1' },
    other: {},
  })
  const nameOf = (id: string) => names.get(id)
  const exists = (id: string) => index.has(id)

  it('reserved names: self is the caller, parent the session it is shown under, top the family root', () => {
    expect(resolveRecipient('c1', 'self', index, nameOf, exists)).toEqual({ kind: 'self' })
    expect(resolveRecipient('c1', 'c1', index, nameOf, exists)).toEqual({ kind: 'self' })
    expect(resolveRecipient('c1', 'parent', index, nameOf, exists)).toEqual({ kind: 'session', sessionId: 'p', via: 'parent' })
    expect(resolveRecipient('p', 'parent', index, nameOf, exists)).toEqual({ kind: 'no_parent' })
    expect(resolveRecipient('c2', 'top', index, nameOf, exists)).toEqual({ kind: 'session', sessionId: 'p', via: 'top' })
    expect(resolveRecipient('p', 'top', index, nameOf, exists)).toEqual({ kind: 'self' })
  })

  it('a user fork addresses the session it was copied from as parent, but is outside its family by name', () => {
    expect(resolveRecipient('f', 'parent', index, nameOf, exists)).toEqual({ kind: 'session', sessionId: 'c1', via: 'parent' })
    expect(resolveRecipient('f', 'parser-2', index, nameOf, exists)).toEqual({ kind: 'unknown' })
    expect(resolveRecipient('c1', 'copy', index, nameOf, exists)).toEqual({ kind: 'unknown' })
  })

  it('a short name resolves within the family, a session id anywhere in the runtime, nothing else', () => {
    expect(resolveRecipient('c1', 'parser-2', index, nameOf, exists)).toEqual({ kind: 'session', sessionId: 'c2', via: 'name' })
    expect(resolveRecipient('c1', 'planner', index, nameOf, exists)).toEqual({ kind: 'session', sessionId: 'p', via: 'name' })
    expect(resolveRecipient('c1', 'other', index, nameOf, exists)).toEqual({ kind: 'session', sessionId: 'other', via: 'id' })
    expect(resolveRecipient('c1', 'nobody', index, nameOf, exists)).toEqual({ kind: 'unknown' })
    expect(resolveRecipient('c1', '  ', index, nameOf, exists)).toEqual({ kind: 'unknown' })
  })

  it('an archived namesake is still the name\'s owner: the name is never handed to another session', () => {
    // Names are unique per family, archived members included; whoever holds
    // it is resolved, and the archive check refuses the send afterwards.
    const archivedNames = new Map(names).set('c2', 'done')
    expect(resolveRecipient('c1', 'done', index, id => archivedNames.get(id), exists)).toEqual({ kind: 'session', sessionId: 'c2', via: 'name' })
  })

  it('a missing parent resolves to its id and is then not found; a cycle and a deep chain terminate', () => {
    const orphan = indexOf({ c: child('gone') })
    expect(resolveRecipient('c', 'parent', orphan, () => undefined, id => orphan.has(id))).toEqual({ kind: 'session', sessionId: 'gone', via: 'parent' })
    const cycle = indexOf({ a: child('b'), b: child('a') })
    expect(resolveRecipient('a', 'top', cycle, () => undefined, id => cycle.has(id)).kind).toBe('session')
    const deep: Record<string, SessionLineageInput> = { s0: {} }
    for (let i = 1; i <= FAMILY_DEPTH_LIMIT + 5; i++) deep[`s${i}`] = child(`s${i - 1}`, { name: `n${i}` })
    const deepIndex = indexOf(deep)
    const nameAt = (id: string) => deep[id]?.spawnedFrom?.name
    const far = resolveRecipient(`s${FAMILY_DEPTH_LIMIT + 5}`, 'top', deepIndex, nameAt, id => deepIndex.has(id))
    expect(far.kind).toBe('session')
    // Within the walk's reach a name resolves; the leaf's family is cut at the limit.
    expect(resolveRecipient('s3', 'n2', deepIndex, nameAt, id => deepIndex.has(id))).toEqual({ kind: 'session', sessionId: 's2', via: 'name' })
  })
})

describe('controlDecision', () => {
  const index = indexOf({
    p: {},
    c: child('p'),
    g: child('c'),
    s: child('p'),
    f: { forkedFromSessionId: 'c' },
    d: { ...child('p'), lineageDetached: true },
    t: child('p', { initiator: 'user', userFork: true }),
    tm: { spawnerSessionId: 'p', teammateName: 'ada' },
    x: {},
  })

  it('a session controls the children its model started and their delegated descendants', () => {
    expect(controlDecision('p', 'c', index, 'stop')).toEqual({ ok: true })
    expect(controlDecision('p', 'g', index, 'archive')).toEqual({ ok: true })
    expect(controlDecision('c', 'g', index, 'unarchive')).toEqual({ ok: true })
  })

  it('family membership grants nothing: a parent, a sibling, a stranger, a fork, a detached link, a user task', () => {
    const refused = { ok: false, code: 'not_delegated', reason: 'only a person can stop that session.' }
    expect(controlDecision('c', 'p', index, 'stop')).toEqual(refused)
    expect(controlDecision('g', 'p', index, 'stop')).toEqual(refused)
    expect(controlDecision('c', 's', index, 'stop')).toEqual(refused)
    expect(controlDecision('x', 'c', index, 'stop')).toEqual(refused)
    expect(controlDecision('c', 'f', index, 'stop')).toEqual(refused)
    expect(controlDecision('p', 'd', index, 'stop')).toEqual(refused)
    expect(controlDecision('p', 't', index, 'stop')).toEqual(refused)
    expect(controlDecision('p', 'nope', index, 'stop')).toEqual(refused)
    expect(controlDecision('p', 'c', index, 'archive')).toEqual({ ok: true })
    expect(controlDecision('c', 'p', index, 'archive')).toMatchObject({ reason: 'only a person can archive that session.' })
    expect(controlDecision('c', 'p', index, 'unarchive')).toMatchObject({ reason: 'only a person can unarchive that session.' })
    expect(controlDecision('p', 'p', index, 'archive')).toMatchObject({ ok: false, code: 'self' })
  })

  it('a teammate is its team\'s: the lead is pointed at Shutdown, anyone else refused; a cycle terminates', () => {
    expect(controlDecision('p', 'tm', index, 'stop')).toMatchObject({ ok: false, code: 'team', reason: /Shutdown/ })
    expect(controlDecision('p', 'tm', index, 'archive')).toMatchObject({ ok: false, code: 'team' })
    expect(controlDecision('x', 'tm', index, 'stop')).toMatchObject({ ok: false, code: 'not_delegated' })
    const loop = indexOf({ a: child('b'), b: child('a') })
    expect(controlDecision('z', 'a', loop, 'stop')).toMatchObject({ ok: false, code: 'not_delegated' })
  })
})

describe('detachDecision', () => {
  it('lets a parent detach a child its model started, and a model-started child detach itself', () => {
    expect(detachDecision('p', 'c', child('p'))).toEqual({ ok: true })
    expect(detachDecision('c', 'c', child('p'))).toEqual({ ok: true })
    expect(detachDecision('p', 'c', { ...child('p'), lineageDetached: true })).toEqual({ ok: true })
  })
  it('refuses a user fork, a user-started task and a teammate', () => {
    expect(detachDecision('p', 'f', { forkedFromSessionId: 'p' })).toMatchObject({ ok: false, code: 'user_fork' })
    expect(detachDecision('p', 'f', { ...child('p'), forkedFromSessionId: 'x' })).toMatchObject({ ok: false, code: 'user_fork' })
    expect(detachDecision('p', 't', child('p', { initiator: 'user', userFork: true }))).toMatchObject({ ok: false, code: 'user_task' })
    expect(detachDecision('lead', 'tm', { spawnerSessionId: 'lead', teammateName: 'ada' })).toMatchObject({ ok: false, code: 'team' })
  })
  it('refuses a session that is not the caller\'s child, a top-level session and a shared checkout', () => {
    expect(detachDecision('other', 'c', child('p'))).toMatchObject({ ok: false, code: 'not_delegated' })
    // Already detached: a stranger is still refused, not told it was done.
    expect(detachDecision('other', 'c', { ...child('p'), lineageDetached: true })).toMatchObject({ ok: false, code: 'not_delegated' })
    expect(detachDecision('p', 'p', {})).toMatchObject({ ok: false, code: 'top_level' })
    expect(detachDecision('p', 'c', child('p', { sharedCheckout: true }))).toMatchObject({ ok: false, code: 'shared_checkout' })
  })
})

describe('archiveDecision', () => {
  const idle = { archived: false, running: false, liveWork: false, waitingForUser: false, starting: false }
  it('archives an idle session once, and protects a running, working, waiting or starting one', () => {
    expect(archiveDecision(idle)).toEqual({ ok: true, changed: true })
    expect(archiveDecision({ ...idle, archived: true })).toEqual({ ok: true, changed: false })
    expect(archiveDecision({ ...idle, running: true })).toMatchObject({ ok: false, code: 'running' })
    expect(archiveDecision({ ...idle, liveWork: true })).toMatchObject({ ok: false, code: 'live_work' })
    expect(archiveDecision({ ...idle, waitingForUser: true })).toMatchObject({ ok: false, code: 'waiting_user' })
    expect(archiveDecision({ ...idle, starting: true })).toMatchObject({ ok: false, code: 'starting' })
  })
})

describe('lineageInputFromRelationFields', () => {
  it('rebuilds the relation the summary was built from', () => {
    const origin: SessionOrigin = { sessionId: 'p', taskId: 't', kind: 'hand_off', initiator: 'model', name: 'x' }
    const s1 = buildSessionSummaryFromMetadata('c', 1, { spawnedFrom: origin })!
    expect(lineageInputFromRelationFields(s1)).toEqual({ spawnedFrom: { sessionId: 'p', taskId: '', kind: 'hand_off', initiator: 'model', name: 'x' } })
    const s2 = buildSessionSummaryFromMetadata('f', 1, { forkedFromSessionId: 'p' })!
    expect(lineageInputFromRelationFields(s2)).toEqual({ forkedFromSessionId: 'p' })
    const s3 = buildSessionSummaryFromMetadata('d', 1, { spawnedFrom: origin, lineageDetached: true })!
    expect(lineageInputFromRelationFields(s3)).toEqual({ lineageDetached: true })
    const s4 = buildSessionSummaryFromMetadata('t', 1, { spawnedFrom: { ...origin, initiator: 'user', userFork: true } })!
    expect(lineageInputFromRelationFields(s4).spawnedFrom).toMatchObject({ sessionId: 'p', initiator: 'user', userFork: true })
    expect(lineageInputFromRelationFields(buildSessionSummaryFromMetadata('s', 1, {})!)).toEqual({})
  })
  it('the summary carries the archived flag', () => {
    expect(buildSessionSummaryFromMetadata('a', 1, { archived: true })?.archived).toBe(true)
    expect(buildSessionSummaryFromMetadata('a', 1, { archived: false })?.archived).toBeUndefined()
  })
})

describe('pageTranscript', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: `u${i}`,
    timestamp: `2026-11-01T00:00:0${i}Z`,
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content:
        i % 2 === 0
          ? `prompt ${i}`
          : [
              { type: 'text', text: `answer ${i}` },
              { type: 'tool-call', toolName: 'Read', args: {} },
            ],
    },
  })) as never[]

  it('takes the last rows oldest first, with text, tool names and the cursor', () => {
    const page = pageTranscript([{ type: 'session_meta' } as never, ...entries], 3)
    expect(page).toMatchObject({ hasMore: true })
    if ('error' in page) throw new Error('unexpected')
    expect(page.events.map(e => e.uuid)).toEqual(['u7', 'u8', 'u9'])
    expect(page.events[0]).toEqual({ uuid: 'u7', type: 'assistant', at: '2026-11-01T00:00:07Z', text: 'answer 7', toolCalls: ['Read'] })
    expect(page.events[1]).toEqual({ uuid: 'u8', type: 'user', at: '2026-11-01T00:00:08Z', text: 'prompt 8' })
  })
  it('pages backwards from beforeUuid and reports the end', () => {
    const page = pageTranscript(entries, 4, 'u3')
    if ('error' in page) throw new Error('unexpected')
    expect(page.events.map(e => e.uuid)).toEqual(['u0', 'u1', 'u2'])
    expect(page.hasMore).toBe(false)
    expect(pageTranscript(entries, 4, 'nope')).toEqual({ error: 'unknown_cursor' })
  })
})

describe('small helpers', () => {
  it('clampLimit, receiptTail, appendPeerInbox', () => {
    expect(clampLimit(undefined, 40, 500)).toBe(40)
    expect(clampLimit(9000, 40, 500)).toBe(500)
    expect(clampLimit(0, 40, 500)).toBe(1)
    expect(receiptTail({ messageId: 'msg_1', state: 'queued' })).toBe('(delivery: queued; message_id: msg_1)')
    expect(receiptTail({ messageId: 'msg_1', state: 'undelivered', reasonCode: 'no_turn' })).toBe('(delivery: undelivered; reason_code: no_turn; message_id: msg_1)')
    const entry = { messageId: 'm', fromSessionId: 'a', trust: 'trusted' as const, text: 'hi', at: 1 }
    const many = Array.from({ length: PEER_INBOX_MAX + 3 }, (_, i) => ({ ...entry, messageId: `m${i}` }))
    const kept = appendPeerInbox([...many, { junk: true }], { ...entry, messageId: 'last' })
    expect(kept).toHaveLength(PEER_INBOX_MAX)
    expect(kept.at(-1)?.messageId).toBe('last')
  })
})
