import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetBashCwdInterceptorForTests,
  interceptBashCd,
  parseBashCdCommand,
  resolveCdTarget,
} from '../toolkit/builtin/glic/bashCwdInterceptor'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ToolCallContext } from '../toolkit/toolCallContext'

type SetAgentLoopSettingsFn = (params: {
  cwd?: string
  actionTimeoutMs?: number
  stepTimeoutMs?: number
  executionContext?: { sessionId?: string }
}) => Promise<{
  ok: true
  appliedActionTimeoutMs?: number
  appliedStepTimeoutMs?: number
  appliedCwd?: string
}>

afterEach(() => {
  _resetBashCwdInterceptorForTests()
})

// ============================================================================
// parseBashCdCommand
// ============================================================================

describe('parseBashCdCommand', () => {
  it('extracts the target from a plain `cd <path>`', () => {
    expect(parseBashCdCommand('cd /foo/bar')).toBe('/foo/bar')
    expect(parseBashCdCommand('  cd   /foo/bar  ')).toBe('/foo/bar')
  })

  it('handles `cd` with quoted argument', () => {
    expect(parseBashCdCommand('cd "/foo with spaces"')).toBe('/foo with spaces')
    expect(parseBashCdCommand("cd '/foo with spaces'")).toBe('/foo with spaces')
  })

  it('strips a trailing semicolon', () => {
    expect(parseBashCdCommand('cd /foo;')).toBe('/foo')
    expect(parseBashCdCommand('cd /foo ;')).toBe('/foo')
  })

  it('handles `builtin cd` prefix', () => {
    expect(parseBashCdCommand('builtin cd /foo')).toBe('/foo')
  })

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['cd alone with no arg', 'cd'],
    ['cd with trailing space only', 'cd  '],
    ['something else', 'ls /foo'],
    ['compound &&', 'cd /foo && ls'],
    ['compound ||', 'cd /foo || ls'],
    ['compound ;', 'cd /foo ; ls'],
    ['piped', 'cd /foo | ls'],
    ['backgrounded', 'cd /foo &'],
    ['echo with embedded cd', 'echo "cd /foo"'],
  ])('returns null for %s', (_label, input) => {
    expect(parseBashCdCommand(input)).toBeNull()
  })
})

// ============================================================================
// resolveCdTarget
// ============================================================================

describe('resolveCdTarget', () => {
  it('returns absolute targets verbatim (after normalisation)', () => {
    expect(resolveCdTarget('/foo/bar', '/home/me', '/home/me')).toBe('/foo/bar')
  })

  it('joins relative targets onto the current cwd', () => {
    expect(resolveCdTarget('sub', '/home/me/project', '/home/me')).toBe(
      '/home/me/project/sub',
    )
    expect(resolveCdTarget('./sub', '/home/me/project', '/home/me')).toBe(
      '/home/me/project/sub',
    )
  })

  it('resolves `..` segments', () => {
    expect(
      resolveCdTarget('../sibling', '/home/me/project', '/home/me'),
    ).toBe('/home/me/sibling')
    expect(
      resolveCdTarget('../..', '/home/me/project/sub', '/home/me'),
    ).toBe('/home/me')
  })

  it('expands `~` and `~/sub` against homeDir', () => {
    expect(resolveCdTarget('~', '/anywhere', '/home/me')).toBe('/home/me')
    expect(resolveCdTarget('~/docs', '/anywhere', '/home/me')).toBe(
      '/home/me/docs',
    )
  })

  it('rejects `~` when homeDir is undefined', () => {
    expect(resolveCdTarget('~/docs', '/anywhere', undefined)).toBeNull()
  })

  it('rejects roots and near-roots', () => {
    expect(resolveCdTarget('/', '/home/me', '/home/me')).toBeNull()
    expect(resolveCdTarget('../../../..', '/a/b', undefined)).toBeNull()
  })

  it('handles Windows-style cwd and target', () => {
    expect(
      resolveCdTarget('sub', 'C:\\Users\\me\\project', undefined),
    ).toBe('C:\\Users\\me\\project\\sub')
    expect(
      resolveCdTarget('..\\sibling', 'C:\\Users\\me\\project', undefined),
    ).toBe('C:\\Users\\me\\sibling')
  })
})

// ============================================================================
// interceptBashCd — full integration
// ============================================================================

function makeRuntimeConfig(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) =>
      env[name] === '1' || env[name] === 'true' || env[name] === 'yes',
    now: () => 0,
    createUUID: () => 'u',
    createTimestamp: () => 'ts',
    getMaxStructuredOutputRetries: () => 5,
  }
}

function makeContext(args: {
  cwd: string
  sessionId: string
  setAgentLoopSettings?: (params: {
    cwd?: string
    executionContext?: { sessionId?: string }
  }) => Promise<{
    ok: true
    appliedActionTimeoutMs?: number
    appliedStepTimeoutMs?: number
    appliedCwd?: string
  }>
}): ToolCallContext {
  return {
    options: {
      commands: [],
      cwd: args.cwd,
      projectRoot: args.cwd,
      sessionId: args.sessionId,
      debug: false,
      mainLoopModel: 'test',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { enabledAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    platformCapabilities: {
      session: args.setAgentLoopSettings
        ? {
            onStop: async () => ({ ok: true as const, stopped: false }),
            setAgentLoopSettings: args.setAgentLoopSettings,
          }
        : undefined,
    } as ToolCallContext['platformCapabilities'],
    getAppState: () =>
      ({}) as ReturnType<ToolCallContext['readAppState']>,
    setAppState: () => {},
    markCallsInFlight: () => {},
    noteReplyLength: () => {},
    noteFileHistory: () => {},
    noteAttribution: () => {},
    messages: [],
  } as unknown as ToolCallContext
}

describe('interceptBashCd', () => {
  it('passes through non-cd commands', async () => {
    const setter = vi.fn()
    const result = await interceptBashCd(
      { command: 'ls -la' },
      makeContext({
        cwd: '/home/me',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({ HOME: '/home/me' }),
    )
    expect(result.kind).toBe('passthrough')
    expect(setter).not.toHaveBeenCalled()
  })

  it('passes through compound `cd` commands', async () => {
    const setter = vi.fn()
    const result = await interceptBashCd(
      { command: 'cd /foo && ls' },
      makeContext({
        cwd: '/home/me',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({ HOME: '/home/me' }),
    )
    expect(result.kind).toBe('passthrough')
    expect(setter).not.toHaveBeenCalled()
  })

  it('intercepts pure `cd <abs>` and pushes the new cwd to C++', async () => {
    const setter = vi.fn<SetAgentLoopSettingsFn>(async () => ({
      ok: true as const,
      appliedCwd: '/var/lib/foo',
    }))
    const result = await interceptBashCd(
      { command: 'cd /var/lib/foo' },
      makeContext({
        cwd: '/home/me',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({ HOME: '/home/me' }),
    )
    expect(result.kind).toBe('cd')
    if (result.kind !== 'cd') return // narrow
    expect(result.appliedCwd).toBe('/var/lib/foo')
    expect(result.resultText).toContain('/var/lib/foo')
    expect(setter).toHaveBeenCalledTimes(1)
    expect(setter.mock.calls[0]?.[0].cwd).toBe('/var/lib/foo')
    expect(setter.mock.calls[0]?.[0].executionContext?.sessionId).toBe(
      'sess-1',
    )
  })

  it('resolves relative `cd` against the current cwd', async () => {
    const setter = vi.fn<SetAgentLoopSettingsFn>(async () => ({ ok: true as const }))
    const result = await interceptBashCd(
      { command: 'cd sub' },
      makeContext({
        cwd: '/home/me/project',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({}),
    )
    expect(result.kind).toBe('cd')
    expect(setter.mock.calls[0]?.[0].cwd).toBe('/home/me/project/sub')
  })

  it('caches the cwd so the NEXT cd resolves against the new value', async () => {
    const setter = vi.fn<SetAgentLoopSettingsFn>(async () => ({ ok: true as const }))
    const context = makeContext({
      cwd: '/home/me/project',
      sessionId: 'sess-1',
      setAgentLoopSettings: setter,
    })
    const config = makeRuntimeConfig({})

    await interceptBashCd({ command: 'cd /var/lib/foo' }, context, config)
    expect(setter.mock.calls[0]?.[0].cwd).toBe('/var/lib/foo')

    // The second `cd` uses a relative path; if the cache is working,
    // it resolves against /var/lib/foo (not the stale context.cwd
    // which is still /home/me/project).
    await interceptBashCd({ command: 'cd sub' }, context, config)
    expect(setter.mock.calls[1]?.[0].cwd).toBe('/var/lib/foo/sub')
  })

  it('returns error for unresolvable targets (e.g. `cd ~` with no HOME)', async () => {
    const setter = vi.fn()
    const result = await interceptBashCd(
      { command: 'cd ~/docs' },
      makeContext({
        cwd: '/home/me',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({}), // no HOME
    )
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.resultText).toContain('cannot resolve')
    expect(setter).not.toHaveBeenCalled()
  })

  it('falls through to passthrough when no session capability is available', async () => {
    // No setAgentLoopSettings — older C++ build, headless runtime, tests.
    const result = await interceptBashCd(
      { command: 'cd /foo' },
      makeContext({
        cwd: '/home/me',
        sessionId: 'sess-1',
      }),
      makeRuntimeConfig({ HOME: '/home/me' }),
    )
    expect(result.kind).toBe('passthrough')
  })

  it('falls through when the C++ side rejects the new cwd', async () => {
    const setter = vi.fn(async () => {
      throw new Error('path does not exist')
    })
    const result = await interceptBashCd(
      { command: 'cd /nonexistent' },
      makeContext({
        cwd: '/home/me',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({}),
    )
    expect(result.kind).toBe('passthrough')
  })

  it('converts a git-bash `cd /c/...` to a native path on a Windows host', async () => {
    // The C++ session set_cwd rejects `/c/shift` on Windows as non-absolute.
    // With a Windows session cwd we must push the native `C:\shift` instead.
    const setter = vi.fn<SetAgentLoopSettingsFn>(async () => ({ ok: true as const }))
    const result = await interceptBashCd(
      { command: 'cd /c/shift' },
      makeContext({
        cwd: 'C:\\Users\\me\\project',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({}),
    )
    expect(result.kind).toBe('cd')
    if (result.kind !== 'cd') return
    expect(result.appliedCwd).toBe('C:\\shift')
    expect(setter.mock.calls[0]?.[0].cwd).toBe('C:\\shift')
  })

  it('leaves a POSIX `cd /c/...` untouched on a POSIX host', async () => {
    const setter = vi.fn<SetAgentLoopSettingsFn>(async () => ({ ok: true as const }))
    await interceptBashCd(
      { command: 'cd /c/shift' },
      makeContext({
        cwd: '/home/me/project',
        sessionId: 'sess-1',
        setAgentLoopSettings: setter,
      }),
      makeRuntimeConfig({}),
    )
    expect(setter.mock.calls[0]?.[0].cwd).toBe('/c/shift')
  })
})
