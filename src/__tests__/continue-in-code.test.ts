/**
 * "Continue in Code": the chat-only offer tool, the cut that re-opens the
 * prompt behind an offer, the fork retarget shape, and the per-session
 * callback binding the shell hands each thread.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolvePromptCutForToolCall } from '../sessions/sessionStore'
import { isForkRetarget } from '../browser/worker/sharedWorkerProtocol'
import { ContinueInCodeTool } from '../toolkit/builtin/continueInCode'
import { createSessionMessageCallbackFactory } from '../browser/webview/sessionMessageCallbacks'
import { expandGroups } from '../toolkit/builtin/toolGroups'
import { getTemplate } from '../prompting/templateRegistry'

const prompt = (uuid: string, text: string) => ({
  type: 'user',
  uuid,
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const toolCall = (uuid: string, toolCallId: string, toolName: string) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, args: {} }] },
})
const toolResult = (uuid: string, toolCallId: string) => ({
  type: 'user',
  uuid,
  toolUseResult: 'ok',
  message: { role: 'user', content: [{ type: 'tool-result', toolCallId, output: 'ok' }] },
})

describe('resolvePromptCutForToolCall', () => {
  const entries = [
    prompt('p0', 'what is a monad?'),
    { type: 'assistant', uuid: 'a0', message: { role: 'assistant', content: [{ type: 'text', text: 'A monad is...' }] } },
    prompt('p1', 'now fix the failing test in my repo'),
    toolCall('a1', 'tc-skill', 'Skill'),
    toolResult('r1', 'tc-skill'),
    toolCall('a2', 'tc-offer', 'ContinueInCode'),
    toolResult('r2', 'tc-offer'),
    { type: 'custom-title', customTitle: 'Monads' },
  ]

  it('names the prompt that started the offer turn, skipping tool results in between', () => {
    expect(resolvePromptCutForToolCall(entries, 'tc-offer')).toBe('p1')
  })

  it('is null for a call the transcript does not hold', () => {
    expect(resolvePromptCutForToolCall(entries, 'tc-missing')).toBeNull()
  })

  it('is null when no prompt precedes the call', () => {
    expect(resolvePromptCutForToolCall([toolCall('a1', 'tc', 'ContinueInCode')], 'tc')).toBeNull()
  })
})

describe('isForkRetarget', () => {
  it('needs both a type and a non-blank folder', () => {
    expect(isForkRetarget({ templateType: 'code', projectRoot: '/work/app' })).toBe(true)
    expect(isForkRetarget({ templateType: 'code' })).toBe(false)
    expect(isForkRetarget({ templateType: '', projectRoot: '/work/app' })).toBe(false)
    expect(isForkRetarget({ templateType: 'code', projectRoot: '   ' })).toBe(false)
    expect(isForkRetarget('code')).toBe(false)
    expect(isForkRetarget(null)).toBe(false)
  })
})

describe('ContinueInCode tool', () => {
  it('requires a reason and changes nothing when called', async () => {
    expect((await ContinueInCodeTool.checkInput!({ reason: '' }, {} as never)).result).toBe(false)
    expect((await ContinueInCodeTool.checkInput!({ reason: 'edit files in your project' }, {} as never)).result).toBe(true)
    expect(ContinueInCodeTool.readsOnly({ reason: 'x' })).toBe(true)
    const out = await ContinueInCodeTool.call({ reason: 'x' }, {} as never, (() => {}) as never, {} as never)
    expect(String(out.data)).toContain('Code session')
  })

  it('belongs to the chat template only', () => {
    for (const type of ['chat', 'code', 'agent']) {
      const eager = expandGroups(getTemplate(type)!.config.tools ?? [])
      expect(eager.has('ContinueInCode'), type).toBe(type === 'chat')
    }
  })
})

describe('session message callbacks: onContinueInCode', () => {
  it('binds the session and forwards the cut and the folder', async () => {
    const continueInCode = vi.fn(async () => true)
    const get = createSessionMessageCallbackFactory(() => {}, () => {}, undefined, continueInCode)
    expect(await get('chat-1').onContinueInCode!('p1', { path: '/work/app' })).toBe(true)
    expect(continueInCode).toHaveBeenCalledWith('chat-1', 'p1', { path: '/work/app' })
    expect(get('chat-1').onContinueInCode).toBe(get('chat-1').onContinueInCode)
  })

  it('is absent when the shell offers no handler', () => {
    expect(createSessionMessageCallbackFactory(() => {}, () => {})('chat-1').onContinueInCode).toBeUndefined()
  })
})
