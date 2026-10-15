import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ContextRow,
  InvokedSkillsAttachment,
  Message,
  UserRow,
} from '../runtime/RuntimeTypes'
import {
  MSG_TYPE_ATTACHMENT,
  MSG_TYPE_USER,
} from '../runtime/VercelModelConstants'
import { renderAttachmentMessage } from '../messages/renderAttachments'
import {
  REFOLD_SKILL_TOKEN_CAP,
  REFOLD_SKILLS_TOKEN_POOL,
  __resetInvokedSkillsStoreForTests,
  noteSkillUse,
  clearInvokedSkillsForSession,
  createInvokedSkillsAttachmentPayload,
  skillsUsedBy,
  restoreInvokedSkillsFromMessages,
} from '../skillLibrary/invokedSkillsStore'

beforeEach(() => {
  __resetInvokedSkillsStoreForTests()
})

describe('invokedSkillsStore — add / get / scope', () => {
  it('records a skill invocation and looks it up by (session, agent)', () => {
    noteSkillUse('S1', 'pdf', '/skills/pdf/SKILL.md', 'pdf body', null)
    const got = skillsUsedBy('S1')
    expect(got.size).toBe(1)
    const entry = Array.from(got.values())[0]!
    expect(entry.skillName).toBe('pdf')
    expect(entry.skillPath).toBe('/skills/pdf/SKILL.md')
    expect(entry.content).toBe('pdf body')
    expect(entry.agentId).toBe(null)
  })

  it('overwrites on re-invocation (same session/agent/name) with the newer body', () => {
    noteSkillUse('S1', 'pdf', '/skills/pdf/SKILL.md', 'v1', null)
    noteSkillUse('S1', 'pdf', '/skills/pdf/SKILL.md', 'v2', null)
    const got = skillsUsedBy('S1')
    expect(got.size).toBe(1)
    expect(Array.from(got.values())[0]!.content).toBe('v2')
  })

  it('scopes by sessionId — sessions do not see each other', () => {
    noteSkillUse('S1', 'pdf', '/skills/pdf/SKILL.md', 'A', null)
    noteSkillUse('S2', 'pdf', '/skills/pdf/SKILL.md', 'B', null)
    expect(Array.from(skillsUsedBy('S1').values())[0]!.content).toBe('A')
    expect(Array.from(skillsUsedBy('S2').values())[0]!.content).toBe('B')
  })

  it('scopes by agentId within a session — main and sub-agent are distinct', () => {
    noteSkillUse('S1', 'pdf', '/p', 'main body', null)
    noteSkillUse('S1', 'pdf', '/p', 'subagent body', 'agent-7')
    expect(skillsUsedBy('S1', null).size).toBe(1)
    expect(skillsUsedBy('S1', 'agent-7').size).toBe(1)
    expect(
      Array.from(skillsUsedBy('S1', null).values())[0]!.content,
    ).toBe('main body')
    expect(
      Array.from(skillsUsedBy('S1', 'agent-7').values())[0]!.content,
    ).toBe('subagent body')
  })

  it('clearInvokedSkillsForSession drops the whole session bucket', () => {
    noteSkillUse('S1', 'pdf', '/p', 'A', null)
    noteSkillUse('S2', 'docx', '/d', 'B', null)
    clearInvokedSkillsForSession('S1')
    expect(skillsUsedBy('S1').size).toBe(0)
    expect(skillsUsedBy('S2').size).toBe(1)
  })

  it('no-ops on empty sessionId / skillName', () => {
    noteSkillUse('', 'pdf', '/p', 'body', null)
    noteSkillUse('S1', '', '/p', 'body', null)
    expect(skillsUsedBy('S1').size).toBe(0)
  })
})

describe('createInvokedSkillsAttachmentPayload', () => {
  it('returns null when nothing has been invoked', () => {
    expect(createInvokedSkillsAttachmentPayload('S1')).toBeNull()
  })

  it('produces an attachment with the invoked skills (recent-first ordering)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    noteSkillUse('S1', 'a', '/a', 'body A', null)
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'))
    noteSkillUse('S1', 'b', '/b', 'body B', null)
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'))
    noteSkillUse('S1', 'c', '/c', 'body C', null)
    const payload = createInvokedSkillsAttachmentPayload('S1')!
    expect(payload.type).toBe('invoked_skills')
    // Most-recent first: c, b, a.
    expect(payload.skills.map(s => s.name)).toEqual(['c', 'b', 'a'])
    vi.useRealTimers()
  })

  it('truncates per-skill content at REFOLD_SKILL_TOKEN_CAP', () => {
    // One skill larger than the per-skill cap (5000 tokens * 4 chars/token = 20000 chars).
    const huge = 'X'.repeat(REFOLD_SKILL_TOKEN_CAP * 4 + 5_000)
    noteSkillUse('S1', 'big', '/big', huge, null)
    const payload = createInvokedSkillsAttachmentPayload('S1')!
    expect(payload.skills[0]!.content.length).toBeLessThan(huge.length)
    expect(payload.skills[0]!.content.endsWith('…')).toBe(true)
    // Capped within the per-skill char budget.
    expect(payload.skills[0]!.content.length).toBeLessThanOrEqual(
      REFOLD_SKILL_TOKEN_CAP * 4,
    )
  })

  it('drops skills that would exceed REFOLD_SKILLS_TOKEN_POOL', () => {
    // Per-skill cap = 5_000 tokens (20k chars). Total budget = 25_000 tokens —
    // so 6 skills each near the per-skill cap pushes the running total over
    // and the OLDEST drops out (recent-first sort + first-overflow-stops).
    vi.useFakeTimers()
    const huge = 'X'.repeat(REFOLD_SKILL_TOKEN_CAP * 4)
    for (let i = 0; i < 6; i += 1) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}Z`))
      noteSkillUse('S1', `s${i}`, `/p${i}`, huge, null)
    }
    const payload = createInvokedSkillsAttachmentPayload('S1')!
    // Five fit (5 × 5000 = 25000 tokens); the sixth (oldest = s0) is dropped.
    // Order is recent-first.
    expect(payload.skills.map(s => s.name)).toEqual([
      's5',
      's4',
      's3',
      's2',
      's1',
    ])
    vi.useRealTimers()
    // Sanity: total content tokens at the budget.
    const totalChars = payload.skills.reduce(
      (sum, s) => sum + s.content.length,
      0,
    )
    expect(totalChars).toBeLessThanOrEqual(REFOLD_SKILLS_TOKEN_POOL * 4)
  })

  it('filters out the other agent scope (subagent isolation)', () => {
    noteSkillUse('S1', 'a', '/a', 'main', null)
    noteSkillUse('S1', 'b', '/b', 'subagent', 'agent-7')
    const mainPayload = createInvokedSkillsAttachmentPayload('S1', null)!
    expect(mainPayload.skills.map(s => s.name)).toEqual(['a'])
    const subPayload = createInvokedSkillsAttachmentPayload('S1', 'agent-7')!
    expect(subPayload.skills.map(s => s.name)).toEqual(['b'])
  })
})

describe('restoreInvokedSkillsFromMessages', () => {
  function fakeAttachmentMessage(
    skills: InvokedSkillsAttachment['skills'],
  ): ContextRow {
    return {
      type: MSG_TYPE_ATTACHMENT,
      uuid: 'u',
      timestamp: 't',
      attachment: { type: 'invoked_skills', skills },
    } as ContextRow
  }

  it('re-populates the store from invoked_skills attachments on resume', () => {
    const messages: Message[] = [
      // Some unrelated user message…
      {
        type: MSG_TYPE_USER,
        uuid: 'u1',
        timestamp: 't1',
        message: { role: 'user', content: 'hi' },
      } as Message,
      fakeAttachmentMessage([
        { name: 'pdf', path: '/skills/pdf/SKILL.md', content: 'restored pdf body' },
        { name: 'docx', path: '/skills/docx/SKILL.md', content: 'restored docx body' },
      ]),
    ]
    expect(skillsUsedBy('S1').size).toBe(0)
    restoreInvokedSkillsFromMessages('S1', messages)
    const restored = skillsUsedBy('S1')
    expect(restored.size).toBe(2)
    const byName = new Map(
      Array.from(restored.values()).map(e => [e.skillName, e]),
    )
    expect(byName.get('pdf')!.content).toBe('restored pdf body')
    // In-store entries expose `skillPath` (the attachment payload uses `path`).
    expect(byName.get('docx')!.skillPath).toBe('/skills/docx/SKILL.md')
  })

  it('ignores attachments with missing fields', () => {
    const messages: Message[] = [
      fakeAttachmentMessage([
        { name: '', path: '/p', content: 'body' } as never, // empty name
        { name: 'ok', path: '/ok', content: 'ok body' },
      ]),
    ]
    restoreInvokedSkillsFromMessages('S1', messages)
    const restored = skillsUsedBy('S1')
    expect(restored.size).toBe(1)
    expect(Array.from(restored.values())[0]!.skillName).toBe('ok')
  })

  it('does not throw on non-attachment messages or missing payloads', () => {
    const messages: Message[] = [
      {
        type: MSG_TYPE_USER,
        uuid: 'u',
        timestamp: 't',
        message: { role: 'user', content: 'hi' },
      } as Message,
      // attachment without `invoked_skills`
      {
        type: MSG_TYPE_ATTACHMENT,
        uuid: 'u2',
        timestamp: 't2',
        attachment: { type: 'date_change', newDate: '2026-01-01' },
      } as ContextRow,
    ]
    expect(() => restoreInvokedSkillsFromMessages('S1', messages)).not.toThrow()
    expect(skillsUsedBy('S1').size).toBe(0)
  })

  it('renders to a system-reminder user message that the model can read (track → emit → render)', () => {
    noteSkillUse('S1', 'pdf', '/skills/pdf/SKILL.md', '## How to PDF\nstep one', null)
    noteSkillUse('S1', 'review', '/skills/review/SKILL.md', '## Review checklist\n- diff', null)
    const payload = createInvokedSkillsAttachmentPayload('S1')!
    const attachmentMessage: ContextRow = {
      type: MSG_TYPE_ATTACHMENT,
      uuid: 'u',
      timestamp: 't',
      attachment: payload,
    } as ContextRow
    const rendered = renderAttachmentMessage(attachmentMessage)
    expect(rendered).toHaveLength(1)
    const msg = rendered[0]! as UserRow
    expect(msg.type).toBe(MSG_TYPE_USER)
    expect(msg.isMeta).toBe(true)
    const content = msg.message.content as string
    // A system-reminder wrapper around one block per invoked skill.
    expect(content).toContain('<system-reminder>')
    expect(content).toContain(
      'The following skills were invoked in this session. Continue to follow these guidelines:',
    )
    expect(content).toContain('### Skill: pdf')
    expect(content).toContain('Path: /skills/pdf/SKILL.md')
    expect(content).toContain('## How to PDF')
    expect(content).toContain('### Skill: review')
    // The two skills are separated by the `---` divider.
    expect(content.split('\n---\n').length).toBeGreaterThanOrEqual(2)
  })

  it('renders an empty list to no messages (defensive — builder also returns null first)', () => {
    const attachmentMessage: ContextRow = {
      type: MSG_TYPE_ATTACHMENT,
      uuid: 'u',
      timestamp: 't',
      attachment: { type: 'invoked_skills', skills: [] },
    } as ContextRow
    expect(renderAttachmentMessage(attachmentMessage)).toEqual([])
  })

  it('survives a round-trip: invoke → emit → restore → re-emit produces the same attachment', () => {
    noteSkillUse('S1', 'a', '/a', 'body A', null)
    noteSkillUse('S1', 'b', '/b', 'body B', null)
    const first = createInvokedSkillsAttachmentPayload('S1')!
    // Simulate process restart: wipe and re-load from the prior attachment.
    __resetInvokedSkillsStoreForTests()
    const messages: Message[] = [
      {
        type: MSG_TYPE_ATTACHMENT,
        uuid: 'u',
        timestamp: 't',
        attachment: first,
      } as ContextRow,
    ]
    restoreInvokedSkillsFromMessages('S1', messages)
    const second = createInvokedSkillsAttachmentPayload('S1')!
    expect(second.skills.map(s => s.name).sort()).toEqual(
      first.skills.map(s => s.name).sort(),
    )
    for (const s of second.skills) {
      const original = first.skills.find(o => o.name === s.name)!
      expect(s.content).toBe(original.content)
      expect(s.path).toBe(original.path)
    }
  })
})
