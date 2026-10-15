/**
 * Security: placeholders the host itself expands in a request's header and
 * query values — a stored secret (`{{secret:NAME}}`), a provider's OAuth
 * token (`{{oauth:NAME}}`). Code that does not own the secret (a settings
 * hook, a mod) must never send one: the host would fill it in for whatever
 * URL that code chose.
 */
const HOST_PLACEHOLDERS = ['{{secret:', '{{oauth:'] as const

/** True when `value` carries a host placeholder. */
export function holdsHostPlaceholder(value: string): boolean {
  return HOST_PLACEHOLDERS.some(mark => value.includes(mark))
}
