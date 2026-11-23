import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import { reapplyProviderCatalog, resetCustomProviderRecords } from '../config/customProviderRegistry'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { resolveProviders } from '../mods/provider/providerManifest'
import { __resetEndpointTrustForTest, publishBrokerProviderBaseUrls } from '../models/endpoints/endpointTrust'
import '../models/drivers/builtinDrivers'
import { createModelProvider } from '../models/drivers/modelProvider'
import { resolveProviderSpec } from '../models/drivers/driverRegistry'

/**
 * A provider mod that declares the `anonymous` credential method sends its
 * requests with an empty credential when no key is stored, instead of a
 * `{{secret:api_key}}` template the host refuses before sending.
 */

const ID = 'mod.acme.main'
const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] } as never

function definitionFor(methods: string[]) {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: { en: 'Acme' },
        defaultBaseUrl: 'https://api.acme.example/v1',
        domains: ['api.acme.example'],
        // A Bearer-credential chat wire: a built-in provider's own.
        format: BUILTIN_PROVIDER_DEFINITIONS.find(d => d.config.wire?.format.endsWith('-chat'))!.config.wire!.format,
        credentials: { methods },
        module: './providers/main.js',
      },
    },
  })
  expect(errors).toEqual([])
  const provider = resolveProviders('acme', '/p/acme', manifest!.providers!)[0]!
  return modProviderDefinition({ plugin: 'acme', pluginVersion: '1.0.0', provider, isLoaded: () => true })
}

function authorizationFor(methods: string[]): string | undefined {
  registerModProviderDefinition(definitionFor(methods))
  reapplyProviderCatalog()
  return createModelProvider(resolveProviderSpec(ID)!).buildRequest(payload, 'm').headers.authorization
}

afterEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  __resetEndpointTrustForTest()
})

describe('anonymous provider mods', () => {
  it('an anonymous-only mod may run keyless and sends no secret template with no key stored', () => {
    expect(definitionFor(['anonymous']).config.wire?.apiKeyOptional).toBe(true)
    const authorization = authorizationFor(['anonymous'])
    expect(authorization).toBe('Bearer ')
    expect(authorization).not.toContain('{{secret:')
  })

  it('a key-only mod keeps the key template', () => {
    expect(definitionFor(['apiKey']).config.wire?.apiKeyOptional).toBeUndefined()
    expect(authorizationFor(['apiKey'])).toBe('Bearer {{secret:api_key}}')
  })

  it('a mod offering both sends the stored key when one is stored', () => {
    publishBrokerProviderBaseUrls([{ id: ID, hasStoredApiKey: true }])
    expect(authorizationFor(['apiKey', 'anonymous'])).toBe('Bearer {{secret:api_key}}')
  })

  it('a router still has no wire', () => {
    const provider = { id: ID, manifest: { kind: 'router', displayName: { en: 'Acme' }, domains: [], credentials: { methods: ['anonymous'] } } }
    const definition = modProviderDefinition({ plugin: 'acme', pluginVersion: '1.0.0', provider: provider as never, isLoaded: () => true })
    expect(definition.config.wire).toBeUndefined()
  })
})
