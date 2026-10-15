/**
 * The window's language as a mod sees it (`$.plugin.locale`, `session.start`): the
 * locale given at init, fixed for the slot's life. Pure.
 */

/** What a mod reads when the runtime was given no usable locale. */
export const MOD_DEFAULT_LOCALE = 'en'

/** A BCP-47 tag tidied for a mod: trimmed, `_` -> `-`; empty -> `en`. The
 *  region and script subtags are kept as the host wrote them. */
export function normalizeModLocale(raw: unknown): string {
  if (typeof raw !== 'string') return MOD_DEFAULT_LOCALE
  const tag = raw.trim().replace(/_/g, '-')
  return tag === '' ? MOD_DEFAULT_LOCALE : tag
}
