/**
 * The rule a person's base URL for a provider mod is held to, and the
 * manifest's `settings` binding that makes the base URL editable (F-27).
 */
import { describe, expect, it } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { judgeBaseUrl } from '../mods/provider/providerBaseUrlRule'
import { boundSettingName } from '../mods/provider/providerSettingBinds'

const boundary = { domains: ['acme.test'] }

describe('judgeBaseUrl', () => {
  it('accepts a host inside the declared domains, and a sub-domain of one', () => {
    expect(judgeBaseUrl('https://acme.test/v1', boundary)).toEqual({ kind: 'accepted', url: 'https://acme.test/v1', host: 'acme.test' })
    expect(judgeBaseUrl('https://eu.api.acme.test/v1/', boundary)).toEqual({
      kind: 'accepted',
      url: 'https://eu.api.acme.test/v1',
      host: 'eu.api.acme.test',
    })
  })

  it('does not take a look-alike host for a declared one', () => {
    expect(judgeBaseUrl('https://acme.test.evil.example/v1', boundary).kind).toBe('needs-confirmation')
    expect(judgeBaseUrl('https://notacme.test/v1', boundary).kind).toBe('needs-confirmation')
  })

  it('accepts plain http only for a loopback host, on any port', () => {
    for (const url of ['http://127.0.0.1:8123/v1', 'http://localhost:9000', 'http://[::1]:7000/v1', 'https://localhost:8443/v1']) {
      expect(judgeBaseUrl(url, boundary).kind, url).toBe('accepted')
    }
  })

  it('refuses plain http to any other host, also a declared one or one the person added', () => {
    expect(judgeBaseUrl('http://acme.test/v1', boundary)).toEqual({ kind: 'refused', problem: 'scheme' })
    expect(judgeBaseUrl('http://gateway.example/v1', { ...boundary, personHosts: ['gateway.example'] })).toEqual({
      kind: 'refused',
      problem: 'scheme',
    })
    expect(judgeBaseUrl('ftp://acme.test/v1', boundary)).toEqual({ kind: 'refused', problem: 'scheme' })
  })

  it('refuses credentials, a query and a fragment', () => {
    expect(judgeBaseUrl('https://user:pw@acme.test/v1', boundary)).toEqual({ kind: 'refused', problem: 'credentials' })
    expect(judgeBaseUrl('https://user@acme.test/v1', boundary)).toEqual({ kind: 'refused', problem: 'credentials' })
    expect(judgeBaseUrl('https://acme.test/v1?key=1', boundary)).toEqual({ kind: 'refused', problem: 'query-or-fragment' })
    expect(judgeBaseUrl('https://acme.test/v1?', boundary)).toEqual({ kind: 'refused', problem: 'query-or-fragment' })
    expect(judgeBaseUrl('https://acme.test/v1#top', boundary)).toEqual({ kind: 'refused', problem: 'query-or-fragment' })
  })

  it('refuses what is not a URL', () => {
    for (const text of ['', '   ', 'acme.test/v1', 'https://', 'https://acme .test', 'https://acme.test\\v1']) {
      expect(judgeBaseUrl(text, boundary), JSON.stringify(text)).toEqual({ kind: 'refused', problem: 'not-a-url' })
    }
  })

  it('asks for confirmation for a host outside the domains, and accepts it once the person added it', () => {
    expect(judgeBaseUrl('https://Gateway.Example/v1', boundary)).toEqual({
      kind: 'needs-confirmation',
      url: 'https://gateway.example/v1',
      host: 'gateway.example',
    })
    expect(judgeBaseUrl('https://gateway.example/v1', { ...boundary, personHosts: ['gateway.example'] }).kind).toBe('accepted')
    // The person added one host, not its sub-domains.
    expect(judgeBaseUrl('https://eu.gateway.example/v1', { ...boundary, personHosts: ['gateway.example'] }).kind).toBe(
      'needs-confirmation',
    )
  })

  it('refuses a host the person\'s record cannot hold: an IP literal other than loopback, a trailing dot, an underscore', () => {
    for (const url of ['https://[fd00::5]/v1', 'https://acme.test./v1', 'https://my_gw.example/v1']) {
      expect(judgeBaseUrl(url, boundary), url).toEqual({ kind: 'refused', problem: 'not-a-url' })
    }
    expect(judgeBaseUrl('https://10.0.0.5/v1', boundary).kind).toBe('needs-confirmation')
  })
})

function check(settings: Record<string, unknown>) {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: 'Acme',
        defaultBaseUrl: 'https://api.acme.test/v1',
        domains: ['acme.test'],
        format: 'google',
        credentials: { methods: ['apiKey'] },
        module: './providers/main.js',
        settings,
      },
    },
  })
  return { provider: manifest?.providers?.main, errors: errors.join('\n') }
}

const gateway = { type: 'string', format: 'url', binds: 'baseUrl', title: { en: 'Gateway URL' } }

describe('manifest settings: a field bound to the base URL', () => {
  it('is kept with its format and binding, beside ordinary fields', () => {
    const { provider, errors } = check({ gateway, region: { type: 'string', title: 'Region' } })
    expect(errors).toBe('')
    expect(provider?.settings?.gateway).toMatchObject({ type: 'string', format: 'url', binds: 'baseUrl' })
    expect(provider?.settings?.region?.binds).toBeUndefined()
    expect(boundSettingName(provider?.settings, 'baseUrl')).toBe('gateway')
  })

  it('a provider without a bound field is unchanged', () => {
    const { provider, errors } = check({ region: { type: 'string', title: 'Region' } })
    expect(errors).toBe('')
    expect(boundSettingName(provider?.settings, 'baseUrl')).toBeUndefined()
  })

  it('refuses the provider for an unknown binds value, naming the field', () => {
    const { provider, errors } = check({ gateway: { ...gateway, binds: 'proxy' } })
    expect(provider).toBeUndefined()
    expect(errors).toContain('settings.gateway.binds')
    expect(errors).toContain('"proxy"')
  })

  it('refuses a bound field that is not a string', () => {
    const { provider, errors } = check({ port: { type: 'number', binds: 'baseUrl', title: 'Port' } })
    expect(provider).toBeUndefined()
    expect(errors).toContain('settings.port.binds')
  })

  it('refuses a sensitive bound field', () => {
    const { provider, errors } = check({ gateway: { ...gateway, sensitive: true } })
    expect(provider).toBeUndefined()
    expect(errors).toContain('settings.gateway.binds: a bound field cannot be sensitive')
  })

  it('refuses a second field bound to the base URL', () => {
    const { provider, errors } = check({ gateway, mirror: { ...gateway, title: 'Mirror' } })
    expect(provider).toBeUndefined()
    expect(errors).toContain('settings.mirror.binds: "baseUrl" is already bound by settings.gateway')
  })

  it('refuses a default or options on a bound field: its value is the slot\'s', () => {
    const { provider, errors } = check({ gateway: { ...gateway, default: 'https://x.acme.test', required: true } })
    expect(provider).toBeUndefined()
    expect(errors).toContain('settings.gateway.binds')
    expect(errors).toContain('"default"')
  })

  it('refuses an unknown format, and a format on a field that is not a string', () => {
    expect(check({ gateway: { ...gateway, format: 'email' } }).errors).toContain('settings.gateway.format')
    expect(check({ count: { type: 'number', format: 'url', title: 'Count' } }).errors).toContain('settings.count.format')
  })
})
