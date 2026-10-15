import { describe, expect, it } from 'vitest'
import {
  RUNTIME_KEEP_ALIVE_LOCK,
  holdRuntimeKeepAliveLock,
} from '../browser/boot/runtimeKeepAlive'

type Request = { name: string; options: LockOptions; held: Promise<unknown> }

function makeLocks() {
  const requests: Request[] = []
  const locks = {
    request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) {
      // The lock is held for as long as the callback's promise is pending.
      const held = Promise.resolve(callback({ name, mode: options.mode ?? 'exclusive' } as Lock))
      requests.push({ name, options, held })
      return held
    },
  }
  return { locks: locks as unknown as Pick<LockManager, 'request'>, requests }
}

describe('holdRuntimeKeepAliveLock', () => {
  it('requests ONE shared lock under the keep-alive name', () => {
    const { locks, requests } = makeLocks()
    expect(holdRuntimeKeepAliveLock(locks)).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.name).toBe(RUNTIME_KEEP_ALIVE_LOCK)
    // Shared: a second window of the same profile must hold it too, not queue
    // behind the first.
    expect(requests[0]!.options).toEqual({ mode: 'shared' })
  })

  it('never releases it: the callback promise stays pending', async () => {
    const { locks, requests } = makeLocks()
    holdRuntimeKeepAliveLock(locks)
    const outcome = await Promise.race([
      requests[0]!.held.then(
        () => 'released',
        () => 'released',
      ),
      new Promise(resolve => setTimeout(() => resolve('held'), 30)),
    ])
    expect(outcome).toBe('held')
  })

  it('reports false, and does not throw, where Web Locks does not exist', () => {
    // `null`, not `undefined`: an omitted argument means "this realm's own
    // `navigator.locks`", which node has.
    expect(holdRuntimeKeepAliveLock(null)).toBe(false)
  })

  it('reports false when the request throws synchronously', () => {
    const locks = {
      request() {
        throw new DOMException('insecure', 'SecurityError')
      },
    } as unknown as Pick<LockManager, 'request'>
    expect(holdRuntimeKeepAliveLock(locks)).toBe(false)
  })

  it('swallows a request that rejects (the document went away)', async () => {
    let unhandled = false
    const onUnhandled = () => {
      unhandled = true
    }
    process.on('unhandledRejection', onUnhandled)
    const locks = {
      request: () => Promise.reject(new DOMException('gone', 'AbortError')),
    } as unknown as Pick<LockManager, 'request'>
    expect(holdRuntimeKeepAliveLock(locks)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toBe(false)
  })
})
