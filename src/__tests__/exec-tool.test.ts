// The `exec` tool — SafeCode's Execute lane — and its nested execution gate.
//
// `runNestedTool` runs a nested tool call through the SAME permission phases
// as a direct model call (plan mode, file pipeline / rule gate, self-gate,
// interactive ask, hooks); `runExec` composes a REGISTERED CLI + argv into one
// single-quoted command and dispatches it through the Bash tool via that gate.
// The hook/headless boundary is mocked (those engines are tested elsewhere);
// the permission machinery is real.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, ToolUseConfirmResolution } from '../runtime/RuntimeTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'

const { preHookMock, postHookMock, headlessMock } = vi.hoisted(() => ({
  preHookMock: vi.fn(async () => ({ blocked: false, message: '' })),
  postHookMock: vi.fn(async () => ''),
  headlessMock: vi.fn(async () => ({ behavior: 'deny', message: 'headless auto-deny' })),
}))


// Imported AFTER the mocks are registered (vi.mock is hoisted above this).
import { ExecTool, runExec, runNestedTool } from '../toolkit/builtin/exec'

type FakeToolOptions = {
  permission?: { behavior: 'allow' | 'deny' | 'ask'; message?: string; updatedInput?: Record<string, unknown> }
  callData?: unknown
  requiresUI?: boolean
  readOnly?: boolean
  validate?: (input: Record<string, unknown>) => Promise<{ result: boolean; message?: string }>
  onCall?: (input: Record<string, unknown>) => void
}

function fakeTool(name: string, opts: FakeToolOptions = {}): ToolContract {
  const permission = opts.permission ?? { behavior: 'allow' as const }
  return {
    name,
    readsOnly: () => opts.readOnly ?? false,
    async selfVerdict() {
      return permission
    },
    async call(input: Record<string, unknown>) {
      opts.onCall?.(input)
      return { data: opts.callData ?? 'CALL_OK' }
    },
    haltsForUser: opts.requiresUI ? () => true : undefined,
    checkInput: opts.validate,
  } as unknown as ToolContract
}

/** Minimal getAppState with a permissionRules — what the nested gate's
 *  plan-mode / file-pipeline / rule phases read. */
function makeAppState(
  mode: string,
  extra: Record<string, unknown> = {},
): () => { permissionRules: Record<string, unknown> } {
  return () => ({
    permissionRules: {
      mode,
      extraWorkspaceRoots: new Map(),
      ...extra,
    },
  })
}

function makeContext(
  tools: ToolContract[],
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  const ctx = {
    options: { tools, cwd: '/proj', sessionId: 's1' },
    cancelSource: new AbortController(),
    toolRunSeams: { nested: { preHooks: (...a: unknown[]) => preHookMock(...(a as [])), postHooks: (...a: unknown[]) => postHookMock(...(a as [])), headlessDecision: (...a: unknown[]) => headlessMock(...(a as [])) } } as never,
    requestToolUseConfirm: undefined,
    readAppState: makeAppState('default'),
    ...overrides,
  } as unknown as ToolCallContext
  return ctx
}

const canUseTool = vi.fn() as unknown as PermissionDecider
const invokingRow = {} as unknown as Message

beforeEach(() => {
  preHookMock.mockReset()
  preHookMock.mockResolvedValue({ blocked: false, message: '' })
  postHookMock.mockReset()
  postHookMock.mockResolvedValue('')
  headlessMock.mockReset()
  headlessMock.mockResolvedValue({ behavior: 'deny', message: 'headless auto-deny' })
})

describe('runNestedTool — the nested permission gate', () => {
  it('runs an allowed tool and returns its data', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('Foo', { permission: { behavior: 'allow' }, callData: 'HELLO', onCall })])
    const res = await runNestedTool('Foo', { a: 1 }, ctx, canUseTool, invokingRow)
    expect(res).toEqual({ ok: true, data: 'HELLO', raw: 'HELLO' })
    expect(onCall).toHaveBeenCalledWith({ a: 1 })
  })

  it('refuses a denied tool without calling it', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('Foo', { permission: { behavior: 'deny', message: 'nope' }, onCall })])
    const res = await runNestedTool('Foo', {}, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(false)
    expect(res.data).toBe('nope')
    expect(onCall).not.toHaveBeenCalled()
  })

  it('honors an ask that the user allows via requestToolUseConfirm', async () => {
    const onCall = vi.fn()
    const confirm = vi.fn(async () => ({ behavior: 'allow' }) as ToolUseConfirmResolution)
    const ctx = makeContext(
      [fakeTool('Foo', { permission: { behavior: 'ask', message: 'confirm?' }, callData: 'YES', onCall })],
      { requestToolUseConfirm: confirm } as never,
    )
    const res = await runNestedTool('Foo', {}, ctx, canUseTool, invokingRow)
    expect(confirm).toHaveBeenCalled()
    expect(res).toEqual({ ok: true, data: 'YES', raw: 'YES' })
  })

  it('refuses an ask when no confirm channel exists', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('Foo', { permission: { behavior: 'ask', message: 'confirm?' }, onCall })])
    const res = await runNestedTool('Foo', {}, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(false)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('refuses an unknown tool', async () => {
    const res = await runNestedTool('Missing', {}, makeContext([]), canUseTool, invokingRow)
    expect(res.ok).toBe(false)
    expect(res.data).toMatch(/Unknown tool/)
  })

  it('refuses a tool that needs interactive UI', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('AskUserQuestion', { requiresUI: true, onCall })])
    const res = await runNestedTool('AskUserQuestion', {}, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(false)
    expect(res.data).toMatch(/interactive UI/)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('gives two concurrent same-name asks distinct toolUseIDs', async () => {
    const ids: string[] = []
    const confirm = vi.fn(async (req: { approvalCallId: string }) => {
      ids.push(req.approvalCallId)
      return { behavior: 'allow' } as ToolUseConfirmResolution
    })
    const ctx = makeContext(
      [fakeTool('Foo', { permission: { behavior: 'ask', message: 'confirm?' }, callData: 'OK' })],
      { requestToolUseConfirm: confirm } as never,
    )
    await Promise.all([
      runNestedTool('Foo', {}, ctx, canUseTool, invokingRow),
      runNestedTool('Foo', {}, ctx, canUseTool, invokingRow),
    ])
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('denies a non-read-only nested tool in plan mode without calling it', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('Foo', { onCall })], {
      readAppState: makeAppState('plan'),
    } as never)
    const res = await runNestedTool('Foo', {}, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(false)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('allows a read-only nested tool in plan mode', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('Foo', { onCall, readOnly: true })], {
      readAppState: makeAppState('plan'),
    } as never)
    const res = await runNestedTool('Foo', {}, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(true)
    expect(onCall).toHaveBeenCalled()
  })

  it('nested hosted Write inside the cwd is allowed silently (Velloc default)', async () => {
    const onCall = vi.fn()
    const confirm = vi.fn()
    const ctx = makeContext([fakeTool('Write', { onCall })], {
      requestToolUseConfirm: confirm,
    } as never)
    const res = await runNestedTool(
      'Write',
      { file_path: '/proj/a.txt', content: 'x' },
      ctx,
      canUseTool,
      invokingRow,
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(res.ok).toBe(true)
    expect(onCall).toHaveBeenCalled()
  })

  it('nested hosted Write to a protected path asks first (safety, bypass-immune)', async () => {
    const onCall = vi.fn()
    const confirm = vi.fn(async () => ({ behavior: 'allow' }) as ToolUseConfirmResolution)
    const ctx = makeContext([fakeTool('Write', { onCall })], {
      requestToolUseConfirm: confirm,
    } as never)
    const res = await runNestedTool(
      'Write',
      { file_path: '/proj/.git/config', content: 'x' },
      ctx,
      canUseTool,
      invokingRow,
    )
    expect(confirm).toHaveBeenCalled()
    expect(res.ok).toBe(true)
    expect(onCall).toHaveBeenCalled()
  })

  it('nested hosted Write is stopped by a deny rule', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('Write', { onCall })], {
      readAppState: makeAppState('default', {
        denyRuleBook: { session: ['Write'] },
      }),
    } as never)
    const res = await runNestedTool(
      'Write',
      { file_path: '/proj/a.txt', content: 'x' },
      ctx,
      canUseTool,
      invokingRow,
    )
    expect(res.ok).toBe(false)
    expect(res.data).toMatch(/den/i)
    expect(onCall).not.toHaveBeenCalled()
  })
})

describe('runExec — registered CLIs only', () => {
  it('refuses an unregistered tool (shells / interpreters / file utils / npx)', async () => {
    const ctx = makeContext([])
    for (const forbidden of ['bash', 'sh', 'powershell', 'python', 'cat', 'rm', 'node', 'npx']) {
      const res = await runExec(forbidden, [], undefined, ctx, canUseTool, invokingRow)
      expect(res.ok, forbidden).toBe(false)
      expect(res.data).toMatch(/not a registered tool/)
    }
  })

  it('enforces the npm subcommand allowlist (run/exec/anything-else refused)', async () => {
    const bash = fakeTool('Bash', { callData: { output: 'ok', exit_code: 0 } })
    const ctx = makeContext([bash])
    // `npm run <script>` executes arbitrary package.json shell — refused.
    for (const sub of ['run', 'exec', 'publish', '']) {
      const res = await runExec('npm', sub ? [sub, 'build'] : [], undefined, ctx, canUseTool, invokingRow)
      expect(res.ok, `npm ${sub}`).toBe(false)
      expect(res.data).toMatch(/Permitted npm subcommands/)
    }
    // The dependency/test operations pass.
    for (const sub of ['install', 'ci', 'test']) {
      const res = await runExec('npm', [sub], undefined, ctx, canUseTool, invokingRow)
      expect(res.ok, `npm ${sub}`).toBe(true)
    }
  })

  it('composes argv into a single-quoted command and unwraps the Bash envelope', async () => {
    let seen: Record<string, unknown> | undefined
    const bash = fakeTool('Bash', {
      onCall: input => {
        seen = input
      },
      // The real Bash tool returns this envelope; runExec unwraps it.
      callData: { output: 'git version 2.46\n', exit_code: 0 },
    })
    const ctx = makeContext([bash])
    const res = await runExec('git', ['--version'], undefined, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ output: 'git version 2.46\n', exitCode: 0 })
    expect(seen).toEqual({ command: "git '--version'" })
  })

  it('surfaces a non-zero exit as { output, exitCode } WITHOUT throwing', async () => {
    const bash = fakeTool('Bash', {
      callData: { output: 'ninja: build stopped: subcommand failed.\n', exit_code: 1 },
    })
    const ctx = makeContext([bash])
    const res = await runExec('ninja', ['-C', 'out/Debug'], undefined, ctx, canUseTool, invokingRow)
    // A failed build is a command that RAN — the model needs its output + code,
    // not a thrown-away throw. ok:true, exitCode carries the failure.
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({
      output: 'ninja: build stopped: subcommand failed.\n',
      exitCode: 1,
    })
  })

  it('neutralizes shell metacharacters in args (no injection)', async () => {
    let seen: Record<string, unknown> | undefined
    const bash = fakeTool('Bash', { onCall: input => (seen = input) })
    const ctx = makeContext([bash])
    await runExec('git', ['status', '; rm -rf /'], undefined, ctx, canUseTool, invokingRow)
    // The ; and spaces are inside a single-quoted arg — one literal argument.
    expect(seen).toEqual({ command: "git 'status' '; rm -rf /'" })
  })

  it('rejects non-string/number args', async () => {
    const ctx = makeContext([fakeTool('Bash')])
    const res = await runExec('git', [{}], undefined, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(false)
    expect(res.data).toMatch(/must be a string or finite number/)
  })

  it('prefixes a composed (injection-free) cd for options.cwd', async () => {
    let seen: Record<string, unknown> | undefined
    const bash = fakeTool('Bash', { onCall: input => (seen = input) })
    const ctx = makeContext([bash])
    await runExec('ninja', ['-C', 'out/Debug'], { cwd: 'src' }, ctx, canUseTool, invokingRow)
    expect(seen!.command).toBe("cd '/proj/src' && ninja '-C' 'out/Debug'")
  })

  it('inherits the Bash permission gate — a deny rule stops exec', async () => {
    const onCall = vi.fn()
    const ctx = makeContext([fakeTool('Bash', { onCall })], {
      readAppState: makeAppState('default', { denyRuleBook: { session: ['Bash'] } }),
    } as never)
    const res = await runExec('git', ['status'], undefined, ctx, canUseTool, invokingRow)
    expect(onCall).not.toHaveBeenCalled()
    expect(res.ok).toBe(false)
  })
})

describe('runNestedTool — prepareCall (SuperShell wrapper)', () => {
  it('gates and hooks see the original input; only tool.call receives the rewrite', async () => {
    let called: Record<string, unknown> | undefined
    const ctx = makeContext([fakeTool('Bash', { onCall: input => (called = input) })])
    const res = await runNestedTool(
      'Bash',
      { command: 'npm test' },
      ctx,
      canUseTool,
      invokingRow,
      { prepareCall: input => ({ ...input, command: `WRAPPED(${String(input.command)})` }) },
    )
    expect(res.ok).toBe(true)
    expect(called!.command).toBe('WRAPPED(npm test)')
    // PreToolUse hook saw the model's command, not the wrapper.
    expect((preHookMock.mock.calls[0] as unknown[])[1]).toEqual({ command: 'npm test' })
  })

  it('a deny rule on the original command stops the call before prepareCall runs', async () => {
    const onCall = vi.fn()
    const prepareCall = vi.fn((input: Record<string, unknown>) => input)
    const ctx = makeContext([fakeTool('Bash', { onCall })], {
      readAppState: makeAppState('default', { denyRuleBook: { session: ['Bash'] } }),
    } as never)
    const res = await runNestedTool('Bash', { command: 'rm -rf x' }, ctx, canUseTool, invokingRow, {
      prepareCall,
    })
    expect(res.ok).toBe(false)
    expect(prepareCall).not.toHaveBeenCalled()
    expect(onCall).not.toHaveBeenCalled()
  })
})

describe('nested hooks + headless', () => {
  it('a PreToolUse hook block stops the nested Bash (and never calls it)', async () => {
    const onCall = vi.fn()
    preHookMock.mockResolvedValue({ blocked: true, message: 'no bash allowed' })
    const ctx = makeContext([fakeTool('Bash', { onCall })])
    const res = await runNestedTool('Bash', { command: 'ls' }, ctx, canUseTool, invokingRow)
    expect(preHookMock).toHaveBeenCalled()
    expect((preHookMock.mock.calls[0] as unknown[])[0]).toBe('Bash')
    expect(onCall).not.toHaveBeenCalled()
    expect(res.ok).toBe(false)
    expect(res.data).toMatch(/Hook blocked/)
  })

  it('exec inherits the Bash PreToolUse hook (blocked before the command runs)', async () => {
    const onCall = vi.fn()
    preHookMock.mockResolvedValue({ blocked: true, message: 'nope' })
    const ctx = makeContext([fakeTool('Bash', { onCall })])
    const res = await runExec('git', ['status'], undefined, ctx, canUseTool, invokingRow)
    expect((preHookMock.mock.calls[0] as unknown[])[0]).toBe('Bash')
    expect(onCall).not.toHaveBeenCalled()
    expect(res.ok).toBe(false)
  })

  it('a PostToolUse note is appended to a successful nested call', async () => {
    postHookMock.mockResolvedValue('[PostToolUse hook blocked: Bash]\nlint failed')
    const ctx = makeContext([fakeTool('Bash', { callData: 'ran ls' })])
    const res = await runNestedTool('Bash', { command: 'ls' }, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(true)
    expect(res.data).toContain('ran ls')
    expect(res.data).toContain('lint failed')
  })

  it('a nested ask auto-denies in a headless context (no confirm parked)', async () => {
    const confirm = vi.fn()
    const ctx = makeContext(
      [fakeTool('Foo', { permission: { behavior: 'ask', message: 'confirm?' } })],
      {
        readAppState: makeAppState('default', { suppressAsks: true }),
        requestToolUseConfirm: confirm,
      } as never,
    )
    const res = await runNestedTool('Foo', {}, ctx, canUseTool, invokingRow)
    expect(headlessMock).toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(res.ok).toBe(false)
    expect(res.data).toContain('headless auto-deny')
  })

  it('a headless allow (PermissionRequest hook) lets the nested call proceed', async () => {
    const onCall = vi.fn()
    headlessMock.mockResolvedValue({ behavior: 'allow', message: '' })
    const ctx = makeContext(
      [fakeTool('Foo', { permission: { behavior: 'ask' }, onCall })],
      {
        readAppState: makeAppState('default', { suppressAsks: true }),
        requestToolUseConfirm: vi.fn(),
      } as never,
    )
    const res = await runNestedTool('Foo', {}, ctx, canUseTool, invokingRow)
    expect(res.ok).toBe(true)
    expect(onCall).toHaveBeenCalled()
  })
})

describe('ExecTool — the model-facing surface', () => {
  it('validates tool membership and args shape', async () => {
    const ctx = makeContext([])
    expect((await ExecTool.checkInput!({}, ctx)).result).toBe(false)
    expect((await ExecTool.checkInput!({ tool: 'python' }, ctx)).result).toBe(false)
    expect(
      (await ExecTool.checkInput!({ tool: 'git', args: 'status' as never }, ctx)).result,
    ).toBe(false)
    expect((await ExecTool.checkInput!({ tool: 'git', args: ['status'] }, ctx)).result).toBe(true)
  })

  it('returns the output plainly on exit 0, and tags a non-zero exit', async () => {
    const bash = fakeTool('Bash', { callData: { output: 'clean\n', exit_code: 0 } })
    const ok = await ExecTool.call(
      { tool: 'git', args: ['status'] },
      makeContext([bash]),
      canUseTool,
      invokingRow,
    )
    expect(ok.data).toBe('clean\n')

    const failing = fakeTool('Bash', { callData: { output: 'FAILED tests\n', exit_code: 2 } })
    const bad = await ExecTool.call(
      { tool: 'npm', args: ['test'] },
      makeContext([failing]),
      canUseTool,
      invokingRow,
    )
    expect(bad.data).toBe('FAILED tests\n[exit code 2]')
  })

  it('surfaces a refusal (registry/policy/permission) as the result text', async () => {
    const res = await ExecTool.call(
      { tool: 'npm', args: ['run', 'build'] },
      makeContext([fakeTool('Bash')]),
      canUseTool,
      invokingRow,
    )
    expect(res.data).toMatch(/Permitted npm subcommands/)
  })

  it('describes the registry (npx absent, npm restricted) to the model', async () => {
    const desc = await ExecTool.description({}, {
      tools: [],
    } as never)
    expect(desc).toContain('git')
    expect(desc).toContain('npm is limited to: install, ci, test')
    expect(desc).not.toMatch(/\bnpx\b/)
  })
})
