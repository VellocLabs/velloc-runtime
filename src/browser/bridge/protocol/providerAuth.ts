/**
 * Bridge namespace: `providerAuth` — the network/keychain half of provider setup,
 * C++-served on the guest DIRECT bridge. `verify` is a read-only TRANSIENT probe;
 * the caller persists via the worker `providers.upsert`.
 */
export type ProviderAuthModel = { id: string; label?: string }

/**
 * One provider in the C++ registry (the `list` action, mirroring the legacy
 * `getAgentProviders`). Carries the bits the Models page needs that settings.json
 * doesn't have: `authMode` (apiKey vs oauth), `type` (cloud vs local), and the
 * live OAuth connection state.
 */
export type ProviderAuthProviderInfo = {
  id: string
  name: string
  /** 'cloud' | 'local' — gates whether an API key is required. */
  type?: string
  /** 'apiKey' | 'oauth' — selects the API-key vs OAuth UI branch. */
  authMode?: string
  isConfigured?: boolean
  hasStoredApiKey?: boolean
  /**
   * True when the broker pref carries a `last_verification` stamp for this
   * provider (the same gate `BuildCatalog`'s `provider_verified` uses). Lets
   * the Models page show "Connected" for a provider configured outside
   * settings.json (launch prefs / legacy path) whose config the page's
   * settings.json `providers.configs` view never carries.
   */
  isVerified?: boolean
  /** OAuth: live connection state. */
  connected?: boolean
  connectedEmail?: string
  baseUrl?: string
  /** True when the provider ships a default base URL (gates the Base URL field). */
  hasDefaultBaseUrl?: boolean
  defaultModel?: string
  enabledModels?: string[]
  models?: ProviderAuthModel[]
  /** Provider-specific note (e.g. the Ollama hint). */
  note?: string
}

export type ProviderAuthBridgeActionMap = {
  /**
   * Registry of known providers + their configured/auth state + active
   * selection. The same data the legacy `getAgentProviders` chrome.send route
   * returned; served by the guest-registered provider adapter.
   */
  list: {
    payload: Record<string, never>
    result: {
      providers: ProviderAuthProviderInfo[]
      activeProviderId?: string
    }
  }
  verify: {
    payload: {
      providerId: string
      updates: Record<string, unknown>
      /**
       * A saved provider record whose STORED (sealed) key the host probes with
       * when `updates.api_key` is empty — a custom provider is probed through
       * its dialect's shared backend slot (`providerId`), and the WebUI only
       * knows the record has a key. Optional and additive: an older host
       * ignores it (and probes with the slot's stored key, as before).
       */
      keyProviderId?: string
    }
    result: {
      success: boolean
      providerId?: string
      baseUrl?: string
      verifiedAtMs?: number
      modelCount?: number
      models?: ProviderAuthModel[]
      errorCode?: string
      error?: string
    }
  }
  beginOAuth: {
    payload: { providerId: string }
    result: {
      success: boolean
      deviceCode?: string
      userCode?: string
      verificationUri?: string
      error?: string
    }
  }
  oauthStatus: {
    payload: { providerId: string }
    result: { connected: boolean; connectedEmail?: string }
  }
  refresh: {
    payload: { providerId: string }
    result: { success: boolean; models?: ProviderAuthModel[]; error?: string }
  }
  reset: {
    payload: { providerId: string }
    result: { success: boolean; error?: string }
  }
}
