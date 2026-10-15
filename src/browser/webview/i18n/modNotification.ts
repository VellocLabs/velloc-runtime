/**
 * The text of a `modState` notification, composed from the catalog out of
 * `mod: { plugin, state, reason }` — never the runtime's English `message`.
 */
import type { RuntimeNotification } from '../../runtimeProtocol'
import type { TranslateFn } from './translate'

export function localizeRuntimeNotification(
  notification: RuntimeNotification,
  t: TranslateFn,
): RuntimeNotification {
  const mod = notification.mod
  if (!mod) return notification
  const params = { name: mod.plugin, reason: mod.reason ?? '' }
  const key =
    mod.state === 'refused'
      ? mod.reason
        ? 'notification.mod.refused'
        : 'notification.mod.refusedNoReason'
      : mod.state === 'failed'
        ? mod.reason
          ? 'notification.mod.failed'
          : 'notification.mod.failedNoReason'
        : mod.state === 'dead'
          ? mod.reason
            ? 'notification.mod.dead'
            : 'notification.mod.deadNoReason'
          : null
  if (!key) return notification
  return { ...notification, message: t(key, params), title: mod.plugin }
}
