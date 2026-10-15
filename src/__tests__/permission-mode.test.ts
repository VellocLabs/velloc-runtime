import { describe, expect, it, vi } from 'vitest'
import { AgentPermissionCoordinator } from '../browser/worker/AgentPermissionCoordinator'
import {
  PLAN_MODE_READ_ONLY_HOSTED_TOOLS,
  isToolAllowedInPlanMode,
  planModeRejectMessage,
} from '../permissions/planMode'
import { isHostedToolReadOnly } from '../permissions/hostedToolReadOnly'
import { PlanOnTool } from '../toolkit/builtin/planEnter'
import { ExitPlanModeTool } from '../toolkit/builtin/planExit'
import { SpawnAgentTool } from '../toolkit/builtin/subagentLaunch'
import { JobReadTool } from '../toolkit/builtin/subAgentControlTools'

describe('permission mode coordinator', () => {
  it('applyMode persists the mode the engine ENTERED, not a refused request', async () => {
    // The engine refuses bypass under the killswitch and stays on its
    // previous mode; persisting the request would restore a mode the session
    // never entered (and be refused again on every boot).
    let current = 'acceptEdits'
    const setPermissionMode = vi.fn((mode: string) => {
      if (mode !== 'bypassPermissions') current = mode
    })
    const updateSessionMetadata = vi.fn(async () => {})
    const coordinator = new AgentPermissionCoordinator({
      emitState: () => {},
      emitError: () => {},
    })
    coordinator.bindRuntime({
      engine: { setPermissionMode, getCurrentPermissionMode: () => current },
      conversationStore: {
        getSessionMetadata: async () => ({ permissionMode: 'default' }),
        updateSessionMetadata,
      },
    } as never)

    await coordinator.applyMode('bypassPermissions')
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(updateSessionMetadata).toHaveBeenCalledWith({ permissionMode: 'acceptEdits' })

    // An accepted request persists as itself.
    updateSessionMetadata.mockClear()
    await coordinator.applyMode('plan')
    expect(updateSessionMetadata).toHaveBeenCalledWith({ permissionMode: 'plan' })
  })
})

describe('plan-mode tool gate (isToolAllowedInPlanMode)', () => {
  const fakeTool = (name: string, readOnly: boolean) => ({
    name,
    readsOnly: () => readOnly,
  })
  // A host tool answers `isReadOnly(input)` as host/hostTools.ts wires it.
  const hostedTool = (name: string) => ({
    name,
    readsOnly: (input: unknown) => isHostedToolReadOnly(name, undefined, input),
  })

  it('allows TS read-only tools (isReadOnly() === true)', () => {
    expect(isToolAllowedInPlanMode(fakeTool('AskUserQuestion', true), {})).toBe(
      true,
    )
  })

  it('allows read-only hosted tools that do not advertise the flag', () => {
    // No read_only field in the host manifest: the hosted tool's isReadOnly
    // answers from the allowlist (hostedToolReadOnly.ts).
    for (const name of ['Read', 'Grep', 'Glob', 'BrowserReadPage']) {
      expect(isToolAllowedInPlanMode(hostedTool(name), {})).toBe(true)
    }
    // Background-shell output is NO LONGER a hosted tool — `BashOutput` was
    // removed from the allowlist. Its read capability moved to the TS
    // `TaskOutput`, which self-reports isReadOnly() and is allowed via the TS
    // branch (asserted below), so the plan-mode read is preserved.
    expect(PLAN_MODE_READ_ONLY_HOSTED_TOOLS.has('BashOutput')).toBe(false)
  })

  it('does not admit a tool by a hosted name — it answers for itself', () => {
    // An MCP or mod tool that reports itself writable stays blocked even when
    // its name is one the hosted read-only and shell sets carry.
    expect(isToolAllowedInPlanMode(fakeTool('Read', false), {})).toBe(false)
    expect(isToolAllowedInPlanMode(fakeTool('Bash', false), { command: 'ls' })).toBe(false)
  })

  it('allows TaskOutput in plan mode (reading background output is read-only)', () => {
    expect(JobReadTool.readsOnly?.({})).toBe(true)
    expect(isToolAllowedInPlanMode(JobReadTool, {})).toBe(true)
  })

  it('always allows ExitPlanMode even though it is not read-only', () => {
    // The exit hatch — without this exemption the model could never leave plan
    // mode (ExitPlanMode flips the mode, so isReadOnly() is false).
    expect(isToolAllowedInPlanMode(fakeTool('ExitPlanMode', false), {})).toBe(
      true,
    )
  })

  it('allows Skill in plan mode (loads instructions; execution paths gated)', () => {
    // Skill is isReadOnly()===false (it can run embedded shell / fork), but
    // loading a skill's INSTRUCTIONS is read-only, and its execution paths are
    // gated in plan mode at the source (embedded shell skipped, fork inlined).
    // So research skills (e.g. a Jira lookup) can run while planning.
    expect(
      isToolAllowedInPlanMode(fakeTool('Skill', false), { skill: 'jira' }),
    ).toBe(true)
  })

  it('allows the Agent (subagent dispatcher) in plan mode', () => {
    // SpawnAgentTool.isReadOnly() is true: the Agent tool only dispatches, and the
    // permission checks happen on the tools the subagent calls. The model must
    // be able to spawn exploration subagents while planning; the subagent's own
    // Write/Edit/Bash calls are what get plan-gated (forked subagents inherit the
    // parent's getAppState, so they share plan mode). A gate that rejected every
    // subagent spawn would leave plan mode unable to delegate research.
    expect(SpawnAgentTool.readsOnly?.({})).toBe(true)
    expect(
      isToolAllowedInPlanMode(SpawnAgentTool, {
        description: 'explore the codebase',
        prompt: 'find X',
      }),
    ).toBe(true)
  })

  it('denies non-read-only, non-allowlisted tools (writes / actions)', () => {
    for (const name of ['Write', 'Edit', 'mcp__server__do_thing']) {
      expect(isToolAllowedInPlanMode(hostedTool(name), {})).toBe(false)
    }
  })

  // `code`-type sessions register SuperEdit as their ONLY file-mutation tool
  // (no raw Write/Edit — src/template/code/template.md), so blocking it here
  // would leave them unable to write their own plan file. The gate admits the
  // TOOL; the per-target plan enforcement (reads yes, writes only to the exact
  // plan file) lives in commitOverlay, which sees the resolved paths — see
  // super-edit-tool.test.ts "plan mode" cases.
  it('allows SuperEdit wholesale (per-target gate lives in commitOverlay)', () => {
    expect(
      isToolAllowedInPlanMode(fakeTool('SuperEdit', false), {
        code: 'await writeTextFile("x.txt", "hi")',
      }),
    ).toBe(true)
  })

  // Plan-mode browser policy: BROWSING yes, ACTING no. Navigation / viewport /
  // tab-focus tools are research affordances (they change where the user is
  // looking, never page content or user data); interaction tools can submit,
  // purchase, delete, execute JS, or move files — blocked until plan exit.
  it('browser gate: allows BROWSING tools, denies INTERACTION tools', () => {
    const browsing = [
      'BrowserNavigate',
      'BrowserSearch',
      'BrowserBack',
      'BrowserActivateTab',
      'BrowserScroll',
      'BrowserScrollToElement',
      'BrowserHover',
      // Observation set (pre-existing allowlist).
      'BrowserReadPage',
      'BrowserReadElement',
      'BrowserScreenshot',
      'BrowserFindText',
      'BrowserMediaState',
    ]
    for (const name of browsing) {
      expect(
        isToolAllowedInPlanMode(hostedTool(name), {}),
        `${name} must be allowed in plan mode (browsing)`,
      ).toBe(true)
    }
    const interaction = [
      'BrowserClick',
      'BrowserType',
      'BrowserFillForm',
      'BrowserSelect',
      'BrowserDragAndDrop',
      'BrowserEvaluate',
      'BrowserUpload',
      'BrowserDownload',
      'BrowserCloseTab',
      'BrowserMediaControl',
      'BrowserDone',
    ]
    for (const name of interaction) {
      expect(
        isToolAllowedInPlanMode(hostedTool(name), {}),
        `${name} must stay blocked in plan mode (interaction)`,
      ).toBe(false)
    }
  })

  // The shell gate is command-aware in plan mode, NOT a blanket block: a
  // conservative classifier (readOnlyShellCommand.ts) admits read-only
  // Bash/PowerShell commands and rejects everything else.
  it('shell gate: allows READ-ONLY commands, denies mutating/unknown ones', () => {
    const bash = (command: string) =>
      isToolAllowedInPlanMode(hostedTool('Bash'), { command })
    const ps = (command: string) =>
      isToolAllowedInPlanMode(hostedTool('PowerShell'), { command })

    for (const cmd of [
      'ls -la',
      'cat src/index.ts',
      'git status',
      'git log --oneline -20',
      'git diff HEAD~1',
      'grep -rn foo src',
      'rg pattern',
      'gh pr view 12',
      'git log | head -20',
    ]) {
      expect(bash(cmd), cmd).toBe(true)
    }
    for (const cmd of ['Get-ChildItem', 'Get-Content file.txt', 'Select-String foo']) {
      expect(ps(cmd), cmd).toBe(true)
    }

    for (const cmd of [
      'rm -rf build',
      'git push',
      'git commit -m wip',
      'echo hi > out.txt',
      'ls && rm x',
      'cat "$(rm x)"',
      'sudo ls',
      'npm install',
      'find . -delete',
      'mv a b',
    ]) {
      expect(bash(cmd), cmd).toBe(false)
    }
    for (const cmd of ['Remove-Item x', 'Set-Content f v', 'Out-File f']) {
      expect(ps(cmd), cmd).toBe(false)
    }

    // A shell call with no command is denied.
    expect(isToolAllowedInPlanMode(hostedTool('Bash'), {})).toBe(false)
  })

  it('rejection message names the tool and points at ExitPlanMode', () => {
    const msg = planModeRejectMessage('Write')
    expect(msg).toContain('Write')
    expect(msg).toContain('ExitPlanMode')
    expect(msg.toLowerCase()).toContain('plan mode')
  })

  it('read-only hosted allowlist covers exploration but not mutation', () => {
    expect(PLAN_MODE_READ_ONLY_HOSTED_TOOLS.has('Read')).toBe(true)
    expect(PLAN_MODE_READ_ONLY_HOSTED_TOOLS.has('Write')).toBe(false)
    expect(PLAN_MODE_READ_ONLY_HOSTED_TOOLS.has('Bash')).toBe(false)
  })
})

describe('plan-mode plan-file write exception', () => {
  const cwd = '/work/project'
  const planPath = '/work/project/.velloc/plans/session-abc.md'
  const planFile = { cwd, path: planPath }
  // Write/Edit are hosted tools that always report isReadOnly() === false.
  const write = (name: string, file_path: string) =>
    isToolAllowedInPlanMode(
      { name, readsOnly: () => false },
      { file_path },
      planFile,
    )

  it('allows Write to the exact session plan file (absolute path)', () => {
    expect(write('Write', planPath)).toBe(true)
  })

  it('allows Write to the plan file via a cwd-relative path', () => {
    expect(write('Write', '.velloc/plans/session-abc.md')).toBe(true)
  })

  it('allows Edit to the plan file', () => {
    expect(write('Edit', planPath)).toBe(true)
  })

  it('denies Write to any other file, including a sibling .md in the plan dir', () => {
    // Strict-equality gate: only the one session plan file is writable,
    // never a crafted sibling in the same dir.
    expect(write('Write', '/work/project/src/index.ts')).toBe(false)
    expect(write('Write', '/work/project/.velloc/plans/other.md')).toBe(false)
  })

  it('denies a traversal path that escapes to the plan file', () => {
    expect(write('Write', '.velloc/plans/../../../etc/passwd')).toBe(false)
  })

  it('denies plan-file writes when no plan target is supplied (back-compat)', () => {
    expect(
      isToolAllowedInPlanMode(
        { name: 'Write', readsOnly: () => false },
        { file_path: planPath },
      ),
    ).toBe(false)
  })
})

describe('ExitPlanMode interactive approval gate', () => {
  // ExitPlanMode HALTS the agent loop for the user (like AskUserQuestion) so the
  // model STOPS after presenting the plan instead of looping. requiresUserInteraction
  // is what routes it to runToolUse's pendingToolUse halt; the banner resolves
  // via submitToolResult. (Prose "stop here" did NOT halt the model — it kept
  // calling ExitPlanMode 3× — which is why this must be a real halt.)
  it('requires user interaction (halts the loop via pendingToolUse)', () => {
    expect(ExitPlanModeTool.haltsForUser?.()).toBe(true)
  })

  it('does not add an ask permission gate (defaults to allow; the halt is the gate)', async () => {
    const result = await ExitPlanModeTool.selfVerdict({}, {} as never)
    expect(result.behavior).toBe('allow')
  })
})

describe('EnterPlanMode interactive approval gate', () => {
  // A model-invoked EnterPlanMode asks the user first ("Enter plan mode?"),
  // since switching modes is the user's call. requiresUserInteraction
  // routes it to runToolUse's queued-confirm halt; approve resumes into call()
  // (which flips the mode), reject sends a declined error tool result. Without
  // this the model switched the session into plan mode silently.
  it('requires user interaction (halts the loop at the Enter plan mode? ask)', () => {
    expect(PlanOnTool.haltsForUser?.()).toBe(true)
  })

  it('does not add an ask permission gate (defaults to allow; the halt is the gate)', async () => {
    const result = await PlanOnTool.selfVerdict({}, {} as never)
    expect(result.behavior).toBe('allow')
  })
})
