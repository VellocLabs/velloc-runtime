import { describe, expect, it } from 'vitest'

import {
  isRestoredSessionPointer,
  resolveBootSession,
} from '../browser/webview/bootSessionPointer'

/**
 * The boot pointer can be stale. An id restored from it is a hint (an absent record means stale); an id minted
 * here is real (an absent record means brand-new and must still be persisted, F-17). Both directions are pinned.
 */
describe('resolveBootSession', () => {
  const mint = () => 'minted-id'

  it('marks a session restored from the persisted pointer', () => {
    expect(
      resolveBootSession({
        storedSessionId: 'session-from-last-run',
        mintSessionId: mint,
      }),
    ).toEqual({ sessionId: 'session-from-last-run', restored: true })
  })

  it('mints a fresh id — NOT restored — when the pointer is unset', () => {
    // The first-ever boot of a profile. This session is real by construction,
    // so it must stay creatable at bind or an empty New Thread would no
    // longer survive a restart.
    expect(
      resolveBootSession({ storedSessionId: null, mintSessionId: mint }),
    ).toEqual({ sessionId: 'minted-id', restored: false })
  })

  it('a host-supplied id wins over the pointer and is NOT restored', () => {
    // `?sessionId=` is a deliberate deep link from the host, not a stale
    // leftover, so it keeps today's create-on-bind behaviour.
    expect(
      resolveBootSession({
        initialSessionId: 'session-from-host',
        storedSessionId: 'session-from-last-run',
        mintSessionId: mint,
      }),
    ).toEqual({ sessionId: 'session-from-host', restored: false })
  })
})

describe('isRestoredSessionPointer', () => {
  it('is true only for the restored boot session itself', () => {
    const boot = { sessionId: 'session-restored', restored: true }

    expect(isRestoredSessionPointer(boot, 'session-restored')).toBe(true)
    // A New Thread minted later in the same document must NOT inherit the
    // flag — it has no record on disk yet either, and marking it would stop
    // the bind from ever making it durable.
    expect(isRestoredSessionPointer(boot, 'session-new-thread')).toBe(false)
  })

  it('is false for every session when the boot id was minted here', () => {
    const boot = { sessionId: 'session-minted', restored: false }

    expect(isRestoredSessionPointer(boot, 'session-minted')).toBe(false)
    expect(isRestoredSessionPointer(boot, 'session-other')).toBe(false)
  })
})
