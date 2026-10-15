/**
 * The desktop page's restart gate (`browser/boot/updateRestartGate.ts`): the
 * background updater reloads a hidden page only when this answers true, so
 * every doubt must answer false.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createUpdateRestartGate,
  installUpdateRestartGate,
  type RestartGate,
} from '../browser/boot/updateRestartGate'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'

const connectionAnswering = (answer: () => Promise<unknown>) => {
  const request = vi.fn(async (_route: string) => answer())
  // Only `request` is read; the cast stands in for the rest of the connection.
  return { request, connection: async () => ({ request }) as unknown as Pick<RuntimeConnection, 'request'> }
}

describe('updateRestartGate', () => {
  it('asks the runtime for runtime.getRestartReadiness', async () => {
    const { request, connection } = connectionAnswering(async () => ({ ready: true, reasons: [] }))
    expect(await createUpdateRestartGate(connection)()).toBe(true)
    expect(request).toHaveBeenCalledWith('runtime.getRestartReadiness')
  })

  it('answers false when the runtime is busy', async () => {
    const { connection } = connectionAnswering(async () => ({ ready: false, reasons: ['turn_running'] }))
    expect(await createUpdateRestartGate(connection)()).toBe(false)
  })

  it('answers false when the runtime rejects (e.g. an older runtime without the action)', async () => {
    const { connection } = connectionAnswering(async () => { throw new Error('unknown action') })
    expect(await createUpdateRestartGate(connection)()).toBe(false)
  })

  it('answers false for a malformed answer', async () => {
    for (const answer of [null, undefined, {}, { ready: 'yes' }, { ready: 1 }]) {
      const { connection } = connectionAnswering(async () => answer)
      expect(await createUpdateRestartGate(connection)()).toBe(false)
    }
  })

  it('answers false when the connection cannot be opened', async () => {
    const gate = createUpdateRestartGate(async () => { throw new Error('no worker') })
    expect(await gate()).toBe(false)
  })

  it('installs itself where the updater looks for it', async () => {
    const target: { __nexusRestartGate?: RestartGate } = {}
    const { connection } = connectionAnswering(async () => ({ ready: true }))
    installUpdateRestartGate(connection, target)
    expect(typeof target.__nexusRestartGate).toBe('function')
    expect(await target.__nexusRestartGate!()).toBe(true)
  })
})
