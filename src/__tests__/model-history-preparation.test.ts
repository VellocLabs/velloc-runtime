/**
 * Behaviour pins for the history the model receives: reasoning, error-card,
 * blank-turn filtering, user-message merging and tool call / result pairing.
 */

import { describe, expect, it, vi } from 'vitest'
import { prepareHistoryForModel as prepare } from '../messages/prepareModelHistory'
import type { Message } from '../runtime/RuntimeTypes'

const SYN_TEXT = '[Tool result missing due to internal error]'

let n = 0
function user(content: unknown, extra: Record<string, unknown> = {}): Message {
  return { type: 'user', uuid: `u${n++}`, message: { role: 'user', content }, ...extra } as unknown as Message
}
function asst(content: unknown, extra: Record<string, unknown> = {}): Message {
  return { type: 'assistant', uuid: `a${n++}`, message: { role: 'assistant', content }, ...extra } as unknown as Message
}
const TU = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'x' })
const TR = (id: string) => ({ type: 'tool-result', toolCallId: id, result: 'ok' })
const SYN = (id: string) => ({ type: 'tool-result', toolCallId: id, result: SYN_TEXT, isError: true })
const T = (text: string) => ({ type: 'text', text })

function contentOf(m: Message): unknown {
  return (m as unknown as { message: { content: unknown } }).message.content
}
function quiet<R>(fn: () => R): R {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try { return fn() } finally { spy.mockRestore() }
}

describe('model history preparation', () => {
  it('adds a synthetic result for a trailing unanswered tool call', () => {
    const out = quiet(() => prepare([user('hi'), asst([TU('a')])]))
    expect(out).toHaveLength(3)
    expect(contentOf(out[2])).toEqual([SYN('a')])
    expect((out[2] as { isMeta?: boolean }).isMeta).toBe(true)
  })

  it('merges results split across user messages', () => {
    const out = prepare([asst([TU('a'), TU('b')]), user([TR('a')]), user([TR('b')])])
    expect(out).toHaveLength(2)
    expect(contentOf(out[1])).toEqual([TR('a'), TR('b')])
  })

  it('hoists results ahead of interleaved text', () => {
    const out = prepare([asst([TU('a'), TU('b')]), user([TR('a')]), user('skill text'), user([TR('b')])])
    expect(out).toHaveLength(2)
    expect(contentOf(out[1])).toEqual([TR('a'), TR('b'), T('skill text')])
  })

  it('joins adjacent text with a newline seam', () => {
    const out = prepare([user('2 + 2'), user('3 + 3')])
    expect(out).toHaveLength(1)
    expect(contentOf(out[0])).toEqual([T('2 + 2\n'), T('3 + 3')])
  })

  it('keeps a lone string user untouched', () => {
    const u = user('solo')
    const out = prepare([u])
    expect(out[0]).toBe(u)
  })

  it('replaces a leading orphan result with a marker', () => {
    const out = quiet(() => prepare([user([TR('z')])]))
    expect(contentOf(out[0])).toEqual([T('[Orphaned tool result removed due to conversation resume]')])
    const out2 = quiet(() => prepare([user('a'), user([TR('z')])]))
    expect(out2).toHaveLength(1)
    expect(contentOf(out2[0])).toEqual([T('a')])
  })

  it('swaps an orphan result for the missing one', () => {
    const out = quiet(() => prepare([asst([TU('a')]), user([TR('z'), T('x')])]))
    expect(contentOf(out[1])).toEqual([SYN('a'), T('x')])
  })

  it('dedupes results within one message', () => {
    const out = quiet(() => prepare([asst([TU('a')]), user([TR('a'), TR('a')])]))
    expect(contentOf(out[1])).toEqual([TR('a')])
  })

  it('replaces an all-orphan user with a meta placeholder', () => {
    const out = quiet(() => prepare([asst([T('hi')]), user([TR('z')])]))
    expect(out).toHaveLength(2)
    expect(contentOf(out[1])).toBe('(no content)')
    expect((out[1] as { isMeta?: boolean }).isMeta).toBe(true)
  })

  it('interrupts a repeated tool call id', () => {
    const out = quiet(() => prepare([asst([TU('a')]), user([TR('a')]), asst([TU('a')]), user([TR('a')])]))
    expect(out).toHaveLength(4)
    expect(contentOf(out[2])).toEqual([T('[Tool use interrupted]')])
    expect(contentOf(out[3])).toBe('(no content)')
  })

  it('drops reasoning blocks but keeps replay ones beside text', () => {
    expect(contentOf(prepare([asst([{ type: 'thinking', thinking: '' }, T('x')])])[0])).toEqual([T('x')])
    const replay = { type: 'thinking', thinking: 'r', signature: 'velloc-replay-v1:{}' }
    expect(prepare([asst([replay])])).toHaveLength(0)
    expect(contentOf(prepare([asst([replay, T('y')])])[0])).toEqual([replay, T('y')])
    expect(contentOf(prepare([asst([{ type: 'redacted_thinking', data: 'q' }, T('z')])])[0])).toEqual([T('z')])
  })

  it('strips media before a media error and drops the card', () => {
    const out = prepare([user([T('see'), { type: 'image' }]), asst([T('Image too large')], { isApiErrorMessage: true })])
    expect(out).toHaveLength(1)
    expect(contentOf(out[0])).toEqual([T('see')])
    const img = { type: 'image' }
    const out2 = prepare([user([T('see'), img]), asst([T('rate limited')], { isApiErrorMessage: true })])
    expect(out2).toHaveLength(1)
    expect(contentOf(out2[0])).toEqual([T('see'), img])
  })

  it('drops blank assistant turns but keeps ones with tool calls', () => {
    expect(prepare([asst([T('\n\n')])])).toHaveLength(0)
    expect(prepare([asst([])])).toHaveLength(0)
    const out = quiet(() => prepare([asst([T(' '), TU('a')]), user([TR('a')])]))
    expect(out).toHaveLength(2)
  })

  it('a system message between call and result orphans the result', () => {
    const sys = { type: 'system', uuid: 's', content: 'note' } as unknown as Message
    const out = quiet(() => prepare([asst([TU('a')]), sys, user([TR('a')])]))
    expect(out).toHaveLength(3)
    expect(contentOf(out[1])).toEqual([SYN('a')])
    expect(out[2]).toBe(sys)
  })

  it('does not mutate inputs and preserves metadata on merge', () => {
    const first = user([T('one')], { isMeta: false, extraField: 7 })
    const second = user([T('two')])
    const snapshot = JSON.stringify([first, second])
    const out = prepare([first, second])
    expect(JSON.stringify([first, second])).toBe(snapshot)
    expect(out[0].uuid).toBe(first.uuid)
    expect((out[0] as unknown as { extraField: number }).extraField).toBe(7)
  })

  it('does not merge users across a non-user', () => {
    const sys = { type: 'system', uuid: 's2', content: 'n' } as unknown as Message
    expect(prepare([user('a'), sys, user('b')])).toHaveLength(3)
  })
})
