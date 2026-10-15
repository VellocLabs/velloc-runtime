import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createForkSendRegistry,
  deliverForkSend,
  resolveForkSendCutUuid,
  resolveForkSendPlan,
} from '../browser/webview/forkSend'
import type { Message } from '../runtime/RuntimeTypes'

/**
 * "Send in a forked session" (Ctrl/⌘+Alt+Enter): the whole conversation is
 * forked (inclusive cut at its last message) and the composer's message is
 * sent into the copy once the manager acks the fork.
 */

describe('resolveForkSendCutUuid', () => {
  it('cuts at the last message of the transcript', () => {
    const messages: Message[] = [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
      { type: 'user', uuid: 'u2' },
      { type: 'assistant', uuid: 'a2' },
    ]
    expect(resolveForkSendCutUuid(messages)).toBe('a2')
  })

  it('skips trailing title / meta records and entries without a uuid', () => {
    const messages: Message[] = [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'a1' },
      { type: 'custom-title', uuid: 't1' },
      { type: 'ai-title', uuid: 't2' },
      { type: '__session_meta', uuid: 'm1' },
      { type: 'assistant' },
    ]
    expect(resolveForkSendCutUuid(messages)).toBe('a1')
  })

  it('is null for an empty session — there is nothing to fork', () => {
    expect(resolveForkSendCutUuid([])).toBeNull()
    expect(resolveForkSendCutUuid([{ type: 'custom-title' }])).toBeNull()
  })
})

describe('createForkSendRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands the payload to the ack and resolves the sender true', async () => {
    const registry = createForkSendRegistry<string>(1_000)
    const sent = registry.register('req-1', 'hello')
    const claimed = registry.take('req-1')
    expect(claimed?.payload).toBe('hello')
    claimed!.settle(true)
    await expect(sent).resolves.toBe(true)
    // Claimed once: a duplicate ack finds nothing.
    expect(registry.take('req-1')).toBeUndefined()
  })

  it('resolves false when no ack arrives, and a late ack finds nothing', async () => {
    const registry = createForkSendRegistry<string>(1_000)
    const sent = registry.register('req-2', 'lost?')
    vi.advanceTimersByTime(1_001)
    await expect(sent).resolves.toBe(false)
    expect(registry.take('req-2')).toBeUndefined()
  })

  it('ignores acks that are not fork-sends', () => {
    const registry = createForkSendRegistry<string>(1_000)
    registry.register('req-3', 'mine')
    expect(registry.take('someone-else')).toBeUndefined()
    expect(registry.take(undefined)).toBeUndefined()
    expect(registry.take('req-3')?.payload).toBe('mine')
  })
})

describe('resolveForkSendPlan', () => {
  it('forks at the cut whenever there is one', () => {
    const messages: Message[] = [{ type: 'user', uuid: 'u1' }]
    expect(resolveForkSendPlan(messages, false)).toEqual({ kind: 'fork', cutUuid: 'u1' })
    expect(resolveForkSendPlan(messages, true)).toEqual({ kind: 'fork', cutUuid: 'u1' })
  })

  it('an idle empty session sends normally', () => {
    expect(resolveForkSendPlan([], false)).toEqual({ kind: 'send' })
  })

  it('refuses while the first turn runs — the send would land in THAT turn', () => {
    // The page's transcript is the one fetched at the last settle: still empty
    // during a session's first turn, although the session is busy.
    expect(resolveForkSendPlan([], true)).toEqual({ kind: 'refuse' })
  })
})

describe('deliverForkSend', () => {
  it('settles true only after the submit went out', async () => {
    const order: string[] = []
    await deliverForkSend(
      { payload: 'msg', settle: ok => order.push(`settle:${ok}`) },
      async payload => {
        order.push(`send:${payload}`)
      },
    )
    expect(order).toEqual(['send:msg', 'settle:true'])
  })

  it('settles false when the submit fails, so the sender restores the text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const settle = vi.fn()
    await deliverForkSend({ payload: 'msg', settle }, async () => {
      throw new Error('upload failed')
    })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(false)
    warn.mockRestore()
  })
})
