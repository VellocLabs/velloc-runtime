/**
 * The additive primitives the host manifest lists (`primitives`), for this
 * realm's model transport. `undefined` until a runtime with a manifest is
 * created — and until then a spec that needs a primitive is not served.
 * One host serves a realm, so a single value is right; a runtime created
 * without a manifest (tests, a partial config) leaves it alone.
 * Dependency-free: the bridge reads it too.
 */
let hostPrimitives: ReadonlySet<string> | undefined

export function setHostPrimitives(primitives: readonly string[] | undefined): void {
  hostPrimitives = primitives ? new Set(primitives) : undefined
}

export function hostServesPrimitive(primitive: string): boolean {
  return !!hostPrimitives?.has(primitive)
}
