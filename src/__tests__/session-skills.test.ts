import { describe, expect, it } from 'vitest'
import {
  buildSessionSkillPanelList,
  filterSessionSkillsByParent,
  restoreSessionSkillsFromTranscript,
  sessionHasInvokedSkills,
  sessionSkillsEqual,
} from '../browser/webview/sessionSkills'
import type { NexusSessionSkillRow } from '../browser/bridge/protocol/ui'
import type { LoadedSkillSummary } from '../browser/worker/workerProtocol'
import type { Message } from '../runtime/RuntimeTypes'

const row = (over: Partial<NexusSessionSkillRow> = {}): NexusSessionSkillRow => ({
  spawnerSessionId: 'S1',
  name: 'plugin:build',
  path: '/skills/build/SKILL.md',
  invokedAt: 1000,
  ...over,
})

describe('sessionSkillsEqual', () => {
  it('is true for identical row lists (same order + fields)', () => {
    expect(sessionSkillsEqual([row()], [row()])).toBe(true)
  })

  it('is false when a field or the length differs', () => {
    expect(sessionSkillsEqual([row()], [row({ name: 'other' })])).toBe(false)
    expect(sessionSkillsEqual([row()], [row(), row({ name: 'x' })])).toBe(false)
    expect(sessionSkillsEqual([row()], [row({ invokedAt: 2000 })])).toBe(false)
  })
})

describe('filterSessionSkillsByParent', () => {
  it('keeps only the active session rows, preserving order', () => {
    const rows = [
      row({ spawnerSessionId: 'S1', name: 'a' }),
      row({ spawnerSessionId: 'S2', name: 'b' }),
      row({ spawnerSessionId: 'S1', name: 'c' }),
    ]
    expect(filterSessionSkillsByParent(rows, 'S1').map(r => r.name)).toEqual(['a', 'c'])
  })

  it('returns [] for no rows or no session', () => {
    expect(filterSessionSkillsByParent(undefined, 'S1')).toEqual([])
    expect(filterSessionSkillsByParent([row()], null)).toEqual([])
  })
})

describe('sessionSkillsEqual — size participates', () => {
  it('is false when only size differs (same-ms re-invocation with a new body)', () => {
    expect(
      sessionSkillsEqual([row({ size: 10 })], [row({ size: 20 })]),
    ).toBe(false)
  })
})

describe('sessionSkillsEqual — status + id participate', () => {
  it('is false when only the status differs (same row re-logged)', () => {
    expect(
      sessionSkillsEqual(
        [row({ id: 'e1', status: 'loaded' })],
        [row({ id: 'e1', status: 'failed' })],
      ),
    ).toBe(false)
  })

  it('is false when only the id differs (two same-ms invocations)', () => {
    expect(
      sessionSkillsEqual(
        [row({ id: 'e1', invokedAt: 5 })],
        [row({ id: 'e2', invokedAt: 5 })],
      ),
    ).toBe(false)
  })
})

describe('buildSessionSkillPanelList', () => {
  const registry: LoadedSkillSummary[] = [
    {
      name: 'commit',
      path: 'bundled:commit',
      description: 'Create a git commit',
      source: 'bundled',
      size: 2048,
    },
    // Dynamic-content bundled skill: registry size is unknown (empty-string
    // content placeholder).
    { name: 'debug', path: 'bundled:debug', source: 'bundled', size: undefined },
  ]

  it('lists ONLY the active session\'s invoked skills, in feed order — not the whole registry', () => {
    const rows = [
      row({ spawnerSessionId: 'S1', name: 'debug', path: 'bundled:debug', invokedAt: 2000 }),
      row({ spawnerSessionId: 'S2', name: 'commit', path: 'bundled:commit' }),
      row({ spawnerSessionId: 'S1', name: 'commit', path: 'bundled:commit', invokedAt: 1000 }),
    ]
    const list = buildSessionSkillPanelList(rows, 'S1', registry)
    // 'S2''s invocation is out; the registry's uninvoked skills are out too.
    expect(list.map(s => s.name)).toEqual(['debug', 'commit'])
  })

  it('enriches rows from the registry (description/source) and prefers the row\'s own size', () => {
    const rows = [
      row({ spawnerSessionId: 'S1', name: 'debug', path: 'bundled:debug', size: 917 }),
    ]
    const list = buildSessionSkillPanelList(rows, 'S1', registry)
    // The invoked body's real byte length wins even though the registry has
    // no size for a dynamic-content bundled skill — this is the "0k" fix.
    expect(list[0]).toMatchObject({
      name: 'debug',
      source: 'bundled',
      size: 917,
    })
  })

  it('backfills size from the registry when an older worker bundle emits none', () => {
    const rows = [
      row({ spawnerSessionId: 'S1', name: 'commit', path: 'bundled:commit', size: undefined }),
    ]
    const list = buildSessionSkillPanelList(rows, 'S1', registry)
    expect(list[0]).toMatchObject({
      name: 'commit',
      description: 'Create a git commit',
      size: 2048,
    })
  })

  it('keeps an invoked skill the registry no longer knows (row stands alone)', () => {
    const rows = [
      row({ spawnerSessionId: 'S1', name: 'gone', path: '/skills/gone/SKILL.md', size: 5 }),
    ]
    const list = buildSessionSkillPanelList(rows, 'S1', registry)
    expect(list[0]).toMatchObject({ name: 'gone', size: 5 })
    expect(list[0]!.description).toBeUndefined()
  })

  it('returns [] with no session or no rows', () => {
    expect(buildSessionSkillPanelList([row()], null, registry)).toEqual([])
    expect(buildSessionSkillPanelList(undefined, 'S1', registry)).toEqual([])
  })

  it('keeps every invocation as its own row — re-invocation is another `loaded` row', () => {
    const rows: NexusSessionSkillRow[] = [
      row({ name: 'pdf', path: '/s/pdf/SKILL.md', invokedAt: 3000, id: 'e2', status: 'loaded', detailId: 'skill:u2', size: 100 }),
      row({ name: 'pdf', path: '/s/pdf/SKILL.md', invokedAt: 1000, id: 'e1', status: 'loaded', detailId: 'skill:u1', size: 100 }),
    ]
    const list = buildSessionSkillPanelList(rows, 'S1', registry)
    expect(list).toEqual([
      expect.objectContaining({ id: 'e2', name: 'pdf', status: 'loaded', detailId: 'skill:u2' }),
      expect.objectContaining({ id: 'e1', name: 'pdf', status: 'loaded', detailId: 'skill:u1' }),
    ])
  })

  it('defaults a missing status to loaded (older worker bundle) and carries a failed row\'s error', () => {
    const rows: NexusSessionSkillRow[] = [
      row({ name: 'pdf', path: '/s/pdf/SKILL.md', invokedAt: 2000, id: 'ok' }),
      row({ name: 'pdf', path: '/s/pdf/SKILL.md', invokedAt: 1000, id: 'bad', status: 'failed', error: 'shell boom' }),
    ]
    const list = buildSessionSkillPanelList(rows, 'S1', registry)
    expect(list[0]!.status).toBe('loaded') // status absent → loaded
    expect(list[1]).toMatchObject({ status: 'failed', error: 'shell boom' })
  })

  it('marks transcript-restored rows as loaded', () => {
    const list = buildSessionSkillPanelList([], 'S1', registry, [
      { name: 'debug', detailId: 'skill:u9' },
    ])
    expect(list[0]).toMatchObject({
      name: 'debug',
      status: 'loaded',
      detailId: 'skill:u9',
    })
  })

  it('appends transcript-restored skills after the live rows, registry-enriched, without duplicating live names', () => {
    const rows = [
      row({ spawnerSessionId: 'S1', name: 'commit', path: 'bundled:commit', size: 30 }),
    ]
    const list = buildSessionSkillPanelList(rows, 'S1', registry, [
      // Live already — must NOT appear twice, but lends its sidecar id to
      // the live row (a bundled skill's only body source).
      { name: 'commit', detailId: 'skill:u1' },
      { name: 'debug', detailId: 'skill:u2' },
      // No longer in the registry — row stands alone on its sidecar.
      { name: 'gone', detailId: 'skill:u3' },
    ])
    expect(list.map(s => s.name)).toEqual(['commit', 'debug', 'gone'])
    expect(list[0]).toMatchObject({ size: 30, detailId: 'skill:u1' })
    expect(list[1]).toMatchObject({
      path: 'bundled:debug',
      source: 'bundled',
      detailId: 'skill:u2',
    })
    // Registry-unknown restored row: empty path, sidecar only, no size badge.
    expect(list[2]).toMatchObject({ path: '', detailId: 'skill:u3' })
    expect(list[2]!.size).toBeUndefined()
  })
})

describe('restoreSessionSkillsFromTranscript', () => {
  const skillMessage = (
    name: string,
    over: Record<string, unknown> = {},
  ): Message =>
    ({
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n\n[Skill instructions are stored in tool-details and loaded on demand.]`,
      },
      toolCallDetailRef: { toolCallId: `skill:${name}-uuid`, toolName: 'Skill' },
      ...over,
    }) as unknown as Message

  it('recovers skill invocations (name + sidecar id), newest-first, ignoring non-skill messages', () => {
    const messages: Message[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } } as Message,
      skillMessage('alpha'),
      { type: 'assistant', message: { role: 'assistant', content: [] } } as unknown as Message,
      skillMessage('beta'),
    ]
    expect(restoreSessionSkillsFromTranscript(messages)).toEqual([
      { name: 'beta', detailId: 'skill:beta-uuid' },
      { name: 'alpha', detailId: 'skill:alpha-uuid' },
    ])
  })

  it('requires isMeta — a user literally pasting the tags is not an invocation', () => {
    expect(
      restoreSessionSkillsFromTranscript([skillMessage('alpha', { isMeta: false })]),
    ).toEqual([])
  })

  it('dedupes by name keeping the LATEST invocation and its position', () => {
    const later = skillMessage('alpha', {
      toolCallDetailRef: { toolCallId: 'skill:alpha-later', toolName: 'Skill' },
    })
    const restored = restoreSessionSkillsFromTranscript([
      skillMessage('alpha'),
      skillMessage('beta'),
      later,
    ])
    // alpha re-invoked after beta → alpha is the newest row, with the LATER
    // invocation's sidecar id.
    expect(restored).toEqual([
      { name: 'alpha', detailId: 'skill:alpha-later' },
      { name: 'beta', detailId: 'skill:beta-uuid' },
    ])
  })

  it('handles block-structured content and a legacy message with no sidecar ref', () => {
    const blocky = skillMessage('gamma', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<command-message>gamma</command-message>\n\nbody' },
        ],
      },
      toolCallDetailRef: undefined,
    })
    expect(restoreSessionSkillsFromTranscript([blocky])).toEqual([
      { name: 'gamma', detailId: null },
    ])
  })

  it('returns [] for empty input', () => {
    expect(restoreSessionSkillsFromTranscript(undefined)).toEqual([])
    expect(restoreSessionSkillsFromTranscript([])).toEqual([])
  })
})

describe('sessionHasInvokedSkills', () => {
  const skillMessage = (name: string, over: Record<string, unknown> = {}): Message =>
    ({
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n\n[Skill instructions are stored in tool-details and loaded on demand.]`,
      },
      ...over,
    }) as unknown as Message
  const userMsg = (text: string): Message =>
    ({ type: 'user', message: { role: 'user', content: text } }) as Message

  it('is true when the transcript proves ANY skill was loaded', () => {
    expect(
      sessionHasInvokedSkills([userMsg('hello'), skillMessage('alpha'), userMsg('bye')]),
    ).toBe(true)
  })

  it('is false for a conversation that never loaded a skill', () => {
    expect(
      sessionHasInvokedSkills([
        userMsg('hello'),
        { type: 'assistant', message: { role: 'assistant', content: [] } } as unknown as Message,
        userMsg('do the thing'),
      ]),
    ).toBe(false)
  })

  it('requires isMeta — a user pasting the tags does not count', () => {
    expect(sessionHasInvokedSkills([skillMessage('alpha', { isMeta: false })])).toBe(false)
  })

  it('is false for empty / undefined input', () => {
    expect(sessionHasInvokedSkills(undefined)).toBe(false)
    expect(sessionHasInvokedSkills([])).toBe(false)
  })
})
