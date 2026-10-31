// `engine/systemPromptSources.ts`: per-turn prompt-profile resolution; any cache on the path keys on
// `templateType + promptProfile`. Two builds for the same session/type with a different model selection must
// render two different profiles.

import { afterEach, describe, expect, it } from 'vitest'
import type {
  BrowserContextSnapshot,
  BrowserHostBridge,
} from '../browser/bridge/BrowserHostBridge'
import type { SystemPromptPart } from '../runtime/interfaces/PromptContextProvider'
import type { ToolContractList } from '../toolkit/toolContract'
import {
  recordEntryResolution,
  resetEntryResolutions,
} from '../config/nexusModelConfig/modelEntryResolution'
import { gatherSystemPromptSources } from '../engine/systemPromptSources'
import { applyPlatformLineGates } from '../prompting/systemPromptLoader'
import { getHolderProse } from '../prompting/templateRegistry'

// The minimal host the prompt path touches: one context snapshot (the shape
// production produces — nullable slots are `null`, never absent; see
// `BrowserContextSnapshot` in bridge/protocol) and no `catalog` capability
// (so the `{{system-prompt-tools}}` slot renders empty).
function fakeHostBridge(platform: 'win32' | 'linux' | 'unknown' = 'win32'): BrowserHostBridge {
  const snapshot: BrowserContextSnapshot = {
    session: {
      browserName: 'velloc',
      tabCount: 0,
      platform: platform === 'unknown' ? undefined : platform,
      osVersion: '10.0',
      shell: 'powershell',
    },
    activeTab: null,
    workspace: null,
    userProfile: null,
    domSnapshot: null,
    accessibilitySnapshot: null,
  } as BrowserContextSnapshot
  return {
    supportsBridgeCapability: () => false,
    getBrowserContextSnapshot: async () => snapshot,
  } as unknown as BrowserHostBridge
}

// Sections are finished text with no name attached; find one by how it opens.
function sectionStartingWith(
  parts: SystemPromptPart[],
  ...prefixes: string[]
): string | undefined {
  return parts.find(p => prefixes.some(prefix => p.startsWith(prefix)))
}

async function renderCodeIntro(selection: {
  providerId: string
  mainLoopModel: string
}): Promise<string> {
  const { defaultSystemPrompt } = await gatherSystemPromptSources(
    {
      tools: [] as unknown as ToolContractList,
      mainLoopModel: selection.mainLoopModel,
      extraWorkspaceRoots: [],
      mcpClients: [],
      cwd: 'D:\\proj',
      providerId: selection.providerId,
      templateType: 'code',
    },
    { hostBridge: fakeHostBridge(), sessionStartDate: '2026-09-03' },
  )
  // The SHARED `system` holder is the one that renders per profile for
  // `code` (`# How this session works` vs `# Harness`) — `code_intro` is profile-independent.
  const system = sectionStartingWith(defaultSystemPrompt, '# How this session works', '# Harness')
  expect(system, 'system section is present').toBeDefined()
  return system!
}

describe('fetchSystemPromptParts — prompt profile follows the model selection every turn', () => {
  it('lean ⇄ standard flips on a mid-session switch (no rendering sticks)', async () => {
    // Turn 1: Fable on first-party Anthropic ⇒ lean (`# Harness`).
    const lean = await renderCodeIntro({
      providerId: 'anthropic',
      mainLoopModel: 'claude-fable-5-1',
    })
    expect(lean).toContain('# Harness')
    expect(lean).not.toContain('# How this session works')

    // Turn 2, same session type, SAME provider, the user picked Sonnet ⇒
    // standard. The provider is unchanged, so only a model-keyed resolution
    // can flip this — exactly the switch scenario.
    const standard = await renderCodeIntro({
      providerId: 'anthropic',
      mainLoopModel: 'claude-sonnet-5',
    })
    expect(standard).toContain('# How this session works')
    expect(standard).not.toContain('# Harness')

    // Turn 3: back to Fable ⇒ lean again, byte-identical to turn 1.
    const leanAgain = await renderCodeIntro({
      providerId: 'anthropic',
      mainLoopModel: 'claude-fable-5-1',
    })
    expect(leanAgain).toBe(lean)

    // A relayed / uncatalogued model is STANDARD: `lean` is opt-in, declared
    // per model in the catalog, so a model nobody has classified gets more
    // instruction rather than less (prompting/promptProfile.ts).
    const relayed = await renderCodeIntro({
      providerId: 'custom-openai',
      mainLoopModel: 'gpt-5.5',
    })
    expect(relayed).toBe(standard)
    // …including a Claude id behind a relay: the catalog is keyed per
    // provider, and a `custom-<slug>` endpoint may host anything.
    const relayedVendorModel = await renderCodeIntro({
      providerId: 'custom-anthropic',
      mainLoopModel: 'claude-opus-5',
    })
    expect(relayedVendorModel).toBe(standard)
    // The declared lean line covers Opus now, not just Fable.
    const opus = await renderCodeIntro({
      providerId: 'anthropic',
      mainLoopModel: 'claude-opus-5',
    })
    expect(opus).toBe(lean)
  })

  it('a type with no -lean holders renders identically under both profiles', async () => {
    // `safe_code` deliberately has no lean variant: its audience is
    // unknown models behind relays. A standard-profile model and a lean one
    // must yield the same intro.
    const render = async (mainLoopModel: string) => {
      const { defaultSystemPrompt } = await gatherSystemPromptSources(
        {
          tools: [] as unknown as ToolContractList,
          mainLoopModel,
          extraWorkspaceRoots: [],
          mcpClients: [],
          cwd: 'D:\\proj',
          providerId: 'anthropic',
          templateType: 'safe_code',
        },
        { hostBridge: fakeHostBridge(), sessionStartDate: '2026-09-03' },
      )
      return sectionStartingWith(defaultSystemPrompt, 'You are ')
    }
    const standard = await render('claude-sonnet-5')
    const lean = await render('claude-fable-5-1')
    expect(standard).toBeDefined()
    expect(lean).toBe(standard)
  })
})

describe('fetchSystemPromptParts — the environment block names the concrete model', () => {
  afterEach(() => resetEntryResolutions())

  const environmentLine = async (mainLoopModel: string) => {
    const { defaultSystemPrompt } = await gatherSystemPromptSources(
      {
        tools: [] as unknown as ToolContractList,
        mainLoopModel,
        extraWorkspaceRoots: [],
        mcpClients: [],
        cwd: 'D:\\proj',
        providerId: 'anthropic',
        templateType: 'code',
      },
      { hostBridge: fakeHostBridge(), sessionStartDate: '2026-09-03' },
    )
    return defaultSystemPrompt
      .flatMap(part => part.split(String.fromCharCode(10)))
      .find(line => line.startsWith('- Model running this session:'))
  }

  it('a model ENTRY selection is told as the concrete model it resolves to', async () => {
    recordEntryResolution('anthropic', 'claude-haiku-*@latest', {
      id: 'claude-haiku-4-5',
      versionLabel: '4.5',
      preview: false,
    })
    expect(await environmentLine('claude-haiku-*@latest')).toBe(
      '- Model running this session: claude-haiku-4-5',
    )
  })

  it('a concrete id is told as itself', async () => {
    expect(await environmentLine('claude-fable-5-1')).toBe(
      '- Model running this session: claude-fable-5-1',
    )
  })
})

describe('platform line gates', () => {
  const text = ['a', '{{IF_PLATFORM:win32}}windows', '{{IF_PLATFORM:!win32}}elsewhere', 'b'].join('\n')

  it('keeps the matching line, marker stripped, and drops the other whole', () => {
    expect(applyPlatformLineGates(text, 'win32')).toBe('a\nwindows\nb')
    expect(applyPlatformLineGates(text, 'linux')).toBe('a\nelsewhere\nb')
  })

  it('an unknown platform keeps only the negated lines', () => {
    expect(applyPlatformLineGates(text, undefined)).toBe('a\nelsewhere\nb')
  })

  it('a dropped last line leaves no trailing newline', () => {
    expect(applyPlatformLineGates('a\n{{IF_PLATFORM:darwin}}mac', 'win32')).toBe('a')
  })
})

describe('fetchSystemPromptParts — the run-block rule names the platform shell', () => {
  const runRule = async (platform: 'win32' | 'linux' | 'unknown') => {
    const { defaultSystemPrompt } = await gatherSystemPromptSources(
      {
        tools: [] as unknown as ToolContractList,
        mainLoopModel: 'relay-model',
        extraWorkspaceRoots: [],
        mcpClients: [],
        cwd: 'D:\\proj',
        providerId: 'custom-relay',
        templateType: 'code',
      },
      { hostBridge: fakeHostBridge(platform), sessionStartDate: '2026-09-03' },
    )
    const prompt = defaultSystemPrompt.join('\n')
    expect(prompt).not.toContain('{{IF_PLATFORM:')
    return prompt.split('\n').filter(line => line.includes('Run button'))
  }

  const expectPlatformRule = (windows: string[], linux: string[]) => {
    expect(windows).toHaveLength(1)
    expect(windows[0]).toContain('tagged `powershell`')
    expect(windows[0]).not.toContain('`bash`')
    expect(linux).toHaveLength(1)
    expect(linux[0]).toContain('tagged `bash`')
    expect(linux[0]).not.toContain('powershell')
  }

  it('a Windows session is told PowerShell only, any other bash only', async () => {
    const linux = await runRule('linux')
    expectPlatformRule(await runRule('win32'), linux)
    expect(await runRule('unknown')).toEqual(linux)
  })

  it('the lean holder carries the same per-platform rule', () => {
    const lean = getHolderProse('code_tone_and_style', { type: 'code', profile: 'lean' })!
    const rule = (platform: 'win32' | 'linux') =>
      applyPlatformLineGates(lean, platform)
        .split('\n')
        .filter(line => line.includes('Run button'))
    expectPlatformRule(rule('win32'), rule('linux'))
  })
})
