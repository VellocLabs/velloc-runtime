// Single source of truth for the visible product name in nexus_web.
//
// Injected at build time from the product brand via the `VITE_PRODUCT_NAME`
// env var (Vite inlines `VITE_`-prefixed vars onto `import.meta.env`),
// mirroring how `VITE_BRANDING_PATH_COMPONENT` feeds the runtime dir — see
// ./runtimeDir.ts. `npm run dev` and unit tests run without that env, so they
// fall back to the defaults below.

export const DEFAULT_PRODUCT_NAME = 'Velloc Code'
export const DEFAULT_PRODUCT_LONG_NAME = 'Velloc Code in Chrome'

function readProductFromEnv(): string | undefined {
  return import.meta.env.VITE_PRODUCT_NAME?.trim() || undefined
}

let cachedProductName: string | undefined

// Runtime override of the model-facing product name (`/debug name`), realm-local
// to the SharedWorker; persisted to `agent.productNameOverride` and re-applied at
// session boot. Page-realm UI keeps the build brand.
let productNameOverride: string | undefined

/** Set (non-empty string) or clear (`undefined`/blank) the session override. */
export function setProductNameOverride(name: string | undefined): void {
  productNameOverride = name?.trim() || undefined
}

/** The active session override, if any — `undefined` means "build default". */
export function getProductNameOverride(): string | undefined {
  return productNameOverride
}

export function getProductName(): string {
  if (productNameOverride !== undefined) {
    return productNameOverride
  }
  if (cachedProductName === undefined) {
    cachedProductName = readProductFromEnv() ?? DEFAULT_PRODUCT_NAME
  }
  return cachedProductName
}

// Test-only: reset the memoized product name so a test can re-stub
// `VITE_PRODUCT_NAME` (via `vi.stubEnv`) and re-read.
export function __resetProductNameForTest(): void {
  cachedProductName = undefined
}
