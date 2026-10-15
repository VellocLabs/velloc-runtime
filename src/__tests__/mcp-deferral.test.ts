import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { LiveServerLink } from '../mcp'
import type { MCPPool } from '../mcp'
import {
  buildMCPSkillCommands,
  buildMCPToolsForServer,
  mcpServerSkillName,
  mcpServerSkillNamesFromPool,
} from '../mcp'
import {
  activateSkills,
  getActiveSkills,
  isDeferredSkill,
  registerDeferrableSkills,
  shouldHideToolFromModel,
} from '../toolkit/run/deferredTools'

// Register a set of MCP server skills as deferrable with their switch ON
// (defaultDeferred), so the gate hides their tools until activation.
function deferMcpServers(names: readonly string[]): void {
  registerDeferrableSkills(names.map(name => ({ name, defaultDeferred: true })))
}
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { SkillRunTool } from '../toolkit/builtin/skill'

// Deferral state is process-global; reset after each test.
afterEach(() => {
  registerDeferrableSkills([]) // resets unit defaults + group-tool map
})

function connectedServer(name: string): LiveServerLink {
  return {
    name,
    config: { type: 'http', url: 'http://example.test' },
    status: 'connected',
    tools: [
      { name: 'do_thing', description: 'Does a thing' },
      { name: 'other_thing' },
    ],
  }
}

// Minimal pool — only listServers is exercised here (callTool is on the
// tool's call(), which these tests don't invoke).
function poolWith(...servers: LiveServerLink[]): MCPPool {
  return { listServers: () => servers } as unknown as MCPPool
}

function appState(overrides: Partial<WorkingState> = {}): WorkingState {
  return { permissionRules: { mode: 'default' }, ...overrides } as WorkingState
}

describe('MCP deferrability', () => {
  it('namespaces the server skill name under mcp__', () => {
    expect(mcpServerSkillName('my-server')).toBe('mcp__my-server')
    // Sanitizes illegal chars so it can never collide via odd names.
    expect(mcpServerSkillName('weird name!')).toBe('mcp__weird_name_')
  })

  it('tags every MCP tool with its per-server skill bucket', () => {
    const server = connectedServer('files')
    const tools = buildMCPToolsForServer(poolWith(server), server)
    expect(tools.map(t => t.name)).toEqual([
      'mcp__files__do_thing',
      'mcp__files__other_thing',
    ])
    for (const t of tools) {
      expect(t.skill).toBe('mcp__files')
      expect(t.fromMcpServer).toBe(true)
    }
  })

  it('enumerates connected servers as deferred-skill candidates', () => {
    const pool = poolWith(connectedServer('files'), connectedServer('github'))
    expect(mcpServerSkillNamesFromPool(pool).sort()).toEqual([
      'mcp__files',
      'mcp__github',
    ])
  })

  it('omits a disconnected server from the skill set', () => {
    const live = connectedServer('files')
    const dead = { ...connectedServer('github'), status: 'failed' as const }
    expect(mcpServerSkillNamesFromPool(poolWith(live, dead))).toEqual([
      'mcp__files',
    ])
  })

  describe('gating (registered deferred + armed)', () => {
    it('hides MCP tools until the server skill is activated', () => {
      const server = connectedServer('files')
      const [tool] = buildMCPToolsForServer(poolWith(server), server)
      deferMcpServers(mcpServerSkillNamesFromPool(poolWith(server)))

      expect(isDeferredSkill('mcp__files')).toBe(true)
      // Hidden before activation.
      expect(shouldHideToolFromModel(tool!, appState())).toBe(true)

      // Activate the server's skill → visible.
      let state = appState()
      activateSkills(f => {
        state = f(state)
      }, ['mcp__files'])
      expect(shouldHideToolFromModel(tool!, state)).toBe(false)
    })

    it('never hides MCP tools when the server switch is off', () => {
      const server = connectedServer('files')
      const [tool] = buildMCPToolsForServer(poolWith(server), server)
      // Switch OFF (defaultDeferred:false) → visible. MCP's real default is
      // deferred; this exercises the user opting a server back in.
      registerDeferrableSkills([{ name: 'mcp__files', defaultDeferred: false }])
      expect(shouldHideToolFromModel(tool!, appState())).toBe(false)
    })
  })

  describe('per-server Skill command (Tier 1.5)', () => {
    it('builds a model-invocable mcp__<server> command per connected server', () => {
      const cmds = buildMCPSkillCommands(
        poolWith(connectedServer('files'), connectedServer('github')),
      )
      expect(cmds.map(c => c.name).sort()).toEqual(['mcp__files', 'mcp__github'])
      const files = cmds.find(c => c.name === 'mcp__files')!
      expect(files.type).toBe('prompt')
      // Model-invocable (SkillRunTool rejects hiddenFromModel).
      expect(files.hiddenFromModel).toBeFalsy()
      // permittedTools = the server's fully-qualified tool names.
      expect(files.permittedTools).toEqual([
        'mcp__files__do_thing',
        'mcp__files__other_thing',
      ])
      // Body orients the model on the now-available tools.
      expect(files.content).toContain('mcp__files__do_thing')
    })

    it('skips disconnected servers', () => {
      const dead = { ...connectedServer('github'), status: 'failed' as const }
      const cmds = buildMCPSkillCommands(poolWith(connectedServer('files'), dead))
      expect(cmds.map(c => c.name)).toEqual(['mcp__files'])
    })

    it('invoking Skill(mcp__<server>) activates the server bucket → tools surface', async () => {
      const server = connectedServer('files')
      const pool = poolWith(server)
      const [tool] = buildMCPToolsForServer(pool, server)
      const [command] = buildMCPSkillCommands(pool)

      deferMcpServers(mcpServerSkillNamesFromPool(pool))

      let state: WorkingState = createEmptyAppState()
      const ctx = createNoopToolUseContext({
        tools: [SkillRunTool, tool!],
        platformCapabilities: new NoopPlatformCapabilities(),
        appState: state,
        setAppState: updater => {
          state = updater(state)
        },
        sessionId: 'mcp-skill-test',
        commands: [command!],
      })

      // Hidden before activation.
      expect(shouldHideToolFromModel(tool!, ctx.readAppState())).toBe(true)

      await SkillRunTool.call(
        { skill: 'mcp__files' },
        ctx,
        async () => ({ behavior: 'allow' as const }),
        { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [] } } as never,
      )

      expect(getActiveSkills(ctx.readAppState())).toContain('mcp__files')
      expect(shouldHideToolFromModel(tool!, ctx.readAppState())).toBe(false)
    })
  })
})
