import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { ToolCallContext } from '../toolkit/toolCallContext'

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

/** settings.json on a memory fs, installed as the process-wide fs impl. */
function installSettings(providers: unknown) {
  const files = new Map<string, string>([
    [SETTINGS_PATH, JSON.stringify({ version: 1, providers })],
  ])
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
  }
  vi.doMock('../utils/fs/runtimeFs', async () => {
    const actual =
      await vi.importActual<typeof import('../utils/fs/runtimeFs')>('../utils/fs/runtimeFs')
    return {
      ...actual,
      processFs: () => fs as RuntimeFs,
      fsForContext: (c: { options: { fsOperations?: RuntimeFs } }) =>
        c.options.fsOperations ?? (fs as RuntimeFs),
    }
  })
  return fs as RuntimeFs
}

function ctx(providerId?: string): ToolCallContext {
  return {
    options: {
      homeDir: HOME,
      sessionId: 'lead-1',
      ...(providerId ? { userSpecifiedProviderId: providerId } : {}),
    },
  } as unknown as ToolCallContext
}

async function survey(providerId?: string) {
  const { surveyProviderCatalog } = await import('../team/providerCatalog')
  return surveyProviderCatalog(ctx(providerId))
}

const ALLOW = async () => ({ behavior: 'allow' as const })
const PARENT = {
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [] },
} as never

async function callTool(input: { provider?: string } = {}, providerId = 'anthropic') {
  const { TeamProvidersTool } = await import('../toolkit/builtin/teamTools')
  const result = await TeamProvidersTool.call(input, ctx(providerId), ALLOW, PARENT)
  return (result as { data: string }).data
}

beforeEach(() => {
  vi.resetModules()
  wipeSettingsMemos()
})

describe('providerCatalog — endpoint trust comes from the DOMAIN', () => {
  it('trusts a vendor provider on its own endpoint and distrusts a relay', async () => {
    installSettings({
      configs: {
        anthropic: { apiKey: 'k' },
        relayed: { apiKey: 'k', baseUrl: 'https://relay.example.test/v1' },
      },
    })
    const catalog = await survey()
    const byId = Object.fromEntries(catalog.providers.map(p => [p.id, p]))
    expect(byId.anthropic?.trust).toBe('trusted')
    expect(byId.anthropic?.trustReasons).toEqual([])
    expect(byId.relayed?.trust).toBe('untrusted')
    expect(byId.relayed?.trustReasons).toContain('base-url-override')
  })

  it('ignores the provider id: an override onto an official domain stays trusted', async () => {
    // The whole point of deriving trust from the domain — where the bytes go
    // is not a function of which provider id the user picked.
    installSettings({
      configs: { anthropic: { apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1' } },
    })
    const catalog = await survey()
    expect(catalog.providers[0]?.trust).toBe('trusted')
    expect(catalog.providers[0]?.trustReasons).toEqual([])
  })

  it('flags a plaintext endpoint separately from the domain verdict', async () => {
    installSettings({
      configs: { gw: { apiKey: 'k', baseUrl: 'http://gateway.internal/v1' } },
    })
    const catalog = await survey()
    expect(catalog.providers[0]?.insecure).toBe(true)
    expect(catalog.providers[0]?.trustReasons).toContain('insecure-base-url')
  })

  it('reads the base URL from DISK, not from whatever was last published', async () => {
    // `classifyEndpoint` falls back to a module-level published map; the
    // survey must not depend on whether that publish has happened.
    const { publishProviderBaseUrls } = await import('../models/endpoints/endpointTrust')
    publishProviderBaseUrls({ anthropic: 'https://relay.example.test/v1' })
    installSettings({ configs: { anthropic: { apiKey: 'k' } } })
    const catalog = await survey()
    expect(catalog.providers[0]?.trust).toBe('trusted')
  })
})

describe('providerCatalog — one trust value', () => {
  it('reports the user setting, not the domain, when a custom provider sits on an official domain', async () => {
    // A user-created provider pointed at OpenAI really does reach OpenAI, so
    // the domain alone would say trusted. The user's declaration is what
    // gates isolation and a custom provider defaults to untrusted, so that
    // is the ONE value the survey prints — there is no second column to
    // contradict it.
    installSettings({
      configs: {
        'custom-cheap-relay': {
          isCustomProvider: true,
          displayName: 'Cheap Relay',
          baseUrl: 'https://api.openai.com/v1',
          enabledModels: ['gpt-5.6'],
        },
      },
    })
    const catalog = await survey()
    const p = catalog.providers[0]
    expect(p?.trust).toBe('untrusted')
    const { renderProviderCatalog } = await import('../team/providerCatalog')
    const text = renderProviderCatalog(catalog)
    expect(text).not.toContain('DISAGREE')
    expect(text).not.toContain('Spawns as')
  })

  it('names the passthrough catalog as the reason for the two backend slots', async () => {
    // `custom-openai` / `custom-anthropic` are the ids classifyEndpoint knows
    // as endpoint-defined; a user-created `custom-<slug>` is not one of them.
    installSettings({ configs: { 'custom-openai': { apiKey: 'k' } } })
    const catalog = await survey()
    expect(catalog.providers[0]?.trustReasons).toEqual(['custom-endpoint-provider'])
    expect(catalog.providers[0]?.trust).toBe('untrusted')
  })

  it('follows the user OVER the domain on a vendor endpoint', async () => {
    // The case that produced the bug report: Anthropic on its own official
    // domain, marked untrusted by hand. One value, and it is the user's.
    installSettings({
      configs: {
        anthropic: { apiKey: 'k', trust: 'untrusted', enabledModels: ['claude-sonnet-5'] },
      },
    })
    const catalog = await survey('anthropic')
    expect(catalog.providers[0]?.trust).toBe('untrusted')
    expect(catalog.leadTrust).toBe('untrusted')
    const { renderProviderCatalog } = await import('../team/providerCatalog')
    const text = renderProviderCatalog(catalog)
    expect(text).toContain('untrusted')
    expect(text).not.toContain('DISAGREE')
  })

  it('follows the user the OTHER way too — an explicit trusted relay reads trusted', async () => {
    installSettings({
      configs: {
        gw: { apiKey: 'k', baseUrl: 'https://gateway.example.test/v1', trust: 'trusted' },
      },
    })
    const catalog = await survey()
    expect(catalog.providers[0]?.trust).toBe('trusted')
    expect(catalog.hasUntrusted).toBe(false)
  })

  it('derives the default from the DOMAIN when the user set nothing', async () => {
    // Seeding rule: a built-in provider pointed off its vendor domain is
    // untrusted before anyone touches the toggle, and clearing the marker
    // (which is what a reset does) returns to exactly this answer.
    installSettings({
      configs: { anthropic: { apiKey: 'k', baseUrl: 'https://relay.example.test/v1' } },
    })
    const catalog = await survey()
    expect(catalog.providers[0]?.trust).toBe('untrusted')
    expect(catalog.providers[0]?.trustReasons).toContain('base-url-override')
  })
})

describe('providerCatalog — models and effort', () => {
  it('reports the curated effort tiers for an enabled model', async () => {
    installSettings({
      configs: { anthropic: { apiKey: 'k', enabledModels: ['claude-sonnet-5'] } },
    })
    // The window is the model catalog's (the row leaves it unset): install
    // the runtime's figures into this test's fresh module graph.
    ;(await import('./_helpers/builtinCatalogFigures')).installBuiltinCatalogFigures()
    const catalog = await survey()
    const model = catalog.providers[0]?.models[0]
    expect(model?.modelId).toBe('claude-sonnet-5')
    expect(model?.efforts.length).toBeGreaterThan(0)
    expect(model?.contextWindow).toBeGreaterThan(0)
  })

  it('falls back to the user custom model list, and reports no effort when unknown', async () => {
    installSettings({
      configs: {
        abc: {
          isCustomProvider: true,
          customModels: [{ modelId: 'abc-coder-v2', contextWindow: 100, maxOutputTokens: 10 }],
        },
      },
    })
    const catalog = await survey()
    expect(catalog.providers[0]?.models.map(m => m.modelId)).toEqual(['abc-coder-v2'])
    // No catalog overlay applied in this test realm: an empty tier list means
    // "do not pin an effort", and the renderer must say so rather than imply
    // effort is unsupported.
    expect(catalog.providers[0]?.models[0]?.efforts).toEqual([])
    const { renderProviderCatalog } = await import('../team/providerCatalog')
    expect(renderProviderCatalog(catalog)).toContain('do not pin an effort')
  })

  it('reports a provider with no enabled model as NOT usable', async () => {
    // Curated entries are PATTERNS, so there is no honest list of ids to
    // invent here — and with the host catalog published at boot, an empty
    // column means the provider is not set up (or every model is disabled),
    // not "unknown yet". The renderer must say it cannot run a teammate
    // rather than invite a spawn on the provider default.
    installSettings({ configs: { anthropic: { apiKey: 'k' } } })
    const catalog = await survey()
    expect(catalog.providers[0]?.models).toEqual([])
    expect(catalog.providers[0]?.modelsSource).toBe('none')
    const { renderProviderCatalog } = await import('../team/providerCatalog')
    const text = renderProviderCatalog(catalog)
    expect(text).toContain('not usable')
    expect(text).not.toContain('provider default')
  })

  it('falls back to the HOST catalog — the same ids the quick picker shows', async () => {
    // The reported bug: Anthropic's picker was full of models while the team
    // survey said "(none enabled)", which read as "unusable" and stopped
    // /team-safe.
    const { publishHostModelCatalog } = await import('../config/hostModelCatalog')
    publishHostModelCatalog({
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '',
          enabled: true,
          models: [
            { id: 'claude-opus-5', label: 'Opus 5', enabled: true },
            { id: 'claude-sonnet-5', label: 'Sonnet 5', enabled: true },
            { id: 'claude-sonnet-5-20260101', label: 'Sonnet 5', enabled: true, pickerAliasId: 'claude-sonnet-5' },
            { id: 'claude-haiku-4-5', label: 'Haiku 4.5', enabled: false },
          ],
        },
      ],
    })
    installSettings({ configs: { anthropic: { apiKey: 'k' } } })
    const catalog = await survey()
    // The picker's own visibility rule: no disabled row, no alias-hidden row.
    expect(catalog.providers[0]?.models.map(m => m.modelId)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ])
    expect(catalog.providers[0]?.modelsSource).toBe('host')
  })

  it('prefers the user enabled subset over the host catalog', async () => {
    const { publishHostModelCatalog } = await import('../config/hostModelCatalog')
    publishHostModelCatalog({
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '',
          enabled: true,
          models: [{ id: 'claude-opus-5', label: 'Opus 5', enabled: true }],
        },
      ],
    })
    installSettings({
      configs: { anthropic: { apiKey: 'k', enabledModels: ['claude-sonnet-5'] } },
    })
    const catalog = await survey()
    expect(catalog.providers[0]?.models.map(m => m.modelId)).toEqual(['claude-sonnet-5'])
    expect(catalog.providers[0]?.modelsSource).toBe('enabled')
  })
})

describe('surveyProviders — the skills table', () => {
  it('marks a host-sourced model list as not curated, and leaves a curated one bare', async () => {
    // The lead reads this table before it picks `child_model`. A host list is
    // only what the picker offers, so the row has to say so — otherwise the
    // lead reads an advertised id as the user's choice.
    const { publishHostModelCatalog } = await import('../config/hostModelCatalog')
    publishHostModelCatalog({
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '',
          enabled: true,
          models: [{ id: 'claude-opus-5', label: 'Opus 5', enabled: true }],
        },
      ],
    })
    installSettings({
      configs: {
        anthropic: { apiKey: 'k' },
        openai: { apiKey: 'k', enabledModels: ['gpt-x'] },
      },
    })
    const { surveyProviders, renderProviderTable } = await import(
      '../skillLibrary/builtin/teamProviders'
    )
    const survey = await surveyProviders(ctx())
    expect(survey.rows.find(r => r.id === 'anthropic')?.modelsAreHostDefaults).toBe(true)
    const table = renderProviderTable(survey)
    const anthropicRow = table.split('\n').find(l => l.includes('`anthropic`')) ?? ''
    expect(anthropicRow).toContain('claude-opus-5')
    expect(anthropicRow).toContain('not curated')
    const openaiRow = table.split('\n').find(l => l.includes('`openai`')) ?? ''
    expect(openaiRow).toContain('gpt-x')
    expect(openaiRow).not.toContain('not curated')
  })
})

describe('TeamProviders tool', () => {
  it('renders providers, trust and effort, and never a key or base URL', async () => {
    installSettings({
      configs: {
        anthropic: { apiKey: 'sk-secret-value', enabledModels: ['claude-sonnet-5'] },
        'custom-cheap-relay': {
          isCustomProvider: true,
          displayName: 'Cheap Relay',
          baseUrl: 'https://relay.example.test/v1',
          enabledModels: ['big-1'],
        },
      },
    })
    const text = await callTool()
    expect(text).toContain('`anthropic`')
    expect(text).toContain('Cheap Relay')
    expect(text).toContain('untrusted')
    expect(text).toContain('Reasoning effort')
    // The reply lands in the transcript and is sent to the LEAD's provider.
    expect(text).not.toContain('sk-secret-value')
    expect(text).not.toContain('relay.example.test')
    expect(text).not.toContain('apiKey')
  })

  it('filters to one provider, and says so when the id is not configured', async () => {
    installSettings({
      configs: {
        anthropic: { apiKey: 'k', enabledModels: ['claude-sonnet-5'] },
        openai: { apiKey: 'k', enabledModels: ['gpt-5.6'] },
      },
    })
    const filtered = await callTool({ provider: 'openai' })
    expect(filtered).toContain('| `openai` |')
    // The TABLE is what the filter narrows.
    expect(filtered).not.toContain('| `anthropic` |')
    // The lead footer names the provider THIS session runs on. That is session
    // context, not a row in the filtered report, so it survives the filter —
    // asserted here so a later change cannot drop it silently.
    expect(filtered).toContain('This session (the lead) runs on `anthropic`')
    const missing = await callTool({ provider: 'nope' })
    expect(missing).toContain('No provider "nope" is configured')
    expect(missing).toContain('`anthropic`')
  })

  it('resolves an UNPINNED lead to the ACTIVE provider — and refuses when that is untrusted', async () => {
    // `leadTrust` came only from the pinned provider id, so an unpinned lead
    // whose requests the host routes to an untrusted active provider read as
    // "no lead trust": the roster was rendered (and uploaded to the relay)
    // while the spawn, resolving the same session, refused it.
    installSettings({
      activeProviderId: 'custom-relay',
      configs: {
        'custom-relay': { isCustomProvider: true, trust: 'untrusted' },
        anthropic: { apiKey: 'k', enabledModels: ['claude-sonnet-5'] },
      },
    })
    const catalog = await survey()
    expect(catalog.leadProviderId).toBe('custom-relay')
    expect(catalog.leadTrust).toBe('untrusted')
    const { TeamProvidersTool } = await import('../toolkit/builtin/teamTools')
    const result = await TeamProvidersTool.call({}, ctx(), ALLOW, PARENT)
    const text = (result as { data: string }).data
    expect(text.startsWith('Refused.')).toBe(true)
    expect(text).not.toContain('claude-sonnet-5')
  })

  it('fails CLOSED on a lead whose provider is unknown or cannot be resolved at all', async () => {
    installSettings({
      configs: { anthropic: { apiKey: 'k', enabledModels: ['claude-sonnet-5'] } },
    })
    // Pinned to an id the user does not have: the host would run it on the
    // active provider, so nothing is known about where the roster would go.
    expect((await survey('nobody')).leadTrust).toBe('untrusted')
    // No pinned and no active provider: nothing can be shown to be trusted.
    expect((await survey()).leadTrust).toBe('untrusted')
    // The ordinary case is unchanged.
    expect((await survey('anthropic')).leadTrust).toBe('trusted')
  })

  it('REFUSES when the lead itself runs on an untrusted provider', async () => {
    // The roster would be uploaded to the relay the arrangement exists to
    // contain. Same refusal the two team skills make.
    installSettings({
      configs: {
        'custom-relay': { isCustomProvider: true, trust: 'untrusted' },
        anthropic: { apiKey: 'k', enabledModels: ['claude-sonnet-5'] },
      },
    })
    const text = await callTool({}, 'custom-relay')
    expect(text.startsWith('Refused.')).toBe(true)
    expect(text).not.toContain('claude-sonnet-5')
  })

  it('is read-only and concurrency-safe', async () => {
    const { TeamProvidersTool } = await import('../toolkit/builtin/teamTools')
    expect(TeamProvidersTool.readsOnly({})).toBe(true)
    expect(TeamProvidersTool.parallelSafe({})).toBe(true)
  })

  it('is gated behind the agent-teams skill, like every other team tool', async () => {
    const { TeamProvidersTool, TEAM_PROVIDERS_TOOL_NAME } = await import(
      '../toolkit/builtin/teamTools'
    )
    const { AGENT_TEAMS_TOOL_NAMES, AGENT_TEAMS_SKILL_NAME } = await import(
      '../toolkit/builtin/team/agentTeamsSkill'
    )
    expect(TeamProvidersTool.skill).toBe(AGENT_TEAMS_SKILL_NAME)
    // Missing here, the tool would stay in tools[] after the skill was
    // deactivated — the gate reads this list, not the tool's own field.
    expect(AGENT_TEAMS_TOOL_NAMES).toContain(TEAM_PROVIDERS_TOOL_NAME)
  })
})

describe('the team skills read the same survey', () => {
  it('projects the one trust value into the skill table', async () => {
    // `/team-safe` must keep showing the ENFORCED value: its table is what a
    // lead plans isolation against.
    installSettings({
      configs: {
        anthropic: { apiKey: 'k', trust: 'untrusted', enabledModels: ['claude-sonnet-5'] },
      },
    })
    const { surveyProviders } = await import('../skillLibrary/builtin/teamProviders')
    const s = await surveyProviders(ctx('anthropic'))
    expect(s.rows[0]?.trust).toBe('untrusted')
    expect(s.rows[0]?.models).toEqual(['claude-sonnet-5'])
    expect(s.hasUntrusted).toBe(true)
    expect(s.leadTrust).toBe('untrusted')
  })
})
