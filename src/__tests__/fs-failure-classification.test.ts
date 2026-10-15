import { describe, expect, it } from 'vitest'
import {
  isFsNotFoundError,
  isFsTransportFailure,
} from '../utils/fsTransportFailure'

// The not-found predicate decides the DANGEROUS verdict (absent → a
// null-vs-null pair slips a commit past SuperEdit's conflict check), so its
// match is ANCHORED at the leading wire code — an open substring match flips a message that merely
// EMBEDS not-found prose (a path echoed Node-style) into "absent".

const err = (message: string, name?: string): Error => {
  const e = new Error(message)
  if (name) e.name = name
  return e
}

describe('isFsNotFoundError — anchored wire-code classification', () => {
  it('matches every real absent-path producer', () => {
    // Host stat/read, flattened by BrowserFsOperations.send.
    expect(isFsNotFoundError(err('FS_ERROR: ENOENT: no such file or directory'))).toBe(true)
    // Unflattened / test-fake shapes with a leading code.
    expect(isFsNotFoundError(err('ENOENT: /proj/x.txt'))).toBe(true)
    expect(isFsNotFoundError(err('ENOENT /proj/x.txt'))).toBe(true)
    // A file where a directory component was expected — the path as named
    // does not exist (host FILE_ERROR_NOT_A_DIRECTORY mapping).
    expect(isFsNotFoundError(err('FS_ERROR: ENOTDIR: not a directory'))).toBe(true)
    // The ONE legacy old-host wording, prefixed as it arrives on the wire.
    expect(
      isFsNotFoundError(err('FS_ERROR: File not found or permission denied')),
    ).toBe(true)
    // Platform-shaped errors carry the name, whatever the prose.
    expect(isFsNotFoundError(err('Source does not exist', 'NotFoundError'))).toBe(true)
  })

  it('does NOT match transient codes, embedded prose, or path echoes', () => {
    expect(isFsNotFoundError(err('FS_ERROR: EACCES: permission denied'))).toBe(false)
    expect(isFsNotFoundError(err('FS_ERROR: EBUSY: file is in use or locked'))).toBe(false)
    expect(isFsNotFoundError(err('FS_ERROR: EIO: input/output error'))).toBe(false)
    expect(
      isFsNotFoundError(err('FS_ERROR: EUNKNOWN: filesystem operation failed (error -1)')),
    ).toBe(false)
    // The scenario: a permission failure whose message ECHOES a path
    // containing "not found" must not read as absent.
    expect(
      isFsNotFoundError(
        err("EACCES: permission denied, stat '/proj/404 not found/x.md'"),
      ),
    ).toBe(false)
    // A message that merely mentions missing-ness mid-sentence.
    expect(isFsNotFoundError(err('handler not found for capability: fs'))).toBe(false)
    // The retired free-form fixture shape matches nothing real.
    expect(isFsNotFoundError(err('FS_ERROR: not found'))).toBe(false)
    // Non-Error throwables classify as transient (fail-safe).
    expect(isFsNotFoundError('ENOENT: thrown as a string')).toBe(false)
    expect(isFsNotFoundError(null)).toBe(false)
  })

  it('transport failures never read as not-found, whatever their prose', () => {
    const disposed = err('Runtime scope was disposed.')
    disposed.name = 'AbortError'
    expect(isFsTransportFailure(disposed)).toBe(true)
    expect(isFsNotFoundError(disposed)).toBe(false)
  })
})
