/**
 * Classification of fs bridge failures: `isFsTransportFailure` (the bridge pipe
 * is dead) and `isFsNotFoundError` (the path is absent). Anything else is a
 * transient failure (permission / lock / I/O) to surface honestly; a dead pipe
 * must never read as "the file vanished". Name-based, not `instanceof`: class
 * identity does not survive realm boundaries.
 */
import { isAbortLikeError } from './providerConnectivity'

const TRANSPORT_MESSAGE_PATTERN =
  /scope was disposed|Worker was disposed|transport_disposed|bridge_transport_error/

export function isFsTransportFailure(err: unknown): boolean {
  if (isAbortLikeError(err)) return true
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' && TRANSPORT_MESSAGE_PATTERN.test(message)
}

/**
 * True when an fs failure means the path is ABSENT, as opposed to a transient
 * failure that must not read as "no file there". Counts: the `NotFoundError`
 * name, a leading `ENOENT` / `ENOTDIR` wire code (anchored at the message start,
 * never an open substring: "absent" is the dangerous verdict), and one exact
 * legacy literal from older hosts.
 */
const FS_NOT_FOUND_PATTERN =
  /^(?:[A-Z_]+: )?(?:ENOENT\b|ENOTDIR\b|File not found or permission denied$)/

export function isFsNotFoundError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'NotFoundError') return true
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' && FS_NOT_FOUND_PATTERN.test(message)
}
