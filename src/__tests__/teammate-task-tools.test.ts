import { describe, expect, it } from 'vitest'
import {
  TEAMMATE_SHARED_TASK_TOOL_NAMES,
  withTeammateSharedTaskTools,
} from '../toolkit/builtin/team/teammateTaskTools'

/**
 * The shared-task tools every teammate keeps — the pure rule createAgentRuntime
 * applies after the template allowlist. A `safe_code` (untrusted) teammate's
 * allowlist drops the team tools wholesale; this puts back exactly the three
 * registry-only ones and nothing that talks, spawns or executes.
 */
const t = (name: string) => ({ name })

describe('withTeammateSharedTaskTools', () => {
  it('names exactly the three registry-only task tools', () => {
    expect([...TEAMMATE_SHARED_TASK_TOOL_NAMES]).toEqual(['TaskCreate', 'TaskUpdate', 'TaskList'])
    for (const banned of ['SendMessage', 'Shutdown', 'SpawnTeammate', 'TeamCreate', 'TeamDelete', 'Agent', 'Bash']) {
      expect(TEAMMATE_SHARED_TASK_TOOL_NAMES).not.toContain(banned)
    }
  })

  it('adds the task tools a safe_code allowlist dropped, from the discovered set, after the kept tools', () => {
    const discovered = ['Read', 'SuperEdit', 'TaskCreate', 'SendMessage', 'TaskUpdate', 'TaskList', 'Bash'].map(t)
    const allowlisted = ['Read', 'SuperEdit'].map(t)
    expect(withTeammateSharedTaskTools(allowlisted, discovered).map(x => x.name)).toEqual([
      'Read',
      'SuperEdit',
      'TaskCreate',
      'TaskUpdate',
      'TaskList',
    ])
  })

  it('is a no-op for a code teammate that already carries them', () => {
    const discovered = ['Read', 'TaskCreate', 'TaskUpdate', 'TaskList'].map(t)
    const allowlisted = ['TaskList', 'Read', 'TaskCreate', 'TaskUpdate'].map(t)
    expect(withTeammateSharedTaskTools(allowlisted, discovered).map(x => x.name)).toEqual([
      'TaskList',
      'Read',
      'TaskCreate',
      'TaskUpdate',
    ])
  })

  it('never invents a tool the discovered set lacks', () => {
    expect(withTeammateSharedTaskTools([t('Read')], [t('Read'), t('TaskList')]).map(x => x.name)).toEqual([
      'Read',
      'TaskList',
    ])
  })
})
