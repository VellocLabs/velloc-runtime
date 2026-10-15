import { describe, expect, it } from 'vitest'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import type { Message, UserRow } from '../runtime/RuntimeTypes'
import { createSkillInvocationMessage } from '../skillLibrary/skillInvocationMessage'
import {
  SKILL_BODY_STUB_MARKER,
  getSkillBodyDetailId,
  isSkillBodyDetailId,
  isSkillInvocationStub,
  parseSkillInvocationTags,
  skillInvocationStub,
} from '../skillLibrary/skillInvocationTags'
import {
  getLazyToolCallRefsFromMessage,
  getToolCallDetailsFromMessage,
  hydrateMessageToolPayloads,
  sanitizeMessageForPersistence,
  sanitizeMessageForUi,
  type BrowserToolCallDetailRecord,
} from '../utils/toolCallDetails'
import {
  collectSkillBodyRefs,
  collectToolCalls,
  skillBodyRefFromMessage,
} from '../browser/webview/assistantUiAdapterParts'
import { convertTranscriptToThreadMessages } from '../browser/webview/assistantUiAdapter'

// The skill-invocation message (isMeta user message: loading-metadata tags
// + the expanded SKILL.md body) used to be persisted verbatim — a handful of
// skills were a third of a transcript. It now rides the lazy tool-detail
// sidecar: `skill:<uuid>` ref on the message, body in `tool-details/`, tags +
// marker in the transcript row, full text restored for the model on hydrate.
// The UI renders it as a Skill card instead of hiding it.

const COMMAND: ChromiumCommandMetadata = {
  name: 'superpowers:writing-plans',
  description: 'Write plans',
  path: 'C:/skills/writing-plans/SKILL.md',
  userCallable: true,
} as unknown as ChromiumCommandMetadata

const BODY = '# Writing Plans\n\nA long body.\n\n## Steps\n- one\n- two'

function contentOf(message: Message): string {
  return (message as UserRow).message.content as string
}

describe('createSkillInvocationMessage', () => {
  it('builds the isMeta message with a skill:<uuid> sidecar holding the full text', () => {
    const message = createSkillInvocationMessage(COMMAND, 'my args', BODY)
    expect(message.isMeta).toBe(true)
    const content = contentOf(message)
    expect(content.startsWith('<command-message>superpowers:writing-plans</command-message>')).toBe(true)
    expect(content).toContain('<command-args>my args</command-args>')
    expect(content.endsWith(BODY)).toBe(true)

    const detailId = getSkillBodyDetailId(message)
    expect(detailId).toBe(`skill:${message.uuid}`)
    expect(isSkillBodyDetailId(detailId)).toBe(true)

    // The sidecar record persistToolCallDetails writes.
    const details = getToolCallDetailsFromMessage(message)
    expect(details).toHaveLength(1)
    expect(details[0]).toMatchObject({
      toolCallId: detailId,
      toolName: 'Skill',
      args: { skill: 'superpowers:writing-plans', args: 'my args' },
      result: content,
    })
    // And the lazy ref hydrateMessagesForModel collects.
    expect(getLazyToolCallRefsFromMessage(message)).toEqual([
      { toolCallId: detailId, toolName: 'Skill' },
    ])
  })
})

describe('parseSkillInvocationTags / stub', () => {
  it('parses name, args and the skill-format flag; rejects non-skill text', () => {
    expect(
      parseSkillInvocationTags(
        '<command-message>a:b</command-message>\n<command-name>/a:b</command-name>\n<command-args>x y</command-args>\n\nbody',
      ),
    ).toEqual({ name: 'a:b', args: 'x y', skillFormat: false })
    expect(
      parseSkillInvocationTags(
        '<command-message>m</command-message>\n<command-name>m</command-name>\n<skill-format>true</skill-format>\n\nbody',
      ),
    ).toEqual({ name: 'm', skillFormat: true })
    expect(parseSkillInvocationTags('plain user text')).toBeNull()
    expect(parseSkillInvocationTags([{ type: 'text', text: 'x' }])).toBeNull()
  })

  it('the stub keeps only the tag header plus the marker', () => {
    const message = createSkillInvocationMessage(COMMAND, undefined, BODY)
    const stub = skillInvocationStub(contentOf(message))
    expect(stub).toBe(
      '<command-message>superpowers:writing-plans</command-message>\n'
      + '<command-name>/superpowers:writing-plans</command-name>\n\n'
      + SKILL_BODY_STUB_MARKER,
    )
    expect(isSkillInvocationStub(stub)).toBe(true)
    expect(isSkillInvocationStub(contentOf(message))).toBe(false)
    expect(stub).not.toContain('A long body')
  })
})

describe('persist → hydrate round-trip', () => {
  it('sanitize strips the body to the stub (persistence AND UI copies)', () => {
    const message = createSkillInvocationMessage(COMMAND, undefined, BODY)
    for (const sanitized of [
      sanitizeMessageForPersistence(message),
      sanitizeMessageForUi(message),
    ]) {
      const content = contentOf(sanitized)
      expect(isSkillInvocationStub(content)).toBe(true)
      expect(content).not.toContain('A long body')
      // The ref survives (it is how hydrate finds the sidecar) …
      expect(getSkillBodyDetailId(sanitized)).toBe(getSkillBodyDetailId(message))
      // … the inline detail does not (it is the sidecar's job).
      expect((sanitized as { toolCallDetail?: unknown }).toolCallDetail).toBeUndefined()
      expect(sanitized.isMeta).toBe(true)
    }
    // The original is untouched (the runtime keeps the full text in memory).
    expect(contentOf(message).endsWith(BODY)).toBe(true)
  })

  it('hydrate puts the full text back from the sidecar', () => {
    const message = createSkillInvocationMessage(COMMAND, 'args!', BODY)
    const detailId = getSkillBodyDetailId(message)!
    const persisted = sanitizeMessageForPersistence(message)
    const details = new Map<string, BrowserToolCallDetailRecord>(
      getToolCallDetailsFromMessage(message).map(d => [d.toolCallId, d]),
    )
    const hydrated = hydrateMessageToolPayloads(persisted, details)
    expect(contentOf(hydrated)).toBe(contentOf(message))
    expect(getSkillBodyDetailId(hydrated)).toBe(detailId)
  })

  it('a missing sidecar leaves the stub (degraded, not corrupt)', () => {
    const message = createSkillInvocationMessage(COMMAND, undefined, BODY)
    const persisted = sanitizeMessageForPersistence(message)
    const hydrated = hydrateMessageToolPayloads(persisted, new Map())
    expect(isSkillInvocationStub(contentOf(hydrated))).toBe(true)
  })

  it('a pre-sidecar skill message (no ref) is persisted verbatim as before', () => {
    const legacy: Message = {
      type: 'user',
      uuid: 'legacy-1',
      isMeta: true,
      message: {
        role: 'user',
        content: `<command-message>x</command-message>\n<command-name>/x</command-name>\n\n${BODY}`,
      },
    } as unknown as Message
    expect(contentOf(sanitizeMessageForPersistence(legacy))).toBe(contentOf(legacy))
  })
})

describe('adapter: skill invocations render as Skill cards', () => {
  const SKILL_TEXT =
    '<command-message>browser</command-message>\n<command-name>/browser</command-name>\n\n## Browser tools'

  it('a user-typed /skill (no tool call) becomes a synthesized Skill tool-call card', () => {
    const message = createSkillInvocationMessage(COMMAND, 'go', BODY)
    const persisted = sanitizeMessageForPersistence(message)
    const { messages } = convertTranscriptToThreadMessages([
      {
        type: 'user',
        uuid: 'u-1',
        timestamp: '2026-08-19T12:00:00.000Z',
        message: { role: 'user', content: '/superpowers:writing-plans go' },
      } as unknown as Message,
      persisted,
    ])
    expect(messages).toHaveLength(2)
    const card = messages[1]!
    expect(card.role).toBe('assistant')
    expect(card.id).toBe(message.uuid)
    expect(card.content).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolName: 'Skill',
        toolCallId: `skill:${message.uuid}`,
        args: { skill: 'superpowers:writing-plans', args: 'go' },
        result: {
          skillBodyRef: {
            name: 'superpowers:writing-plans',
            args: 'go',
            detailId: `skill:${message.uuid}`,
            inlineBody: null,
          },
        },
      }),
    ])
  })

  it('a pre-sidecar (inline body) skill message still renders, carrying the body inline', () => {
    const ref = skillBodyRefFromMessage({
      type: 'user',
      uuid: 'legacy',
      isMeta: true,
      message: { role: 'user', content: SKILL_TEXT },
    } as unknown as UserRow)
    expect(ref).toEqual({ name: 'browser', detailId: null, inlineBody: SKILL_TEXT })
  })

  it('a model-invoked Skill call absorbs its injected message: ONE card, ref on the tool call', () => {
    const injected = createSkillInvocationMessage(COMMAND, undefined, BODY)
    const transcript: Message[] = [
      {
        type: 'assistant',
        uuid: 'a-1',
        timestamp: '2026-08-19T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'call-skill', toolName: 'Skill', args: { skill: COMMAND.name } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'r-1',
        message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-skill' }] },
        toolUseResult: '',
        sourceToolAssistantUUID: 'a-1',
        toolCallDetailRef: { toolCallId: 'call-skill', toolName: 'Skill' },
      },
      { ...sanitizeMessageForPersistence(injected), sourceToolAssistantUUID: 'a-1' },
    ] as unknown as Message[]

    const refs = collectSkillBodyRefs(transcript, collectToolCalls(transcript))
    expect(refs.absorbedMessageIds.has(injected.uuid!)).toBe(true)
    expect(refs.byToolCallId.get('call-skill')).toMatchObject({
      name: COMMAND.name,
      detailId: `skill:${injected.uuid}`,
    })

    const { messages } = convertTranscriptToThreadMessages(transcript)
    // Only the assistant message with the Skill call — no second card.
    expect(messages).toHaveLength(1)
    expect(messages.some(m => m.id === injected.uuid)).toBe(false)
    const part = (messages[0]!.content as unknown as Array<Record<string, unknown>>)[0]!
    expect(part).toMatchObject({
      type: 'tool-call',
      toolName: 'Skill',
      args: { skill: COMMAND.name },
      result: { skillBodyRef: { name: COMMAND.name, detailId: `skill:${injected.uuid}` } },
    })
  })

  it('pairs the n-th injected message with the n-th Skill call of one assistant message', () => {
    const first = createSkillInvocationMessage(COMMAND, undefined, 'b1')
    const second = createSkillInvocationMessage(
      { ...COMMAND, name: 'other:skill' } as ChromiumCommandMetadata,
      undefined,
      'b2',
    )
    const transcript: Message[] = [
      {
        type: 'assistant',
        uuid: 'a-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'Skill', args: {} },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'Skill', args: {} },
          ],
        },
      },
      { ...first, sourceToolAssistantUUID: 'a-1' },
      { ...second, sourceToolAssistantUUID: 'a-1' },
    ] as unknown as Message[]
    const refs = collectSkillBodyRefs(transcript, collectToolCalls(transcript))
    expect(refs.byToolCallId.get('c1')?.name).toBe(COMMAND.name)
    expect(refs.byToolCallId.get('c2')?.name).toBe('other:skill')
  })
})
