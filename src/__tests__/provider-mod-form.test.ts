import { describe, expect, it } from 'vitest'

import type { BrowserLlmModProvider } from '../browser/bridge/protocol/nexus_llm'
import {
  API_KEY_PROMPT_KEY,
  credentialMethodsOf,
  defaultKeyPrompt,
  isModProviderAdded,
  isModProviderConnected,
  satisfiesPromptPattern,
  modProviderConfig,
  promptProblems,
  promptWrites,
  ruleHolds,
  settingsAsUserConfig,
  storedAnswers,
  storedPromptKeys,
  visiblePrompts,
} from '../browser/webview/settings/modProviderForm'
import type { CredentialPrompt } from '../mods/provider/providerManifest'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The pure half of the provider-mod credentials form: which prompts show,
 * whether the answers fit, where each answer goes, and the config a save
 * writes. `providers.upsert` REPLACES the whole entry, so the last group
 * pins that nothing a save writes drops `source` / `modVersion` / `account`.
 */

const prompts: CredentialPrompt[] = [
  {
    type: 'select',
    key: 'plan',
    message: 'Plan',
    options: [
      { label: 'Free', value: 'free' },
      { label: { en: 'Team', de: 'Team (de)' }, value: 'team', hint: 'Shared' },
    ],
  },
  { type: 'text', key: 'team_id', message: 'Team id', pattern: '^t-[0-9]+$', when: { key: 'plan', op: 'eq', value: 'team' } },
  { type: 'text', key: 'note', message: 'Free note', when: { key: 'plan', op: 'neq', value: 'team' } },
  { type: 'text', key: 'org_token', message: 'Org token', secret: true, when: { key: 'plan', op: 'eq', value: 'team' } },
  { type: 'text', key: API_KEY_PROMPT_KEY, message: 'API key', secret: true },
]

describe('credential methods', () => {
  it('lists what the row states, and defaults to the key', () => {
    expect(credentialMethodsOf({ state: 'ready', credentialMethods: ['apiKey', 'anonymous', 'login'] })).toEqual([
      'apiKey',
      'anonymous',
      'login',
    ])
    expect(credentialMethodsOf({ state: 'ready' })).toEqual(['apiKey'])
    expect(credentialMethodsOf({ state: 'ready', credentialMethods: [] })).toEqual(['apiKey'])
    expect(credentialMethodsOf(undefined)).toEqual(['apiKey'])
  })
})

describe('when rules', () => {
  it('eq holds on a match and neq on a mismatch; a missing answer reads as empty', () => {
    expect(ruleHolds({ key: 'plan', op: 'eq', value: 'team' }, { plan: 'team' })).toBe(true)
    expect(ruleHolds({ key: 'plan', op: 'eq', value: 'team' }, {})).toBe(false)
    expect(ruleHolds({ key: 'plan', op: 'neq', value: 'team' }, {})).toBe(true)
    expect(ruleHolds({ key: 'plan', op: 'neq', value: 'team' }, { plan: 'team' })).toBe(false)
  })

  it('shows a prompt only while its rule holds over the answers so far', () => {
    expect(visiblePrompts(prompts, {}).map(p => p.key)).toEqual(['plan', 'note', API_KEY_PROMPT_KEY])
    expect(visiblePrompts(prompts, { plan: 'team' }).map(p => p.key)).toEqual([
      'plan',
      'team_id',
      'org_token',
      API_KEY_PROMPT_KEY,
    ])
  })

  it('a rule cannot be met by the answer to a prompt that is itself hidden', () => {
    const chain: CredentialPrompt[] = [
      { type: 'text', key: 'a', message: 'A' },
      { type: 'text', key: 'b', message: 'B', when: { key: 'a', op: 'eq', value: '1' } },
      { type: 'text', key: 'c', message: 'C', when: { key: 'b', op: 'eq', value: 'x' } },
    ]
    // b is hidden (a is not 1), so its stale answer "x" does not reveal c.
    expect(visiblePrompts(chain, { a: '0', b: 'x' }).map(p => p.key)).toEqual(['a'])
    expect(visiblePrompts(chain, { a: '1', b: 'x' }).map(p => p.key)).toEqual(['a', 'b', 'c'])
  })
})

describe('validation', () => {
  it('requires every visible prompt, but only the visible ones', () => {
    expect(promptProblems(prompts, {})).toEqual({ plan: 'required', note: 'required', [API_KEY_PROMPT_KEY]: 'required' })
    expect(promptProblems(prompts, { plan: 'team' })).toEqual({
      team_id: 'required',
      org_token: 'required',
      [API_KEY_PROMPT_KEY]: 'required',
    })
  })

  it('checks a text prompt against its pattern and a select against its options', () => {
    const bad = promptProblems(prompts, { plan: 'team', team_id: 'nope', org_token: 'x', [API_KEY_PROMPT_KEY]: 'k' })
    expect(bad).toEqual({ team_id: 'pattern' })
    expect(promptProblems(prompts, { plan: 'team', team_id: 't-42', org_token: 'x', [API_KEY_PROMPT_KEY]: 'k' })).toEqual({})
    expect(promptProblems(prompts, { plan: 'gold', [API_KEY_PROMPT_KEY]: 'k', note: 'n' })).toEqual({ plan: 'option' })
  })

  it('a blank answer is fine when a value is already stored for it', () => {
    expect(promptProblems(prompts, { plan: 'free', note: 'n' }, new Set([API_KEY_PROMPT_KEY]))).toEqual({})
  })

  it('a pattern that does not compile never matches (fails closed)', () => {
    expect(satisfiesPromptPattern('(', 'anything')).toBe(false)
    expect(satisfiesPromptPattern('^a+$', 'aaa')).toBe(true)
    expect(promptProblems([{ type: 'text', key: 'k', message: 'K', pattern: '(' }], { k: 'v' })).toEqual({ k: 'pattern' })
  })
})

describe('where an answer goes', () => {
  it('routes the key to apiKey, secret answers to named secrets, the rest to plugin options', () => {
    const writes = promptWrites(prompts, {
      plan: 'team',
      team_id: ' t-42 ',
      org_token: 'tok',
      [API_KEY_PROMPT_KEY]: 'sk-1',
      note: 'ignored: hidden',
    })
    expect(writes.apiKey).toBe('sk-1')
    expect(writes.secrets).toEqual({ org_token: 'tok' })
    expect(writes.options).toEqual({ 'signin.plan': 'team', 'signin.team_id': 't-42' })
    // The prompts that own an option: a hidden one's old answer is cleared too.
    expect(writes.ownedOptions.sort()).toEqual(['signin.note', 'signin.plan', 'signin.team_id'])
  })

  it('a secret answer never lands in the options', () => {
    const writes = promptWrites(prompts, { plan: 'team', team_id: 't-1', org_token: 'tok', [API_KEY_PROMPT_KEY]: 'sk' })
    expect(JSON.stringify(writes.options)).not.toContain('tok')
    expect(JSON.stringify(writes.options)).not.toContain('sk')
    expect(writes.ownedOptions.some(name => name.includes('org_token') || name.includes(API_KEY_PROMPT_KEY))).toBe(false)
  })

  it('a blank answer writes nothing, so a stored value stays', () => {
    const writes = promptWrites(prompts, { plan: 'free', [API_KEY_PROMPT_KEY]: '   ' })
    expect(writes.apiKey).toBeUndefined()
    expect(writes.secrets).toEqual({})
  })

  it('reads stored plain answers back and knows which prompts hold a stored secret', () => {
    expect(storedAnswers(prompts, { 'signin.plan': 'team', 'signin.team_id': 't-9', other: 'x' })).toEqual({
      plan: 'team',
      team_id: 't-9',
    })
    const saved: NexusProviderConfig = { hasApiKey: true, storedSecrets: ['org_token'] }
    expect([...storedPromptKeys(prompts, saved)].sort()).toEqual([API_KEY_PROMPT_KEY, 'org_token'])
    expect([...storedPromptKeys(prompts, undefined)]).toEqual([])
  })

  it('a provider that declares no prompts shows one secret key field', () => {
    const only = defaultKeyPrompt('API key')
    expect(only).toMatchObject({ type: 'text', key: API_KEY_PROMPT_KEY, secret: true })
    expect(promptWrites([only], { [API_KEY_PROMPT_KEY]: 'sk' }).apiKey).toBe('sk')
  })
})

describe('the config a save writes (providers.upsert replaces the whole entry)', () => {
  const stored: NexusProviderConfig = {
    source: 'mod',
    modVersion: '1.2.0',
    account: 'zed@example.com',
    hasApiKey: true,
    storedSecrets: ['org_token'],
    modelEntries: [{ family: 'f', version: 'latest' }],
    defaultModel: 'f@latest',
    lastVerification: { providerId: 'mod.acme.main', verifiedAtMs: 5 },
  }

  it('keeps source, modVersion and account through every kind of save', () => {
    const changes: Array<Parameters<typeof modProviderConfig>[1]> = [
      {},
      { apiKey: 'sk-new' },
      { secrets: { org_token: 'tok' } },
      { credentialMode: 'anonymous' as const },
      { credentialMode: null },
      { apiKey: 'sk', secrets: { a: 'b' }, credentialMode: null },
    ]
    for (const change of changes) {
      const next = modProviderConfig(stored, change)
      expect(next.source).toBe('mod')
      expect(next.modVersion).toBe('1.2.0')
      expect(next.account).toBe('zed@example.com')
      // Nothing else the person set is lost either.
      expect(next.modelEntries).toEqual(stored.modelEntries)
      expect(next.defaultModel).toBe('f@latest')
    }
  })

  it('drops the redacted view (hasApiKey / storedSecrets) and never invents a key', () => {
    const next = modProviderConfig(stored, { credentialMode: 'anonymous' })
    expect('hasApiKey' in next).toBe(false)
    expect('storedSecrets' in next).toBe(false)
    // An absent apiKey/secrets means "keep what is stored" to the adapter.
    expect('apiKey' in next).toBe(false)
    expect('secrets' in next).toBe(false)
  })

  it('a new key drops the old key\'s verification stamp; other saves keep it', () => {
    expect(modProviderConfig(stored, { apiKey: 'sk-new' }).lastVerification).toBeUndefined()
    expect(modProviderConfig(stored, { secrets: { a: 'b' } }).lastVerification).toEqual(stored.lastVerification)
  })

  it('sets and clears the keyless mode', () => {
    expect(modProviderConfig(stored, { credentialMode: 'anonymous' }).credentialMode).toBe('anonymous')
    const anonymous = modProviderConfig(stored, { credentialMode: 'anonymous' })
    expect('credentialMode' in modProviderConfig(anonymous, { credentialMode: null })).toBe(false)
    expect(modProviderConfig(anonymous, { secrets: { a: 'b' } }).credentialMode).toBe('anonymous')
  })

  it('writes secrets by name (the adapter merges name by name, "" removes one)', () => {
    expect(modProviderConfig(stored, { secrets: { org_token: '' } }).secrets).toEqual({ org_token: '' })
  })

  it('starts from the marker when nothing is stored yet', () => {
    expect(modProviderConfig(undefined, { apiKey: 'sk' })).toEqual({ source: 'mod', apiKey: 'sk' })
  })
})

describe('added / connected', () => {
  it('a bare adopted entry is not added; a key, an account or the keyless mode is', () => {
    expect(isModProviderAdded({ source: 'mod', modVersion: '1' })).toBe(false)
    expect(isModProviderAdded(undefined)).toBe(false)
    expect(isModProviderAdded({ source: 'mod', hasApiKey: true })).toBe(true)
    expect(isModProviderAdded({ source: 'mod', account: 'a' })).toBe(true)
    expect(isModProviderAdded({ source: 'mod', credentialMode: 'anonymous' })).toBe(true)
  })

  it('reads as connected on a key, an account or the keyless mode', () => {
    expect(isModProviderConnected({ source: 'mod' })).toBe(false)
    expect(isModProviderConnected({ source: 'mod', hasApiKey: true })).toBe(true)
    expect(isModProviderConnected({ source: 'mod', credentialMode: 'anonymous' })).toBe(true)
  })
})

describe('declared settings', () => {
  const mod: BrowserLlmModProvider = {
    state: 'ready',
    settings: {
      region: {
        type: 'string',
        title: { en: 'Region', de: 'Region (de)' },
        description: { en: 'Where it runs', de: 'Wo es läuft' },
        options: ['us', 'eu'],
        default: 'us',
      },
      token: { type: 'string', title: 'Token', description: '', sensitive: true },
      limit: { type: 'number', title: 'Limit', description: 'Max', min: 1, max: 9 },
    },
  }

  it('resolves the vendor text in the person\'s language and falls back to English', () => {
    const de = settingsAsUserConfig(mod, {}, [], 'de')
    expect(de.fields.region).toMatchObject({ title: 'Region (de)', description: 'Wo es läuft', options: ['us', 'eu'] })
    const fr = settingsAsUserConfig(mod, {}, [], 'fr')
    expect(fr.fields.region?.title).toBe('Region')
    expect(settingsAsUserConfig(mod, {}, [], 'de-AT').fields.region?.title).toBe('Region (de)')
  })

  it('carries stored values, masks a stored sensitive one and never takes its value', () => {
    const config = settingsAsUserConfig(mod, { region: 'eu', limit: 3, token: 'LEAK' }, ['token'], 'en')
    expect(config.values).toEqual({ region: 'eu', limit: 3, token: '••••' })
    expect(JSON.stringify(config)).not.toContain('LEAK')
    expect(settingsAsUserConfig(mod, { token: 'LEAK' }, [], 'en').values.token).toBeUndefined()
  })
})
