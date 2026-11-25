/**
 * The realm's one `ProviderCredentials`, wired to the realm's pieces; each is read
 * when USED, so a later runtime or re-registered plugin is the one that answers.
 */
import { createNativePrimitives } from '../../../browser/bridge/nativePrimitives'
import { hostOpensSignInWindows, openSignInWindow } from '../../../browser/bridge/signInWindow'
import { getMcpHost } from '../../../mcp/mcpHost'
import { runtimeProviderConfigs } from '../../../models/drivers/runtimeProviders'
import { traceLine } from '../../../utils/debugLog'
import { providerHostSources } from '../providerHostSources'
import { getProviderModHost } from '../providerModHost'
import { currentWebProfiles } from '../webProfilesRuntime'
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
        loginWindow: registration.manifest.credentials.loginWindow?.allow ?? [],
      }
    },
    openWindow: request => {
      const host = getMcpHost()
      if (!host || !hostOpensSignInWindows(host.manifest)) {
        const error = new Error('interact.openWindow: this Velloc has no sign-in windows')
        error.name = 'NotSupportedError'
        return Promise.reject(error)
      }
      const primitives = createNativePrimitives({
        transport: host.transport,
        createRequestId: () => `provider-login-${crypto.randomUUID()}`,
        manifest: host.manifest,
      })
      return openSignInWindow(primitives.webWindow, host.manifest, request)
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
    holdProfile: async profile => {
      const profiles = currentWebProfiles()
      if (!profiles) {
        const error = new Error('interact.openWindow: this Velloc cannot keep web profiles')
        error.name = 'NotSupportedError'
        throw error
      }
      return profiles.hold(profile)
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
