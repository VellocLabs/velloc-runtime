/**
 * The realm's one `ProviderCredentials`, wired to the realm's pieces; each is read
 * when USED, so a later runtime or re-registered plugin is the one that answers.
 */
import { runtimeProviderConfigs } from '../../../models/drivers/runtimeProviders'
import { traceLine } from '../../../utils/debugLog'
import { providerHostSources } from '../providerHostSources'
import { getProviderModHost } from '../providerModHost'
import { ProviderCredentials, type CredentialDeps } from './providerCredentials'

export function defaultCredentialDeps(): CredentialDeps {
  return {
    runtime: () => getProviderModHost().runtime(),
    describe: providerId => {
      const registration = getProviderModHost()
        .registered()
        .find(entry => entry.providerId === providerId)
      if (!registration) return undefined
      return {
        secrets: (registration.manifest.credentials.secrets ?? []).map(secret => secret.name),
        methods: registration.manifest.credentials.methods,
      }
    },
    storedConfigOf: providerId => runtimeProviderConfigs()[providerId],
    writeConfig: async (providerId, config) => {
      const write = providerHostSources().writeProviderConfig
      if (!write) {
        const error = new Error('the settings store is not connected')
        error.name = 'NotSupportedError'
        throw error
      }
      await write(providerId, config)
    },
    report: line => traceLine(`[provider-mods] ${line}`, { level: 'warn' }),
  }
}

let instance: ProviderCredentials | undefined

/** The realm's service. */
export function getProviderCredentials(): ProviderCredentials {
  instance ??= new ProviderCredentials(defaultCredentialDeps())
  return instance
}

/** Test seam: replace (or, with undefined, forget) the realm's service. */
export function setProviderCredentialsForTests(next: ProviderCredentials | undefined): void {
  instance = next
}
