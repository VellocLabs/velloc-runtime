/**
 * Security: plugs a registered provider into the request seam. A provider whose seam
 * cannot be built gets one whose `request` always fails, so its requests never go
 * out without the vendor's transformation.
 */
import {
  registerProviderRequestSeam,
  type ProviderRequestSeam,
} from '../../models/drivers/providerRequestSeam'
import type { ProviderRegisteredListener, ProviderRegistration } from './providerModHost'
import { ProviderIdMapper } from './ids/idMapper'
import type { ProviderIdDeps } from './nouns/providerNounDeps'
import { createIdsHook, createProviderSeam } from './providerSeamAdapter'
import { getProviderCredentials } from './login/credentialDeps'

/** The seam for a registration: the adapter's, or — when the adapter refuses
 *  the provider's declaration — one that fails every request closed. */
export function seamForRegistration(
  registration: Pick<ProviderRegistration, 'providerId' | 'manifest' | 'runtime'>,
  report: (line: string) => void,
  ids?: ProviderIdDeps,
): ProviderRequestSeam {
  const { providerId, manifest, runtime } = registration
  try {
    const seam = createProviderSeam(
      runtime,
      providerId,
      {
        ...(manifest.requestNeeds ? { requestNeeds: manifest.requestNeeds } : {}),
        // The manifest says `digest` (the default) or `body`; only `body` is a need.
        ...(manifest.signNeeds === 'body' ? { signNeeds: 'body' as const } : {}),
      },
      // A provider that signs in keeps its token fresh (PM-7); others carry nothing.
      manifest.credentials?.methods?.includes('login') ? getProviderCredentials().seamCredentials(providerId) : undefined,
    )
    // The id mapper exists only for a provider that states `ids` rules; one
    // that states none pays nothing. Rules that cannot run must not be
    // skipped (the vendor's ids would go out unmapped): that is an error here.
    if (manifest.ids && Object.keys(manifest.ids).length > 0) {
      if (!ids) throw new Error('its id rules cannot run in this realm (no id key store)')
      seam.ids = new ProviderIdMapper({
        providerId,
        rules: manifest.ids,
        idKey: () => ids.idKey(providerId),
        stores: ids.stores,
        hook: createIdsHook(runtime, providerId),
      })
    }
    return seam
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    report(`${providerId}: its request hooks cannot be attached (${reason}); its requests will fail`)
    return {
      request() {
        throw new Error(`the provider's request hooks could not be attached: ${reason}`)
      },
    }
  }
}

/** The listener for `onProviderModRegistered`: plug the seam in, and take it
 *  out when the provider is replaced or removed. */
export function providerSeamListener(report: (line: string) => void, ids?: ProviderIdDeps): ProviderRegisteredListener {
  return registration => registerProviderRequestSeam(registration.providerId, seamForRegistration(registration, report, ids))
}
