import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import { createEmptyAppState } from '../runtime/testing/noopAdapters'
import {
  fireLifecycleEvent,
  fireAlertRaised,
  fireAfterFold,
  executePostToolFailureHooks,
  fireAfterToolCall,
  fireBeforeFold,
  fireBeforeToolCall,
  fireSessionClosed,
  fireSessionOpened,
  fireTurnEnd,
  fireChildAgentStarted,
  executeSubagentStopHooks,
  firePromptSubmitted,
  matchesMatcher,
} from '../lifecycleHooks/runHooks'
import {
  attachInProcessHook,
  attachTransientHook,
} from '../lifecycleHooks/sessionScopedHooks'

describe('matchesMatcher', () => {
  it('treats undefined and empty as match-all', () => {
    expect(matchesMatcher(undefined, 'Bash')).toBe(true)
    expect(matchesMatcher('', 'Bash')).toBe(true)
  })

  it('matches exact tool names', () => {
    expect(matchesMatcher('Bash', 'Bash')).toBe(true)
    expect(matchesMatcher('Bash', 'Read')).toBe(false)
  })

  it('supports trailing-* glob prefixes', () => {
    expect(matchesMatcher('Browser*', 'BrowserClick')).toBe(true)
    expect(matchesMatcher('Browser*', 'BashRun')).toBe(false)
    expect(matchesMatcher('*', 'Anything')).toBe(true)
  })
})

describe('fireLifecycleEvent — function hook execution', () => {
  let appState: WorkingState
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }

  beforeEach(() => {
    appState = createEmptyAppState()
  })

  it('returns blocked: false when no hooks are registered', async () => {
    const result = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(false)
    expect(result.results).toEqual([])
  })

  it('runs a passing function hook without blocking', async () => {
    attachInProcessHook(setAppState, 's1', 'PreToolUse', 'Bash', () => true, 'denied')
    const result = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.outcome.status).toBe('pass')
  })

  it('blocks when a function hook returns false', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Bash',
      () => false,
      'No Bash allowed',
    )
    const result = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(true)
    expect(result.errors).toEqual(['No Bash allowed'])
  })

  it('blocks when a function hook throws', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Bash',
      () => {
        throw new Error('boom')
      },
      'fallback',
    )
    const result = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(true)
    expect(result.results[0]!.outcome.status).toBe('error')
    expect(result.errors[0]).toContain('boom')
  })

  it('aggregates pass + block hooks in parallel', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Bash',
      async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return true
      },
      'A',
    )
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Bash',
      () => false,
      'B blocked',
    )
    const result = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.errors).toContain('B blocked')
  })

  it('skips hooks whose matcher does not apply', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Bash',
      () => false,
      'no Bash',
    )
    const result = await fireBeforeToolCall({
      toolName: 'Read',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(false)
    expect(result.results).toEqual([])
  })

  it('honors trailing-* matcher glob', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Browser*',
      () => false,
      'blocked',
    )
    const browserResult = await fireBeforeToolCall({
      toolName: 'BrowserClick',
      sessionId: 's1',
      appState,
    })
    expect(browserResult.blocked).toBe(true)

    const otherResult = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(otherResult.blocked).toBe(false)
  })

  it('times out a slow function hook', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Bash',
      async signal =>
        new Promise<boolean>(resolve => {
          // Resolve true after a long delay — but the executor's timeout
          // should fire first.
          const timer = setTimeout(() => resolve(true), 1000)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve(true)
          })
        }),
      'hook took too long',
      { timeout: 25 },
    )
    const result = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(true)
    expect(result.results[0]!.outcome.status).toBe('timeout')
    expect(result.errors[0]).toContain('timed out')
  })

  it('reports `not_implemented` for command/prompt/http/agent hooks without blocking', async () => {
    attachTransientHook(setAppState, 's1', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo hi',
    })
    attachTransientHook(setAppState, 's1', 'PreToolUse', 'Bash', {
      type: 'http',
      url: 'https://example.com',
    })
    const result = await fireLifecycleEvent({
      event: 'PreToolUse',
      subject: 'Bash',
      sessionId: 's1',
      appState,
    })
    // Not-implemented outcomes are not blocking — they're informational so a
    // caller registering a not-yet-implemented hook command doesn't accidentally
    // brick its own tool calls before the executor ships.
    expect(result.blocked).toBe(false)
    expect(result.results).toHaveLength(2)
    expect(result.results.every(r => r.outcome.status === 'not_implemented'))
      .toBe(true)
  })

  it('agent hook blocks when the verifier returns ok:false', async () => {
    attachTransientHook(setAppState, 's1', 'PreToolUse', 'Bash', {
      type: 'agent',
      prompt: 'Verify the change is safe',
    })
    const result = await fireLifecycleEvent({
      event: 'PreToolUse',
      subject: 'Bash',
      sessionId: 's1',
      appState,
      agentRunner: async () =>
        JSON.stringify({ ok: false, reason: 'unsafe edit' }),
    })
    expect(result.blocked).toBe(true)
    expect(result.results[0]!.outcome.status).toBe('block')
    expect(result.errors[0]).toContain('unsafe edit')
  })

  it('agent hook passes when the verifier returns ok:true', async () => {
    attachTransientHook(setAppState, 's1', 'PreToolUse', 'Bash', {
      type: 'agent',
      prompt: 'Verify the change is safe',
    })
    const result = await fireLifecycleEvent({
      event: 'PreToolUse',
      subject: 'Bash',
      sessionId: 's1',
      appState,
      agentRunner: async () => 'Looks good.\n{"ok": true}',
    })
    expect(result.blocked).toBe(false)
    expect(result.results[0]!.outcome.status).toBe('pass')
  })

  it('agent hook without a runner is not_implemented (non-blocking)', async () => {
    attachTransientHook(setAppState, 's1', 'PreToolUse', 'Bash', {
      type: 'agent',
      prompt: 'Verify the change is safe',
    })
    const result = await fireLifecycleEvent({
      event: 'PreToolUse',
      subject: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(false)
    expect(result.results[0]!.outcome.status).toBe('not_implemented')
  })

  it('removes once-true persistable hooks after they fire', async () => {
    attachTransientHook(setAppState, 's1', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo hi',
      once: true,
    })
    await fireLifecycleEvent({
      event: 'PreToolUse',
      subject: 'Bash',
      sessionId: 's1',
      appState,
      setAppState,
    })
    // Hook executor doesn't yet *run* command hooks but `once` removal
    // is shared with the registry-mutation path and must apply
    // regardless of execution status, so the second pass should find
    // nothing matching.
    const second = await fireLifecycleEvent({
      event: 'PreToolUse',
      subject: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(second.results).toEqual([])
  })

  it('fireAfterToolCall routes to PostToolUse with tool name subject', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PostToolUse',
      'EchoTool',
      () => false,
      'post failed',
    )
    const result = await fireAfterToolCall({
      toolName: 'EchoTool',
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(true)
    expect(result.errors).toEqual(['post failed'])

    // Different tool name → no match
    const other = await fireAfterToolCall({
      toolName: 'OtherTool',
      sessionId: 's1',
      appState,
    })
    expect(other.blocked).toBe(false)
  })

  it('executePostToolFailureHooks routes to PostToolUseFailure event', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PostToolUseFailure',
      'Bash',
      () => false,
      'failure blocked',
    )
    // PostToolUse hooks do NOT match a PostToolUseFailure event.
    attachInProcessHook(
      setAppState,
      's1',
      'PostToolUse',
      'Bash',
      () => false,
      'should not fire',
    )
    const result = await executePostToolFailureHooks({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
    })
    expect(result.results).toHaveLength(1)
    expect(result.errors).toEqual(['failure blocked'])
  })

  it('fireTurnEnd fires on empty subject (match-all matcher)', async () => {
    attachInProcessHook(setAppState, 's1', 'Stop', '', () => false, 'stop blocked')
    const result = await fireTurnEnd({
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(true)
    expect(result.errors).toEqual(['stop blocked'])
  })

  it('fireBeforeFold uses the reason as subject', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PreCompact',
      'autocompact',
      () => false,
      'no compact',
    )
    const matching = await fireBeforeFold({
      reason: 'autocompact',
      sessionId: 's1',
      appState,
    })
    expect(matching.blocked).toBe(true)
    // Different reason → no match
    const other = await fireBeforeFold({
      reason: 'microcompact',
      sessionId: 's1',
      appState,
    })
    expect(other.blocked).toBe(false)
  })

  it('fireAfterFold fires on the post-compact event', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'PostCompact',
      'autocompact',
      () => false,
      'compact summary needs review',
    )
    const result = await fireAfterFold({
      reason: 'autocompact',
      sessionId: 's1',
      appState,
    })
    expect(result.errors).toEqual(['compact summary needs review'])
  })

  it('firePromptSubmitted fires once with empty subject', async () => {
    attachInProcessHook(
      setAppState,
      's1',
      'UserPromptSubmit',
      '',
      () => false,
      'prompt denied',
    )
    const result = await firePromptSubmitted({
      sessionId: 's1',
      appState,
    })
    expect(result.blocked).toBe(true)
    expect(result.errors).toEqual(['prompt denied'])

    // Tool-name matchers do NOT match the empty subject.
    attachInProcessHook(
      setAppState,
      's2',
      'UserPromptSubmit',
      'Bash',
      () => false,
      'never',
    )
    const skipped = await firePromptSubmitted({
      sessionId: 's2',
      appState,
    })
    expect(skipped.results).toHaveLength(0)
  })

  it('fireSessionOpened fires on empty subject (match-all)', async () => {
    attachInProcessHook(setAppState, 's1', 'SessionStart', '', () => false, 'start blocked')
    const result = await fireSessionOpened({ source: 'startup', sessionId: 's1', appState })
    expect(result.blocked).toBe(true)
    expect(result.errors).toEqual(['start blocked'])
  })

  it('fireSessionOpened uses the source as the matcher subject', async () => {
    attachInProcessHook(setAppState, 's1', 'SessionStart', 'clear|compact', () => false, 'after clear')
    const matching = await fireSessionOpened({ source: 'clear', sessionId: 's1', appState })
    expect(matching.errors).toEqual(['after clear'])
    const other = await fireSessionOpened({ source: 'startup', sessionId: 's1', appState })
    expect(other.results).toHaveLength(0)
  })

  it('fireSessionClosed uses the reason as subject', async () => {
    attachInProcessHook(setAppState, 's1', 'SessionEnd', 'manual', () => false, 'ended')
    const matching = await fireSessionClosed({ reason: 'manual', sessionId: 's1', appState })
    expect(matching.errors).toEqual(['ended'])
    const other = await fireSessionClosed({ reason: 'timeout', sessionId: 's1', appState })
    expect(other.results).toHaveLength(0)
  })

  it('fireAlertRaised uses the notification type as subject', async () => {
    attachInProcessHook(setAppState, 's1', 'Notification', 'turn_complete', () => false, 'notified')
    const matching = await fireAlertRaised({
      notificationType: 'turn_complete',
      sessionId: 's1',
      appState,
    })
    expect(matching.errors).toEqual(['notified'])
    const other = await fireAlertRaised({
      notificationType: 'idle',
      sessionId: 's1',
      appState,
    })
    expect(other.results).toHaveLength(0)
  })

  it('executeSubagentStart/StopHooks use the agent id as subject', async () => {
    attachInProcessHook(setAppState, 's1', 'SubagentStart', 'agent-7', () => false, 'sub start')
    attachInProcessHook(setAppState, 's1', 'SubagentStop', 'agent-7', () => false, 'sub stop')
    const start = await fireChildAgentStarted({ agentId: 'agent-7', sessionId: 's1', appState })
    expect(start.errors).toEqual(['sub start'])
    const stop = await executeSubagentStopHooks({ agentId: 'agent-7', sessionId: 's1', appState })
    expect(stop.errors).toEqual(['sub stop'])
    // A different agent id does not match.
    const otherAgent = await executeSubagentStopHooks({ agentId: 'agent-9', sessionId: 's1', appState })
    expect(otherAgent.results).toHaveLength(0)
  })

  it('propagates the parent abort signal into the hook callback', async () => {
    const controller = new AbortController()
    let observedAborted = false
    attachInProcessHook(
      setAppState,
      's1',
      'PreToolUse',
      'Bash',
      async signal =>
        new Promise<boolean>(resolve => {
          signal?.addEventListener('abort', () => {
            observedAborted = true
            resolve(true)
          })
          // Otherwise wait — the test aborts before resolution.
          setTimeout(() => resolve(true), 1000)
        }),
      'abort',
      { timeout: 1000 },
    )
    const promise = fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
      signal: controller.signal,
    })
    controller.abort(new Error('parent cancelled'))
    const result = await promise
    expect(observedAborted).toBe(true)
    // Status should be 'aborted' (not timeout, not block) — the parent
    // signal fired before the timeout.
    expect(['aborted', 'pass']).toContain(result.results[0]!.outcome.status)
  })
})
