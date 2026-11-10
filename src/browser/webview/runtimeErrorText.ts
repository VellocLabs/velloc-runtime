import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import type { TranslateFn } from './i18n'

/**
 * The `state.lastError` codes the thread has words for. A code missing here
 * renders as the raw `code: message` — a developer-facing fallback, kept so a
 * new runtime error is loud rather than hidden. A new code the user is meant
 * to read takes a row here and a catalog entry, never a literal.
 */
const RUNTIME_ERROR_MESSAGE_KEYS: Partial<Record<string, Parameters<TranslateFn>[0]>> = {
  runtime_connection_failed: 'thread.runtimeConnectionFailed',
  plugin_template_absent: 'thread.pluginTemplateAbsent',
  plugin_template_waiting: 'thread.pluginTemplateWaiting',
  plugin_template_owner: 'thread.pluginTemplateOwner',
  plugin_app_seed: 'thread.pluginAppSeedFailed',
  topbar_command_unknown: 'thread.topbarCommandUnknown',
}

/**
 * What the error card shows for `lastError`: the catalog text for a known
 * code, with the raw `code: message` as `detail` (the card's `title`, the
 * technical detail for a bug report); the raw pair itself for an unknown code.
 */
export function runtimeErrorText(
  lastError: BrowserRuntimeClientState['lastError'],
  t: TranslateFn,
): { text: string; detail: string | null } | null {
  if (!lastError) return null
  const raw = `${lastError.code}: ${lastError.message}`
  const key = RUNTIME_ERROR_MESSAGE_KEYS[lastError.code]
  return key ? { text: t(key), detail: raw } : { text: raw, detail: null }
}
