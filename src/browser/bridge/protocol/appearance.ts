/**
 * Bridge namespace: `appearance` — the host-owned next-launch UI locale
 * (`intl.app_locale`) and a per-client theme RESOLVER: `resolveTheme` runs a
 * client's own choice through Chrome's colour pipeline WITHOUT writing any pref
 * and posts the roles back as `nexus-theme`. A binary without it rejects with
 * `unknown_route`; the guest degrades to the classic palette (G-3).
 */

/** The three positions of the Appearance › Mode control. */
export type BrowserColorScheme = 'system' | 'light' | 'dark'

/**
 * The variants the resolver accepts. Chrome's own `kSystem` is deliberately
 * not offered: the guest always pairs a seed colour with an explicit variant,
 * and `kSystem` would ignore the seed.
 */
export type BrowserColorVariant =
  | 'tonalSpot'
  | 'neutral'
  | 'vibrant'
  | 'expressive'

/**
 * What the client sends for a resolve: which scheme to resolve for, plus the
 * seed + variant to run through the colour pipeline. Omit `seed` (or pass
 * an empty string) for Chrome's stock palette; `variant` defaults to
 * `tonalSpot` when absent. `scheme: 'system'` resolves against the HOST's
 * OS-level scheme — the client has already collapsed its own 'system' to
 * light/dark before posting (each client's 'system' follows its OWN device).
 */
export type ResolveThemeRequest = {
  /** Always `'light' | 'dark'` on the wire — never `'system'`. */
  scheme: 'light' | 'dark'
  /** `#rrggbb`, or absent for the stock palette. */
  seed?: string
  variant?: BrowserColorVariant
}

/**
 * The host's resolved theme: the same role map the panel used to broadcast
 * as `nexus-theme` (see `boot/hostTheme.ts` — `HostThemePayload` and
 * `HOST_THEME_ROLE_TOKENS` are the contract). Returned as a REQUEST result
 * here, not broadcast — only the asking client receives it. The guest then
 * applies it through the exact same code path a broadcast payload took.
 */
export type ResolveThemeResult = {
  scheme: 'light' | 'dark'
  /** Role name → browser-resolved colour string (the forms `boot/hostTheme.ts` accepts). */
  colors: Record<string, string>
}

export type AppearanceSnapshot = {
  /** BCP-47 tag of the PROSPECTIVE locale: what the next launch will use,
   *  which is what the dropdown shows between a change and the restart. */
  locale: string
  /**
   * DEPRECATED theme fields, kept so the desktop panel can migrate its host-pref
   * choice into its own localStorage; absence means "nothing to migrate".
   */
  scheme?: BrowserColorScheme
  variant?: string
  /** `#rrggbb`, absent when no user colour was set. */
  color?: string
}

export type AppearanceBridgeActionMap = {
  getAppearance: {
    payload: Record<string, never>
    result: AppearanceSnapshot
  }
  /** Resolve (scheme, seed, variant) through Chrome's colour pipeline WITHOUT
   *  writing any pref. The per-client replacement for the old setColorScheme /
   *  setUserColor pref writes. */
  resolveTheme: {
    payload: ResolveThemeRequest
    result: ResolveThemeResult
  }
  /** Takes effect on the next launch. The host validates against the locales
   *  this build actually ships on both surfaces and rejects anything else —
   *  the guest's dropdown is a convenience, not the constraint. */
  setUiLocale: {
    payload: { locale: string }
    result: { ok: true }
  }
}
