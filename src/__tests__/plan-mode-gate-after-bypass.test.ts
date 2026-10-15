/**
 * Plan mode keeps its own gate, whatever mode it was entered from. A session
 * that switched from bypassPermissions into plan mode is planning, so a
 * write or exec tool is refused there; only bypassPermissions itself allows
 * everything.
 */
import { describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { decideToolPermission } from '../toolkit/run/toolPermissionGate'
import { evaluateRuleGate } from '../permissions/ruleEngine'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

const PROJ = '/work/project'

function makeTool(name: string, readsOnly = false): ToolContract {
  return declareTool({
    name,
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => `${name} test tool`,
    call: async () => ({ data: { ok: true } }),
    readsOnly: () => readsOnly,
  }) as unknown as ToolContract
}

function contextFor(permissionRules: WorkingState['permissionRules'], tools: ToolContract[]) {
  const appState: WorkingState = { ...createEmptyAppState(), permissionRules }
  const context = createNoopToolUseContext({
    tools,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState: () => {},
    cwd: PROJ,
    projectRoot: PROJ,
    sessionId: 'sess-plan-gate',
  })
  context.readAppState = () => appState
  return context
}

const fromBypass: WorkingState['permissionRules'] = {
  mode: 'plan',
  modeBeforePlan: 'bypassPermissions',
  extraWorkspaceRoots: new Map(),
}
const fromDefault: WorkingState['permissionRules'] = {
  mode: 'plan',
  modeBeforePlan: 'default',
  extraWorkspaceRoots: new Map(),
}
const bypass: WorkingState['permissionRules'] = {
  mode: 'bypassPermissions',
  extraWorkspaceRoots: new Map(),
}

describe('plan mode gates even when entered from bypass', () => {
  it('the rule gate does not allow-all in plan mode, from either prior mode', () => {
    const tool = makeTool('Shell')
    for (const ctx of [fromBypass, fromDefault]) {
      expect(evaluateRuleGate(tool, { command: 'rm x' }, ctx).behavior).toBe('passthrough')
    }
    expect(evaluateRuleGate(tool, { command: 'rm x' }, bypass).behavior).toBe('allow')
  })

  it('an exec tool is refused in plan mode entered from bypass', async () => {
    const tool = makeTool('Shell')
    for (const rules of [fromBypass, fromDefault]) {
      const verdict = await decideToolPermission(tool, { command: 'rm x' }, contextFor(rules, [tool]))
      expect(verdict.decision).toBe('deny')
    }
  })

  it('a file write is refused in plan mode entered from bypass', async () => {
    const tool = makeTool('Write')
    const input = { file_path: `${PROJ}/src/a.ts`, content: 'x' }
    const verdict = await decideToolPermission(tool, input, contextFor(fromBypass, [tool]))
    expect(verdict.decision).toBe('deny')
  })

  it('a read-only tool still runs in plan mode entered from bypass', async () => {
    const tool = makeTool('Peek', true)
    const verdict = await decideToolPermission(tool, {}, contextFor(fromBypass, [tool]))
    expect(verdict.decision).toBe('allow')
  })

  it('bypassPermissions itself still allows the exec tool', async () => {
    const tool = makeTool('Shell')
    const verdict = await decideToolPermission(tool, { command: 'rm x' }, contextFor(bypass, [tool]))
    expect(verdict.decision).toBe('allow')
  })
})
