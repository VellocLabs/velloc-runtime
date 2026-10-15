/**
 * Provider mods (PM-3) — the plugin manifest's `providers` component: what is
 * accepted, what is refused and how, the id rules, the module paths, the
 * localized text resolver and the icon check.
 */
import { describe, expect, it } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { isLocalizedText, resolveLocalizedText } from '../config/localizedText'
import { iconAsImage, modProviderDefinition, safeIconSvg } from '../mods/provider/modProviderDefinition'
import {
  MOD_PROVIDER_ID_PREFIX,
  isModProviderId,
  modProviderId,
  resolveProviders,
} from '../mods/provider/providerManifest'

/** A manifest with one valid provider, `over` merged into the provider. */
function manifest(over: Record<string, unknown> = {}, name = 'opencode', key = 'zen') {
  return {
    name,
    version: '1.4.0',
    providers: {
      [key]: {
        providerApi: 1,
        displayName: { en: 'OpenCode Zen', 'zh-CN': 'OpenCode 禅' },
        icon: './icon.svg',
        defaultBaseUrl: 'https://opencode.ai/zen/v1',
        domains: ['opencode.ai'],
        format: 'openai-chat',
        credentials: {
          methods: ['apiKey', 'anonymous'],
          secrets: [{ name: 'access_token' }, { name: 'refresh_token', label: 'Refresh token' }],
        },
        module: './providers/zen.ts',
        ...over,
      },
    },
  }
}

function check(over: Record<string, unknown> = {}, name?: string, key?: string) {
  const { manifest: parsed, errors } = checkPluginDescriptor(manifest(over, name, key))
  return { providers: parsed?.providers, errors }
}

describe('manifest providers — accepted', () => {
  it('keeps a valid provider as written', () => {
    const { providers, errors } = check()
    expect(errors).toEqual([])
    expect(providers?.zen).toMatchObject({
      providerApi: 1,
      defaultBaseUrl: 'https://opencode.ai/zen/v1',
      domains: ['opencode.ai'],
      format: 'openai-chat',
      module: './providers/zen.ts',
      icon: './icon.svg',
    })
    expect(providers?.zen?.credentials.methods).toEqual(['apiKey', 'anonymous'])
    expect(providers?.zen?.credentials.secrets).toEqual([
      { name: 'access_token' },
      { name: 'refresh_token', label: 'Refresh token' },
    ])
  })

  it('takes several providers from one plugin, each on its own id', () => {
    const base = manifest()
    const both = {
      ...base,
      providers: { zen: base.providers.zen, go: { ...base.providers.zen, defaultBaseUrl: 'https://opencode.ai/go/v1' } },
    }
    const { manifest: parsed, errors } = checkPluginDescriptor(both)
    expect(errors).toEqual([])
    expect(Object.keys(parsed?.providers ?? {})).toEqual(['zen', 'go'])
  })

  it('accepts the short format names and stores the codec id', () => {
    expect(check({ format: 'anthropic' }).providers?.zen?.format).toBe('anthropic-messages')
    expect(check({ format: 'google' }).providers?.zen?.format).toBe('gemini')
  })

  it('accepts a loopback http base URL and a sub-domain of a declared domain', () => {
    expect(check({ defaultBaseUrl: 'http://127.0.0.1:4010/v1', domains: ['127.0.0.1'] }).errors).toEqual([])
    expect(check({ defaultBaseUrl: 'https://api.opencode.ai/v1' }).errors).toEqual([])
  })

  it('reads credentials.prompts, settings, requestNeeds, signNeeds, ids and updates', () => {
    const { providers, errors } = check({
      credentials: {
        methods: ['apiKey', 'login'],
        secrets: [{ name: 'access_token' }],
        readsSecrets: true,
        prompts: [
          { type: 'select', key: 'plan', message: { en: 'Plan' }, options: [{ label: 'Free', value: 'free' }, { label: 'Paid', value: 'paid', hint: { en: 'Billed' } }] },
          { type: 'text', key: 'api_key', message: 'Key', secret: true, pattern: '^oc_', placeholder: 'oc_…', when: { key: 'plan', op: 'eq', value: 'paid' } },
        ],
      },
      settings: { region: { type: 'string', options: ['us', 'eu'], default: 'us', title: { en: 'Region', 'zh-CN': '区域' } } },
      requestNeeds: ['system', 'system'],
      signNeeds: 'body',
      ids: {
        session: { derive: 'hmac', prefix: 'ses_', template: '{hex:12}{base62:14}' },
        request: { derive: 'random', prefix: 'msg_' },
        toolCall: { derive: 'hmac', alphabet: 'base62', length: 24 },
        message: { derive: 'chain', over: ['prev', 'contentSha256'], alphabet: 'base62', length: 24 },
      },
      updates: { marketplace: 'opencode@official', url: 'https://example.com/opencode.json' },
    })
    expect(errors).toEqual([])
    const zen = providers!.zen!
    expect(zen.credentials.readsSecrets).toBe(true)
    expect(zen.credentials.prompts).toHaveLength(2)
    expect(zen.settings?.region?.title).toEqual({ en: 'Region', 'zh-CN': '区域' })
    expect(zen.settings?.region?.options).toEqual(['us', 'eu'])
    expect(zen.requestNeeds).toEqual(['system'])
    expect(zen.signNeeds).toBe('body')
    expect(zen.ids?.message).toEqual({ derive: 'chain', over: ['prev', 'contentSha256'], alphabet: 'base62', length: 24 })
    expect(zen.updates?.marketplace).toBe('opencode@official')
  })

  it('accepts the cwd need, and an older host refusing a need it does not know is the same path', () => {
    const { providers, errors } = check({ requestNeeds: ['system', 'cwd'] })
    expect(errors).toEqual([])
    expect(providers!.zen!.requestNeeds).toEqual(['system', 'cwd'])
    expect(check({ requestNeeds: ['cwd', 'folder'] }).errors.join(' ')).toMatch(/"folder" is not known to this Velloc \(it knows system \/ tools \/ body \/ cwd\)/)
  })

  it('reads the reasoning kind, a chain over the id itself and a random request rule with a clock', () => {
    const { providers, errors } = check({
      ids: {
        reasoning: { derive: 'hook' },
        toolCall: { derive: 'chain', over: ['prev', 'value'], length: 20 },
        request: { derive: 'random', prefix: 'msg_', template: '{time:hex:12}{base62:14}' },
        session: { derive: 'encrypt', prefix: 'e_' },
      },
    })
    expect(errors).toEqual([])
    expect(Object.keys(providers!.zen!.ids!).sort()).toEqual(['reasoning', 'request', 'session', 'toolCall'])
    expect(providers!.zen!.ids!.toolCall).toEqual({ derive: 'chain', over: ['prev', 'value'], length: 20 })
  })

  it('ignores a property it does not know, as a newer manifest may carry one', () => {
    const { providers, errors } = check({ futureThing: { a: 1 } })
    expect(errors).toEqual([])
    expect(providers?.zen).toBeDefined()
  })
})

describe('manifest providers — refused', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown providerApi, naming it', { providerApi: 2 }, /providerApi: 2 is not supported/],
    ['a missing providerApi', { providerApi: undefined }, /providerApi: required/],
    ['a non-integer providerApi', { providerApi: 1.5 }, /providerApi: required and must be a whole number/],
    ['a missing displayName', { displayName: undefined }, /displayName/],
    ['an empty displayName map', { displayName: {} }, /displayName has no entries/],
    ['a displayName with a bad locale tag', { displayName: { 'not a locale': 'x' } }, /not a locale tag/],
    ['a missing defaultBaseUrl', { defaultBaseUrl: undefined }, /defaultBaseUrl: required/],
    ['a base URL that is not a URL', { defaultBaseUrl: 'nope' }, /not a URL/],
    ['a plain http base URL on a public host', { defaultBaseUrl: 'http://opencode.ai/v1' }, /must be https/],
    ['a base URL carrying credentials', { defaultBaseUrl: 'https://u:p@opencode.ai/v1' }, /credentials/],
    ['a base URL with a query', { defaultBaseUrl: 'https://opencode.ai/v1?x=1' }, /query/],
    ['a base URL outside the declared domains', { defaultBaseUrl: 'https://other.example/v1' }, /not among the declared domains/],
    ['no domains', { domains: [] }, /domains/],
    ['a domain with a wildcard', { domains: ['*.opencode.ai'] }, /plain host name/],
    ['a domain with a scheme', { domains: ['https://opencode.ai'] }, /plain host name/],
    ['an unknown format', { format: 'grpc' }, /format: expected one of/],
    ['no credentials', { credentials: undefined }, /credentials: required/],
    ['no credential methods', { credentials: { methods: [] } }, /credentials.methods/],
    ['an unknown credential method', { credentials: { methods: ['oauth'] } }, /"oauth" is not one of/],
    ['a secret name outside the charset', { credentials: { methods: ['apiKey'], secrets: [{ name: 'a b' }] } }, /secrets\[0\].name/],
    ['a secret named api_key', { credentials: { methods: ['apiKey'], secrets: [{ name: 'api_key' }] } }, /api_key/],
    ['a secret declared twice', { credentials: { methods: ['apiKey'], secrets: [{ name: 'a' }, { name: 'a' }] } }, /declared twice/],
    ['a secret prompt that answers no credential', { credentials: { methods: ['apiKey'], prompts: [{ type: 'text', key: 'token', message: 'T', secret: true }] } }, /must be "api_key" or a declared/],
    ['a prompt pattern that is not a regex', { credentials: { methods: ['apiKey'], prompts: [{ type: 'text', key: 'x', message: 'X', pattern: '(' }] } }, /not a valid regular expression/],
    ['a select with no options', { credentials: { methods: ['apiKey'], prompts: [{ type: 'select', key: 'x', message: 'X', options: [] }] } }, /options: expected a non-empty list/],
    ['two prompts on one key', { credentials: { methods: ['apiKey'], prompts: [{ type: 'text', key: 'x', message: 'X' }, { type: 'text', key: 'x', message: 'Y' }] } }, /used by two prompts/],
    ['a rule naming a prompt that is not there', { credentials: { methods: ['apiKey'], prompts: [{ type: 'text', key: 'x', message: 'X', when: { key: 'nope', op: 'eq', value: 'a' } }] } }, /must be another prompt's key/],
    ['a rule value the select cannot answer', { credentials: { methods: ['apiKey'], prompts: [{ type: 'select', key: 's', message: 'S', options: [{ label: 'A', value: 'a' }] }, { type: 'text', key: 'x', message: 'X', when: { key: 's', op: 'eq', value: 'zz' } }] } }, /not one of "s"'s options/],
    ['a settings field the field rules refuse', { settings: { region: { type: 'string', options: ['us'], title: 'R' } } }, /settings\.region: a field with options needs a default/],
    ['a settings key that is not an identifier', { settings: { 'a-b': { type: 'string', title: 'R' } } }, /settings\.a-b/],
    ['a request need it does not know, so less data is never given silently', { requestNeeds: ['system', 'history'] }, /"history" is not known to this Velloc/],
    ['a sign need it does not know', { signNeeds: 'everything' }, /signNeeds: "everything" is not known/],
    ['an id kind it does not know', { ids: { thing: { derive: 'keep' } } }, /unknown id kind/],
    ['a random id outside the request kind', { ids: { session: { derive: 'random' } } }, /request kind only/],
    ['a chain rule with nothing to chain over', { ids: { message: { derive: 'chain' } } }, /needs a non-empty list/],
    ['a chain on the session kind', { ids: { session: { derive: 'chain', over: ['prev'] } } }, /not the session kind/],
    ['a keep rule with a prefix', { ids: { toolCall: { derive: 'keep', prefix: 'x_' } } }, /"keep" takes no prefix/],
    ['a hook rule with a template', { ids: { toolCall: { derive: 'hook', template: '{hex:4}' } } }, /"hook" takes no template/],
    ['an encrypt rule with a length', { ids: { toolCall: { derive: 'encrypt', length: 8 } } }, /"encrypt" takes no length/],
    ['a template together with a length', { ids: { toolCall: { derive: 'hmac', template: '{hex:4}', length: 4 } } }, /cannot both be given/],
    ['a template that is not one', { ids: { toolCall: { derive: 'hmac', template: '{hex}' } } }, /template: .*whole width/],
    ['a clock in a rule that must repeat', { ids: { toolCall: { derive: 'hmac', template: '{time:hex:12}' } } }, /"random" only/],
    ['a length over what the alphabet gives', { ids: { toolCall: { derive: 'hmac', alphabet: 'base62', length: 44 } } }, /at most 43/],
    ['a chain field it does not know', { ids: { message: { derive: 'chain', over: ['prev', 'content'] } } }, /needs a non-empty list/],
    ['an update URL that is not https', { updates: { url: 'http://example.com/x' } }, /updates.url/],
    ['a module outside the plugin', { module: '../evil.ts' }, /module: required/],
    ['an absolute module path', { module: '/etc/x.ts' }, /module: required/],
    ['a module that is not a script', { module: './providers/zen.json' }, /module: required/],
    ['an icon that is not an svg', { icon: './icon.png' }, /icon: must be a relative path to an .svg/],
    ['no module', { module: undefined }, /module: required/],
  ]
  for (const [what, over, message] of cases) {
    it(`refuses ${what}`, () => {
      const { providers, errors } = check(over)
      expect(providers).toBeUndefined()
      expect(errors.join('\n')).toMatch(message)
      expect(errors.every(error => error.startsWith('providers.zen'))).toBe(true)
    })
  }

  it('drops only the bad provider and keeps the rest of the manifest', () => {
    const base = manifest()
    const { manifest: parsed, errors } = checkPluginDescriptor({
      ...base,
      providers: { zen: base.providers.zen, go: { ...base.providers.zen, providerApi: 9 } },
    })
    expect(Object.keys(parsed?.providers ?? {})).toEqual(['zen'])
    expect(parsed?.version).toBe('1.4.0')
    expect(errors.join('\n')).toMatch(/providers\.go\.providerApi: 9/)
  })

  it('refuses a providers field that is not an object', () => {
    const { manifest: parsed, errors } = checkPluginDescriptor({ name: 'p', providers: ['zen'] })
    expect(parsed?.providers).toBeUndefined()
    expect(errors.join('\n')).toMatch(/providers: expected an object/)
  })

  it('refuses every provider of a plugin whose name cannot form an id', () => {
    const { providers, errors } = check({}, 'my.plugin')
    expect(providers).toBeUndefined()
    expect(errors.join('\n')).toMatch(/cannot form a provider id/)
  })

  it('refuses a provider key outside the charset', () => {
    const { providers, errors } = check({}, 'opencode', 'a.b')
    expect(providers).toBeUndefined()
    expect(errors.join('\n')).toMatch(/providers\.a\.b: the key must be/)
  })

  it('refuses an id longer than 64 characters', () => {
    const { providers, errors } = check({}, 'p'.repeat(40), 'k'.repeat(30))
    expect(providers).toBeUndefined()
    expect(errors.join('\n')).toMatch(/the most is 64/)
    // Exactly 64 is fine.
    expect(check({}, 'p'.repeat(30), 'k'.repeat(29)).providers).toBeDefined()
  })

  it('writes no module twice into the hooks list: a provider module is not a hooks module', () => {
    const { manifest: parsed } = checkPluginDescriptor({ ...manifest(), hooks: './hooks/hooks.json' })
    expect(parsed?.hooks).toBe('./hooks/hooks.json')
    expect(parsed?.providers?.zen?.module).toBe('./providers/zen.ts')
  })
})

describe('provider ids', () => {
  it('forms mod.<plugin>.<key>, in the host secret-name charset', () => {
    const id = modProviderId('opencode', 'zen')
    expect(id).toBe('mod.opencode.zen')
    expect(id.startsWith(MOD_PROVIDER_ID_PREFIX)).toBe(true)
    expect(isModProviderId(id)).toBe(true)
    expect(isModProviderId('openai')).toBe(false)
    expect(isModProviderId('mod.a b.c')).toBe(false)
    expect(isModProviderId(`mod.${'x'.repeat(70)}`)).toBe(false)
  })

  it('is never a built-in id: every built-in lacks the mod. prefix', async () => {
    const { BUILTIN_PROVIDER_DEFINITIONS } = await import('../config/nexusModelConfig/providers')
    for (const definition of BUILTIN_PROVIDER_DEFINITIONS) {
      expect(isModProviderId(definition.config.providerId)).toBe(false)
    }
  })

  it('resolves module and icon paths inside the plugin directory', () => {
    const { providers } = check()
    const [resolved] = resolveProviders('opencode', '/plugins/opencode', providers!)
    expect(resolved).toMatchObject({ key: 'zen', id: 'mod.opencode.zen' })
    expect(resolved!.modulePath.replace(/\\/g, '/')).toBe('/plugins/opencode/providers/zen.ts')
    expect(resolved!.iconPath!.replace(/\\/g, '/')).toBe('/plugins/opencode/icon.svg')
  })
})

describe('LocalizedText', () => {
  it('reads a string as itself and rejects empties and junk', () => {
    expect(isLocalizedText('x')).toBe(true)
    expect(isLocalizedText('')).toBe(false)
    expect(isLocalizedText({})).toBe(false)
    expect(isLocalizedText({ en: '' })).toBe(false)
    expect(isLocalizedText({ en: 'x', 'zh-CN': 3 })).toBe(false)
    expect(isLocalizedText(['x'])).toBe(false)
    expect(isLocalizedText(null)).toBe(false)
  })

  it("picks the person's locale, then English, then the first entry", () => {
    const text = { fr: 'Salut', en: 'Hello', 'zh-CN': '你好' }
    expect(resolveLocalizedText(text, 'zh-CN')).toBe('你好')
    expect(resolveLocalizedText(text, 'fr')).toBe('Salut')
    expect(resolveLocalizedText(text, 'de')).toBe('Hello')
    expect(resolveLocalizedText(text, undefined)).toBe('Hello')
    expect(resolveLocalizedText({ fr: 'Salut', 'zh-CN': '你好' }, 'de')).toBe('Salut')
    expect(resolveLocalizedText('plain', 'zh-CN')).toBe('plain')
    expect(resolveLocalizedText(undefined, 'en')).toBe('')
  })

  it('matches a locale case- and separator-insensitively, and by language', () => {
    const text = { en: 'Hello', 'zh-CN': '你好' }
    expect(resolveLocalizedText(text, 'ZH_cn')).toBe('你好')
    expect(resolveLocalizedText(text, 'zh-SG')).toBe('你好')
    expect(resolveLocalizedText(text, 'en-GB')).toBe('Hello')
    expect(resolveLocalizedText({ 'en-US': 'Hi', fr: 'Salut' }, 'de')).toBe('Hi')
  })
})

describe('safeIconSvg', () => {
  const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22" fill="currentColor"/></svg>'

  it('passes a plain mark', () => {
    expect(safeIconSvg(MARK)).toBe(MARK)
    expect(safeIconSvg(`﻿  ${MARK}\n`)).toBe(MARK)
  })

  it('refuses anything that could run code or reach out', () => {
    const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
    for (const bad of [
      wrap('<script>alert(1)</script>'),
      wrap('<path onload="x()" d="M0 0"/>'),
      '<svg x=""onload="fetch(1)" xmlns="http://www.w3.org/2000/svg"></svg>',
      wrap('<rect width="9" height="9"/onmouseover="x()"/>'),
      wrap("<rect width='9''onclick='x()'/>"),
      '<svg onload="x()" xmlns="http://www.w3.org/2000/svg"></svg>',
      wrap('<foreignObject><div/></foreignObject>'),
      wrap('<a href="javascript:x()"><path d="M0 0"/></a>'),
      wrap('<use href="https://evil.example/x.svg#a"/>'),
      wrap('<image href="data:image/png;base64,AAAA"/>'),
      wrap('<path style="fill:url(https://evil.example/x)"/>'),
      wrap('<style>@import url(x)</style>'),
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<div>not an svg</div>',
      '',
      `<svg>${'x'.repeat(70_000)}</svg>`,
    ]) {
      expect(safeIconSvg(bad), bad.slice(0, 60)).toBeUndefined()
    }
  })

  it('is drawn as an image in a frame of our own: the vendor text never enters the page as markup', () => {
    const drawn = iconAsImage(MARK)
    expect(drawn.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image width="24" height="24" href="data:image/svg+xml,')).toBe(true)
    const href = drawn.slice(drawn.indexOf('href="') + 'href="'.length, drawn.lastIndexOf('"/></svg>'))
    expect(href).not.toMatch(/[<>"']/)
    expect(decodeURIComponent(href.slice('data:image/svg+xml,'.length))).toBe(MARK)
    const { providers } = check()
    const [provider] = resolveProviders('opencode', '/plugins/opencode', providers!)
    const definition = modProviderDefinition({ plugin: 'opencode', provider: provider!, iconSvg: MARK, isLoaded: () => true })
    expect(definition.iconSvg).toBe(drawn)
  })

  it('allows a reference into the document itself', () => {
    const inside = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0"/></svg>'
    expect(safeIconSvg(inside)).toBe(inside)
  })
})
