import { afterEach, describe, expect, it } from 'vitest'

import { collectInitialAttachmentMessages } from '../messages/contextAttachments'
import { renderAttachmentMessage } from '../messages/renderAttachments'
import {
  copyPlanFileForFork,
  planDocPath,
  getPlanFilePathForSession,
} from '../utils/planFiles'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import { makeUserRow } from '../messages/messageFactories'
import { SPAWN_TOOL_ID } from '../toolkit/builtin/subagentLaunch'
import { PlanOnTool } from '../toolkit/builtin/planEnter'
import { ExitPlanModeTool } from '../toolkit/builtin/planExit'
import { createPlanAutoOpenGate } from '../browser/webview/planAutoOpenGate'
import {
  buildApprovedPlanMessage,
  buildRejectedPlanMessage,
  resolvePlanText,
} from '../permissions/planApproval'
import type { ContextRow, Message } from '../runtime/RuntimeTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'

// Plan-mode reminder + Enter/Exit round-trip: while `permissionRules.mode === 'plan'` the model is read-only and
// ends each turn with AskUserQuestion or ExitPlanMode; reminders are `<system-reminder>` meta user messages. The
// sub-agent workflow goes only to sessions whose tool pool has `Agent`; others get the direct-search variant.

// ---------------------------------------------------------------------------
// In-memory fs — just enough for planDocPath / planFileExists +
// ExitPlanMode's writeFile/readFile and EnterPlanMode's mkdir.
// ---------------------------------------------------------------------------
function makeFakeFs(seed: Record<string, string> = {}): {
  fs: RuntimeFs
  files: Map<string, string>
} {
  const files = new Map<string, string>(Object.entries(seed))
  const fileStat = (): RuntimeFsStat =>
    ({
      size: 0,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
    }) as RuntimeFsStat
  const fs: RuntimeFs = {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      if (!files.has(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return fileStat()
    },
    async mkdir(): Promise<void> {
      // plan dir is implicit in this in-memory fs — no-op.
    },
    async readFile(path: string): Promise<string> {
      const content = files.get(path)
      if (content === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return content
    },
    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    },
  } as RuntimeFs
  return { fs, files }
}

interface ContextOptions {
  mode?: string
  modeBeforePlan?: string
  attachmentState?: Record<string, unknown>
  tools?: Array<{ name: string }>
  agentId?: string
  cwd?: string
  sessionId?: string
}

function makeContext(opts: ContextOptions = {}): {
  context: ToolCallContext
  getState: () => Record<string, unknown>
} {
  let appState: Record<string, unknown> = {
    permissionRules: {
      mode: opts.mode ?? 'default',
      ...(opts.modeBeforePlan !== undefined ? { modeBeforePlan: opts.modeBeforePlan } : {}),
    },
    attachmentState: opts.attachmentState ?? {},
  }
  const context = {
    options: {
      cwd: opts.cwd ?? '/workspace',
      sessionId: opts.sessionId ?? 'session-1',
      commands: [],
      tools: opts.tools ?? [],
      mainLoopModel: 'inherit',
    },
    messages: [],
    agentId: opts.agentId,
    readAppState: () => appState,
    writeAppState: (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    },
  } as unknown as ToolCallContext
  return { context, getState: () => appState }
}

// Run the real public attachment path and return the rendered plan-mode texts.
async function collectAndRender(context: ToolCallContext): Promise<string[]> {
  const runtimeConfig = new BrowserRuntimeConfig()
  const messages = await collectInitialAttachmentMessages({
    input: '',
    context,
    runtimeConfig,
    // Browser context is no longer auto-attached, so hostBridge is unused.
    hostBridge: {} as never,
  })
  return messages
    .flatMap((m: ContextRow) => renderAttachmentMessage(m))
    .map((m: Message) => {
      const content = (m.message as { content?: unknown }).content
      return typeof content === 'string' ? content : JSON.stringify(content)
    })
}

const noopCanUseTool: PermissionDecider = async () => undefined

afterEach(() => {
  resetProcessFs()
})

describe('plan-mode reminder — first turn (full)', () => {
  it('emits the full workflow with Explore/Plan sub-agents when the session has the Agent tool', async () => {
    installProcessFs(makeFakeFs().fs)
    const { context } = makeContext({
      mode: 'plan',
      tools: [{ name: SPAWN_TOOL_ID }],
    })
    const texts = await collectAndRender(context)
    expect(texts).toHaveLength(1)
    const text = texts[0]!
    // Wrapped in the harness-nudge envelope.
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text.trimEnd().endsWith('</system-reminder>')).toBe(true)
    // Read-only contract + supersedes.
    expect(text).toContain('Plan mode is active')
    expect(text).toContain('MUST NOT make any edits')
    expect(text).toContain('supersedes any other instructions')
    // The RIGHT-TYPE workflow: parallel Explore + Plan sub-agents.
    expect(text).toContain('subagent_type=Explore')
    expect(text).toContain('subagent_type=Plan')
    // The turn-ending contract.
    expect(text).toContain('AskUserQuestion')
    expect(text).toContain('ExitPlanMode')
    // The plan-file path is surfaced.
    expect(text).toContain(planDocPath(context))
  })

  it('uses the direct-search workflow (no sub-agents) for a session without the Agent tool', async () => {
    installProcessFs(makeFakeFs().fs)
    const { context } = makeContext({ mode: 'plan', tools: [] })
    const texts = await collectAndRender(context)
    expect(texts).toHaveLength(1)
    const text = texts[0]!
    expect(text).toContain('Plan mode is active')
    // Direct read-only search, NOT the sub-agent fan-out.
    expect(text).toContain('Read, Grep, and Glob')
    expect(text).not.toContain('subagent_type=Explore')
    // Still ends the turn with the same contract.
    expect(text).toContain('ExitPlanMode')
  })

  it('tells the model the plan file already exists when it does', async () => {
    const { context } = makeContext({ mode: 'plan', tools: [] })
    const planPath = planDocPath(context)
    installProcessFs(makeFakeFs({ [planPath]: '# existing plan' }).fs)
    const texts = await collectAndRender(context)
    expect(texts[0]!).toContain('already exists')
  })
})

describe('plan-mode reminder — subsequent turn (sparse)', () => {
  it('emits the short nudge once the previous turn was already in plan mode', async () => {
    installProcessFs(makeFakeFs().fs)
    const { context } = makeContext({
      mode: 'plan',
      attachmentState: { lastPermissionMode: 'plan' },
    })
    const texts = await collectAndRender(context)
    expect(texts).toHaveLength(1)
    const text = texts[0]!
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text).toContain('Plan mode still active')
    // The sparse nudge does not repeat the full workflow body.
    expect(text).not.toContain('## Workflow')
  })
})

describe('plan-mode reminder — re-entry', () => {
  it('prepends the re-entry reminder after a prior exit when a plan file survives', async () => {
    const { context } = makeContext({
      mode: 'plan',
      attachmentState: { lastPermissionMode: 'default', hasExitedPlanModeInSession: true },
    })
    const planPath = planDocPath(context)
    installProcessFs(makeFakeFs({ [planPath]: '# old plan' }).fs)
    const texts = await collectAndRender(context)
    // re-entry reminder THEN the full reminder.
    expect(texts.length).toBe(2)
    expect(texts[0]!).toContain('Re-entering plan mode')
    expect(texts[0]!.startsWith('<system-reminder>')).toBe(true)
    expect(texts[0]!).toContain(planPath)
    expect(texts[1]!).toContain('Plan mode is active')
  })
})

describe('plan-mode reminder — exit', () => {
  it('emits the exit reminder on the turn after leaving plan mode', async () => {
    const { context } = makeContext({
      mode: 'default',
      attachmentState: { lastPermissionMode: 'plan' },
    })
    const planPath = planDocPath(context)
    installProcessFs(makeFakeFs({ [planPath]: '# plan' }).fs)
    const texts = await collectAndRender(context)
    expect(texts).toHaveLength(1)
    const text = texts[0]!
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text).toContain('Exited plan mode')
    expect(text).toContain(planPath)
  })

  it('emits nothing once the exit reminder has already fired', async () => {
    installProcessFs(makeFakeFs().fs)
    const { context } = makeContext({
      mode: 'default',
      attachmentState: { lastPermissionMode: 'default' },
    })
    expect(await collectAndRender(context)).toEqual([])
  })
})

describe('EnterPlanMode tool', () => {
  it('flips the session into plan mode and stashes the previous mode', async () => {
    installProcessFs(makeFakeFs().fs)
    const { context, getState } = makeContext({ mode: 'acceptEdits' })
    const validation = await PlanOnTool.checkInput!({}, context)
    expect(validation.result).toBe(true)
    const result = await PlanOnTool.call(
      {},
      context,
      noopCanUseTool,
      makeUserRow(new BrowserRuntimeConfig(), ''),
    )
    const permission = (getState().permissionRules as {
      mode: string
      modeBeforePlan?: string
    })
    expect(permission.mode).toBe('plan')
    expect(permission.modeBeforePlan).toBe('acceptEdits')
    expect(String(result.data).toLowerCase()).toContain('plan mode')
  })

  it('rejects inside a sub-agent context', async () => {
    const { context } = makeContext({ mode: 'default', agentId: 'agent-7' })
    const validation = await PlanOnTool.checkInput!({}, context)
    expect(validation.result).toBe(false)
    if (validation.result === false) {
      expect(validation.message).toContain('subagent')
    }
  })

  it('rejects when already in plan mode', async () => {
    const { context } = makeContext({ mode: 'plan' })
    const validation = await PlanOnTool.checkInput!({}, context)
    expect(validation.result).toBe(false)
  })
})

describe('ExitPlanMode tool', () => {
  it('rejects when not in plan mode', async () => {
    const { context } = makeContext({ mode: 'default' })
    const validation = await ExitPlanModeTool.checkInput!({}, context)
    expect(validation.result).toBe(false)
  })

  // ExitPlanMode HALTS on the main thread (requiresUserInteraction → runToolUse
  // yields pendingToolUse), so call() does NOT run there — the halt + delivery
  // are covered by hook-integration.test.ts. call() runs ONLY in an agent / SDK
  // context (no interactive surface), where it auto-approves: persists the plan,
  // restores the prior mode, and returns the approved-plan message.
  it('call() auto-approves (agent/SDK path): persists the plan, restores the mode, returns approved prose', async () => {
    const { fs, files } = makeFakeFs()
    installProcessFs(fs)
    const { context, getState } = makeContext({
      mode: 'plan',
      modeBeforePlan: 'acceptEdits',
      agentId: 'agent-1',
    })
    const planBody = '# Plan\n1. Do the thing'
    const result = await ExitPlanModeTool.call(
      { plan: planBody },
      context,
      noopCanUseTool,
      makeUserRow(new BrowserRuntimeConfig(), ''),
    )
    expect(files.get(planDocPath(context))).toBe(planBody)
    const permission = getState().permissionRules as {
      mode: string
      modeBeforePlan?: string
    }
    expect(permission.mode).toBe('acceptEdits')
    expect(permission.modeBeforePlan).toBeUndefined()
    expect(String(result.data)).toContain('User has approved your plan')
    expect(String(result.data)).toContain(planBody)
  })
})

describe('plan-approval prose + plan-text resolution', () => {
  it('approved message echoes the plan and saved path', () => {
    const msg = buildApprovedPlanMessage(
      '# Plan\n1. step',
      '/ws/.velloc/plans/s.md',
    )
    expect(msg).toContain('approved your plan')
    expect(msg).toContain('# Plan')
    expect(msg).toContain('/ws/.velloc/plans/s.md')
  })

  it('approved message is a bare acknowledgement when there is no plan text', () => {
    const msg = buildApprovedPlanMessage('', '/ws/x.md')
    expect(msg).toContain('approved exiting plan mode')
    expect(msg).not.toContain('Approved Plan')
  })

  it('rejected message keeps the model planning and carries the feedback', () => {
    const msg = buildRejectedPlanMessage('use Redis not in-memory')
    expect(msg.toLowerCase()).toContain('keep planning')
    expect(msg).toContain('use Redis not in-memory')
    expect(msg).toContain('ExitPlanMode')
  })

  it('rejected message omits the feedback section when none is given', () => {
    const msg = buildRejectedPlanMessage('   ')
    expect(msg).not.toContain('Feedback')
  })

  it('resolvePlanText writes an inline plan to the plan file and returns it', async () => {
    const { fs, files } = makeFakeFs()
    installProcessFs(fs)
    const { context } = makeContext({ mode: 'plan' })
    const text = await resolvePlanText(context, { plan: '# Inline' })
    expect(text).toBe('# Inline')
    expect(files.get(planDocPath(context))).toBe('# Inline')
  })

  it('resolvePlanText reads the persisted plan when no inline plan is given', async () => {
    const { context } = makeContext({ mode: 'plan' })
    const planPath = planDocPath(context)
    installProcessFs(makeFakeFs({ [planPath]: '# Saved' }).fs)
    expect(await resolvePlanText(context, {})).toBe('# Saved')
  })

  it('resolvePlanText returns an empty string when no plan exists', async () => {
    installProcessFs(makeFakeFs().fs)
    const { context } = makeContext({ mode: 'plan' })
    expect(await resolvePlanText(context, {})).toBe('')
  })
})

describe('plan-file fork carry-over (copyPlanFileForFork)', () => {
  const cwd = '/workspace'

  it('copies the source plan to the forked session path', async () => {
    const srcPath = getPlanFilePathForSession(cwd, 'src-session')
    const { fs, files } = makeFakeFs({ [srcPath]: '# Source plan' })
    installProcessFs(fs)
    const copied = await copyPlanFileForFork(cwd, 'src-session', 'fork-session')
    expect(copied).toBe(true)
    // Keyed by the NEW sessionId — content copied, not aliased.
    expect(files.get(getPlanFilePathForSession(cwd, 'fork-session'))).toBe(
      '# Source plan',
    )
  })

  it('no-ops when the source session has no plan', async () => {
    installProcessFs(makeFakeFs().fs)
    expect(await copyPlanFileForFork(cwd, 'src-session', 'fork-session')).toBe(
      false,
    )
  })

  it('never clobbers a plan the fork already wrote', async () => {
    const srcPath = getPlanFilePathForSession(cwd, 'src')
    const dstPath = getPlanFilePathForSession(cwd, 'dst')
    const { fs, files } = makeFakeFs({
      [srcPath]: '# Source',
      [dstPath]: '# Fork-edited',
    })
    installProcessFs(fs)
    expect(await copyPlanFileForFork(cwd, 'src', 'dst')).toBe(false)
    expect(files.get(dstPath)).toBe('# Fork-edited')
  })
})

describe('plan panel auto-open gate (createPlanAutoOpenGate)', () => {
  // The shell's auto-open guard was a single
  // shared ref slot, so two sessions each holding a pending plan evicted each
  // other's key — switching A→B→A force-reopened a plan panel the user had
  // deliberately closed. The gate keys per session.
  it('opens once per (session, plan) and never re-opens the same pending plan', () => {
    const gate = createPlanAutoOpenGate()
    expect(gate('A', 'plan-A')).toBe(true)
    // Same pending plan again (e.g. re-render, or the user closed the tab):
    // never fought.
    expect(gate('A', 'plan-A')).toBe(false)
    // A NEW plan in the same session opens again.
    expect(gate('A', 'plan-A2')).toBe(true)
  })

  it('sessions do not evict each other: A→B→A does not re-open A\'s closed plan', () => {
    const gate = createPlanAutoOpenGate()
    expect(gate('A', 'plan-A')).toBe(true) // A auto-opens (user then closes it)
    expect(gate('B', 'plan-B')).toBe(true) // switch to B: B's plan auto-opens
    // Switch back to A: same pending plan — pre-fix the shared slot now held
    // plan-B, so this wrongly returned true and re-opened the closed panel.
    expect(gate('A', 'plan-A')).toBe(false)
  })

  it('ignores null/undefined session or plan ids', () => {
    const gate = createPlanAutoOpenGate()
    expect(gate(null, 'plan-A')).toBe(false)
    expect(gate('A', undefined)).toBe(false)
    // A null tick must not clear the recorded key (mirrors the old "ref is
    // NOT cleared on null" rule).
    expect(gate('A', 'plan-A')).toBe(true)
    expect(gate('A', null)).toBe(false)
    expect(gate('A', 'plan-A')).toBe(false)
  })
})
