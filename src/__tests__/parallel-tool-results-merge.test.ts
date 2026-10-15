/**
 * Parallel tool results: N tool_use blocks answered by N separate user messages are folded (`foldUserTurns`)
 * before `matchCallsToAnswers` in `prepareHistoryForModel`, so every call is matched to its real result.
 */

import { describe, expect, it } from 'vitest'
import { prepareHistoryForModel } from '../messages/prepareModelHistory'
import { __serializeMessagesForBridgeForTest } from '../engine/turn/bridgeSerialization'
import type { Message } from '../runtime/RuntimeTypes'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_USER,
  PART_DOCUMENT,
  PART_IMAGE,
  PART_TEXT,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  ROLE_ASSISTANT,
  ROLE_TOOL,
  ROLE_USER,
} from '../runtime/VercelModelConstants'

function makeAssistantWithToolUses(
  uuid: string,
  toolUses: Array<{ toolCallId: string; toolName: string; args: unknown }>,
): Message {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid,
    message: {
      role: ROLE_ASSISTANT,
      content: toolUses.map(t => ({
        type: PART_TOOL_CALL,
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        args: t.args,
      })),
    },
  } as unknown as Message
}

function makeUserToolResult(
  uuid: string,
  toolCallId: string,
  result: string,
  isError = false,
): Message {
  return {
    type: MSG_TYPE_USER,
    uuid,
    message: {
      role: ROLE_USER,
      content: [
        {
          type: PART_TOOL_RESULT_CANONICAL,
          toolCallId,
          result,
          ...(isError ? { isError: true } : {}),
        },
      ],
    },
  } as unknown as Message
}

function getToolResultBlocks(message: Message): Array<{
  toolCallId?: string
  result?: unknown
  isError?: boolean
}> {
  const content = (message.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (b): b is { type?: unknown } =>
        !!b && typeof b === 'object' && 'type' in (b as object),
    )
    .filter(
      (b): b is {
        type: typeof PART_TOOL_RESULT_CANONICAL
        toolCallId?: string
        result?: unknown
        isError?: boolean
      } => b.type === PART_TOOL_RESULT_CANONICAL,
    )
}

describe('prepareHistoryForModel — parallel tool_result merge', () => {
  it('merges two consecutive user tool_result messages into one (the D3 regression)', () => {
    const assistant = makeAssistantWithToolUses('asst-1', [
      {
        toolCallId: 'toolu_A',
        toolName: 'Write',
        args: { file_path: '/x/user_role.md', content: 'A' },
      },
      {
        toolCallId: 'toolu_B',
        toolName: 'Write',
        args: { file_path: '/x/MEMORY.md', content: 'B' },
      },
    ])
    const resultA = makeUserToolResult(
      'user-A',
      'toolu_A',
      'File created successfully at: /x/user_role.md',
    )
    const resultB = makeUserToolResult(
      'user-B',
      'toolu_B',
      'File created successfully at: /x/MEMORY.md',
    )

    const out = prepareHistoryForModel([assistant, resultA, resultB])

    // 1 assistant + 1 (merged) user message, NOT 1 + 2.
    expect(out).toHaveLength(2)
    expect((out[0] as { type?: string }).type).toBe(MSG_TYPE_ASSISTANT)
    expect((out[1] as { type?: string }).type).toBe(MSG_TYPE_USER)

    // The merged user message carries BOTH real tool_results, in order.
    const blocks = getToolResultBlocks(out[1]!)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.toolCallId).toBe('toolu_A')
    expect(blocks[1]?.toolCallId).toBe('toolu_B')

    // Neither block is a synthetic error — both are the real success
    // strings the C++ side returned.
    expect(blocks[0]?.isError).toBeUndefined()
    expect(blocks[1]?.isError).toBeUndefined()
    expect(blocks[0]?.result).toContain('user_role.md')
    expect(blocks[1]?.result).toContain('MEMORY.md')
  })

  it('splits mixed tool_result + text user content before bridge serialization', () => {
    const mixedUser = {
      type: MSG_TYPE_USER,
      uuid: 'user-mixed',
      message: {
        role: ROLE_USER,
        content: [
          {
            type: PART_TOOL_RESULT_CANONICAL,
            toolCallId: 'call_exit_plan',
            result: 'User has approved your plan.\n\n## Approved Plan:\n# Plan',
          },
          { type: 'text', text: 'Proceed with implementation.' },
        ],
      },
    } as unknown as Message

    const out = __serializeMessagesForBridgeForTest([mixedUser], [])

    expect(out).toHaveLength(2)
    expect(out[0]?.role).toBe(ROLE_TOOL)
    expect(out[1]?.role).toBe(ROLE_USER)
    const toolContent = out[0]?.content
    expect(Array.isArray(toolContent)).toBe(true)
    expect((toolContent as Array<{ type?: string; toolCallId?: string }>)[0]).toMatchObject({
      type: PART_TOOL_RESULT_CANONICAL,
      toolCallId: 'call_exit_plan',
    })
    const userContent = out[1]?.content
    expect(Array.isArray(userContent)).toBe(true)
    expect((userContent as Array<{ type?: string; text?: string }>)[0]).toMatchObject({
      type: 'text',
      text: 'Proceed with implementation.',
    })
  })

  it('dedupes tool_results with the same toolCallId across consecutive user messages', () => {
    const assistant = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'toolu_A', toolName: 'Write', args: {} },
    ])
    const resultA1 = makeUserToolResult('user-A1', 'toolu_A', 'first')
    const resultA2 = makeUserToolResult('user-A2', 'toolu_A', 'duplicate')

    const out = prepareHistoryForModel([assistant, resultA1, resultA2])

    expect(out).toHaveLength(2)
    const blocks = getToolResultBlocks(out[1]!)
    // Only the first id wins; the duplicate is silently dropped.
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.result).toBe('first')
  })

  it('leaves a single user tool_result untouched', () => {
    const assistant = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'toolu_A', toolName: 'Write', args: {} },
    ])
    const resultA = makeUserToolResult('user-A', 'toolu_A', 'ok')

    const out = prepareHistoryForModel([assistant, resultA])
    expect(out).toHaveLength(2)
    const blocks = getToolResultBlocks(out[1]!)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.toolCallId).toBe('toolu_A')
  })

  it('does NOT merge a user tool_result with the next assistant message', () => {
    const asst1 = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'toolu_A', toolName: 'Write', args: {} },
    ])
    const resultA = makeUserToolResult('user-A', 'toolu_A', 'ok')
    const asst2 = makeAssistantWithToolUses('asst-2', [
      { toolCallId: 'toolu_B', toolName: 'Write', args: {} },
    ])
    const resultB = makeUserToolResult('user-B', 'toolu_B', 'ok')

    const out = prepareHistoryForModel([asst1, resultA, asst2, resultB])
    // Two assistant + two user messages — merge only applies to
    // adjacent same-role pairs.
    expect(out).toHaveLength(4)
    expect((out[0] as { type?: string }).type).toBe(MSG_TYPE_ASSISTANT)
    expect((out[1] as { type?: string }).type).toBe(MSG_TYPE_USER)
    expect((out[2] as { type?: string }).type).toBe(MSG_TYPE_ASSISTANT)
    expect((out[3] as { type?: string }).type).toBe(MSG_TYPE_USER)
  })

  it('does not introduce synthetic error placeholders for paired parallel calls', () => {
    // Same shape as the D3 reproduction but asserted negatively: confirm
    // the synthetic string never makes it into the output.
    const assistant = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'toolu_A', toolName: 'Write', args: {} },
      { toolCallId: 'toolu_B', toolName: 'Write', args: {} },
    ])
    const resultA = makeUserToolResult('user-A', 'toolu_A', 'okA')
    const resultB = makeUserToolResult('user-B', 'toolu_B', 'okB')

    const out = prepareHistoryForModel([assistant, resultA, resultB])
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('Tool result missing due to internal error')
    expect(serialized).not.toContain('[Tool result missing')
  })

  it('merges 3+ parallel tool_result messages into one (chaining beyond 2)', () => {
    // The 2-call case is the D3 repro; this guards the N>2 chain (the
    // merge folds each adjacent user message, so 3 collapse to 1).
    const assistant = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'toolu_A', toolName: 'Write', args: { i: 1 } },
      { toolCallId: 'toolu_B', toolName: 'Write', args: { i: 2 } },
      { toolCallId: 'toolu_C', toolName: 'Write', args: { i: 3 } },
    ])
    const rA = makeUserToolResult('user-A', 'toolu_A', 'okA')
    const rB = makeUserToolResult('user-B', 'toolu_B', 'okB')
    const rC = makeUserToolResult('user-C', 'toolu_C', 'okC')

    const out = prepareHistoryForModel([assistant, rA, rB, rC])
    const userMsgs = out.filter(m => m.type === MSG_TYPE_USER)
    expect(userMsgs.length, 'three results must collapse into one user message')
      .toBe(1)
    const ids = getToolResultBlocks(userMsgs[0]!).map(b => b.toolCallId).sort()
    expect(ids).toEqual(['toolu_A', 'toolu_B', 'toolu_C'])
    expect(JSON.stringify(out)).not.toContain('[Tool result missing')
  })

  it('keeps both parallel results when a Skill message sits between them', () => {
    // The live transcript shape: Skill and Grep called in parallel, and the
    // Skill's isMeta instructions (STRING content) persisted between the two
    // results. The merge used to skip string content, so the pairing repair
    // saw only the Skill result, synthesized an error for Grep, and stripped
    // Grep's real result as an orphan — on every request of the session.
    const assistant = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'call_skill', toolName: 'Skill', args: {} },
      { toolCallId: 'call_grep', toolName: 'Grep', args: {} },
    ])
    const skillResult = makeUserToolResult('user-skill', 'call_skill', '')
    const skillBody = {
      type: MSG_TYPE_USER,
      uuid: 'user-skill-body',
      isMeta: true,
      message: { role: ROLE_USER, content: '<command-name>/author</command-name>' },
    } as unknown as Message
    const grepResult = makeUserToolResult('user-grep', 'call_grep', 'a.ts:1: hit')

    const out = prepareHistoryForModel([assistant, skillResult, skillBody, grepResult])

    expect(out).toHaveLength(2)
    const content = (out[1]!.message as { content: Array<{ type: string; text?: string }> }).content
    // Both real results, hoisted ahead of the skill's text.
    expect(content.map(b => b.type)).toEqual([
      PART_TOOL_RESULT_CANONICAL,
      PART_TOOL_RESULT_CANONICAL,
      PART_TEXT,
    ])
    const blocks = getToolResultBlocks(out[1]!)
    expect(blocks.map(b => b.toolCallId)).toEqual(['call_skill', 'call_grep'])
    expect(blocks[1]?.result).toBe('a.ts:1: hit')
    expect(blocks[1]?.isError).toBeUndefined()
    expect(content[2]?.text).toBe('<command-name>/author</command-name>')
    expect(JSON.stringify(out)).not.toContain('[Tool result missing')
  })

  it('hoists tool_results ahead of text when merging array content', () => {
    // A result arriving after a text block still
    // leads the merged message.
    const assistant = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'toolu_A', toolName: 'Write', args: {} },
    ])
    const note = {
      type: MSG_TYPE_USER,
      uuid: 'user-note',
      message: { role: ROLE_USER, content: [{ type: PART_TEXT, text: 'note' }] },
    } as unknown as Message
    const resultA = makeUserToolResult('user-A', 'toolu_A', 'okA')

    const out = prepareHistoryForModel([assistant, note, resultA])
    const content = (out[1]!.message as { content: Array<{ type: string }> }).content
    expect(content.map(b => b.type)).toEqual([PART_TOOL_RESULT_CANONICAL, PART_TEXT])
  })

  it('merges a string-content user message as a text block (no throw)', () => {
    // String content joins the merge as one
    // text block rather than standing apart.
    const assistant = makeAssistantWithToolUses('asst-1', [
      { toolCallId: 'toolu_A', toolName: 'Write', args: {} },
    ])
    const resultA = makeUserToolResult('user-A', 'toolu_A', 'okA')
    const plainUser = {
      type: MSG_TYPE_USER,
      uuid: 'user-plain',
      message: { role: ROLE_USER, content: 'just a string' },
    } as unknown as Message

    const out = prepareHistoryForModel([assistant, resultA, plainUser])
    // Must not throw; the string survives as a text block after the result.
    expect(out).toHaveLength(2)
    const content = (out[1]!.message as { content: Array<{ type: string; text?: string }> }).content
    expect(content.map(b => b.type)).toEqual([PART_TOOL_RESULT_CANONICAL, PART_TEXT])
    expect(content[1]?.text).toBe('just a string')
  })
})

describe('serializeMessagesForBridge — image/document capability downgrade', () => {
  const imageUser = {
    type: MSG_TYPE_USER,
    uuid: 'user-img',
    message: {
      role: ROLE_USER,
      content: [
        { type: PART_TEXT, text: 'what is in this picture?' },
        { type: PART_IMAGE, image: 'aGk=', mimeType: 'image/png' },
        { type: PART_DOCUMENT, data: 'aGk=', mimeType: 'application/pdf' },
      ],
    },
  } as unknown as Message

  it('downgrades image + document parts to text placeholders when the model is text-only', () => {
    const out = __serializeMessagesForBridgeForTest([imageUser], [], {
      allowImageParts: false,
    })
    const content = (out[0] as { content?: unknown }).content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as Array<{ type?: string; text?: string }>
    expect(parts.map(p => p.type)).toEqual([PART_TEXT, PART_TEXT, PART_TEXT])
    expect(parts[1]?.text).toMatch(/image omitted/)
    expect(parts[2]?.text).toMatch(/document omitted/)
  })

  it('passes image + document parts through untouched for capable models (default)', () => {
    for (const options of [undefined, { allowImageParts: true }]) {
      const out = __serializeMessagesForBridgeForTest([imageUser], [], options)
      const parts = (out[0] as { content?: unknown }).content as Array<{
        type?: string
        image?: string
      }>
      expect(parts.map(p => p.type)).toEqual([
        PART_TEXT,
        PART_IMAGE,
        PART_DOCUMENT,
      ])
      expect(parts[1]?.image).toBe('aGk=')
    }
  })
})

// ===========================================================================
// Tool-result media stays inside the tool result: the serializer hands the bridge an image part in the tool
// result's `result` array and mints nothing extra; the C++ provider translators lift it where a wire needs that.
// ===========================================================================

describe('serializeMessagesForBridge — tool-result media placement', () => {
  it('keeps an image part inside the tool result and mints no extra message', () => {
    const messages = [
      makeAssistantWithToolUses('a1', [
        { toolCallId: 't1', toolName: 'Read', args: {} },
      ]),
      {
        type: MSG_TYPE_USER,
        uuid: 'u1',
        message: {
          role: ROLE_USER,
          content: [
            {
              type: PART_TOOL_RESULT_CANONICAL,
              toolCallId: 't1',
              result: [
                { type: PART_TEXT, text: 'Image file read: /tmp/shot.png' },
                { type: PART_IMAGE, image: 'BASE64IMAGEDATA', mimeType: 'image/jpeg' },
              ],
            },
          ],
        },
      } as unknown as Message,
    ]
    const out = __serializeMessagesForBridgeForTest(
      prepareHistoryForModel(messages) as never,
      [] as never,
    )
    const toolMsg = out.find(m => m.role === ROLE_TOOL)
    expect(toolMsg, 'tool message present').toBeTruthy()
    const block = (toolMsg!.content as Array<Record<string, unknown>>)[0]
    const result = block!.result as Array<Record<string, unknown>>
    const image = result.find(p => p.type === PART_IMAGE)
    expect(image, 'image kept in place').toBeTruthy()
    expect(image!.image).toBe('BASE64IMAGEDATA')
    expect(
      out.some(m => m.role === ROLE_USER),
      'no extra user message minted',
    ).toBe(false)
  })
  it('downgrades media inside a tool result for a text-only model, in place', () => {
    // A paged PDF Read or an image Read returns JPEGs; a text-only model
    // cannot take them there either, and the OpenAI translators would lift
    // them onto a user message the provider rejects.
    const messages = [
      makeAssistantWithToolUses('a1', [
        { toolCallId: 't1', toolName: 'Read', args: {} },
      ]),
      {
        type: MSG_TYPE_USER,
        uuid: 'u1',
        message: {
          role: ROLE_USER,
          content: [
            {
              type: PART_TOOL_RESULT_CANONICAL,
              toolCallId: 't1',
              result: [
                { type: PART_TEXT, text: 'PDF file read: /tmp/a.pdf (pages 1-2 of 2)' },
                { type: PART_IMAGE, image: 'PAGE1', mimeType: 'image/jpeg' },
                { type: PART_DOCUMENT, data: 'JVBERi0=', mimeType: 'application/pdf' },
              ],
            },
          ],
        },
      } as unknown as Message,
    ]
    const normalized = prepareHistoryForModel(messages) as never
    const out = __serializeMessagesForBridgeForTest(normalized, [] as never, {
      allowImageParts: false,
    })
    const toolMsg = out.find(m => m.role === ROLE_TOOL)
    const block = (toolMsg!.content as Array<Record<string, unknown>>)[0]
    const result = block!.result as Array<{ type?: string; text?: string }>
    expect(result.map(p => p.type)).toEqual([PART_TEXT, PART_TEXT, PART_TEXT])
    expect(result[0]!.text).toBe('PDF file read: /tmp/a.pdf (pages 1-2 of 2)')
    expect(result[1]!.text).toMatch(/image omitted/)
    expect(result[2]!.text).toMatch(/document omitted/)
    expect(JSON.stringify(out)).not.toContain('PAGE1')

    // Capable model: untouched.
    const kept = __serializeMessagesForBridgeForTest(normalized, [] as never, {
      allowImageParts: true,
    })
    expect(JSON.stringify(kept)).toContain('PAGE1')
  })
})

describe('serializeMessagesForBridge — transcript-only user fields', () => {
  it('sends a mailbox-marked user turn exactly like an unmarked one', () => {
    // `origin` tells the transcript view a turn came from the team mailbox;
    // the model must see the same request either way.
    const user = (extra: Record<string, unknown>) =>
      ({
        type: MSG_TYPE_USER,
        uuid: 'u-mail',
        message: { role: ROLE_USER, content: '[message from a]: hi' },
        ...extra,
      }) as unknown as Message
    const serialize = (message: Message) =>
      __serializeMessagesForBridgeForTest(
        prepareHistoryForModel([message]) as never,
        [] as never,
      )
    const marked = serialize(user({ origin: 'mailbox' }))
    expect(marked).toEqual(serialize(user({})))
    expect(JSON.stringify(marked)).not.toContain('origin')
  })
})
