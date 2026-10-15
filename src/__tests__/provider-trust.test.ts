import { describe, expect, it } from 'vitest'
import {
  defaultProviderTrust,
  isKnownProvider,
  resolveProviderTrust,
} from '../settings/providerTrust'
import {
  __resetEndpointTrustForTest,
  publishProviderTrustOverrides,
} from '../models/endpoints/endpointTrust'
import type { NexusProvidersSettings } from '../settings/settingsTypes'

const providers = (
  configs: NexusProvidersSettings['configs'],
): NexusProvidersSettings => ({ configs })

describe('resolveProviderTrust', () => {
  it('honours an explicit declaration on either kind of provider', () => {
    const settings = providers({
      relay: { isCustomProvider: true, trust: 'trusted' },
      anthropic: { trust: 'untrusted' },
    })
    expect(resolveProviderTrust(settings, 'relay')).toBe('trusted')
    expect(resolveProviderTrust(settings, 'anthropic')).toBe('untrusted')
  })

  it('defaults a CUSTOM provider to untrusted', () => {
    // The load-bearing default: adding a third-party endpoint must not
    // silently open the unrestricted path.
    expect(
      resolveProviderTrust(providers({ relay: { isCustomProvider: true } }), 'relay'),
    ).toBe('untrusted')
  })

  it('defaults a built-in provider on its vendor endpoint to trusted', () => {
    expect(
      resolveProviderTrust(providers({ anthropic: { apiKey: 'k' } }), 'anthropic'),
    ).toBe('trusted')
  })

  it('defaults a built-in provider pointed at a RELAY to untrusted', () => {
    // The seeding rule: the default is derived from the domain, so a vendor
    // provider whose base URL leaves the vendor's domains is untrusted before
    // anyone touches the toggle. Clearing the marker (a reset) returns here.
    expect(
      resolveProviderTrust(
        providers({ anthropic: { apiKey: 'k', baseUrl: 'https://relay.example.test/v1' } }),
        'anthropic',
      ),
    ).toBe('untrusted')
    expect(
      defaultProviderTrust(
        providers({ anthropic: { apiKey: 'k', baseUrl: 'http://gw.internal/v1' } }),
        'anthropic',
      ),
    ).toBe('untrusted')
  })

  it('keeps a LOCAL provider trusted — local weights are not a relay', () => {
    // Seeding from the domain flipped `ollama` to untrusted,
    // which would lock a teammate into safe_code + a read boundary to protect
    // against an operator that does not exist. `classifyEndpoint` flags a
    // local provider because its model IDENTITY is a mutable tag; trust asks
    // a different question — who sees the bytes.
    expect(resolveProviderTrust(providers({ ollama: {} }), 'ollama')).toBe('trusted')
    expect(defaultProviderTrust(providers({ ollama: {} }), 'ollama')).toBe('trusted')
  })

  it('still distrusts a local provider pointed at a REMOTE plaintext host', () => {
    // Only the `local-provider` reason is excused. A base URL that leaves the
    // machine is a third party in the path whatever the provider id says.
    expect(
      resolveProviderTrust(
        providers({ ollama: { baseUrl: 'http://gpu-box.example.test:11434' } }),
        'ollama',
      ),
    ).toBe('untrusted')
  })

  it('lets an explicit marker override the local default in both directions', () => {
    expect(
      resolveProviderTrust(providers({ ollama: { trust: 'untrusted' } }), 'ollama'),
    ).toBe('untrusted')
  })

  it('derives the DOMAIN answer even when the realm has published the marker', () => {
    // `defaultProviderTrust` is the answer BEFORE any explicit marker — it is
    // what a reset returns to, and what the settings checkbox re-derives from
    // a freshly typed URL (it passes `trust: undefined` on purpose). But it
    // delegates to `classifyEndpoint`, which reports `user-marked-untrusted`
    // from the realm's published override map; letting that through would make
    // "type the vendor URL" derive `untrusted` in any realm where the map is
    // populated. The marker is applied one level up, in `resolveProviderTrust`.
    __resetEndpointTrustForTest()
    publishProviderTrustOverrides({ anthropic: 'untrusted' })
    try {
      expect(
        defaultProviderTrust(providers({ anthropic: { apiKey: 'k' } }), 'anthropic'),
      ).toBe('trusted')
      // …and the marker still decides the resolved value.
      expect(
        resolveProviderTrust(
          providers({ anthropic: { apiKey: 'k', trust: 'untrusted' } }),
          'anthropic',
        ),
      ).toBe('untrusted')
    } finally {
      __resetEndpointTrustForTest()
    }
  })

  it('derives the DOMAIN answer when the realm has published a TRUSTED marker too', () => {
    // The other direction of the test above. A published `trusted` override
    // made `classifyEndpoint` return no reasons before any domain rule ran, so
    // a config read with a relay base URL and NO marker (a hand edit, a read
    // racing the next publish) silently defaulted `trusted` — and a teammate
    // spawn treated the relay as trusted although the on-disk config derives
    // untrusted. The default is computed as if nothing had been declared.
    __resetEndpointTrustForTest()
    publishProviderTrustOverrides({ openai: 'trusted' })
    try {
      expect(
        defaultProviderTrust(
          providers({ openai: { apiKey: 'k', baseUrl: 'https://relay.example/v1' } }),
          'openai',
        ),
      ).toBe('untrusted')
      expect(
        resolveProviderTrust(
          providers({ openai: { apiKey: 'k', baseUrl: 'https://relay.example/v1' } }),
          'openai',
        ),
      ).toBe('untrusted')
      // …and the marker still decides the resolved value when it IS on disk.
      expect(
        resolveProviderTrust(
          providers({
            openai: { apiKey: 'k', baseUrl: 'https://relay.example/v1', trust: 'trusted' },
          }),
          'openai',
        ),
      ).toBe('trusted')
    } finally {
      __resetEndpointTrustForTest()
    }
  })

  it('keeps a base-URL override onto an OFFICIAL domain trusted', () => {
    // Regional host / pinned version — the bytes still reach the vendor.
    expect(
      resolveProviderTrust(
        providers({ anthropic: { apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1' } }),
        'anthropic',
      ),
    ).toBe('trusted')
  })

  it('treats an UNCONFIGURED built-in provider as trusted', () => {
    expect(resolveProviderTrust(providers({}), 'anthropic')).toBe('trusted')
    expect(resolveProviderTrust(undefined, 'anthropic')).toBe('trusted')
  })

  it('treats an id nobody registered as UNTRUSTED, not as built-in', () => {
    // `configs[id]` absent used to read as "not custom" and
    // therefore trusted — so a bogus `provider_id` was judged safe while the
    // host ran the child on the ACTIVE provider (which may be the relay).
    expect(resolveProviderTrust(providers({}), 'anything')).toBe('untrusted')
    expect(resolveProviderTrust(undefined, 'relay-that-does-not-exist')).toBe(
      'untrusted',
    )
  })

  it('defaults a configured custom-* backend slot without the marker to untrusted', () => {
    // A legacy "Custom endpoint" row is a relay by construction.
    expect(
      resolveProviderTrust(providers({ 'custom-openai': { apiKey: 'k' } }), 'custom-openai'),
    ).toBe('untrusted')
  })

  it('ignores a junk trust value and falls back to the default', () => {
    const settings = providers({
      relay: { isCustomProvider: true, trust: 'yes' as never },
    })
    expect(resolveProviderTrust(settings, 'relay')).toBe('untrusted')
  })
})

describe('isKnownProvider', () => {
  it('knows a configured provider, whatever its id', () => {
    expect(isKnownProvider(providers({ relay: { isCustomProvider: true } }), 'relay')).toBe(true)
  })

  it('knows an unconfigured built-in provider', () => {
    expect(isKnownProvider(providers({}), 'anthropic')).toBe(true)
    expect(isKnownProvider(undefined, 'openai')).toBe(true)
  })

  it('does NOT know an unconfigured custom-* backend slot', () => {
    // Execution slots, not user-facing providers.
    expect(isKnownProvider(providers({}), 'custom-openai')).toBe(false)
    expect(isKnownProvider(providers({}), 'custom-anthropic')).toBe(false)
  })

  it('does NOT know an id nobody registered', () => {
    expect(isKnownProvider(providers({ anthropic: {} }), 'anything')).toBe(false)
    expect(isKnownProvider(undefined, 'anything')).toBe(false)
  })

  it('is not fooled by prototype keys', () => {
    expect(isKnownProvider(providers({}), 'constructor')).toBe(false)
    expect(isKnownProvider(providers({}), '__proto__')).toBe(false)
  })
})

describe('defaultProviderTrust', () => {
  // What "Reset to default" restores: the built-in safe-provider verdict,
  // ignoring whatever explicit marker the user had set. Any provider may be
  // marked untrusted; the marker is what this deliberately looks past.
  it('ignores an explicit marker on a built-in provider', () => {
    const settings = providers({ anthropic: { trust: 'untrusted' } })
    expect(resolveProviderTrust(settings, 'anthropic')).toBe('untrusted')
    expect(defaultProviderTrust(settings, 'anthropic')).toBe('trusted')
  })

  it('ignores an explicit marker on a user-added provider', () => {
    const settings = providers({ relay: { isCustomProvider: true, trust: 'trusted' } })
    expect(resolveProviderTrust(settings, 'relay')).toBe('trusted')
    expect(defaultProviderTrust(settings, 'relay')).toBe('untrusted')
  })

  it('defaults an unconfigured provider the same way resolve does', () => {
    expect(defaultProviderTrust(providers({}), 'openai')).toBe('trusted')
    expect(defaultProviderTrust(providers({}), 'custom-openai')).toBe('untrusted')
    expect(defaultProviderTrust(providers({}), 'anything')).toBe('untrusted')
  })
})
