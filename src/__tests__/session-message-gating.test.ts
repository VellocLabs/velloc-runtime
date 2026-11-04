// SendMessage is both an `agent-teams` tool and a `sessions` group tool: a
// template that lists `sessions` in `tools:` offers it from the first request,
// whatever `agent-teams` defers (F-36).
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  __setTemplateChannelForTest,
  applyTemplateToolAllowlist,
  getTemplate,
  resolveDeferrableSkills,
  templateListedToolNames,
} from '../prompting/templateRegistry'
import { isToolGroup, TOOL_GROUPS } from '../toolkit/builtin/toolGroups'
import { loadableTools } from '../toolkit/builtin/toolSearch/catalog'
import { BoardAddTool, MailTool, TeamOpenTool } from '../toolkit/builtin/teamTools'
import { AGENT_TEAMS_SKILL_NAME } from '../toolkit/builtin/team/agentTeamsSkill'
import { registerDeferrableSkills, shouldHideToolFromModel } from '../toolkit/run/deferredTools'
import type { ToolContract } from '../toolkit/toolContract'

const TEAM_TOOLS: ToolContract[] = [TeamOpenTool, BoardAddTool, MailTool] as unknown as ToolContract[]

function appState(): WorkingState {
  return { permissionRules: { mode: 'default' } } as WorkingState
}

/** What a session of `type` on `channel` is offered from its first request,
 *  through the same template steps the runtime takes. */
function offeredFromStart(type: string, channel: 'beta' | null) {
  __setTemplateChannelForTest(channel)
  try {
    const config = getTemplate(type)!.config
    const units = resolveDeferrableSkills([], config)
    registerDeferrableSkills(units, undefined, templateListedToolNames(config))
    const unitNames = new Set(units.map(unit => unit.name))
    const loadedSkills = new Set((config.tools ?? []).filter(name => !isToolGroup(name)))
    const kept = applyTemplateToolAllowlist(
      TEAM_TOOLS,
      config,
      tool => typeof tool.skill === 'string' && (unitNames.has(tool.skill) || loadedSkills.has(tool.skill)),
    )
    return {
      visible: kept.filter(tool => !shouldHideToolFromModel(tool, appState())).map(tool => tool.name),
      loadable: loadableTools(kept, undefined).map(tool => tool.name),
    }
  } finally {
    __setTemplateChannelForTest(null)
  }
}

afterEach(() => {
  registerDeferrableSkills([])
})

describe('SendMessage in the sessions group', () => {
  it('the sessions group names SendMessage, which stays an agent-teams tool', () => {
    expect(TOOL_GROUPS.sessions).toContain('SendMessage')
    expect(MailTool.skill).toBe(AGENT_TEAMS_SKILL_NAME)
  })

  it('a beta code session has SendMessage from its first request; the other team tools stay deferred', () => {
    const { visible, loadable } = offeredFromStart('code', 'beta')
    expect(visible).toEqual(['SendMessage'])
    expect(loadable).not.toContain('SendMessage')
    expect(loadable).toContain(TeamOpenTool.name)
  })

  it('a beta agent session has SendMessage from its first request', () => {
    expect(offeredFromStart('agent', 'beta').visible).toEqual(['SendMessage'])
  })

  it('a stable code session, which lists no sessions group, still loads SendMessage through ToolSearch', () => {
    const { visible, loadable } = offeredFromStart('code', null)
    expect(visible).toEqual([])
    expect(loadable).toContain('SendMessage')
  })

  it('a safe_code session is offered no SendMessage at all', () => {
    const { visible, loadable } = offeredFromStart('safe_code', null)
    expect(visible).toEqual([])
    expect(loadable).toEqual([])
  })

  it('a sealed unit still hides a tool a tools: group lists', () => {
    registerDeferrableSkills(
      [{ name: AGENT_TEAMS_SKILL_NAME, defaultDeferred: true, sealed: true }],
      undefined,
      ['SendMessage'],
    )
    expect(shouldHideToolFromModel(MailTool, appState())).toBe(true)
    expect(loadableTools([MailTool as unknown as ToolContract], undefined)).toEqual([])
  })

  it('a deferred unit hides its tool again once no tools: group lists it', () => {
    registerDeferrableSkills([{ name: AGENT_TEAMS_SKILL_NAME, defaultDeferred: true }], undefined, ['SendMessage'])
    expect(shouldHideToolFromModel(MailTool, appState())).toBe(false)
    registerDeferrableSkills([{ name: AGENT_TEAMS_SKILL_NAME, defaultDeferred: true }])
    expect(shouldHideToolFromModel(MailTool, appState())).toBe(true)
  })
})
