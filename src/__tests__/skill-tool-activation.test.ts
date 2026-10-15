import { afterEach, describe, expect, it } from 'vitest'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { ToolContractList } from '../toolkit/toolContract'
import { declareTool } from '../toolkit/toolContract'
import { SkillRunTool } from '../toolkit/builtin/skill'
import {
  getActiveSkills,
  registerDeferrableSkills,
} from '../toolkit/run/deferredTools'

afterEach(() => {
  registerDeferrableSkills([]) // resets unit defaults + group-tool map
})

const PARENT_MESSAGE = {
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [] },
} as never
const ALLOW = async () => ({ behavior: 'allow' as const })

function browserTool(name: string) {
  return declareTool({
    name,
    skill: 'browser',
    argsSchema: { type: 'object', properties: {} },
    description: async () => name,
    async call() {
      return { data: 'ok' }
    },
  })
}

const BROWSER_TOOLS: ToolContractList = [
  browserTool('BrowserClick'),
  browserTool('BrowserNavigate'),
]

function browserSkillCommand(
  overrides: Partial<ChromiumPromptCommand> = {},
): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: 'browser',
    description: 'Browser automation',
    content: 'You now have browser tools.',
    path: '<hosted-skill>/browser',
    loadedFrom: 'bundled',
    source: 'bundled',
    permittedTools: ['BrowserClick', 'BrowserNavigate'],
    ...overrides,
  }
}

function makeContext(command: ChromiumPromptCommand) {
  let state: WorkingState = createEmptyAppState()
  return createNoopToolUseContext({
    tools: [SkillRunTool, ...BROWSER_TOOLS],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: state,
    setAppState: updater => {
      state = updater(state)
    },
    sessionId: 'skill-act-test',
    commands: [command],
  })
}

describe('SkillRunTool — skill activation', () => {
  it('invoking a skill adds its name to activeSkills', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const ctx = makeContext(browserSkillCommand())
    await SkillRunTool.call({ skill: 'browser' }, ctx, ALLOW, PARENT_MESSAGE)
    expect(getActiveSkills(ctx.readAppState())).toContain('browser')
  })

  it('activates by skill name regardless of allowed-tools contents', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const ctx = makeContext(browserSkillCommand({ permittedTools: undefined }))
    await SkillRunTool.call({ skill: 'browser' }, ctx, ALLOW, PARENT_MESSAGE)
    // Membership is derived from each tool's `skill` field C++-side, so
    // activation only needs the skill name — not an allowed-tools list.
    expect(getActiveSkills(ctx.readAppState())).toContain('browser')
  })
})
