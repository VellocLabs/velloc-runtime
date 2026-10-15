import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import { createEmptyAppState } from '../runtime/testing/noopAdapters'
import {
  attachInProcessHook,
  attachTransientHook,
  dropTransientHooks,
  inProcessHooksFor,
  transientHooksFor,
  detachInProcessHook,
  detachTransientHook,
} from '../lifecycleHooks/sessionScopedHooks'
import {
  LIFECYCLE_EVENT_NAMES,
  isLifecycleEventName,
  parseHookCommand,
  parseHookMatcher,
  parseHooksSettings,
  type ShellHookSpec,
  type InProcessHookSpec,
  type HttpHook,
} from '../lifecycleHooks/hookTypes'

describe('LIFECYCLE_EVENT_NAMES', () => {
  it('lists exactly the 27 lifecycle events', () => {
    expect(LIFECYCLE_EVENT_NAMES).toHaveLength(27)
    expect(LIFECYCLE_EVENT_NAMES).toContain('PreToolUse')
    expect(LIFECYCLE_EVENT_NAMES).toContain('Stop')
    expect(LIFECYCLE_EVENT_NAMES).toContain('SessionStart')
    expect(LIFECYCLE_EVENT_NAMES).toContain('FileChanged')
  })

  it('isLifecycleEventName narrows correctly', () => {
    expect(isLifecycleEventName('PreToolUse')).toBe(true)
    expect(isLifecycleEventName('NotAnEvent')).toBe(false)
    expect(isLifecycleEventName(undefined)).toBe(false)
    expect(isLifecycleEventName(42)).toBe(false)
  })
})

describe('parseHookCommand', () => {
  it('parses a minimal command hook', () => {
    const parsed = parseHookCommand({ type: 'command', command: 'ls' })
    expect(parsed).toEqual({ type: 'command', command: 'ls' })
  })

  it('drops invalid timeout, async, and shell values', () => {
    const parsed = parseHookCommand({
      type: 'command',
      command: 'ls',
      timeout: -5,
      async: 'yes' as unknown as boolean,
      shell: 'fish',
    }) as ShellHookSpec | null
    expect(parsed).toEqual({ type: 'command', command: 'ls' })
  })

  it('keeps valid optional fields on command hooks', () => {
    const parsed = parseHookCommand({
      type: 'command',
      command: 'pytest',
      timeout: 30,
      shell: 'bash',
      once: true,
      async: false,
      asyncRewake: true,
      if: 'Bash(pytest *)',
      statusMessage: 'Running tests',
    })
    expect(parsed).toEqual({
      type: 'command',
      command: 'pytest',
      timeout: 30,
      shell: 'bash',
      once: true,
      async: false,
      asyncRewake: true,
      if: 'Bash(pytest *)',
      statusMessage: 'Running tests',
    })
  })

  it('drops an invalid optional field but keeps the hook (non-command types)', () => {
    // Regression for the zod port: a per-field `.catch(undefined)` must drop
    // the bad optional field, NOT reject the whole hook (a naive zod schema
    // would fail the entire parse here).
    const prompt = parseHookCommand({
      type: 'prompt',
      prompt: 'check',
      timeout: 'soon' as unknown as number,
      once: 'sure' as unknown as boolean,
    })
    expect(prompt).toEqual({ type: 'prompt', prompt: 'check' })

    const http = parseHookCommand({
      type: 'http',
      url: 'https://example.com/hook',
      timeout: -1,
    }) as HttpHook | null
    expect(http).toEqual({ type: 'http', url: 'https://example.com/hook' })
  })

  it('strips unknown keys rather than retaining them', () => {
    const parsed = parseHookCommand({
      type: 'command',
      command: 'ls',
      bogus: 'should-not-survive',
    })
    expect(parsed).toEqual({ type: 'command', command: 'ls' })
    expect(parsed && 'bogus' in parsed).toBe(false)
  })

  it('rejects http hooks with malformed urls', () => {
    expect(parseHookCommand({ type: 'http', url: 'not a url' })).toBeNull()
    const ok = parseHookCommand({
      type: 'http',
      url: 'https://example.com/hook',
      headers: { Authorization: 'Bearer x' },
    }) as HttpHook | null
    expect(ok?.url).toBe('https://example.com/hook')
    expect(ok?.headers).toEqual({ Authorization: 'Bearer x' })
  })

  it('rejects unknown command types', () => {
    expect(parseHookCommand({ type: 'spawn', command: 'x' })).toBeNull()
    expect(parseHookCommand(null)).toBeNull()
    expect(parseHookCommand('string')).toBeNull()
  })

  it('returns null when a required field is missing', () => {
    expect(parseHookCommand({ type: 'command' })).toBeNull()
    expect(parseHookCommand({ type: 'prompt' })).toBeNull()
    expect(parseHookCommand({ type: 'http' })).toBeNull()
  })
})

describe('parseHookMatcher / parseHooksSettings', () => {
  it('parses a matcher with multiple hooks and a matcher string', () => {
    const parsed = parseHookMatcher({
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: 'echo pre' },
        { type: 'http', url: 'https://example.com/hook' },
      ],
    })
    expect(parsed?.matcher).toBe('Bash')
    expect(parsed?.hooks).toHaveLength(2)
  })

  it('drops invalid hook entries but keeps valid siblings', () => {
    const parsed = parseHookMatcher({
      hooks: [
        { type: 'command', command: 'echo' },
        { type: 'bogus' },
        { type: 'http', url: 'not a url' },
      ],
    })
    expect(parsed?.hooks).toHaveLength(1)
    expect(parsed?.hooks[0]!.type).toBe('command')
  })

  it('returns null when every hook in the matcher is invalid', () => {
    expect(
      parseHookMatcher({ hooks: [{ type: 'bogus' }] }),
    ).toBeNull()
    expect(parseHookMatcher({ hooks: 'not-an-array' })).toBeNull()
    expect(parseHookMatcher(null)).toBeNull()
  })

  it('parses a HookTableByEvent shape and ignores unknown events', () => {
    const settings = parseHooksSettings({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
      Bogus: [{ hooks: [{ type: 'command', command: 'y' }] }],
      Stop: 'not-an-array',
    })
    expect(settings).not.toBeNull()
    expect(Object.keys(settings!)).toEqual(['PreToolUse'])
  })

  it('returns null when the input is not an object', () => {
    expect(parseHooksSettings(null)).toBeNull()
    expect(parseHooksSettings('hooks')).toBeNull()
    expect(parseHooksSettings([])).toBeNull()
  })
})

describe('session hook registry', () => {
  let appState: WorkingState
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }

  beforeEach(() => {
    appState = createEmptyAppState()
  })

  it('starts with no sessionHooks until something registers', () => {
    expect(appState.sessionHooks).toBeUndefined()
    expect(transientHooksFor(appState, 'sess-1').size).toBe(0)
  })

  it('adds a command hook and reads it back', () => {
    attachTransientHook(setAppState, 'sess-1', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo hi',
    })
    const matchers = transientHooksFor(appState, 'sess-1').get('PreToolUse')
    expect(matchers).toHaveLength(1)
    expect(matchers![0]!.matcher).toBe('Bash')
    expect(matchers![0]!.hooks[0]).toEqual({ type: 'command', command: 'echo hi' })
  })

  it('coalesces multiple hooks under the same (event, matcher, skillRoot) tuple', () => {
    attachTransientHook(setAppState, 'sess-1', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo a',
    })
    attachTransientHook(setAppState, 'sess-1', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo b',
    })
    const matchers = transientHooksFor(appState, 'sess-1').get('PreToolUse')
    expect(matchers).toHaveLength(1)
    expect(matchers![0]!.hooks).toHaveLength(2)
  })

  it('keeps different skillRoots in their own matcher buckets', () => {
    attachTransientHook(
      setAppState,
      'sess-1',
      'PreToolUse',
      'Bash',
      { type: 'command', command: 'echo a' },
      { skillRoot: '/skills/foo' },
    )
    attachTransientHook(
      setAppState,
      'sess-1',
      'PreToolUse',
      'Bash',
      { type: 'command', command: 'echo b' },
      { skillRoot: '/skills/bar' },
    )
    const matchers = transientHooksFor(appState, 'sess-1').get('PreToolUse')
    expect(matchers).toHaveLength(2)
    expect(matchers!.map(m => m.skillRoot)).toEqual([
      '/skills/foo',
      '/skills/bar',
    ])
  })

  it('isolates registrations per sessionId', () => {
    attachTransientHook(setAppState, 'sess-1', 'Stop', '', {
      type: 'command',
      command: 'a',
    })
    attachTransientHook(setAppState, 'sess-2', 'Stop', '', {
      type: 'command',
      command: 'b',
    })
    expect(transientHooksFor(appState, 'sess-1').get('Stop')![0]!.hooks[0])
      .toEqual({ type: 'command', command: 'a' })
    expect(transientHooksFor(appState, 'sess-2').get('Stop')![0]!.hooks[0])
      .toEqual({ type: 'command', command: 'b' })
  })

  it('removes a previously added hook by equality', () => {
    const hook = { type: 'command', command: 'echo hi' } as const
    attachTransientHook(setAppState, 'sess-1', 'PreToolUse', 'Bash', hook)
    detachTransientHook(setAppState, 'sess-1', 'PreToolUse', hook)
    expect(transientHooksFor(appState, 'sess-1').size).toBe(0)
  })

  it('add/remove function hook round-trip works by id', () => {
    let invoked = 0
    const callback = () => {
      invoked++
      return true
    }
    const id = attachInProcessHook(
      setAppState,
      'sess-1',
      'PreToolUse',
      'Bash',
      callback,
      'denied',
    )
    const fnMatchers = inProcessHooksFor(appState, 'sess-1').get(
      'PreToolUse',
    )
    expect(fnMatchers).toHaveLength(1)
    const stored = fnMatchers![0]!.hooks[0] as InProcessHookSpec
    expect(stored.id).toBe(id)
    expect(stored.errorMessage).toBe('denied')
    expect(invoked).toBe(0)

    detachInProcessHook(setAppState, 'sess-1', 'PreToolUse', id)
    expect(inProcessHooksFor(appState, 'sess-1').size).toBe(0)
  })

  it('dropTransientHooks drops every registration for a session', () => {
    attachTransientHook(setAppState, 'sess-1', 'PreToolUse', '', {
      type: 'command',
      command: 'a',
    })
    attachTransientHook(setAppState, 'sess-2', 'PreToolUse', '', {
      type: 'command',
      command: 'b',
    })
    dropTransientHooks(setAppState, 'sess-1')
    expect(transientHooksFor(appState, 'sess-1').size).toBe(0)
    expect(transientHooksFor(appState, 'sess-2').size).toBe(1)
  })

  it('function hooks are not surfaced by transientHooksFor (only by inProcessHooksFor)', () => {
    attachInProcessHook(
      setAppState,
      'sess-1',
      'PreToolUse',
      'Bash',
      () => true,
      'nope',
    )
    expect(transientHooksFor(appState, 'sess-1').size).toBe(0)
    expect(inProcessHooksFor(appState, 'sess-1').size).toBe(1)
  })
})
