import { describe, expect, it, vi } from 'vitest'
import { HostToolError } from '../browser/bridge/hostToolError'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { createInitialBrowserAppState } from '../browser/runtime/AgentRuntimeState'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  fireAfterToolCall,
  fireBeforeToolCall,
  firePromptSubmitted,
} from '../lifecycleHooks/runHooks'
import { buildHookInput } from '../lifecycleHooks/hookInput'
import {
  createBashHookCommandRunner,
  resolveShellPreference,
  type HookCommandRunner,
  type HookCommandRunnerResult,
} from '../lifecycleHooks/hookCommandRunner'
import { hookJsonToDecision, readHookReply } from '../lifecycleHooks/hookOutput'
import type { HookPromptRunner } from '../lifecycleHooks/hookPromptRunner'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'
import type { ShellHookSpec, PromptHook } from '../lifecycleHooks/hookTypes'

// ---- resolveShellPreference ----------------------------------------------

describe('resolveShellPreference', () => {
  it('defaults to bash, then PowerShell fallback', () => {
    expect(resolveShellPreference(undefined)).toEqual(['bash', 'powershell'])
  })

  it('honors an explicit POSIX shell with no fallback', () => {
    expect(resolveShellPreference('bash')).toEqual(['bash'])
    expect(resolveShellPreference('zsh')).toEqual(['zsh'])
    expect(resolveShellPreference('sh')).toEqual(['sh'])
  })

  it('maps PowerShell aliases to a pwsh-then-powershell try', () => {
    expect(resolveShellPreference('powershell')).toEqual(['pwsh', 'powershell'])
    expect(resolveShellPreference('pwsh')).toEqual(['pwsh', 'powershell'])
  })
})

// ---- readHookReply / decision -----------------------------------------

describe('createBashHookCommandRunner', () => {
  it('falls back to PowerShell when the host names the missing shell in service_code', async () => {
    const calls: Record<string, unknown>[] = []
    const context = {
      options: { sessionId: 's1' },
      platformCapabilities: {
        browser: {
          callTool: async ({ args }: { args: Record<string, unknown> }) => {
            calls.push(args)
            if (args.hook_shell === 'bash') {
              // The host's own declared code; the shell service's code is data.
              throw new HostToolError('hook_exec_failed', 'bash is not available', {
                detail: 'bash is not available',
                service_code: 'BINARY_NOT_FOUND',
              })
            }
            return { output: 'ok', exit_code: 0 }
          },
        },
      },
    } as unknown as ToolCallContext
    const runner = createBashHookCommandRunner(context)!
    await expect(runner({ command: 'echo', shell: undefined, stdin: '', env: {}, timeoutMs: 1000 }))
      .resolves.toEqual({ stdout: 'ok', exitCode: 0 })
    expect(calls.map(c => c.hook_shell)).toEqual(['bash', 'powershell'])
  })

  it('does not fall back on a failure that is not a missing shell', async () => {
    const calls: Record<string, unknown>[] = []
    const context = {
      options: { sessionId: 's1' },
      platformCapabilities: {
        browser: {
          callTool: async ({ args }: { args: Record<string, unknown> }) => {
            calls.push(args)
            throw new HostToolError('hook_exec_failed', 'cwd is gone', {
              detail: 'cwd is gone',
              service_code: 'INVALID_CWD',
            })
          },
        },
      },
    } as unknown as ToolCallContext
    const runner = createBashHookCommandRunner(context)!
    await expect(runner({ command: 'echo', shell: undefined, stdin: '', env: {}, timeoutMs: 1000 }))
      .rejects.toThrow('hook_exec_failed: cwd is gone')
    expect(calls.map(c => c.hook_shell)).toEqual(['bash'])
  })
})

describe('readHookReply + hookJsonToDecision', () => {
  it('returns null for plain (non-JSON) output', () => {
    expect(readHookReply('all good')).toBeNull()
    expect(readHookReply('')).toBeNull()
  })

  it('parses a JSON object and maps decision: block', () => {
    const json = readHookReply('{"decision":"block","reason":"nope"}')
    expect(json).toEqual({ decision: 'block', reason: 'nope' })
    expect(hookJsonToDecision(json!)).toEqual({ kind: 'block', reason: 'nope' })
  })

  it('maps continue:false and permissionDecision:deny to block', () => {
    expect(hookJsonToDecision({ continue: false, stopReason: 'stop' })).toEqual({
      kind: 'block',
      reason: 'stop',
    })
    expect(
      hookJsonToDecision({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'denied',
        },
      }),
    ).toEqual({ kind: 'block', reason: 'denied' })
  })

  it('maps approve / allow / empty to pass', () => {
    expect(hookJsonToDecision({ decision: 'approve' }).kind).toBe('pass')
    expect(hookJsonToDecision({}).kind).toBe('pass')
  })
})

// ---- buildHookInput ------------------------------------------------------

describe('buildHookInput', () => {
  it('builds PreToolUse input with tool fields', () => {
    const input = buildHookInput({
      event: 'PreToolUse',
      sessionId: 'sess',
      cwd: '/w',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolUseId: 'tu-1',
    })
    expect(input).toMatchObject({
      session_id: 'sess',
      cwd: '/w',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu-1',
    })
  })

  it('builds UserPromptSubmit input with the prompt', () => {
    const input = buildHookInput({
      event: 'UserPromptSubmit',
      sessionId: 's',
      cwd: '/w',
      prompt: 'hello',
    })
    expect(input.prompt).toBe('hello')
  })

  it('builds SubagentStop input with the agent id and no tool_name', () => {
    const input = buildHookInput({
      event: 'SubagentStop',
      sessionId: 's',
      cwd: '/w',
      toolName: 'asubagent-1',
    })
    expect(input).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_id: 'asubagent-1',
      stop_hook_active: false,
    })
    expect(input.tool_name).toBeUndefined()
  })
})

// ---- executor command path (with a fake runner) --------------------------

function withCommandHook(hook: ShellHookSpec): {
  appState: WorkingState
  setAppState: (u: (p: WorkingState) => WorkingState) => void
} {
  let appState: WorkingState = createInitialBrowserAppState()
  const setAppState = (u: (p: WorkingState) => WorkingState) => {
    appState = u(appState)
  }
  attachTransientHook(setAppState, 'sess', 'PreToolUse', 'Bash', hook, {
    skillRoot: '/plugins/p',
  })
  return { appState, setAppState }
}

function runner(result: HookCommandRunnerResult): HookCommandRunner {
  return vi.fn(async () => result)
}

const HOOK: ShellHookSpec = { type: 'command', command: 'check.sh' }

describe('fireBeforeToolCall — command execution', () => {
  it('exit 0 passes and feeds the runner env + stdin JSON', async () => {
    const { appState, setAppState } = withCommandHook(HOOK)
    const fake = runner({ stdout: '', exitCode: 0 })
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: fake,
      hookInput: {
        cwd: '/w',
        projectRoot: '/proj',
        toolInput: { command: 'ls' },
      },
    })
    expect(res.blocked).toBe(false)
    const arg = (fake as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.env.CLAUDE_PROJECT_DIR).toBe('/proj')
    expect(arg.env.CLAUDE_PLUGIN_ROOT).toBe('/plugins/p')
    const stdin = JSON.parse(arg.stdin)
    expect(stdin.hook_event_name).toBe('PreToolUse')
    expect(stdin.tool_name).toBe('Bash')
    expect(stdin.tool_input).toEqual({ command: 'ls' })
  })

  it('exit 2 blocks the tool and surfaces the output', async () => {
    const { appState, setAppState } = withCommandHook(HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: runner({ stdout: 'denied: rm', exitCode: 2 }),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(true)
    expect(res.errors.join(' ')).toContain('denied: rm')
  })

  it('other non-zero exit is a non-blocking warning', async () => {
    const { appState, setAppState } = withCommandHook(HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: runner({ stdout: 'oops', exitCode: 1 }),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(false)
    expect(res.warnings.length).toBe(1)
  })

  it('a JSON block decision blocks regardless of exit code', async () => {
    const { appState, setAppState } = withCommandHook(HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: runner({
        stdout: '{"decision":"block","reason":"policy"}',
        exitCode: 0,
      }),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(true)
    expect(res.errors.join(' ')).toContain('policy')
  })

  it('falls back to not_implemented when no runner is provided', async () => {
    const { appState, setAppState } = withCommandHook(HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
    })
    expect(res.blocked).toBe(false)
    expect(res.results[0]?.outcome.status).toBe('not_implemented')
  })

  it('does not fire for a non-matching tool', async () => {
    const { appState, setAppState } = withCommandHook(HOOK)
    const fake = runner({ stdout: '', exitCode: 0 })
    const res = await fireBeforeToolCall({
      toolName: 'Read',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: fake,
      hookInput: { cwd: '/w' },
    })
    expect(res.results).toHaveLength(0)
    expect(fake).not.toHaveBeenCalled()
  })
})

// ---- additionalContext / systemMessage injection ------------------------
//
// A non-blocking command hook can feed context back to the model via
// `hookSpecificOutput.additionalContext` (any event) or, for UserPromptSubmit
// / SessionStart, via plain exit-0 stdout. `fireLifecycleEvent` aggregates these
// onto `result.additionalContext` / `result.systemMessages`; the integration
// sites (engine/turnLoop.ts, toolExecution.ts) inject them into the conversation.

describe('fireLifecycleEvent — additionalContext / systemMessage aggregation', () => {
  it('carries structured additionalContext + systemMessage on a pass', async () => {
    const { appState, setAppState } = withCommandHook(HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: runner({
        stdout:
          '{"systemMessage":"ran linter",' +
          '"hookSpecificOutput":{"additionalContext":"lint: unused import on line 5"}}',
        exitCode: 0,
      }),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(false)
    expect(res.additionalContext).toEqual(['lint: unused import on line 5'])
    expect(res.systemMessages).toEqual(['ran linter'])
  })

  it('treats exit-0 plain stdout as context for UserPromptSubmit', async () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (u: (p: WorkingState) => WorkingState) => {
      appState = u(appState)
    }
    attachTransientHook(setAppState, 'sess', 'UserPromptSubmit', '', HOOK, {
      skillRoot: '/skills/s',
    })
    const res = await firePromptSubmitted({
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: runner({ stdout: 'Current branch: feature/login\n', exitCode: 0 }),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(false)
    expect(res.additionalContext).toEqual(['Current branch: feature/login'])
  })

  it('does NOT treat exit-0 plain stdout as context for PostToolUse', async () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (u: (p: WorkingState) => WorkingState) => {
      appState = u(appState)
    }
    attachTransientHook(setAppState, 'sess', 'PostToolUse', 'Bash', HOOK, {
      skillRoot: '/skills/s',
    })
    const res = await fireAfterToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: runner({ stdout: 'transcript-only output', exitCode: 0 }),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(false)
    // Plain stdout is transcript-only here — only the JSON field would inject.
    expect(res.additionalContext).toEqual([])
  })
})

// ---- executor prompt path (with a fake runner) ---------------------------

function withPromptHook(hook: PromptHook): {
  appState: WorkingState
  setAppState: (u: (p: WorkingState) => WorkingState) => void
} {
  let appState: WorkingState = createInitialBrowserAppState()
  const setAppState = (u: (p: WorkingState) => WorkingState) => {
    appState = u(appState)
  }
  attachTransientHook(setAppState, 'sess', 'PreToolUse', 'Bash', hook, {
    skillRoot: '/skills/s',
  })
  return { appState, setAppState }
}

function promptRunner(text: string): HookPromptRunner {
  return vi.fn(async () => text)
}

const PROMPT_HOOK: PromptHook = {
  type: 'prompt',
  prompt: 'Is this safe? $ARGUMENTS',
}

describe('fireBeforeToolCall — prompt execution', () => {
  it('ok:true passes and feeds the runner the substituted prompt + verdict contract', async () => {
    const { appState, setAppState } = withPromptHook(PROMPT_HOOK)
    const fake = promptRunner('{"ok": true}')
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      promptRunner: fake,
      hookInput: { cwd: '/w', toolInput: { command: 'ls' } },
    })
    expect(res.blocked).toBe(false)
    const arg = (fake as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // $ARGUMENTS is replaced with the hook-input JSON.
    expect(arg.prompt).toContain('"hook_event_name":"PreToolUse"')
    expect(arg.prompt).toContain('"tool_name":"Bash"')
    expect(arg.prompt).not.toContain('$ARGUMENTS')
    expect(arg.systemPrompt.join(' ')).toContain('JSON object')
  })

  it("forwards the hook's declared model to the runner", async () => {
    const { appState, setAppState } = withPromptHook({
      ...PROMPT_HOOK,
      model: 'claude-haiku-4-5',
    })
    const fake = promptRunner('{"ok": true}')
    await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      promptRunner: fake,
      hookInput: { cwd: '/w' },
    })
    const arg = (fake as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.model).toBe('claude-haiku-4-5')
  })

  it('leaves model undefined when the hook declares none', async () => {
    const { appState, setAppState } = withPromptHook(PROMPT_HOOK)
    const fake = promptRunner('{"ok": true}')
    await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      promptRunner: fake,
      hookInput: { cwd: '/w' },
    })
    const arg = (fake as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.model).toBeUndefined()
  })

  it('ok:false blocks the tool and surfaces the reason', async () => {
    const { appState, setAppState } = withPromptHook(PROMPT_HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      promptRunner: promptRunner('{"ok": false, "reason": "rm is dangerous"}'),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(true)
    expect(res.errors.join(' ')).toContain('rm is dangerous')
  })

  it('tolerates a verdict wrapped in prose / a code fence', async () => {
    const { appState, setAppState } = withPromptHook(PROMPT_HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      promptRunner: promptRunner('Sure!\n```json\n{"ok": false, "reason": "no"}\n```'),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(true)
    expect(res.errors.join(' ')).toContain('no')
  })

  it('an unparseable verdict is a non-blocking warning', async () => {
    const { appState, setAppState } = withPromptHook(PROMPT_HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      promptRunner: promptRunner('I cannot decide'),
      hookInput: { cwd: '/w' },
    })
    expect(res.blocked).toBe(false)
    expect(res.warnings.length).toBe(1)
  })

  it('falls back to not_implemented when no prompt runner is provided', async () => {
    const { appState, setAppState } = withPromptHook(PROMPT_HOOK)
    const res = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
    })
    expect(res.results[0]?.outcome.status).toBe('not_implemented')
  })
})
