import type { NexusProviderConfig } from './settingsTypes'

/** A provider mod's entry holds a finished sign-in: one that named an
 *  account, or one marked `signedIn` because it named none. */
export function holdsModSignIn(config: NexusProviderConfig | undefined): boolean {
  return !!config?.account || config?.signedIn === true
}
